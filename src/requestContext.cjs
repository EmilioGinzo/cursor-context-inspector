'use strict';

// The context Cursor's client sends with each agent request, outside the prompt messages.
//
// With a chat's message the client sends a RequestContext: rules, agent skills, custom subagents,
// MCP tool definitions and instructions, plus small dynamic items (env, git repos, flags). Since
// Cursor 3.x it also splits the large, rarely changing parts into four protobuf messages
// (RequestContextRulesPart, ...SkillsPart, ...SubagentsPart, ...McpsPart) and sends them by
// reference: `request_context_parts` carries each part's sha256 and byte length. On a chat's first
// message the full context also travels inline; on follow-ups only the ids do, and the server
// reuses the bytes it already has. Cursor keeps none of this in its database (it stores a part in
// agentKv only when the server asks for its bytes), so the plugin rebuilds the parts from their
// sources the way Cursor's client does (see sources.cjs) and records them content-addressed.
//
// This module holds the wire format of the parts: encode (byte-exact with Cursor's protobuf-es
// writer: fields by number, proto3 defaults left out) and decode.

const crypto = require('node:crypto');
const protobuf = require('./protobuf.cjs');

const PARTS = ['rules', 'skills', 'subagents', 'mcps'];

// Field tables in the shape of src/wire/schema.cjs, in Cursor's declaration order.
// Extracted from Cursor 3.x (agent.v1); the wire tests check them against captured bytes.
const f = (no, name, kind, T, more = {}) => ({ no, name, kind, T, repeated: false, oneof: null, opt: false, ...more });
const str = (no, name, more) => f(no, name, 'scalar', 9, more);
const bool = (no, name, more) => f(no, name, 'scalar', 8, more);
const msg = (no, name, T, more) => f(no, name, 'message', T, more);
const R = { repeated: true };
const O = { opt: true };
const P = 'agent.v1.';

const SCHEMA = {
  messages: {
    [`${P}RequestContextRulesPart`]: { fields: [msg(1, 'rules', `${P}CursorRule`, R), msg(2, 'non_file_rules', `${P}CursorRule`, R), str(3, 'cloud_rule', O)] },
    [`${P}RequestContextSkillsPart`]: { fields: [msg(1, 'agent_skills', `${P}AgentSkill`, R), msg(2, 'skill_options', `${P}SkillOptions`, O)] },
    [`${P}RequestContextSubagentsPart`]: { fields: [msg(1, 'custom_subagents', `${P}CustomSubagent`, R)] },
    [`${P}RequestContextMcpsPart`]: { fields: [msg(1, 'tools', `${P}McpToolDefinition`, R), msg(2, 'mcp_instructions', `${P}McpInstructions`, R), msg(3, 'mcp_file_system_options', `${P}McpFileSystemOptions`, O), msg(4, 'mcp_meta_tool_options', `${P}McpMetaToolOptions`, O)] },
    [`${P}CursorRule`]: {
      fields: [str(1, 'full_path'), str(2, 'content'), msg(3, 'type', `${P}CursorRuleType`), f(4, 'source', 'enum', `${P}CursorRuleSource`), str(5, 'git_remote_origin', O), str(6, 'parse_error', O),
        str(7, 'environments', R), str(8, 'disabled_environments', R), str(9, 'plugin', O), str(10, 'marketplace', O), str(11, 'plugin_id', O), str(12, 'marketplace_id', O),
        str(13, 'scoped_to', R), str(14, 'frontmatter'), bool(15, 'is_required', O)],
    },
    [`${P}CursorRuleType`]: {
      fields: [msg(1, 'global', `${P}CursorRuleTypeGlobal`, { oneof: 'type' }), msg(2, 'file_globbed', `${P}CursorRuleTypeFileGlobs`, { oneof: 'type' }),
        msg(3, 'agent_fetched', `${P}CursorRuleTypeAgentFetched`, { oneof: 'type' }), msg(4, 'manually_attached', `${P}CursorRuleTypeManuallyAttached`, { oneof: 'type' })],
    },
    [`${P}CursorRuleTypeGlobal`]: { fields: [] },
    [`${P}CursorRuleTypeFileGlobs`]: { fields: [str(1, 'globs', R)] },
    [`${P}CursorRuleTypeAgentFetched`]: { fields: [str(1, 'description')] },
    [`${P}CursorRuleTypeManuallyAttached`]: { fields: [] },
    [`${P}AgentSkill`]: {
      fields: [str(1, 'full_path'), str(2, 'content'), str(3, 'description'), str(4, 'parse_error', O), str(5, 'environments', R), str(6, 'disabled_environments', R),
        str(7, 'git_remote_origin', O), bool(8, 'disable_model_invocation'), str(9, 'plugin', O), str(10, 'marketplace', O), str(11, 'plugin_id', O), str(12, 'marketplace_id', O),
        str(13, 'globs', R), str(14, 'scoped_to', R)],
    },
    [`${P}SkillOptions`]: { fields: [msg(1, 'skill_descriptors', `${P}SkillDescriptor`, R)] },
    [`${P}SkillDescriptor`]: { fields: [str(1, 'name'), str(2, 'description'), str(3, 'folder_path'), bool(4, 'enabled'), str(5, 'parse_error', O), str(6, 'readme_file_path'), f(7, 'package_type', 'enum', `${P}PackageType`)] },
    [`${P}CustomSubagent`]: {
      fields: [str(1, 'full_path'), str(2, 'name'), str(3, 'description'), str(4, 'tools', R), str(5, 'model'), str(6, 'prompt'), f(7, 'permission_mode', 'enum', `${P}CustomSubagentPermissionMode`),
        bool(8, 'is_background'), str(9, 'plugin', O), str(10, 'marketplace', O), str(11, 'plugin_id', O), str(12, 'marketplace_id', O), bool(13, 'force_default_model'), str(14, 'source', O)],
    },
    // input_schema (a google.protobuf.Value) is left out: Cursor sends input_schema_json instead.
    [`${P}McpToolDefinition`]: { fields: [str(1, 'name'), str(4, 'provider_identifier'), str(5, 'tool_name'), str(2, 'description'), str(6, 'input_schema_json', O), str(7, 'output_schema_json', O), str(8, 'annotations_json', O)] },
    [`${P}McpInstructions`]: { fields: [str(1, 'server_name'), str(2, 'instructions'), str(3, 'server_identifier')] },
    [`${P}McpFileSystemOptions`]: { fields: [bool(1, 'enabled'), str(2, 'workspace_project_dir'), msg(3, 'mcp_descriptors', `${P}McpDescriptor`, R)] },
    [`${P}McpMetaToolOptions`]: { fields: [bool(1, 'enabled'), msg(2, 'mcp_descriptors', `${P}McpDescriptor`, R)] },
    [`${P}McpDescriptor`]: {
      fields: [str(1, 'server_name'), str(2, 'server_identifier'), str(3, 'folder_path', O), str(4, 'server_use_instructions', O), msg(5, 'tools', `${P}McpToolDescriptor`, R),
        str(7, 'plugin', O), str(8, 'marketplace', O), str(9, 'plugin_db_id', O), str(10, 'marketplace_id', O)],
    },
    [`${P}McpToolDescriptor`]: { fields: [str(1, 'tool_name'), str(2, 'definition_path', O), str(3, 'description', O), str(5, 'input_schema_json', O), str(6, 'annotations_json', O)] },
  },
  enums: {
    [`${P}CursorRuleSource`]: { 0: 'CURSOR_RULE_SOURCE_UNSPECIFIED', 1: 'CURSOR_RULE_SOURCE_TEAM', 2: 'CURSOR_RULE_SOURCE_USER' },
    [`${P}CustomSubagentPermissionMode`]: { 0: 'CUSTOM_SUBAGENT_PERMISSION_MODE_UNSPECIFIED', 1: 'CUSTOM_SUBAGENT_PERMISSION_MODE_DEFAULT', 2: 'CUSTOM_SUBAGENT_PERMISSION_MODE_READONLY', 3: 'CUSTOM_SUBAGENT_PERMISSION_MODE_AGENT_ONLY' },
    [`${P}PackageType`]: { 0: 'PACKAGE_TYPE_UNSPECIFIED', 1: 'PACKAGE_TYPE_CURSOR_PROJECT', 2: 'PACKAGE_TYPE_CURSOR_PERSONAL', 3: 'PACKAGE_TYPE_CLAUDE_SKILL', 4: 'PACKAGE_TYPE_CLAUDE_PLUGIN' },
  },
};

const PART_TYPES = {
  rules: `${P}RequestContextRulesPart`,
  skills: `${P}RequestContextSkillsPart`,
  subagents: `${P}RequestContextSubagentsPart`,
  mcps: `${P}RequestContextMcpsPart`,
};

// --- encode ------------------------------------------------------------------------------

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

const tag = (no, wire) => varint((no << 3) | wire);
const len = (no, buf) => Buffer.concat([tag(no, 2), varint(buf.length), buf]);

function enumNumber(T, v) {
  if (typeof v === 'number') return v;
  const names = SCHEMA.enums[T] || {};
  const n = Object.keys(names).find((k) => names[k] === v);
  if (n === undefined) throw new Error(`${T} has no value ${v}`);
  return Number(n);
}

// One value of a field; `present` says an implicit-presence (proto3) default is left out.
function encodeValue(field, v, out, inList) {
  if (field.kind === 'message') return out.push(len(field.no, encode(field.T, v)));
  if (field.kind === 'enum') {
    const n = enumNumber(field.T, v);
    if (n !== 0 || field.opt || inList) out.push(tag(field.no, 0), varint(n));
    return undefined;
  }
  if (field.T === 9) {
    if (v !== '' || field.opt || inList) out.push(len(field.no, Buffer.from(v, 'utf8')));
    return undefined;
  }
  if (field.T === 8) {
    if (v || field.opt || inList) out.push(tag(field.no, 0), varint(v ? 1 : 0));
    return undefined;
  }
  throw new Error(`cannot encode ${field.name}`);
}

// Encode a plain object (field names as in SCHEMA) as message `type`, the way protobuf-es writes it.
function encode(type, obj) {
  const m = SCHEMA.messages[type];
  if (!m) throw new Error(`no message ${type}`);
  const out = [];
  // protobuf-es writes fields by number, whatever their declaration order (McpToolDefinition).
  for (const field of [...m.fields].sort((a, b) => a.no - b.no)) {
    const v = obj[field.name];
    if (v === undefined || v === null) continue;
    if (field.repeated) {
      if (!Array.isArray(v)) throw new Error(`${type}.${field.name} must be an array`);
      // Repeated strings and messages are never packed.
      for (const x of v) encodeValue(field, x, out, true);
    } else encodeValue(field, v, out, false);
  }
  for (const k of Object.keys(obj)) if (!k.startsWith('_') && !m.fields.some((x) => x.name === k)) throw new Error(`${type} has no field ${k}`);
  return Buffer.concat(out);
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// { rules: {...}, ... } plain part objects -> { rules: { id, bytes, data } ... }.
function encodeParts(parts) {
  const out = {};
  for (const k of PARTS) {
    if (!parts[k]) continue;
    const data = encode(PART_TYPES[k], parts[k]);
    out[k] = { id: sha256(data), bytes: data.length, data };
  }
  return out;
}

// --- decode ------------------------------------------------------------------------------

// Part bytes -> plain object (enum names as strings, unknown fields under `_unknown`).
function decodePart(kind, data) {
  return protobuf.decodeMessage(SCHEMA, PART_TYPES[kind], data);
}

// Does `data` look like a part of `kind`? (agentKv holds parts the server once fetched.)
function looksLikePart(kind, data) {
  try {
    const m = decodePart(kind, data);
    return !m._error && !m._unknown && encode(PART_TYPES[kind], strip(m)).equals(data);
  } catch {
    return false;
  }
}

function strip(m) {
  if (Array.isArray(m)) return m.map(strip);
  if (!m || typeof m !== 'object') return m;
  return Object.fromEntries(Object.entries(m).filter(([k]) => !k.startsWith('_')).map(([k, v]) => [k, strip(v)]));
}

module.exports = { PARTS, PART_TYPES, SCHEMA, encode, encodeParts, decodePart, looksLikePart, sha256 };
