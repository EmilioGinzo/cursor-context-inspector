'use strict';

// Readable tree of a decoded flow (see flows.decodeFlow). Strings are printed whole unless
// `clip` is set; multi-line strings are printed as indented blocks.

function clipText(s, clip) {
  return clip && s.length > clip ? `${s.slice(0, clip)}… (+${s.length - clip} chars)` : s;
}

function stringLines(label, s, pad, clip) {
  s = clipText(s, clip);
  if (!s.includes('\n')) return [`${pad}${label}${JSON.stringify(s)}`];
  return [`${pad}${label}|  (${s.split('\n').length} lines)`, ...s.split('\n').map((l) => `${pad}  ${l}`)];
}

function rawLines(fields, pad, clip) {
  const out = [];
  for (const f of fields) {
    const name = f.label ?? `#${f.no}${f.field ? ` ${f.field}` : ''}`;
    const notes = [f.mismatch && `wire type mismatch, ${f.mismatch}`, f.error && `error: ${f.error}`, f.unresolvedType && 'type unresolved in the schema'].filter(Boolean).join('; ');
    const tail = notes ? `  (${notes})` : '';
    if (f.superseded !== undefined) {
      out.push(...valueLines(`${name}${f.key !== undefined ? `[${JSON.stringify(f.key)}]` : ''} superseded by a later value: `, f.superseded, pad, clip));
    } else if (f.mapEntryUnknown) {
      out.push(`${pad}${name}[${JSON.stringify(f.key)}] unknown entry fields:`, ...rawLines(f.mapEntryUnknown, `${pad}  `, clip));
    } else if (f.wire === 'varint') {
      // The zigzag (sint) reading stays in --json; here it would trail every varint.
      out.push(`${pad}${name} varint ${f.value}${f.int64 ? `  (int64 ${f.int64})` : ''}${tail}`);
    } else if (f.wire === 'i64') {
      out.push(`${pad}${name} i64 ${f.fixed64}  (double ${f.double})${tail}`);
    } else if (f.wire === 'i32') {
      out.push(`${pad}${name} i32 ${f.fixed32}  (float ${f.float})${tail}`);
    } else {
      const head = `${name} ${f.group ? 'group' : 'len'}(${f.length})${tail} `;
      if (f.string !== undefined) out.push(...stringLines(head, f.string, pad, clip));
      if (f.message !== undefined) {
        out.push(`${pad}${f.string !== undefined ? `${name} as message:` : `${head}message:`}`);
        out.push(...rawLines(f.message, `${pad}  `, clip));
      }
      if (f.bytes !== undefined) out.push(`${pad}${head}bytes ${clipText(f.bytes, clip)}`);
    }
  }
  return out;
}

function valueLines(label, v, pad, clip) {
  if (v && v.unresolvedType && v.wire) return rawLines([{ ...v, label: label.replace(/: $/, '') }], pad, clip);
  if (v === null || typeof v !== 'object') {
    return typeof v === 'string' ? stringLines(label, v, pad, clip) : [`${pad}${label}${v}`];
  }
  if (Array.isArray(v)) {
    if (!v.length) return [`${pad}${label}[]`];
    const key = label.replace(/: $/, '');
    return v.flatMap((item, i) => valueLines(`${key}[${i}]: `, item, pad, clip));
  }
  const out = label ? [`${pad}${label.replace(/: $/, ':')}`] : [];
  const inner = label ? `${pad}  ` : pad;
  for (const [k, val] of Object.entries(v)) {
    if (k === '_unknown' && Array.isArray(val)) {
      out.push(`${inner}_unknown (fields not in the schema, or not decodable with it):`, ...rawLines(val, `${inner}  `, clip));
    } else if (k === '_error') {
      out.push(`${inner}_error: at byte ${val.offset}: ${val.message}`);
    } else {
      out.push(...valueLines(`${k}: `, val, inner, clip));
    }
  }
  if (label && out.length === 1) out[0] = `${pad}${label}{}`;
  return out;
}

const size = (n) => (n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)} MiB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KiB` : `${n} B`);

function sideLines(name, side, typeName, clip) {
  if (side.missing) return [`== ${name}: no body recorded`];
  if (side.readError) return [`== ${name}: unreadable body: ${side.readError}`];
  const head = [`== ${name}  ${side.protocol}/${side.codec}`, side.encoding && side.encoding !== 'identity' ? `encoding=${side.encoding}` : '', size(side.size),
    `${side.frames.length} frame${side.frames.length === 1 ? '' : 's'}`, typeName || '', side.truncated ? 'TRUNCATED' : ''].filter(Boolean).join('  ');
  const out = [head];
  if (side.contentEncodingError) out.push(`  content-encoding error: ${side.contentEncodingError}`);
  side.frames.forEach((f, i) => {
    const tags = [f.compressed && `compressed ${f.encoding || ''}`.trim(), f.endStream && 'END-STREAM', f.trailers && 'TRAILERS',
      f.truncated && `TRUNCATED: ${f.truncatedReason || ''}`.trim(), f.decompressError && `decompress failed: ${f.decompressError}`, f.jsonError && `bad JSON: ${f.jsonError}`].filter(Boolean);
    out.push(`-- frame ${i}  @${f.offset}  ${size(f.size)}${tags.length ? `  [${tags.join('] [')}]` : ''}`);
    const pad = '  ';
    if (f.trailerHeaders) out.push(...f.trailerHeaders.map(([k, v]) => `${pad}${k}: ${v}`));
    else if (f.json !== undefined) out.push(...valueLines('', f.json, pad, clip));
    else if (f.message) out.push(...valueLines('', f.message, pad, clip));
    else if (f.raw) {
      out.push(...rawLines(f.raw.fields, pad, clip));
      if (f.raw.error) out.push(`${pad}_error: at byte ${f.raw.error.offset}: ${f.raw.error.message}`, `${pad}_rest: ${clipText(f.raw.rest, clip)}`);
    } else if (f.text !== undefined) out.push(...stringLines('', f.text, pad, clip));
    else if (f.bytes !== undefined) out.push(`${pad}bytes ${clipText(f.bytes, clip)}`);
  });
  return out;
}

function renderFlow(flow, { clip } = {}) {
  const status = [`HTTP ${flow.status ?? '?'}`, flow.grpcStatus !== undefined && `grpc-status ${flow.grpcStatus}`, flow.error && `error: ${flow.error}`].filter(Boolean).join('  ');
  const lines = [
    `${flow.method} ${flow.url}`,
    `${flow.dir}`,
    `${new Date((flow.started ?? 0) * 1000).toISOString()}  ${status}`,
  ];
  if (flow.rpcTypes) lines.push(`rpc ${flow.service}/${flow.rpc}  ${flow.rpcTypes.input} -> ${flow.rpcTypes.output}  (${flow.rpcTypes.kind})`);
  else if (flow.service) lines.push(`rpc ${flow.service}/${flow.rpc}  (types unknown)`);
  const trailers = flow.meta && flow.meta.response_trailers;
  lines.push('', ...sideLines('request', flow.request, flow.rpcTypes && flow.rpcTypes.input, clip));
  lines.push('', ...sideLines('response', flow.response, flow.rpcTypes && flow.rpcTypes.output, clip));
  if (trailers && trailers.length) lines.push('', '== response trailers', ...trailers.map(([k, v]) => `  ${k}: ${v}`));
  return lines.join('\n');
}

module.exports = { renderFlow, valueLines, rawLines };
