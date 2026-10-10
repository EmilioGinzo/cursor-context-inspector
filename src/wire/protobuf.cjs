'use strict';

// Protobuf wire-format decoding, with and without a schema. Nothing is dropped:
// fields the schema does not know, values with an unexpected wire type and bytes
// after a parse error are all kept, under `_unknown` / `_error`.
//
// Schema shape (see src/wire/schema.cjs): { messages: { "pkg.Type": { fields: [
//   { no, name, kind: scalar|enum|message|map, T, K?, V?, repeated, oneof, opt } ] } }, enums: {...} }
// T for scalars is protobuf-es ScalarType. A field whose type the extractor could not resolve
// has T: null (and maybe kind: null); its values are decoded schema-less, under `_unknown`
// (map values in place), marked `unresolvedType`.

const MAX_DEPTH = 64;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

const S = {
  DOUBLE: 1, FLOAT: 2, INT64: 3, UINT64: 4, INT32: 5, FIXED64: 6, FIXED32: 7, BOOL: 8,
  STRING: 9, BYTES: 12, UINT32: 13, SFIXED32: 15, SFIXED64: 16, SINT32: 17, SINT64: 18,
};
const WIRE = { VARINT: 0, I64: 1, LEN: 2, SGROUP: 3, EGROUP: 4, I32: 5 };
const WIRE_NAME = ['varint', 'i64', 'len', 'sgroup', 'egroup', 'i32'];

function scalarWire(t) {
  if (t === S.DOUBLE || t === S.FIXED64 || t === S.SFIXED64) return WIRE.I64;
  if (t === S.FLOAT || t === S.FIXED32 || t === S.SFIXED32) return WIRE.I32;
  if (t === S.STRING || t === S.BYTES) return WIRE.LEN;
  return WIRE.VARINT;
}

class Reader {
  constructor(buf, pos = 0, end = buf.length) {
    this.buf = buf;
    this.pos = pos;
    this.end = end;
  }
  done() {
    return this.pos >= this.end;
  }
  varint() {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) throw new Error('varint runs past end');
      const b = this.buf[this.pos++];
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return BigInt.asUintN(64, result);
      shift += 7n;
    }
    throw new Error('varint longer than 10 bytes');
  }
  take(n) {
    if (n > this.end - this.pos) throw new Error(`needs ${n} bytes, ${this.end - this.pos} left`);
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  tag() {
    const t = this.varint();
    const no = Number(t >> 3n);
    const wire = Number(t & 7n);
    if (no < 1 || no > 0x1fffffff) throw new Error(`invalid field number ${no}`);
    if (wire > 5) throw new Error(`invalid wire type ${wire}`);
    return { no, wire };
  }
  // Read one value of `wire` type; returns a bigint (varint), Buffer (i64/i32/len) or skips a group.
  value(wire, no, depth = 0) {
    if (wire === WIRE.VARINT) return this.varint();
    if (wire === WIRE.I64) return this.take(8);
    if (wire === WIRE.I32) return this.take(4);
    if (wire === WIRE.LEN) {
      const n = this.varint();
      if (n > BigInt(this.end - this.pos)) throw new Error(`length ${n} runs past end (${this.end - this.pos} left)`);
      return this.take(Number(n));
    }
    if (wire === WIRE.SGROUP) {
      // Deprecated groups: return the raw bytes up to the matching end-group tag.
      if (depth > MAX_DEPTH) throw new Error('group nesting too deep');
      const start = this.pos;
      for (;;) {
        const before = this.pos;
        const t = this.tag();
        if (t.wire === WIRE.EGROUP) {
          if (t.no !== no) throw new Error(`end-group ${t.no} does not match ${no}`);
          return this.buf.subarray(start, before);
        }
        this.value(t.wire, t.no, depth + 1);
      }
    }
    throw new Error(`unexpected end-group for field ${no}`);
  }
}

const zigzag = (v) => (v >> 1n) ^ -(v & 1n);

function printable(s) {
  if (!s.length) return true;
  let bad = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f || c === 0xfffd) bad++;
  }
  return bad === 0;
}

function tryUtf8(buf) {
  try {
    const s = utf8.decode(buf);
    return printable(s) ? s : undefined;
  } catch {
    return undefined;
  }
}

// ---------- schema-less ----------

// Strictly parse `buf` as a message; returns the field list or throws.
function rawFields(buf, depth) {
  const r = new Reader(buf);
  const fields = [];
  while (!r.done()) {
    const offset = r.pos;
    const { no, wire } = r.tag();
    const v = r.value(wire, no);
    fields.push(rawValue(no, wire, v, depth, offset));
  }
  return fields;
}

// Describe one raw value. A length-delimited value gets every interpretation that fits:
// `string` if it is printable UTF-8, `message` if it parses as protobuf; `bytes` (base64) if neither.
function rawValue(no, wire, v, depth, offset) {
  const f = { no, wire: WIRE_NAME[wire] };
  if (offset !== undefined) f.offset = offset;
  if (wire === WIRE.VARINT) {
    f.value = v.toString();
    const signed = BigInt.asIntN(64, v);
    if (signed < 0n) f.int64 = signed.toString();
    if (v !== 0n && v !== 1n) f.zigzag = zigzag(v).toString();
  } else if (wire === WIRE.I64) {
    f.fixed64 = v.readBigUInt64LE(0).toString();
    f.double = v.readDoubleLE(0);
  } else if (wire === WIRE.I32) {
    f.fixed32 = v.readUInt32LE(0);
    f.float = v.readFloatLE(0);
  } else {
    f.length = v.length;
    const s = tryUtf8(v);
    if (s !== undefined) f.string = s;
    if (v.length && depth < MAX_DEPTH) {
      try {
        f.message = rawFields(v, depth + 1);
      } catch {
        /* not a message */
      }
    }
    if (f.string === undefined && f.message === undefined) f.bytes = v.toString('base64');
    if (wire === WIRE.SGROUP) f.group = true;
  }
  return f;
}

// Decode without a schema; never throws. Returns { fields, error?, rest? }.
function decodeRaw(buf, depth = 0) {
  const r = new Reader(buf);
  const fields = [];
  while (!r.done()) {
    const offset = r.pos;
    try {
      const { no, wire } = r.tag();
      const v = r.value(wire, no);
      fields.push(rawValue(no, wire, v, depth, offset));
    } catch (e) {
      return { fields, error: { offset, message: e.message }, rest: buf.subarray(offset).toString('base64') };
    }
  }
  return { fields };
}

// ---------- schema-aware ----------

// JSON has no NaN or Infinity; spell them as strings, like protobuf's JSON mapping.
const jsonNumber = (x) => (Number.isFinite(x) ? x : String(x));

function scalarValue(t, wire, v) {
  switch (t) {
    case S.DOUBLE: return jsonNumber(v.readDoubleLE(0));
    case S.FLOAT: return jsonNumber(v.readFloatLE(0));
    case S.INT64: return BigInt.asIntN(64, v).toString();
    case S.UINT64: return v.toString();
    case S.INT32: return Number(BigInt.asIntN(32, v));
    case S.FIXED64: return v.readBigUInt64LE(0).toString();
    case S.FIXED32: return v.readUInt32LE(0);
    case S.BOOL: return v !== 0n;
    case S.STRING: {
      try { return utf8.decode(v); } catch { return { _invalidUtf8: v.toString('base64') }; }
    }
    case S.BYTES: return v.toString('base64');
    case S.UINT32: return Number(BigInt.asUintN(32, v));
    case S.SFIXED32: return v.readInt32LE(0);
    case S.SFIXED64: return v.readBigInt64LE(0).toString();
    case S.SINT32: return Number(BigInt.asIntN(32, zigzag(v)));
    case S.SINT64: return BigInt.asIntN(64, zigzag(v)).toString();
    default: throw new Error(`unknown scalar type ${t}`);
  }
}

// The value an absent proto3 scalar has (map entries may omit key or value).
function defaultScalar(t) {
  if (t === S.STRING || t === S.BYTES) return '';
  if (t === S.BOOL) return false;
  if ([S.INT64, S.UINT64, S.FIXED64, S.SFIXED64, S.SINT64].includes(t)) return '0';
  return 0;
}

function enumValue(schema, typeName, v) {
  const n = Number(BigInt.asIntN(32, v));
  const names = schema.enums && schema.enums[typeName];
  return names && names[String(n)] !== undefined ? names[String(n)] : n;
}

// Field (or map value) types the extractor left unresolved. An enum without T still decodes, to numbers.
const unresolved = (kind, T) => kind === null || kind === undefined || (kind === 'message' && !T);

function packable(field) {
  return field.kind === 'enum' || (field.kind === 'scalar' && scalarWire(field.T) !== WIRE.LEN);
}

// Value of a singular (non-map) field from one wire value.
function fieldValue(schema, kind, T, wire, v, depth) {
  if (kind === 'message') return decodeMessage(schema, T, v, depth + 1);
  if (kind === 'enum') return enumValue(schema, T, v);
  return scalarValue(T, wire, v);
}

function expectedWire(kind, T) {
  if (kind === 'message' || kind === 'map') return WIRE.LEN;
  if (kind === 'enum') return WIRE.VARINT;
  return scalarWire(T);
}

function decodeMapEntry(schema, field, buf, depth) {
  const r = new Reader(buf);
  let key;
  let value;
  const unknown = [];
  const V = field.V || {};
  while (!r.done()) {
    const offset = r.pos;
    const { no, wire } = r.tag();
    const v = r.value(wire, no);
    if (no === 1 && wire === scalarWire(field.K)) key = scalarValue(field.K, wire, v);
    else if (no === 2 && unresolved(V.kind, V.T)) value = { unresolvedType: true, ...rawValue(no, wire, v, depth, offset) };
    else if (no === 2 && wire === expectedWire(V.kind, V.T)) value = fieldValue(schema, V.kind, V.T, wire, v, depth);
    else unknown.push(rawValue(no, wire, v, depth, offset));
  }
  if (key === undefined) key = defaultScalar(field.K);
  if (value === undefined) {
    if (V.kind === 'message') value = {};
    else if (V.kind === 'enum') value = enumValue(schema, V.T, 0n);
    else value = defaultScalar(V.T);
  }
  return { key: typeof key === 'object' ? JSON.stringify(key) : String(key), value, unknown };
}

// Decode `buf` as message `typeName` into a JSON-able object keyed by field name. Never throws:
// unknown or mismatched fields go to `_unknown`; a parse error leaves `_error` and `_rest` (base64).
function decodeMessage(schema, typeName, buf, depth = 0) {
  const type = schema && schema.messages && schema.messages[typeName];
  if (!type) {
    const raw = decodeRaw(buf, depth);
    return { _type: typeName, _noSchema: true, ...raw.error ? { _error: raw.error, _rest: raw.rest } : {}, _unknown: raw.fields };
  }
  if (depth > MAX_DEPTH) return { _error: { offset: 0, message: 'nesting too deep' }, _rest: buf.toString('base64') };
  const byNo = new Map(type.fields.map((f) => [f.no, f]));
  const out = {};
  const unknown = [];
  const r = new Reader(buf);
  while (!r.done()) {
    const offset = r.pos;
    let no;
    let wire;
    let v;
    try {
      ({ no, wire } = r.tag());
      v = r.value(wire, no, depth);
    } catch (e) {
      out._error = { offset, message: e.message };
      out._rest = buf.subarray(offset).toString('base64');
      break;
    }
    const field = byNo.get(no);
    if (!field) {
      unknown.push(rawValue(no, wire, v, depth, offset));
      continue;
    }
    if (field.kind !== 'map' && unresolved(field.kind, field.T)) {
      unknown.push({ ...rawValue(no, wire, v, depth, offset), field: field.name, unresolvedType: true });
      continue;
    }
    try {
      if (field.kind === 'map') {
        if (wire !== WIRE.LEN) throw new Error(`map field with wire type ${WIRE_NAME[wire]}`);
        const entry = decodeMapEntry(schema, field, v, depth);
        out[field.name] = out[field.name] || {};
        // A repeated key: the last entry wins, as in protobuf; keep the earlier value visible.
        if (Object.hasOwn(out[field.name], entry.key)) unknown.push({ no, field: field.name, key: entry.key, superseded: out[field.name][entry.key] });
        // defineProperty: a key like "__proto__" must become an entry, not the prototype.
        Object.defineProperty(out[field.name], entry.key, { value: entry.value, enumerable: true, writable: true, configurable: true });
        if (entry.unknown.length) unknown.push({ no, field: field.name, key: entry.key, mapEntryUnknown: entry.unknown });
        continue;
      }
      const want = expectedWire(field.kind, field.T);
      let values;
      if (field.repeated && wire === WIRE.LEN && packable(field)) {
        values = [];
        const pr = new Reader(v);
        while (!pr.done()) values.push(fieldValue(schema, field.kind, field.T, want, pr.value(want, no), depth));
      } else if (wire === want) {
        values = [fieldValue(schema, field.kind, field.T, wire, v, depth)];
      } else {
        unknown.push({ ...rawValue(no, wire, v, depth, offset), field: field.name, mismatch: `expected ${WIRE_NAME[want]}` });
        continue;
      }
      if (field.repeated) {
        out[field.name] = (out[field.name] || []).concat(values);
      } else {
        // A repeated occurrence of a singular field: last wins in protobuf; keep the earlier one visible.
        if (field.name in out) unknown.push({ no, field: field.name, superseded: out[field.name] });
        out[field.name] = values[values.length - 1];
        // Oneof: setting one member clears the others.
        if (field.oneof) {
          for (const other of type.fields) {
            if (other !== field && other.oneof === field.oneof && other.name in out) {
              unknown.push({ no: other.no, field: other.name, superseded: out[other.name] });
              delete out[other.name];
            }
          }
        }
      }
    } catch (e) {
      unknown.push({ ...rawValue(no, wire, v, depth, offset), field: field.name, error: e.message });
    }
  }
  if (unknown.length) out._unknown = unknown;
  return out;
}

module.exports = { ScalarType: S, Reader, decodeRaw, decodeMessage, MAX_DEPTH };
