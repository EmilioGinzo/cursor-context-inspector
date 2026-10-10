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

// Encode a plain object as message `type` of `schema` (field names as in the schema). Bytes take a
// Buffer; enums a number or value name; maps an object; repeated fields an array.
function encodeMessage(schema, type, obj) {
  const m = schema.messages[type];
  if (!m) throw new Error(`no message ${type}`);
  const parts = [];
  for (const [name, value] of Object.entries(obj)) {
    const f = m.fields.find((x) => x.name === name);
    if (!f) throw new Error(`${type} has no field ${name}`);
    const one = (kind, T, v) => {
      if (kind === 'message') return { wire: 2, buf: encodeMessage(schema, T, v) };
      if (kind === 'enum') {
        const names = schema.enums[T] || {};
        const n = typeof v === 'number' ? v : Number(Object.keys(names).find((k) => names[k] === v));
        return { wire: 0, buf: varint(n) };
      }
      if (T === 9) return { wire: 2, buf: Buffer.from(v, 'utf8') };
      if (T === 12) return { wire: 2, buf: bytes(v) };
      if (T === 8) return { wire: 0, buf: varint(v ? 1 : 0) };
      if (T === 1) { const b = Buffer.alloc(8); b.writeDoubleLE(v); return { wire: 1, buf: b }; }
      return { wire: 0, buf: varint(v) };
    };
    const field = (no, { wire, buf }) => (wire === 2 ? pb.len(no, buf) : Buffer.concat([tag(no, wire), buf]));
    if (f.kind === 'map') {
      for (const [k, v] of Object.entries(value)) {
        const key = one('scalar', f.K, f.K === 9 ? k : Number(k));
        parts.push(pb.len(f.no, Buffer.concat([field(1, key), field(2, one(f.V.kind, f.V.T, v))])));
      }
    } else {
      for (const v of f.repeated ? value : [value]) parts.push(field(f.no, one(f.kind, f.T, v)));
    }
  }
  return Buffer.concat(parts);
}

pb.encodeMessage = encodeMessage;

module.exports = pb;
