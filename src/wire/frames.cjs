'use strict';

// Split a captured HTTP body into the messages it carries, by content type:
//   application/grpc[+proto]        5-byte envelopes (flag, uint32 BE length); flag bit0 = compressed (grpc-encoding)
//   application/grpc-web[+proto]    same, flag bit7 = trailers frame (HTTP/1-style "k: v" lines)
//   application/connect+proto|json  same envelope; bit0 = compressed (connect-content-encoding),
//                                   bit1 = end-stream, whose payload is JSON {error?, metadata?}
//   text/event-stream               Connect envelopes when the body walks as them (Cursor's RunSSE),
//                                   otherwise raw SSE text
//   application/proto|json          Connect unary: the whole body is one message (content-encoding)
//   anything else                   one raw frame
// Every frame keeps its byte offset in the body. A truncated tail becomes a final frame
// marked `truncated` holding whatever bytes are there; nothing is thrown away.

const zlib = require('node:zlib');

function header(headers, name) {
  const want = name.toLowerCase();
  for (const [k, v] of headers || []) if (String(k).toLowerCase() === want) return String(v);
  return undefined;
}

function classify(contentType) {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (ct === 'application/grpc' || ct === 'application/grpc+proto') return { protocol: 'grpc', codec: 'proto' };
  if (ct === 'application/grpc+json') return { protocol: 'grpc', codec: 'json' };
  if (ct === 'application/grpc-web' || ct === 'application/grpc-web+proto') return { protocol: 'grpc-web', codec: 'proto' };
  if (ct === 'application/grpc-web+json') return { protocol: 'grpc-web', codec: 'json' };
  if (ct === 'application/connect+proto') return { protocol: 'connect-stream', codec: 'proto' };
  if (ct === 'application/connect+json') return { protocol: 'connect-stream', codec: 'json' };
  if (ct === 'application/proto' || ct === 'application/x-protobuf' || ct === 'application/protobuf') return { protocol: 'connect-unary', codec: 'proto' };
  if (ct === 'application/json' || ct.endsWith('+json')) return { protocol: 'unary', codec: 'json' };
  return { protocol: 'raw', codec: 'raw', contentType: ct };
}

// Returns the decompressed buffer, or throws with a readable message.
function decompress(buf, encoding) {
  const enc = String(encoding || 'identity').trim().toLowerCase();
  if (enc === '' || enc === 'identity') return buf;
  if (enc === 'gzip' || enc === 'x-gzip') return zlib.gunzipSync(buf);
  if (enc === 'deflate') {
    try { return zlib.inflateSync(buf); } catch { return zlib.inflateRawSync(buf); }
  }
  if (enc === 'br') return zlib.brotliDecompressSync(buf);
  if (enc === 'zstd') {
    if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('zstd is not supported by this node');
    return zlib.zstdDecompressSync(buf);
  }
  throw new Error(`unknown encoding "${enc}"`);
}

// Attach `payload` (decoded bytes) to a frame, keeping `compressedPayload` and an error if that fails.
function inflateFrame(frame, raw, encoding) {
  if (!frame.compressed) {
    frame.payload = raw;
    return frame;
  }
  frame.encoding = encoding || 'identity';
  try {
    if (frame.encoding.toLowerCase() === 'identity') throw new Error('compressed flag set, but no encoding was negotiated');
    frame.payload = decompress(raw, encoding);
  } catch (e) {
    frame.payload = raw;
    frame.decompressError = e.message;
  }
  return frame;
}

function parseJson(buf) {
  try {
    return { json: JSON.parse(buf.toString('utf8')) };
  } catch (e) {
    return { jsonError: e.message };
  }
}

function parseGrpcWebTrailers(buf) {
  const out = [];
  for (const line of buf.toString('utf8').split(/\r?\n/)) {
    if (!line) continue;
    const i = line.indexOf(':');
    out.push(i === -1 ? [line, ''] : [line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  return out;
}

function splitEnvelopes(body, protocol, encoding) {
  const frames = [];
  let pos = 0;
  while (pos < body.length) {
    const offset = pos;
    if (body.length - pos < 5) {
      frames.push({ offset, headerOffset: offset, truncated: true, truncatedReason: `envelope header needs 5 bytes, ${body.length - pos} left`, payload: body.subarray(pos) });
      pos = body.length;
      break;
    }
    const flags = body[pos];
    const length = body.readUInt32BE(pos + 1);
    const start = pos + 5;
    const end = Math.min(start + length, body.length);
    const raw = body.subarray(start, end);
    const frame = { offset: start, headerOffset: offset, flags, length, compressed: (flags & 1) === 1 };
    if (protocol === 'connect-stream' && flags & 2) frame.endStream = true;
    if (protocol === 'grpc-web' && flags & 0x80) frame.trailers = true;
    if (end - start < length) {
      frame.truncated = true;
      frame.truncatedReason = `payload declares ${length} bytes, ${end - start} present`;
    }
    inflateFrame(frame, raw, encoding);
    if (frame.endStream && !frame.decompressError) Object.assign(frame, parseJson(frame.payload));
    if (frame.trailers && !frame.decompressError) frame.trailerHeaders = parseGrpcWebTrailers(frame.payload);
    frames.push(frame);
    pos = end;
  }
  return frames;
}

// Whether `body` walks as a chain of Connect envelopes: flags 0-3 at every envelope start. The
// stream may be cut anywhere after the first header (inside a payload or a later header); the
// split then reports it as truncated. SSE text never starts with a byte below 4.
function looksEnveloped(body) {
  if (body.length < 5) return false;
  for (let pos = 0; pos + 5 <= body.length; pos += 5 + body.readUInt32BE(pos + 1)) {
    if (body[pos] > 3) return false;
  }
  return true;
}

// The body with its whole-body content-encoding undone, for sniffing; empty if that fails.
function unwrapped(body, headers) {
  const outer = header(headers, 'content-encoding');
  if (!outer || outer.toLowerCase() === 'identity') return body;
  try { return decompress(body, outer); } catch { return Buffer.alloc(0); }
}

// headers: [[name, value], ...] of the side the body belongs to (request or response).
function splitBody(body, headers) {
  body = body || Buffer.alloc(0);
  let type = classify(header(headers, 'content-type'));
  // Cursor's RunSSE answers with content-type text/event-stream, but the body is Connect
  // streaming envelopes (compressed per connect-content-encoding). Real SSE text stays raw.
  if (type.contentType === 'text/event-stream' && looksEnveloped(unwrapped(body, headers))) type = { protocol: 'connect-stream', codec: 'proto', declaredContentType: type.contentType };
  const result = { ...type, size: body.length, frames: [] };
  if (!body.length) return result;

  if (type.protocol === 'grpc' || type.protocol === 'grpc-web' || type.protocol === 'connect-stream') {
    const encoding = type.protocol === 'connect-stream'
      ? header(headers, 'connect-content-encoding')
      : header(headers, 'grpc-encoding');
    result.encoding = encoding || 'identity';
    // A whole-body content-encoding on a streaming RPC is unusual; undo it first if present.
    let inner = body;
    const outer = header(headers, 'content-encoding');
    if (outer && outer.toLowerCase() !== 'identity') {
      try { inner = decompress(body, outer); result.contentEncoding = outer; } catch (e) { result.contentEncodingError = e.message; }
    }
    result.frames = splitEnvelopes(inner, type.protocol, encoding);
    result.truncated = result.frames.some((f) => f.truncated);
    return result;
  }

  const encoding = header(headers, 'content-encoding');
  const frame = { offset: 0, length: body.length, compressed: !!encoding && encoding.toLowerCase() !== 'identity' };
  inflateFrame(frame, body, encoding);
  if (type.codec === 'json' && !frame.decompressError) Object.assign(frame, parseJson(frame.payload));
  result.encoding = encoding || 'identity';
  result.frames = [frame];
  return result;
}

module.exports = { header, classify, decompress, splitBody, looksEnveloped };
