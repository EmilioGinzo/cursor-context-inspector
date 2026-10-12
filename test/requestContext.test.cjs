'use strict';

// The wire format of the context parts Cursor sends beside the prompt (requestContext.cjs).

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const rc = require('../src/requestContext.cjs');

test('parts encode the way protobuf-es writes them: by field number, proto3 defaults left out', () => {
  // McpToolDefinition declares provider_identifier (4) and tool_name (5) before description (2).
  const data = rc.encode(rc.PART_TYPES.mcps, { tools: [{ name: 'srv-t', provider_identifier: 'srv', tool_name: 't', description: 'Does t.', input_schema_json: '' }] });
  const tool = Buffer.concat([
    Buffer.from([0x0a, 5]), Buffer.from('srv-t'), Buffer.from([0x12, 7]), Buffer.from('Does t.'),
    Buffer.from([0x22, 3]), Buffer.from('srv'), Buffer.from([0x2a, 1]), Buffer.from('t'),
    Buffer.from([0x32, 0]), // optional: kept even when empty
  ]);
  assert.deepStrictEqual(data, Buffer.concat([Buffer.from([0x0a, tool.length]), tool]));
  // Empty strings, false and empty lists of plain fields are not written; enums by number.
  const sub = rc.encode(rc.PART_TYPES.subagents, { custom_subagents: [{ full_path: '', name: 'a', tools: [], is_background: false, permission_mode: 'CUSTOM_SUBAGENT_PERMISSION_MODE_READONLY' }] });
  assert.deepStrictEqual(sub, Buffer.from([0x0a, 5, 0x12, 1, 0x61, 0x38, 2]));
  assert.throws(() => rc.encode(rc.PART_TYPES.rules, { rules: [], unknown_field: 1 }), /no field unknown_field/);

  const parts = rc.encodeParts({ rules: { rules: [{ full_path: '/r.mdc', content: 'x', type: { global: {} } }] } });
  assert.deepStrictEqual(Object.keys(parts), ['rules']);
  assert.strictEqual(parts.rules.id, crypto.createHash('sha256').update(parts.rules.data).digest('hex'));
  assert.deepStrictEqual(rc.decodePart('rules', parts.rules.data), { rules: [{ full_path: '/r.mdc', content: 'x', type: { global: {} } }] });
  assert.ok(rc.looksLikePart('rules', parts.rules.data));
  assert.ok(!rc.looksLikePart('rules', Buffer.from('{"role":"user"}')));
});

test('the part field tables match the installed Cursor', (t) => {
  let full;
  try {
    full = require('../src/wire/schema.cjs').loadSchema();
  } catch {
    return t.skip('Cursor is not installed');
  }
  for (const [type, m] of Object.entries(rc.SCHEMA.messages)) {
    const theirs = full.messages[type];
    assert.ok(theirs, `${type} in Cursor's schema`);
    for (const f of m.fields) {
      const c = theirs.fields.find((x) => x.no === f.no);
      assert.ok(c, `${type}.${f.name} (${f.no})`);
      assert.deepStrictEqual([c.name, c.kind, c.T, !!c.repeated, !!c.opt], [f.name, f.kind, f.T, f.repeated, f.opt], `${type}.${f.name}`);
    }
    // Every field Cursor writes besides input_schema (a Value; Cursor sends input_schema_json).
    const missing = theirs.fields.filter((c) => !m.fields.some((f) => f.no === c.no) && c.name !== 'input_schema');
    assert.deepStrictEqual(missing.map((c) => c.name), [], type);
  }
});
