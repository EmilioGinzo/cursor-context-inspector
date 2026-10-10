'use strict';

// Minimal protobuf encoder for building test fixtures.

function varint(n) {
  let v = BigInt.asUintN(64, BigInt(n));
  const out = [];
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return Buffer.from(out);
}

const tag = (no, wire) => varint((BigInt(no) << 3n) | BigInt(wire));
const bytes = (b) => (Buffer.isBuffer(b) ? b : Buffer.from(b));

const pb = {
  varint,
  tag,
  // field encoders
  v: (no, n) => Buffer.concat([tag(no, 0), varint(n)]),
  sint: (no, n) => Buffer.concat([tag(no, 0), varint((BigInt(n) << 1n) ^ (BigInt(n) < 0n ? -1n : 0n))]),
  len: (no, b) => Buffer.concat([tag(no, 2), varint(bytes(b).length), bytes(b)]),
  d: (no, x) => { const b = Buffer.alloc(8); b.writeDoubleLE(x); return Buffer.concat([tag(no, 1), b]); },
  f: (no, x) => { const b = Buffer.alloc(4); b.writeFloatLE(x); return Buffer.concat([tag(no, 5), b]); },
  packed: (no, ns) => pb.len(no, Buffer.concat(ns.map(varint))),
  msg: (...parts) => Buffer.concat(parts),
  // 5-byte envelope used by gRPC and Connect streaming
  envelope: (flags, payload) => {
    const h = Buffer.alloc(5);
    h[0] = flags;
    h.writeUInt32BE(payload.length, 1);
    return Buffer.concat([h, payload]);
  },
};

module.exports = pb;
