'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const pb = require('./protoEncode.cjs');
const frames = require('../src/wire/frames.cjs');
const protobuf = require('../src/wire/protobuf.cjs');
const flows = require('../src/wire/flows.cjs');
const cli = require('../src/wire/cli.cjs');
const { renderFlow } = require('../src/wire/render.cjs');

const f = (no, name, kind, T, extra = {}) => ({ no, name, kind, T, repeated: false, oneof: null, opt: false, ...extra });
const schema = {
  cursor: { version: 'test' },
  messages: {
    'test.Req': {
      fields: [
        f(1, 'text', 'scalar', 9),
        f(2, 'count', 'scalar', 3),
        f(3, 'ids', 'scalar', 5, { repeated: true }),
        f(4, 'role', 'enum', 'test.Role'),
        f(5, 'labels', 'map', undefined, { K: 9, V: { kind: 'scalar', T: 9 } }),
        f(6, 'child', 'message', 'test.Child'),
        f(7, 'a', 'scalar', 9, { oneof: 'choice' }),
        f(8, 'b', 'message', 'test.Child', { oneof: 'choice' }),
        f(9, 'blob', 'scalar', 12),
        f(10, 'children', 'message', 'test.Child', { repeated: true }),
        f(11, 'flags', 'scalar', 8, { repeated: true }),
        f(12, 'ratio', 'scalar', 1),
        f(13, 'neg', 'scalar', 18),
        f(14, 'byId', 'map', undefined, { K: 5, V: { kind: 'message', T: 'test.Child' } }),
        f(15, 'big', 'scalar', 4),
        f(16, 'roles', 'enum', 'test.Role', { repeated: true }),
      ],
    },
    'test.Child': { fields: [f(1, 'name', 'scalar', 9), f(2, 'next', 'message', 'test.Child')] },
  },
  enums: { 'test.Role': { 0: 'ROLE_UNSPECIFIED', 1: 'ROLE_USER', 2: 'ROLE_ASSISTANT' } },
  services: { 'test.Svc': { methods: { Run: { I: 'test.Req', O: 'test.Child', kind: 'server_streaming' } } } },
};

const child = (name) => pb.len(1, name);

test('schema decode: scalars, int64 strings, packed/unpacked, enums, maps, nested, bytes', () => {
  const buf = pb.msg(
    pb.len(1, 'hello\nworld'),
    pb.v(2, -5),
    pb.packed(3, [1, 2, 300]),
    pb.v(3, 7), // unpacked element appended to the packed ones
    pb.v(4, 2),
    pb.len(5, pb.msg(pb.len(1, 'k1'), pb.len(2, 'v1'))),
    pb.len(5, pb.msg(pb.len(1, 'k2'))), // value omitted -> default
    pb.len(6, pb.msg(child('kid'), pb.len(2, child('grandkid')))),
    pb.len(9, Buffer.from([0, 255, 1])),
    pb.len(10, child('c1')),
    pb.len(10, child('c2')),
    pb.v(11, 1),
    pb.v(11, 0),
    pb.d(12, 0.25),
    pb.sint(13, -3),
    pb.len(14, pb.msg(pb.v(1, 42), pb.len(2, child('forty-two')))),
    pb.v(15, 2n ** 64n - 1n),
    pb.packed(16, [1, 9]),
  );
  const out = protobuf.decodeMessage(schema, 'test.Req', buf);
  assert.deepStrictEqual(out, {
    text: 'hello\nworld',
    count: '-5',
    ids: [1, 2, 300, 7],
    role: 'ROLE_ASSISTANT',
    labels: { k1: 'v1', k2: '' },
    child: { name: 'kid', next: { name: 'grandkid' } },
    blob: Buffer.from([0, 255, 1]).toString('base64'),
    children: [{ name: 'c1' }, { name: 'c2' }],
    flags: [true, false],
    ratio: 0.25,
    neg: '-3',
    byId: { 42: { name: 'forty-two' } },
    big: '18446744073709551615',
    roles: ['ROLE_USER', 9], // unknown enum number stays a number
  });
});

test('schema decode keeps unknown fields, wire-type mismatches and superseded oneof members', () => {
  const buf = pb.msg(pb.len(7, 'first'), pb.len(8, child('second')), pb.v(99, 5), pb.v(1, 3), pb.len(500, 'tail text'));
  const out = protobuf.decodeMessage(schema, 'test.Req', buf);
  assert.deepStrictEqual(out.b, { name: 'second' });
  assert.strictEqual(out.a, undefined);
  const byNo = Object.fromEntries(out._unknown.map((u) => [u.no, u]));
  assert.deepStrictEqual(byNo[7], { no: 7, field: 'a', superseded: 'first' });
  assert.strictEqual(byNo[99].value, '5');
  assert.strictEqual(byNo[1].field, 'text');
  assert.match(byNo[1].mismatch, /expected len/);
  assert.strictEqual(byNo[1].value, '3');
  assert.strictEqual(byNo[500].string, 'tail text');

  const dup = protobuf.decodeMessage(schema, 'test.Req', pb.msg(pb.len(5, pb.msg(pb.len(1, 'k'), pb.len(2, 'old'))), pb.len(5, pb.msg(pb.len(1, 'k'), pb.len(2, 'new')))));
  assert.deepStrictEqual(dup.labels, { k: 'new' });
  assert.deepStrictEqual(dup._unknown, [{ no: 5, field: 'labels', key: 'k', superseded: 'old' }]);
  const proto = protobuf.decodeMessage(schema, 'test.Req', pb.len(5, pb.msg(pb.len(1, '__proto__'), pb.len(2, 'v'))));
  assert.deepStrictEqual(Object.keys(proto.labels), ['__proto__']);
  assert.strictEqual(JSON.parse(JSON.stringify(proto)).labels.__proto__, 'v');
});

test('fields with unresolved schema types decode schema-less, under their names', () => {
  const loose = {
    messages: {
      'test.Loose': {
        fields: [
          f(1, 'msg', 'message', null),
          f(2, 'unknownKind', null, null, { repeated: true }),
          f(3, 'level', 'enum', null),
          f(4, 'byKey', 'map', undefined, { K: 9, V: { kind: 'message', T: null } }),
          f(5, 'nan', 'scalar', 1),
        ],
      },
    },
    enums: {},
  };
  const buf = pb.msg(pb.len(1, child('inner')), pb.v(2, 7), pb.v(3, 2), pb.len(4, pb.msg(pb.len(1, 'k'), pb.len(2, child('val')))), pb.d(5, NaN));
  const out = protobuf.decodeMessage(loose, 'test.Loose', buf);
  const byNo = Object.fromEntries(out._unknown.map((u) => [u.no, u]));
  assert.strictEqual(byNo[1].field, 'msg');
  assert.strictEqual(byNo[1].unresolvedType, true);
  assert.strictEqual(byNo[1].message[0].string, 'inner');
  assert.strictEqual(byNo[2].value, '7');
  assert.strictEqual(out.level, 2);
  assert.strictEqual(out.byKey.k.unresolvedType, true);
  assert.strictEqual(out.byKey.k.message[0].string, 'val');
  assert.strictEqual(out.nan, 'NaN');
  const text = require('../src/wire/render.cjs').valueLines('', out, '', 0).join('\n');
  assert.match(text, /#1 msg len\(7\)  \(type unresolved in the schema\) message:\n {4}#1 len\(5\) "inner"/);
  assert.match(text, /byKey:\n {2}k len\(5\)  \(type unresolved in the schema\) message:/);
});

test('schema decode of malformed or truncated input returns what parsed plus the rest', () => {
  const good = pb.msg(pb.len(1, 'ok'), pb.v(2, 1));
  const bad = Buffer.concat([good, pb.tag(6, 2), pb.varint(50), Buffer.from('short')]);
  const out = protobuf.decodeMessage(schema, 'test.Req', bad);
  assert.strictEqual(out.text, 'ok');
  assert.strictEqual(out.count, '1');
  assert.strictEqual(out._error.offset, good.length);
  assert.match(out._error.message, /runs past end/);
  assert.deepStrictEqual(Buffer.from(out._rest, 'base64'), bad.subarray(good.length));

  // Nested garbage stays local to the nested message.
  const nested = protobuf.decodeMessage(schema, 'test.Req', pb.len(6, Buffer.from([0x0a, 0x09, 0x41])));
  assert.ok(nested.child._error);
});

test('decoders never throw on random input and guard nesting depth', () => {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < 2000; i++) {
    const b = Buffer.from(Array.from({ length: Math.floor(rand() * 64) }, () => Math.floor(rand() * 256)));
    protobuf.decodeRaw(b);
    protobuf.decodeMessage(schema, 'test.Req', b);
  }
  let deep = child('leaf');
  for (let i = 0; i < 300; i++) deep = pb.msg(child(`n${i}`), pb.len(2, deep));
  const out = protobuf.decodeMessage(schema, 'test.Child', deep);
  let node = out;
  let levels = 0;
  while (node.next) { node = node.next; levels++; }
  assert.ok(levels <= protobuf.MAX_DEPTH + 1);
  assert.match(node._error.message, /too deep/);
  assert.ok(node._rest);
  const raw = protobuf.decodeRaw(deep);
  assert.ok(raw.fields.length);
});

test('schema-less decode offers every reading that fits', () => {
  const inner = pb.msg(pb.len(1, 'nested'), pb.v(2, 150));
  const { fields, error } = protobuf.decodeRaw(pb.msg(
    pb.len(1, 'plain text'),
    pb.len(2, inner),
    pb.len(3, Buffer.from([0xff, 0xfe, 0x00, 0x13])),
    pb.len(4, 'J\x05hello'), // a valid message (field 9, len 5), but \x05 rules out text
    pb.v(5, -1),
    pb.f(6, 1.5),
    pb.d(7, -2),
  ));
  assert.strictEqual(error, undefined);
  const [s, m, b, both, neg, flt, dbl] = fields;
  assert.strictEqual(s.string, 'plain text');
  assert.strictEqual(m.string, undefined);
  assert.deepStrictEqual(m.message.map((x) => x.string ?? x.value), ['nested', '150']);
  assert.strictEqual(b.bytes, Buffer.from([0xff, 0xfe, 0x00, 0x13]).toString('base64'));
  assert.strictEqual(both.string, undefined);
  assert.ok(both.message);
  assert.strictEqual(neg.int64, '-1');
  assert.strictEqual(flt.float, 1.5);
  assert.strictEqual(dbl.double, -2);

  // 'J' = field 9 len, ' ' = length 32: printable text that is also a valid message.
  const ambiguous = `J ${'abcdefgh'.repeat(4)}`;
  const twoReadings = protobuf.decodeRaw(pb.len(1, ambiguous)).fields[0];
  assert.strictEqual(twoReadings.string, ambiguous);
  assert.strictEqual(twoReadings.message[0].no, 9);
  assert.strictEqual(twoReadings.message[0].string, 'abcdefgh'.repeat(4));

  const broken = protobuf.decodeRaw(Buffer.concat([pb.v(1, 1), Buffer.from([0x12, 0x10, 0x41])]));
  assert.strictEqual(broken.fields.length, 1);
  assert.strictEqual(broken.error.offset, 2);
  assert.strictEqual(broken.rest, Buffer.from([0x12, 0x10, 0x41]).toString('base64'));
});

const H = (ct, more = {}) => [['Content-Type', ct], ...Object.entries(more)];

test('gRPC framing with per-frame gzip, deflate and br compression', () => {
  const a = child('one');
  const b = child('two');
  const c = child('three');
  const d = child('four');
  const body = Buffer.concat([pb.envelope(0, a), pb.envelope(1, zlib.gzipSync(b))]);
  const split = frames.splitBody(body, H('application/grpc', { 'grpc-encoding': 'gzip' }));
  assert.strictEqual(split.protocol, 'grpc');
  assert.deepStrictEqual(split.frames.map((x) => [x.offset, x.compressed, x.payload.toString('hex')]), [
    [5, false, a.toString('hex')],
    [5 + a.length + 5, true, b.toString('hex')],
  ]);
  for (const [enc, fn] of [['deflate', zlib.deflateSync], ['br', zlib.brotliCompressSync]]) {
    const s = frames.splitBody(pb.envelope(1, fn(c)), H('application/grpc+proto', { 'grpc-encoding': enc }));
    assert.deepStrictEqual(s.frames[0].payload, c, enc);
  }
  if (typeof zlib.zstdCompressSync === 'function') {
    const s = frames.splitBody(pb.envelope(1, zlib.zstdCompressSync(d)), H('application/grpc', { 'grpc-encoding': 'zstd' }));
    assert.deepStrictEqual(s.frames[0].payload, d);
  }
  const web = frames.splitBody(Buffer.concat([pb.envelope(0, a), pb.envelope(0x80, Buffer.from('grpc-status: 0\r\ngrpc-message: ok\r\n'))]), H('application/grpc-web+proto'));
  assert.deepStrictEqual(web.frames[1].trailerHeaders, [['grpc-status', '0'], ['grpc-message', 'ok']]);
  const broken = frames.splitBody(pb.envelope(1, Buffer.from('not gzip')), H('application/grpc', { 'grpc-encoding': 'gzip' }));
  assert.ok(broken.frames[0].decompressError);
  assert.strictEqual(broken.frames[0].payload.toString(), 'not gzip');
  const unnegotiated = frames.splitBody(pb.envelope(1, zlib.gzipSync(a)), H('application/grpc'));
  assert.match(unnegotiated.frames[0].decompressError, /no encoding/);
});

test('Connect streaming: compressed frames and the end-stream trailer', () => {
  const msg = child('streamed');
  const end = Buffer.from(JSON.stringify({ error: { code: 'resource_exhausted', message: 'slow down' }, metadata: { 'x-id': ['1'] } }));
  const body = Buffer.concat([pb.envelope(1, zlib.gzipSync(msg)), pb.envelope(2, end)]);
  const split = frames.splitBody(body, H('application/connect+proto', { 'Connect-Content-Encoding': 'gzip' }));
  assert.strictEqual(split.protocol, 'connect-stream');
  assert.deepStrictEqual(split.frames[0].payload, msg);
  assert.strictEqual(split.frames[1].endStream, true);
  assert.strictEqual(split.frames[1].json.error.code, 'resource_exhausted');
});

test('Connect unary, JSON and raw bodies are single frames', () => {
  const msg = child('unary');
  const u = frames.splitBody(zlib.gzipSync(msg), H('application/proto', { 'content-encoding': 'gzip' }));
  assert.strictEqual(u.protocol, 'connect-unary');
  assert.deepStrictEqual(u.frames[0].payload, msg);
  const j = frames.splitBody(Buffer.from('{"code":"not_found"}'), H('application/json; charset=utf-8'));
  assert.deepStrictEqual(j.frames[0].json, { code: 'not_found' });
  const cj = frames.splitBody(pb.envelope(0, Buffer.from('{"a":1}')), H('application/connect+json'));
  assert.strictEqual(cj.codec, 'json');
  assert.strictEqual(cj.frames[0].payload.toString(), '{"a":1}');
  const r = frames.splitBody(Buffer.from('hi'), H('text/plain'));
  assert.strictEqual(r.protocol, 'raw');
  assert.strictEqual(r.frames[0].payload.toString(), 'hi');
  assert.deepStrictEqual(frames.splitBody(Buffer.alloc(0), H('application/proto')).frames, []);
});

test('truncated envelopes are reported and keep their bytes', () => {
  const full = pb.envelope(0, child('whole'));
  const cut = Buffer.concat([full, pb.envelope(0, child('partial message')).subarray(0, 9)]);
  const s = frames.splitBody(cut, H('application/grpc'));
  assert.strictEqual(s.truncated, true);
  assert.strictEqual(s.frames.length, 2);
  assert.match(s.frames[1].truncatedReason, /declares 17 bytes, 4 present/);
  assert.strictEqual(s.frames[1].payload.length, 4);
  const header = frames.splitBody(Buffer.concat([full, Buffer.from([0, 0, 1])]), H('application/grpc'));
  assert.match(header.frames[1].truncatedReason, /needs 5 bytes, 3 left/);
  assert.deepStrictEqual(header.frames[1].payload, Buffer.from([0, 0, 1]));
});

// ---------- flows on disk ----------

function writeFlow(root, day, name, meta, request, response) {
  const dir = path.join(root, day, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  if (request !== undefined) fs.writeFileSync(path.join(dir, 'request.bin.gz'), request.length ? zlib.gzipSync(request) : Buffer.alloc(0));
  if (response !== undefined) fs.writeFileSync(path.join(dir, 'response.bin.gz'), zlib.gzipSync(response));
  return dir;
}

function fixtureRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-wire-'));
  const req = pb.msg(pb.len(1, 'line one\nline two'), pb.v(4, 1), pb.v(77, 9));
  const resp = Buffer.concat([pb.envelope(0, child('reply')), pb.envelope(2, Buffer.from(JSON.stringify({ error: { code: 'internal', details: [{ type: 'test.Child', value: child('why').toString('base64').replace(/=+$/, '') }] } })))]);
  writeFlow(root, '2026-10-09', '235959-00001-old', { method: 'GET', url: 'https://x.test/', started: 100, status: 200, request_headers: [], response_headers: [['content-type', 'text/plain']] }, Buffer.alloc(0), Buffer.from('hello'));
  const run = writeFlow(root, '2026-10-10', '101500-00002-test.Svc_Run', {
    method: 'POST', url: 'https://api.test/test.Svc/Run', started: 200, status: 200,
    request_headers: [['content-type', 'application/connect+proto']],
    response_headers: [['content-type', 'application/connect+proto']],
    response_trailers: [['grpc-status', '0']],
  }, pb.envelope(0, req), resp);
  return { root, run, req };
}

test('listFlows reads metadata, sizes, RPC names and filters', () => {
  const { root, req } = fixtureRoot();
  const all = flows.listFlows({ root });
  assert.strictEqual(all.length, 2);
  const [old, run] = all;
  assert.strictEqual(old.service, undefined);
  assert.strictEqual(run.service, 'test.Svc');
  assert.strictEqual(run.rpc, 'Run');
  assert.strictEqual(run.grpcStatus, 0);
  assert.strictEqual(run.requestBytes, req.length + 5);
  assert.strictEqual(old.requestBytes, 0);
  assert.deepStrictEqual(flows.listFlows({ root, day: '2026-10-09' }).map((x) => x.id), ['235959-00001-old']);
  assert.deepStrictEqual(flows.listFlows({ root, grep: 'svc/run' }).map((x) => x.rpc), ['Run']);
  assert.deepStrictEqual(flows.listFlows({ root: path.join(root, 'missing') }), []);
  assert.deepStrictEqual(flows.rpcFromUrl('https://h/aiserver.v1.AiService/StreamChat?x=1'), { service: 'aiserver.v1.AiService', method: 'StreamChat' });
  assert.deepStrictEqual(flows.rpcFromUrl('https://h/auth/full_stripe_profile'), {});
});

test('decodeFlow uses the schema RPC types, or decodes schema-less', () => {
  const { run } = fixtureRoot();
  const d = flows.decodeFlow(run, schema);
  assert.deepStrictEqual(d.rpcTypes, { input: 'test.Req', output: 'test.Child', kind: 'server_streaming' });
  const msg = d.request.frames[0].message;
  assert.strictEqual(msg.text, 'line one\nline two');
  assert.strictEqual(msg.role, 'ROLE_USER');
  assert.strictEqual(msg._unknown[0].no, 77);
  assert.deepStrictEqual(d.response.frames[0].message, { name: 'reply' });
  assert.strictEqual(d.response.frames[1].endStream, true);
  assert.deepStrictEqual(d.response.frames[1].json.error.details[0].decoded, { name: 'why' });

  const text = renderFlow(d);
  assert.match(text, /test\.Req -> test\.Child {2}\(server_streaming\)/);
  assert.match(text, / {2}text: \| {2}\(2 lines\)\n {4}line one\n {4}line two\n/);
  assert.match(text, /role: "ROLE_USER"/);
  assert.match(text, /#77 varint 9/);
  assert.match(text, /END-STREAM/);

  assert.match(text, /decoded:\n {8}name: "why"/);

  const unaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-wire-'));
  const unary = writeFlow(unaryRoot, '2026-10-10', '101600-00003-test.Svc_Run', {
    method: 'POST', url: 'https://api.test/test.Svc/Run', started: 300, status: 400,
    request_headers: [['content-type', 'application/proto']],
    response_headers: [['content-type', 'application/json']],
  }, child('q'), Buffer.from(JSON.stringify({ code: 'invalid_argument', details: [{ type: 'test.Child', value: child('bad').toString('base64') }, { type: 'other.Type', value: 'AA' }] })));
  const ud = flows.decodeFlow(unary, schema).response.frames[0].json.details;
  assert.deepStrictEqual(ud[0].decoded, { name: 'bad' });
  assert.strictEqual(ud[1].decoded, undefined);

  const raw = flows.decodeFlow(run, null);
  assert.strictEqual(raw.request.frames[0].raw.fields[0].string, 'line one\nline two');
});

test('wire CLI: ls, show by index with --raw/--json/--clip', async () => {
  const { root } = fixtureRoot();
  const capture = async (argv) => {
    let s = '';
    const code = await cli.run([...argv, '--root', root], { write: (x) => { s += x; } });
    return { code, s };
  };
  const ls = await capture(['ls']);
  assert.strictEqual(ls.code, 0);
  assert.match(ls.s, /^ {3}0 .*https:\/\/x\.test\/\n {3}1 .*test\.Svc\/Run\n$/);
  const show = await capture(['show', '1', '--raw', '--clip', '4']);
  assert.match(show.s, /^schema-less \(--raw\)/);
  assert.match(show.s, /#1 len\(17\) "line… \(\+13 chars\)"/);
  assert.match(ls.s, / 101500-00002 /);
  const schemaFile = path.join(root, 'schema.json');
  fs.writeFileSync(schemaFile, JSON.stringify(schema));
  const json = JSON.parse((await capture(['show', '101500-00002-test.Svc_Run', '--json', '--schema', schemaFile])).s);
  assert.strictEqual(json.rpc, 'Run');
  assert.strictEqual(json.schema, 'schema from Cursor test: 2 messages, 1 enums, 1 services');
  assert.strictEqual(json.request.frames[0].message.role, 'ROLE_USER');
  const short = await capture(['show', '101500-00002', '--schema', schemaFile]);
  assert.match(short.s, /role: "ROLE_USER"/);
  const noSchema = await capture(['show', '2026-10-10/101500-00002-test.Svc_Run/', '--schema', path.join(root, 'missing.json')]);
  assert.match(noSchema.s, /^schema-less \(no schema: ENOENT/);
  await assert.rejects(capture(['show', '-0000']), /matches 2 flows/);
  await assert.rejects(capture(['show', '9']), /no flow #9/);
});

test('a text/event-stream body made of Connect envelopes splits as connect-stream; SSE text stays raw', () => {
  const headers = [['content-type', 'text/event-stream'], ['connect-content-encoding', 'gzip']];
  const msg = pb.msg(pb.len(1, 'hi'));
  const body = Buffer.concat([pb.envelope(0, Buffer.from([0x0a, 0x00])), pb.envelope(1, zlib.gzipSync(msg)), pb.envelope(2, Buffer.from('{}'))]);
  const split = frames.splitBody(body, headers);
  assert.strictEqual(split.protocol, 'connect-stream');
  assert.strictEqual(split.declaredContentType, 'text/event-stream');
  assert.deepStrictEqual(split.frames.map((f) => [f.compressed, !!f.endStream]), [[false, false], [true, false], [false, true]]);
  assert.ok(split.frames[1].payload.equals(msg));
  const sse = frames.splitBody(Buffer.from('data: {"a":1}\n\n'), headers);
  assert.strictEqual(sse.protocol, 'raw');
});

test('a text/event-stream envelope body cut anywhere after its first header splits as a truncated connect-stream', () => {
  const headers = [['content-type', 'text/event-stream'], ['connect-content-encoding', 'gzip']];
  const envelopes = [pb.envelope(0, pb.msg(pb.len(1, 'a'))), pb.envelope(1, zlib.gzipSync(pb.msg(pb.len(1, 'b')))), pb.envelope(2, Buffer.from('{}'))];
  const body = Buffer.concat(envelopes);
  const boundaries = new Set(envelopes.map((_, i) => Buffer.concat(envelopes.slice(0, i + 1)).length));
  for (let n = 5; n < body.length; n++) {
    const split = frames.splitBody(body.subarray(0, n), headers);
    assert.strictEqual(split.protocol, 'connect-stream', `cut at ${n}`);
    assert.strictEqual(split.truncated, !boundaries.has(n), `cut at ${n}`);
  }
  for (let n = 1; n < 5; n++) assert.strictEqual(frames.splitBody(body.subarray(0, n), headers).protocol, 'raw');
});

test('real SSE text stays raw, also behind a gzip content-encoding', () => {
  const sse = ['data: {"a":1}\n\n', ': keep-alive\n\n', 'event: done\r\ndata: x\r\n\r\n', 'id: 1\nretry: 10\n\n'];
  for (const text of sse) {
    assert.strictEqual(frames.splitBody(Buffer.from(text), [['content-type', 'text/event-stream; charset=utf-8']]).protocol, 'raw', text);
    const gz = frames.splitBody(zlib.gzipSync(text), [['content-type', 'text/event-stream'], ['content-encoding', 'gzip']]);
    assert.strictEqual(gz.protocol, 'raw', text);
    assert.strictEqual(gz.frames[0].payload.toString(), text);
  }
  // Envelopes behind a whole-body gzip are still recognised.
  const env = Buffer.concat([pb.envelope(0, pb.msg(pb.len(1, 'a'))), pb.envelope(2, Buffer.from('{}'))]);
  const split = frames.splitBody(zlib.gzipSync(env), [['content-type', 'text/event-stream'], ['content-encoding', 'gzip']]);
  assert.strictEqual(split.protocol, 'connect-stream');
  assert.strictEqual(split.frames.length, 2);
});

test('the compressed flag of an event-stream envelope follows connect-content-encoding', () => {
  const msg = pb.msg(pb.len(1, 'hi'));
  const plain = frames.splitBody(pb.envelope(1, zlib.gzipSync(msg)), [['content-type', 'text/event-stream'], ['connect-content-encoding', 'gzip']]);
  assert.ok(plain.frames[0].payload.equals(msg));
  const none = frames.splitBody(pb.envelope(1, zlib.gzipSync(msg)), [['content-type', 'text/event-stream']]);
  assert.strictEqual(none.protocol, 'connect-stream');
  assert.match(none.frames[0].decompressError, /no encoding was negotiated/);
  const br = frames.splitBody(pb.envelope(1, zlib.brotliCompressSync(msg)), [['content-type', 'text/event-stream'], ['connect-content-encoding', 'br']]);
  assert.ok(br.frames[0].payload.equals(msg));
});
