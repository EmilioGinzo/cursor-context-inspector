'use strict';

// Records the context Cursor sends with a chat's messages outside the prompt (rules, skills,
// subagent definitions, MCP tools: see requestContext.cjs), next to the chat's history.
//
// <history>/context/<sha256>.bin   one request-context part, exactly the bytes rebuilt (stored once)
// <history>/context/<sha256>.redacted.bin  the same, when it held credentials: replaced (redact.cjs);
//                                  the name keeps the sha256 of the bytes before, the one to compare
// <history>/context/<sha256>.md    the same part, readable (collapsed sections, nothing cut)
// <chat>/meta.json  sentContext    per user message: the part ids, when and how they were rebuilt
//
// Cursor keeps none of it, so the parts are rebuilt from their sources (contextSources.cjs) when
// the recorder sees a new user message, shortly after it was sent. A part is only "what Cursor
// sent" when its sha256 is one Cursor used; `storedByCursor` lists parts Cursor itself kept in agentKv under that id.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const rc = require('./requestContext.cjs');
const sources = require('./contextSources.cjs');
const mcpConnections = require('./mcpConnections.cjs');
const { redactValue } = require('./redact.cjs');

// A message is matched with a rebuild made at most this long after it: later, the sources (rule
// files, skills...) are more likely to have changed since the message was sent.
const LIVE_MS = 10 * 60 * 1000;

const KIND_LABEL = { rules: 'Rules', skills: 'Agent skills', subagents: 'Subagent definitions', mcps: 'MCP tools and instructions' };

function writeOnce(file, data) {
  if (fs.existsSync(file)) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// The user messages a snapshot adds: real user turns, not summaries or notifications.
function newUserMessages(hashes, seenBefore, readMessage, userBlocks) {
  return hashes.filter((h) => {
    if (seenBefore.has(h)) return false;
    const m = readMessage(h);
    return m && m.role === 'user' && userBlocks(m).some((b) => b.label === 'User');
  });
}

// Plugin and marketplace database ids are not on disk, but parts Cursor kept in agentKv (sent by
// reference and fetched by the server) carry them. Found by a full scan of agentKv (seconds), so
// once per plugin revision, remembered in context/plugin-ids.json; looked for again after a day.
const PLUGIN_RESCAN_MS = 24 * 3600 * 1000;

function pluginIds(db, dir, plugins, now) {
  const file = path.join(dir, 'context', 'plugin-ids.json');
  let known = {};
  try {
    known = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    /* none yet */
  }
  let changed = false;
  for (const p of plugins) {
    const key = `${p.name}-${p.rev}`;
    const k = known[key];
    if (k && (k.pluginId !== undefined || now - k.scannedAt < PLUGIN_RESCAN_MS)) continue;
    known[key] = { ...findPluginIds(db, p, key), scannedAt: now };
    changed = true;
  }
  if (changed) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(known, null, 2));
  }
  return known;
}

// MCP tool annotations (readOnlyHint, title...) are not on disk. Cursor keeps them in the meta-tool
// parts it stored in agentKv (the server asked for those bytes), so they are read from there, at most
// once an hour, and remembered in context/tool-annotations.json. Servers change them (a title was
// renamed in the captured runs): every distinct value is kept with its count and the row it was last
// seen in, and the one stored last is used. Blob rows are written once, so each scan reads only the
// rows after the last one it saw.
const ANNOTATION_RESCAN_MS = 60 * 60 * 1000;

// { annotations: Map of key -> annotations_json (the last stored), conflicts: tools with more than one value }.
// File: { scannedAt, lastRowid, tools: { key: { annotations_json: { count, lastRowid } } } }.
function toolAnnotations(db, dir, now) {
  const file = path.join(dir, 'context', 'tool-annotations.json');
  let known = { scannedAt: 0, lastRowid: 0, tools: {} };
  try {
    known = { ...known, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    known.tools = mergeAnnotations(known.tools, {});
  } catch {
    /* none yet */
  }
  if (now - known.scannedAt >= ANNOTATION_RESCAN_MS) {
    const found = scanAnnotations(db, known.lastRowid);
    known = { scannedAt: now, lastRowid: found.lastRowid, tools: mergeAnnotations(known.tools, found.tools) };
    writeAtomic(file, JSON.stringify(known, null, 2));
  }
  const annotations = new Map();
  let conflicts = 0;
  for (const [key, values] of Object.entries(known.tools)) {
    const entries = Object.entries(values);
    annotations.set(key, entries.sort((a, b) => b[1].lastRowid - a[1].lastRowid)[0][0]);
    if (entries.length > 1) conflicts++;
  }
  return { annotations, conflicts };
}

// Rows after `after` (up to the newest one now): { tools: { key: { json: { count, lastRowid } } }, lastRowid }.
function scanAnnotations(db, after) {
  let top = after;
  let rows = [];
  try {
    top = db.prepare('SELECT max(rowid) AS top FROM cursorDiskKV').get().top ?? after;
    if (top < after) return scanAnnotations(db, 0); // the table was rebuilt: read it all again
    rows = db.prepare("SELECT rowid AS id, value FROM cursorDiskKV WHERE rowid > ? AND rowid <= ? AND key LIKE 'agentKv:blob:%' AND instr(CAST(value AS TEXT), 'Hint\"') > 0").all(after, top);
  } catch {
    return { tools: {}, lastRowid: after };
  }
  const tools = {};
  for (const r of rows) {
    const data = Buffer.from(r.value);
    if (!rc.looksLikePart('mcps', data)) continue;
    const options = rc.decodePart('mcps', data).mcp_meta_tool_options;
    for (const d of (options && options.mcp_descriptors) || []) {
      for (const t of d.tools || []) {
        if (typeof t.annotations_json !== 'string') continue;
        const values = (tools[sources.annotationKey(d.server_identifier, t.tool_name)] ??= {});
        const e = (values[t.annotations_json] ??= { count: 0, lastRowid: 0 });
        e.count++;
        e.lastRowid = Math.max(e.lastRowid, r.id);
      }
    }
  }
  return { tools, lastRowid: top };
}

// Adds the counts of `found` to `known`, keeping every value either has (none is dropped).
function mergeAnnotations(known, found) {
  const out = {};
  for (const [key, values] of Object.entries(known)) {
    // Earlier files kept one string per tool: it counts once.
    out[key] = typeof values === 'string' ? { [values]: { count: 1, lastRowid: 0 } } : { ...values };
  }
  for (const [key, values] of Object.entries(found)) {
    out[key] = { ...(out[key] || {}) };
    for (const [json, e] of Object.entries(values)) {
      const old = out[key][json] || { count: 0, lastRowid: 0 };
      out[key][json] = { count: old.count + e.count, lastRowid: Math.max(old.lastRowid, e.lastRowid) };
    }
  }
  return out;
}

// Written beside the old file, then renamed over it: a crash leaves the last complete file.
function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function findPluginIds(db, plugin, key) {
  let rows = [];
  try {
    rows = db.prepare("SELECT value FROM cursorDiskKV WHERE key LIKE 'agentKv:blob:%' AND instr(value, ?) > 0").all(Buffer.from(`plugin:${key}`));
  } catch {
    return {};
  }
  for (const r of rows) {
    const data = Buffer.from(r.value);
    if (!rc.looksLikePart('skills', data)) continue;
    const s = (rc.decodePart('skills', data).agent_skills || []).find((x) => x.plugin === plugin.name && x.marketplace === plugin.marketplace && x.plugin_id !== undefined);
    if (s) return { pluginId: s.plugin_id, marketplaceId: s.marketplace_id };
  }
  return {};
}

// Rebuilds the parts for these workspace folders as they were at `at` (the message's time: which
// MCP servers were connected then), at most once per `cache` (one recorder tick).
function rebuild(folders, options, cache, db, dir, at) {
  const key = JSON.stringify([folders, at]);
  if (cache && cache.has(key)) return cache.get(key);
  let result;
  try {
    const logs = options.cursorLogsDir || path.join(options.home || os.homedir(), '.config', 'Cursor', 'logs');
    const env = sources.environment({ ...options, connections: mcpConnections.connectionsAt(logs, at) });
    if (db) env.pluginIds = pluginIds(db, dir, sources.installedPlugins(env), Date.now());
    if (db) {
      const annotations = toolAnnotations(db, dir, Date.now());
      env.toolAnnotations = annotations.annotations;
      env.annotationConflicts = annotations.conflicts;
    }
    const { parts, dynamic, notes } = sources.buildParts(folders, { env });
    result = { encoded: rc.encodeParts(parts), parts, dynamic, notes, at: Date.now() };
  } catch (err) {
    result = { error: err.message, at: Date.now() };
  }
  if (cache) cache.set(key, result);
  return result;
}

// Called by the recorder for a new snapshot of a (root) chat. Returns the entry to add to
// meta.sentContext, or undefined. options: { enabled, now, maxAgeMs, appDir, home, cache }.
function record({ dir, composer, hashes, seenBefore, readMessage, userBlocks, db }, options = {}) {
  if (!options.enabled) return undefined;
  const now = options.now ?? Date.now();
  const maxAge = options.maxAgeMs ?? LIVE_MS;
  if (now - composer.lastUpdatedAt > maxAge) return undefined;
  const messages = newUserMessages(hashes, seenBefore, readMessage, userBlocks);
  if (!messages.length) return undefined;
  const folders = sources.workspaceFolders(composer.workspaceIdentifier);
  const built = rebuild(folders, options, options.cache, db, dir, composer.lastUpdatedAt);
  const entry = { messages, messageAt: composer.lastUpdatedAt, rebuiltAt: built.at, source: 'rebuilt', workspaceFolders: folders };
  if (built.error) return { ...entry, error: redactValue(built.error).value };
  entry.parts = {};
  entry.storedByCursor = [];
  for (const kind of rc.PARTS) {
    const p = built.encoded[kind];
    if (!p) continue;
    // The id stays the sha256 of the bytes as rebuilt, the one to compare with Cursor's; what is
    // stored has its credentials replaced, and says where.
    const clean = redactValue(built.parts[kind]);
    const redacted = clean.count ? { count: clean.count, paths: clean.paths } : undefined;
    writeOnce(path.join(dir, 'context', partFile(p.id, redacted)), redacted ? rc.encodeParts({ [kind]: clean.value })[kind].data : p.data);
    writeOnce(path.join(dir, 'context', `${p.id}.md`), renderPart(kind, clean.value, { id: p.id, bytes: p.bytes, redacted }));
    entry.parts[kind] = { id: p.id, bytes: p.bytes, items: itemCount(kind, built.parts[kind]), ...(redacted ? { redacted } : {}) };
    if (db && hasBlob(db, p.id)) entry.storedByCursor.push(kind);
  }
  if (built.dynamic) {
    const clean = redactValue(built.dynamic);
    entry.dynamic = clean.value;
    if (clean.count) entry.dynamicRedacted = { count: clean.count, paths: clean.paths };
  }
  if (built.notes.length) entry.notes = redactValue(built.notes).value;
  return entry;
}

function hasBlob(db, id) {
  try {
    return !!db.prepare('SELECT 1 FROM cursorDiskKV WHERE key = ?').get(`agentKv:blob:${id}`);
  } catch {
    return false;
  }
}

function itemCount(kind, part) {
  if (kind === 'rules') return (part.rules || []).length;
  if (kind === 'skills') return (part.agent_skills || []).length;
  if (kind === 'subagents') return (part.custom_subagents || []).length;
  // The tools the model is told about: the meta-tool list (every server's tools), else the inline ones.
  const meta = part.mcp_meta_tool_options;
  if (meta && meta.mcp_descriptors) return meta.mcp_descriptors.reduce((n, d) => n + (d.tools || []).length, 0);
  return (part.tools || []).length;
}

// --- reading back --------------------------------------------------------------------------

const partFile = (id, redacted) => `${id}${redacted ? '.redacted' : ''}.bin`;

// A recorded part: { kind, id, data, part, redacted } (decoded), or undefined when its file is
// missing. redacted: its credentials were replaced, so `data` is not exactly the bytes of `id`.
function loadPart(dir, kind, id) {
  for (const redacted of [false, true]) {
    const file = path.join(dir, 'context', partFile(id, redacted));
    if (!fs.existsSync(file)) continue;
    const data = fs.readFileSync(file);
    return { kind, id, data, part: rc.decodePart(kind, data), redacted };
  }
  return undefined;
}

// Every string a part carries, for comparing it with what travelled.
function partStrings(part) {
  const out = [];
  const walk = (v) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!k.startsWith('_')) walk(x);
  };
  walk(part);
  return out;
}

// --- readable form -------------------------------------------------------------------------

const html = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function fenced(text, lang = '') {
  const longest = Math.max(2, ...(String(text).match(/`+/g) || []).map((r) => r.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
}

const details = (summary, body) => `<details><summary>${summary}</summary>\n\n${body}\n\n</details>`;

// Short fields as a list, long or multi-line ones fenced; nothing is cut.
function fields(obj) {
  const lines = [];
  const blocks = [];
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('_') || v === undefined) continue;
    if (typeof v === 'string' && (v.includes('\n') || v.length > 200)) blocks.push(`**${k}**\n\n${fenced(v, /json$/.test(k) ? 'json' : '')}`);
    else lines.push(`- ${k}: ${typeof v === 'string' ? `\`${v.replace(/`/g, "'")}\`` : JSON.stringify(v)}`);
  }
  return [lines.join('\n'), ...blocks].filter(Boolean).join('\n\n');
}

function ruleSummary(r) {
  const type = r.type ? Object.keys(r.type)[0] : 'unknown';
  const how = type === 'file_globbed' ? ` (${(r.type[type].globs || []).join(', ')})` : '';
  return `<code>${html(r.full_path)}</code> — ${type}${html(how)}${r.content ? '' : ' — no content sent'}`;
}

// redacted: { count, paths } of the credentials replaced in `part`.
function renderPart(kind, part, { id, bytes, redacted }) {
  const out = [`# ${KIND_LABEL[kind]} sent with a request`, '',
    `Part \`${id}\` (sha256), ${bytes} bytes. Rebuilt from its sources the way Cursor's client builds it; `
      + 'it is what Cursor sent only where this id is one Cursor used.', ''];
  if (redacted) out.push(redactedNote(redacted), '');
  const section = (title, items, summary) => {
    if (!items || !items.length) return;
    out.push(`## ${title} (${items.length})`, '');
    for (const it of items) out.push(details(summary(it), fields(it)), '');
  };
  if (kind === 'rules') {
    section('Rules', part.rules, ruleSummary);
    section('Rules without a file', part.non_file_rules, ruleSummary);
    if (part.cloud_rule !== undefined) out.push('## Cloud rule', '', fenced(part.cloud_rule), '');
  } else if (kind === 'skills') {
    section('Skills', part.agent_skills, (s) => `<code>${html(s.full_path)}</code>${s.parse_error ? ' — parse error' : ''}`);
    if (part.skill_options) out.push('## Skill options', '', fenced(JSON.stringify(part.skill_options, null, 2), 'json'), '');
  } else if (kind === 'subagents') {
    section('Subagents', part.custom_subagents, (s) => `<b>${html(s.name)}</b> — <code>${html(s.full_path)}</code>`);
  } else if (kind === 'mcps') {
    section('Tools', part.tools, (t) => `<b>${html(t.name)}</b>`);
    section('Server instructions', part.mcp_instructions, (i) => `<b>${html(i.server_name)}</b>`);
    for (const [k, title] of [['mcp_file_system_options', 'MCP folders'], ['mcp_meta_tool_options', 'MCP servers']]) {
      if (part[k]) out.push(details(title, fenced(JSON.stringify(part[k], null, 2), 'json')), '');
    }
  }
  return `${out.join('\n').trimEnd()}\n`;
}

// part: the note is on a part, whose id is the sha256 of the bytes before the replacement.
const redactedNote = (r, part = true) => `Credentials replaced by \`[redacted]\` in ${r.count} place${r.count === 1 ? '' : 's'} (${r.paths.join(', ')}): `
  + `the stored copy differs from what was rebuilt there only${part ? '; the id is the sha256 of the bytes before the replacement' : ''}.`;

// For chat.md: one collapsed section under each user message that has context recorded.
function chatSection(entry, contextDir) {
  if (entry.error) return details('Context sent with this message — could not be rebuilt', `The rebuild failed: ${html(entry.error)}`);
  const lag = Math.round((entry.rebuiltAt - entry.messageAt) / 1000);
  const lines = rc.PARTS.filter((k) => entry.parts && entry.parts[k]).map((k) => {
    const p = entry.parts[k];
    const kept = (entry.storedByCursor || []).includes(k) ? ' — Cursor kept a copy with this id' : '';
    const redacted = p.redacted ? ` — ${p.redacted.count} credential${p.redacted.count === 1 ? '' : 's'} redacted` : '';
    return `- [${KIND_LABEL[k]}](${contextDir}/${p.id}.md): ${p.items} items, ${p.bytes} bytes, \`${p.id.slice(0, 12)}\`${kept}${redacted}`;
  });
  const how = `Rebuilt from the rule, skill, agent and MCP files ${lag >= 0 ? `${lag} s after` : 'around'} the message; `
    + 'not verified against the bytes Cursor sent.';
  const dynamic = entry.dynamic ? ['', details('Environment and git repositories (rebuilt; sent inline with every request)',
    [...(entry.dynamicRedacted ? [redactedNote(entry.dynamicRedacted, false), ''] : []), fenced(JSON.stringify(entry.dynamic, null, 2), 'json')].join('\n'))] : [];
  return details('Context sent with this message, rebuilt (not in the prompt)', [how, '', ...lines, ...(entry.notes || []).map((n) => `- Note: ${html(n)}`), ...dynamic].join('\n'));
}

// For the inspector panel: the latest recorded context of a chat, as a category of items.
function panelCategory(dir, meta) {
  const entry = [...((meta && meta.sentContext) || [])].reverse().find((e) => e.parts);
  if (!entry) return undefined;
  const items = [];
  for (const kind of rc.PARTS) {
    const p = entry.parts[kind] && loadPart(dir, kind, entry.parts[kind].id);
    if (!p) continue;
    const md = renderPart(kind, p.part, { id: p.id, bytes: entry.parts[kind].bytes, redacted: entry.parts[kind].redacted });
    items.push({ id: `sent:${kind}`, label: `${KIND_LABEL[kind]} (${entry.parts[kind].items})`, kind: 'sent_context', text: md, estimatedTokens: Math.ceil(md.length / 4), characterCount: md.length });
  }
  return {
    id: 'sent_context', label: 'Sent with the request, rebuilt (not in the prompt)', estimatedTokens: 0, source: 'history',
    note: `Rebuilt from their sources for the message at ${new Date(entry.messageAt).toISOString()}; not part of Cursor's context usage.`, items,
  };
}

module.exports = { LIVE_MS, record, loadPart, partStrings, renderPart, chatSection, panelCategory, KIND_LABEL };
