'use strict';

// Captured flows on disk, as written by the capture proxy:
//   <root>/<YYYY-MM-DD>/<HHMMSS>-<n>-<path>/{meta.json, request.bin.gz, response.bin.gz}
// listFlows() reads only meta.json and the gzip size trailers; decodeFlow() reads the bodies,
// splits them into frames and decodes each frame (with the schema's RPC types when known).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const frames = require('./frames.cjs');
const protobuf = require('../protobuf.cjs');

function defaultRoot() {
  return process.env.CURSOR_WIRE_DIR || path.join(os.homedir(), '.cursor-wire');
}

// "/pkg.Svc/Method" (package required) -> { service, method }; anything else -> {}.
function rpcFromUrl(url) {
  let p;
  try { p = new URL(url).pathname; } catch { p = String(url || ''); }
  const m = /^\/([A-Za-z_][\w.]*\.[A-Za-z_]\w*)\/([A-Za-z_]\w*)\/?$/.exec(p);
  return m ? { service: m[1], method: m[2] } : {};
}

// Uncompressed size from the gzip ISIZE trailer (exact below 4 GiB); 0 if missing/empty.
function gzSize(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const { size } = fs.fstatSync(fd);
    if (size < 18) return 0;
    const b = Buffer.alloc(4);
    fs.readSync(fd, b, 0, 4, size - 4);
    return b.readUInt32LE(0);
  } catch {
    return 0;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function readBody(file) {
  let gz;
  try { gz = fs.readFileSync(file); } catch { return null; }
  if (!gz.length) return Buffer.alloc(0);
  // Z_SYNC_FLUSH: a recording cut short still yields what inflates.
  return zlib.gunzipSync(gz, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
}

function grpcStatus(meta) {
  const h = (list) => frames.header(list, 'grpc-status');
  const s = h(meta.response_trailers) ?? h(meta.response_headers);
  return s === undefined ? undefined : Number(s);
}

function flowSummary(dir, meta) {
  const { service, method } = rpcFromUrl(meta.url);
  return {
    dir,
    id: path.basename(dir),
    day: path.basename(path.dirname(dir)),
    started: meta.started,
    ended: meta.ended,
    method: meta.method,
    url: meta.url,
    service,
    rpc: method,
    status: meta.status,
    grpcStatus: grpcStatus(meta),
    requestType: frames.header(meta.request_headers, 'content-type'),
    responseType: frames.header(meta.response_headers, 'content-type'),
    requestBytes: gzSize(path.join(dir, 'request.bin.gz')),
    responseBytes: gzSize(path.join(dir, 'response.bin.gz')),
    error: meta.error,
  };
}

function readMeta(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
}

// All flows under `root`, oldest first. `day` limits to one day directory; `grep` keeps flows whose
// url, service, method or directory name contain it (case-insensitive).
function listFlows({ root = defaultRoot(), day, grep } = {}) {
  let days;
  try {
    days = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory() && /^\d{4}-\d{2}-\d{2}$/.test(d.name)).map((d) => d.name).sort();
  } catch {
    return [];
  }
  if (day) days = days.filter((d) => d === day);
  const needle = grep ? grep.toLowerCase() : null;
  const out = [];
  for (const d of days) {
    const dayDir = path.join(root, d);
    for (const ent of fs.readdirSync(dayDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort()) {
      const dir = path.join(dayDir, ent);
      let meta;
      try { meta = readMeta(dir); } catch { continue; } // still being written
      const f = flowSummary(dir, meta);
      if (needle && ![f.url, f.service, f.rpc, f.id].some((s) => s && s.toLowerCase().includes(needle))) continue;
      out.push(f);
    }
  }
  out.sort((a, b) => (a.started ?? 0) - (b.started ?? 0) || a.dir.localeCompare(b.dir));
  return out;
}

// Connect errors (a unary JSON body, or the end-stream frame's `error`) carry
// details: [{ type, value: base64 protobuf, debug? }]. Add `decoded` to each whose type the schema knows.
function decodeErrorDetails(json, schema) {
  const err = json && typeof json === 'object' && (json.error || json);
  if (!schema || !err || !Array.isArray(err.details)) return;
  for (const d of err.details) {
    if (d && typeof d.type === 'string' && typeof d.value === 'string' && schema.messages && schema.messages[d.type]) {
      d.decoded = protobuf.decodeMessage(schema, d.type, Buffer.from(d.value, 'base64'));
    }
  }
}

function decodeFrame(frame, codec, schema, typeName) {
  const out = {
    offset: frame.offset,
    length: frame.length ?? frame.payload.length,
    size: frame.payload.length,
  };
  for (const k of ['flags', 'compressed', 'encoding', 'decompressError', 'truncated', 'truncatedReason', 'endStream', 'trailers', 'trailerHeaders', 'json', 'jsonError']) {
    if (frame[k] !== undefined && frame[k] !== false) out[k] = frame[k];
  }
  if (out.json !== undefined) decodeErrorDetails(out.json, schema);
  if (frame.endStream || frame.trailers || frame.decompressError || out.json !== undefined || out.jsonError) {
    if (out.jsonError || frame.decompressError) out.bytes = frame.payload.toString('base64');
    return out;
  }
  if (codec === 'proto') {
    if (schema && typeName) {
      out.type = typeName;
      out.message = protobuf.decodeMessage(schema, typeName, frame.payload);
    } else {
      out.raw = protobuf.decodeRaw(frame.payload);
    }
  } else {
    const s = frame.payload.toString('utf8');
    if (Buffer.from(s, 'utf8').equals(frame.payload)) out.text = s;
    else out.bytes = frame.payload.toString('base64');
  }
  return out;
}

function resolveRpc(schema, service, method) {
  const svc = schema && schema.services && service && schema.services[service];
  const m = svc && svc.methods && svc.methods[method];
  return m ? { input: m.I, output: m.O, kind: m.kind } : undefined;
}

// Decode one flow directory. `schema` may be null (schema-less decoding).
function decodeFlow(dir, schema = null) {
  const meta = readMeta(dir);
  const summary = flowSummary(dir, meta);
  const rpc = resolveRpc(schema, summary.service, summary.rpc);
  const side = (name, headers, typeName) => {
    let body;
    let readError;
    try {
      body = readBody(path.join(dir, `${name}.bin.gz`));
    } catch (e) {
      readError = e.message;
      body = null;
    }
    if (body === null) return { missing: !readError, readError };
    const split = frames.splitBody(body, headers);
    const { frames: list, ...rest } = split;
    return { ...rest, frames: list.map((f) => decodeFrame(f, split.codec, schema, typeName)) };
  };
  return {
    ...summary,
    meta,
    rpcTypes: rpc,
    request: side('request', meta.request_headers, rpc && rpc.input),
    response: side('response', meta.response_headers, rpc && rpc.output),
  };
}

module.exports = { defaultRoot, rpcFromUrl, listFlows, decodeFlow, resolveRpc, readBody };
