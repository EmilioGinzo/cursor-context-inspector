'use strict';

// Runs tools/cursor-wire.py inside a real mitmdump, in front of a local HTTPS HTTP/2
// server that behaves like a Cursor agent RPC: a bidirectional stream with trailers.
// Skipped when mitmdump or openssl is not installed.

const test = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const http2 = require('node:http2');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const zlib = require('node:zlib');

const ADDON = path.join(__dirname, '..', 'tools', 'cursor-wire.py');

function which(name, extra = []) {
  const dirs = [...(process.env.PATH || '').split(path.delimiter), ...extra];
  return dirs.map((d) => path.join(d, name)).find((p) => fs.existsSync(p));
}
const mitmdump = which('mitmdump', [path.join(os.homedir(), '.local', 'bin')]);
const openssl = which('openssl');
const skip = !mitmdump ? 'mitmdump not installed' : !openssl ? 'openssl not installed' : false;

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

async function waitFor(check, ms = 20000, what = 'condition') {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const listening = (port) => new Promise((resolve) => {
  const s = net.connect(port, '127.0.0.1', () => { s.destroy(); resolve(true); }).on('error', () => resolve(false));
});

const invert = (b) => Buffer.from(b.map((x) => x ^ 0xff));

// A server that answers every request chunk (inverted) as soon as it arrives, then ends with gRPC trailers.
function startServer(tmp) {
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-keyout', path.join(tmp, 'key.pem'), '-out', path.join(tmp, 'cert.pem')], { stdio: 'ignore' });
  const server = http2.createSecureServer({
    key: fs.readFileSync(path.join(tmp, 'key.pem')), cert: fs.readFileSync(path.join(tmp, 'cert.pem')),
  });
  server.on('stream', (stream) => {
    stream.respond({ ':status': 200, 'content-type': 'application/grpc', 'set-cookie': 'sid=server-secret' },
      { waitForTrailers: true });
    stream.on('data', (chunk) => stream.write(invert(chunk)));
    stream.on('end', () => stream.end());
    stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0', 'grpc-message': 'ok' }));
    stream.on('error', () => {});
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// An HTTP/2 session to the server, tunnelled through the proxy with CONNECT.
function connectThroughProxy(proxyPort, serverPort, ca) {
  return new Promise((resolve, reject) => {
    http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: `localhost:${serverPort}` })
      .on('connect', (res, socket) => {
        if (res.statusCode !== 200) return reject(new Error(`CONNECT ${res.statusCode}`));
        const session = http2.connect(`https://localhost:${serverPort}`, {
          createConnection: () => tls.connect({ socket, servername: 'localhost', ALPNProtocols: ['h2'], ca }),
        });
        session.on('error', () => {});
        resolve(session);
      })
      .on('error', reject)
      .end();
  });
}

const gunzip = (file) => zlib.gunzipSync(fs.readFileSync(file)); // throws if the gzip file was never closed

test('cursor-wire records a bidirectional HTTP/2 stream byte-exact and redacts secrets', { skip, timeout: 60000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-wire-test-'));
  const wireDir = path.join(tmp, 'wire');
  const server = await startServer(tmp);
  const port = await freePort();
  const proxy = spawn(mitmdump, ['-q', '--listen-host', '127.0.0.1', '-p', String(port), '-s', ADDON,
    '--set', `wire_dir=${wireDir}`, '--set', `confdir=${path.join(tmp, 'mitm')}`, '--set', 'ssl_insecure=true'],
  { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proxy.stderr.on('data', (d) => { stderr += d; });
  t.after(() => { proxy.kill(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  await waitFor(() => listening(port), 20000, `mitmdump to listen (${stderr})`);
  const ca = fs.readFileSync(path.join(tmp, 'mitm', 'mitmproxy-ca-cert.pem'));
  const session = await connectThroughProxy(port, server.address().port, ca);
  t.after(() => session.destroy());

  // Each chunk is only sent after the previous echo came back: a proxy that buffered
  // either direction would hang here.
  const chunks = [Buffer.from([0, 0, 0, 0, 3, 1, 2, 3]), Buffer.alloc(70000, 0xab), Buffer.from('last frame é')];
  const req = session.request({
    ':method': 'POST', ':path': '/aiserver.v1.AgentService/Run?x=1&access_token=query-secret', 'content-type': 'application/grpc',
    authorization: 'Bearer client-secret', cookie: 'a=cookie-secret', 'x-session-id': 'keep-me',
  });
  let received = Buffer.alloc(0);
  let trailers;
  req.on('data', (d) => { received = Buffer.concat([received, d]); });
  req.on('trailers', (h) => { trailers = h; });
  const ended = new Promise((resolve) => req.on('end', resolve));
  let expected = Buffer.alloc(0);
  for (const c of chunks) {
    expected = Buffer.concat([expected, invert(c)]);
    req.write(c);
    await waitFor(() => received.length >= expected.length, 10000, 'the echo of a streamed chunk');
  }
  req.end();
  await ended;
  assert.deepStrictEqual(received, expected);
  assert.strictEqual(trailers['grpc-status'], '0');

  const day = await waitFor(() => fs.existsSync(wireDir) && fs.readdirSync(wireDir)[0], 5000, 'the day folder');
  const index = path.join(wireDir, day, 'flows.jsonl');
  const line = await waitFor(() => fs.existsSync(index) && fs.readFileSync(index, 'utf8').trim(), 5000, 'flows.jsonl');
  const entry = JSON.parse(line);
  assert.strictEqual(entry.method, 'POST');
  assert.strictEqual(entry.status, 200);
  assert.match(entry.url, /\/aiserver\.v1\.AgentService\/Run\?x=1&access_token=\[redacted\]$/);
  assert.strictEqual(entry.request_bytes, Buffer.concat(chunks).length);
  assert.strictEqual(entry.response_bytes, expected.length);

  const flowDir = path.join(wireDir, day, entry.dir);
  assert.deepStrictEqual(gunzip(path.join(flowDir, 'request.bin.gz')), Buffer.concat(chunks));
  assert.deepStrictEqual(gunzip(path.join(flowDir, 'response.bin.gz')), expected);

  const metaText = fs.readFileSync(path.join(flowDir, 'meta.json'), 'utf8');
  const meta = JSON.parse(metaText);
  assert.strictEqual(meta.complete, true);
  assert.strictEqual(meta.http_version, 'HTTP/2.0');
  const header = (list, name) => list.find(([k]) => k.toLowerCase() === name)?.[1];
  assert.strictEqual(header(meta.request_headers, 'authorization'), '[redacted]');
  assert.strictEqual(header(meta.request_headers, 'cookie'), '[redacted]');
  assert.strictEqual(header(meta.request_headers, 'x-session-id'), 'keep-me');
  assert.strictEqual(header(meta.response_headers, 'set-cookie'), '[redacted]');
  assert.strictEqual(header(meta.response_trailers, 'grpc-status'), '0');
  for (const secret of ['client-secret', 'cookie-secret', 'server-secret', 'query-secret']) {
    assert.ok(!metaText.includes(secret), `${secret} leaked into meta.json`);
    assert.ok(!line.includes(secret), `${secret} leaked into flows.jsonl`);
  }
});

test('cursor-wire closes and indexes a stream the client abandons', { skip, timeout: 60000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-wire-test-'));
  const wireDir = path.join(tmp, 'wire');
  const server = await startServer(tmp);
  const port = await freePort();
  const proxy = spawn(mitmdump, ['-q', '--listen-host', '127.0.0.1', '-p', String(port), '-s', ADDON,
    '--set', `wire_dir=${wireDir}`, '--set', `confdir=${path.join(tmp, 'mitm')}`, '--set', 'ssl_insecure=true'],
  { stdio: 'ignore' });
  t.after(() => { proxy.kill(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  await waitFor(() => listening(port), 20000, 'mitmdump to listen');
  const ca = fs.readFileSync(path.join(tmp, 'mitm', 'mitmproxy-ca-cert.pem'));
  const session = await connectThroughProxy(port, server.address().port, ca);
  const req = session.request({ ':method': 'POST', ':path': '/abandoned', 'content-type': 'application/grpc' });
  req.on('error', () => {});
  let received = 0;
  req.on('data', (d) => { received += d.length; });
  req.write(Buffer.from('half a conversation'));
  await waitFor(() => received > 0, 10000, 'the first echo');
  session.destroy(); // the client goes away mid-stream

  const day = await waitFor(() => fs.existsSync(wireDir) && fs.readdirSync(wireDir)[0], 5000, 'the day folder');
  const index = path.join(wireDir, day, 'flows.jsonl');
  const entry = JSON.parse(await waitFor(() => fs.existsSync(index) && fs.readFileSync(index, 'utf8').trim(), 10000, 'flows.jsonl'));
  assert.ok(entry.error, 'the abandoned flow is indexed with its error');
  const flowDir = path.join(wireDir, day, entry.dir);
  assert.deepStrictEqual(gunzip(path.join(flowDir, 'request.bin.gz')), Buffer.from('half a conversation'));
  assert.deepStrictEqual(gunzip(path.join(flowDir, 'response.bin.gz')), invert(Buffer.from('half a conversation')));
  const meta = JSON.parse(fs.readFileSync(path.join(flowDir, 'meta.json'), 'utf8'));
  assert.strictEqual(meta.complete, true);
  assert.ok(meta.error);
});

test('cursor-wire finalizes a stream the server ends first, and keeps what the client sends after', { skip, timeout: 60000 }, async (t) => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-wire-test-'));
  const wireDir = path.join(tmp, 'wire');
  const server = await startServer(tmp);
  server.removeAllListeners('stream');
  server.on('stream', (stream) => { // answers the first chunk with its status, like an RPC that fails early
    stream.on('error', () => {});
    stream.on('data', () => {});
    stream.respond({ ':status': 200, 'content-type': 'application/grpc' }, { waitForTrailers: true });
    stream.once('data', () => stream.end('early'));
    stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '9' }));
  });
  const port = await freePort();
  const proxy = spawn(mitmdump, ['-q', '--listen-host', '127.0.0.1', '-p', String(port), '-s', ADDON,
    '--set', `wire_dir=${wireDir}`, '--set', `confdir=${path.join(tmp, 'mitm')}`, '--set', 'ssl_insecure=true'],
  { stdio: 'ignore' });
  t.after(() => { proxy.kill(); server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  await waitFor(() => listening(port), 20000, 'mitmdump to listen');
  const ca = fs.readFileSync(path.join(tmp, 'mitm', 'mitmproxy-ca-cert.pem'));
  const session = await connectThroughProxy(port, server.address().port, ca);
  t.after(() => session.destroy());
  const req = session.request({ ':method': 'POST', ':path': '/early', 'content-type': 'application/grpc' });
  req.on('error', () => {});
  req.on('data', () => {});
  const trailers = new Promise((resolve) => req.on('trailers', resolve));
  req.write(Buffer.from('first'));
  assert.strictEqual((await trailers)['grpc-status'], '9');

  // The client connection stays open, yet the flow is already indexed and final.
  const day = await waitFor(() => fs.existsSync(wireDir) && fs.readdirSync(wireDir)[0], 5000, 'the day folder');
  const index = path.join(wireDir, day, 'flows.jsonl');
  const entry = JSON.parse(await waitFor(() => fs.existsSync(index) && fs.readFileSync(index, 'utf8').trim(), 5000, 'flows.jsonl'));
  const flowDir = path.join(wireDir, day, entry.dir);
  const meta = () => JSON.parse(fs.readFileSync(path.join(flowDir, 'meta.json'), 'utf8'));
  assert.strictEqual(meta().complete, true);
  assert.deepStrictEqual(gunzip(path.join(flowDir, 'response.bin.gz')), Buffer.from('early'));

  req.end(Buffer.from(' and late'));
  await waitFor(() => meta().request_ended, 5000, 'the late end of the request');
  assert.deepStrictEqual(gunzip(path.join(flowDir, 'request.bin.gz')), Buffer.from('first and late'));
  assert.strictEqual(meta().request_bytes, 'first and late'.length);
});

// The script runs with its own HOME and CURSOR_WIRE_DIR, and CURSOR_BIN=/bin/echo, so it
// never touches a real proxy, CA store or Cursor.
const SCRIPT = path.join(__dirname, '..', 'tools', 'cursor-wire');
const ss = which('ss');

test('cursor-wire launch only uses the proxy start recorded, or an explicit one it verified', {
  skip: skip || (!ss && 'ss not installed'), timeout: 60000,
}, async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-wire-test-'));
  const fakeCursor = path.join(home, 'fake-cursor'); // prints what Cursor would get
  fs.writeFileSync(fakeCursor, '#!/bin/sh\necho "proxy=$HTTPS_PROXY,$http_proxy env_proxy=$NODE_USE_ENV_PROXY ' +
    'no_proxy=$NO_PROXY ca=$NODE_EXTRA_CA_CERTS ssl=$SSL_CERT_FILE" "$@"\n', { mode: 0o755 });
  const env = {
    ...process.env, HOME: home, CURSOR_WIRE_DIR: path.join(home, 'wire'), CURSOR_BIN: fakeCursor,
    PATH: `${path.dirname(mitmdump)}${path.delimiter}${process.env.PATH}`,
  };
  const run = (...args) => {
    try {
      return { ok: true, out: execFileSync(SCRIPT, args, { env, encoding: 'utf8', stdio: 'pipe' }) };
    } catch (e) {
      return { ok: false, out: `${e.stdout}${e.stderr}` };
    }
  };
  const other = net.createServer().listen(0, '127.0.0.1'); // a listener that is not our proxy
  await new Promise((r) => other.on('listening', r));
  t.after(() => {
    run('stop');
    other.close();
    fs.rmSync(home, { recursive: true, force: true });
  });

  let r = run('launch');
  assert.ok(!r.ok && /no proxy recorded/.test(r.out), r.out);

  const port = await freePort();
  r = run('start', '--port', String(port));
  assert.ok(r.ok, r.out);
  r = run('start', '--port', String(await freePort()));
  assert.ok(!r.ok && /already running/.test(r.out), r.out);

  const proxy = `http://127.0.0.1:${port}`;
  r = run('launch', '--new-window');
  assert.ok(r.ok, r.out);
  assert.ok(r.out.includes(`--proxy-server=${proxy} --new-window`), r.out);
  // Cursor's Node children (the agent worker) ignore --proxy-server and need the environment.
  assert.ok(r.out.includes(`proxy=${proxy},${proxy} env_proxy=1 no_proxy=localhost,127.0.0.1,::1 ` +
    `ca=${path.join(home, '.mitmproxy', 'mitmproxy-ca-cert.pem')}`), r.out);
  // Cursor's MCP process ignores NODE_EXTRA_CA_CERTS; it trusts the system store, which follows SSL_CERT_FILE.
  const bundle = path.join(home, 'wire', 'ca-bundle.pem');
  assert.ok(r.out.includes(`ssl=${bundle} `), r.out);
  const pem = fs.readFileSync(bundle, 'utf8');
  const mitmCa = fs.readFileSync(path.join(home, '.mitmproxy', 'mitmproxy-ca-cert.pem'), 'utf8').trim();
  assert.ok(pem.trim().endsWith(mitmCa), 'the bundle ends with mitmproxy\'s CA');
  assert.ok(pem.split('BEGIN CERTIFICATE').length > 2, 'the bundle keeps the system certificates');
  r = run('env');
  for (const v of [`HTTPS_PROXY=${proxy}`, 'NODE_USE_ENV_PROXY=1', `--proxy-server=${proxy}`]) assert.ok(r.out.includes(v), r.out);

  // check finds an agent worker and its connection through the proxy, without printing its command line.
  const agent = spawn(process.execPath, ['-e', `require('net').connect(${port}, '127.0.0.1'); setInterval(() => {}, 1000)`,
    'worker', '--api-key=agent-secret'], { argv0: 'cursor-agent', stdio: 'ignore' });
  t.after(() => agent.kill());
  await waitFor(() => run('check').out.includes(`pid ${agent.pid} `), 10000, 'check to see the agent');
  r = run('check');
  assert.match(r.out, new RegExp(`pid ${agent.pid} node \\(cursor-agent\\): ok, 1 connection\\(s\\) via 127\\.0\\.0\\.1:${port}`));
  assert.ok(!r.out.includes('agent-secret') && !r.out.includes('worker'), r.out);

  const otherPort = String(other.address().port);
  r = run('launch', '--port', otherPort);
  assert.ok(!r.ok && /not a mitmdump running cursor-wire\.py/.test(r.out), r.out);
  r = run('launch', '--port', otherPort, '--any-proxy');
  assert.ok(r.ok && r.out.includes(`127.0.0.1:${otherPort}`), r.out);
  r = run('launch', '--port', String(await freePort()));
  assert.ok(!r.ok && /no proxy listening/.test(r.out), r.out);

  assert.match(run('status').out, new RegExp(`running: pid \\d+ on 127\\.0\\.0\\.1:${port}`));
  r = run('stop');
  assert.ok(r.ok && /stopped/.test(r.out), r.out);
  assert.strictEqual(await listening(port), false);
  r = run('launch');
  assert.ok(!r.ok && /no proxy recorded/.test(r.out), r.out);
});
