'use strict';

// cursor-context wire ls   [--day YYYY-MM-DD] [--grep text] [--root dir] [--json]
// cursor-context wire show <flow> [--raw] [--json] [--clip N] [--schema file.json | --app dir] [--root dir]
// cursor-context wire conv    [<conversation id prefix>] [--day D] [--json] [--clip N | --full]
// cursor-context wire compare [<chat name | composerId prefix>] [--day D] [--json] [--clip N | --full]
//                             [--history dir] [--db state.vscdb | --no-db] [--record-now]
// --record-now compares against a fresh record: the plugin's own recordChat run now, on Cursor's DB,
// into a temporary history folder (the real history is not touched).
// <flow> is a flow directory, or its name (e.g. 101500-00002-aiserver.v1.AiService_ServerTime, or a
// unique part of it). An index into the `wire ls` listing (with the same --day/--grep) also works,
// but shifts while the proxy is recording.

const fs = require('node:fs');
const path = require('node:path');
const flows = require('./flows.cjs');
const { renderFlow } = require('./render.cjs');
const conversation = require('./conversation.cjs');
const compareLib = require('./compare.cjs');
const report = require('./report.cjs');

const USAGE = `usage:
  cursor-context wire ls [--day YYYY-MM-DD] [--grep text] [--json]
  cursor-context wire show <flow dir or name> [--raw] [--json] [--clip N] [--schema file.json | --app dir]
      <flow> may also be a \`wire ls\` index (same --day/--grep), but indexes shift while recording
  cursor-context wire conv [<conversation id prefix>] [--day D] [--json] [--clip N | --full]
      agent conversations rebuilt from the Run/RunSSE/BidiAppend flows: every client and server message
  cursor-context wire compare [<chat name | composerId prefix>] [--day D] [--json] [--clip N | --full]
                              [--history dir] [--db state.vscdb | --no-db] [--record-now]
      the rebuilt conversations against what the plugin recorded (default ~/.cursor-context-history
      and Cursor's state.vscdb, read-only); --record-now records them afresh, with the plugin's own
      recorder, into a temporary folder and compares against that
  captures are read from --root, $CURSOR_WIRE_DIR or ~/.cursor-wire;
  the schema is extracted from Cursor at --app (cached), or read from --schema (cursor-wire-schema --out)`;

// Returns { schema, note }: from a schema JSON file, else extracted from the Cursor app (cached).
function loadSchema({ file, appDir } = {}) {
  let schema;
  try {
    schema = file ? JSON.parse(fs.readFileSync(file, 'utf8')) : require('./schema.cjs').loadSchema(appDir ? { appDir } : {});
  } catch (e) {
    return { schema: null, note: `schema-less (no schema: ${e.message}): fields shown by number` };
  }
  if (!schema || !schema.messages) return { schema: null, note: 'schema-less (no schema found): fields shown by number' };
  const cursor = schema.cursor && schema.cursor.version;
  const n = (o) => Object.keys(o || {}).length;
  return { schema, note: `schema${cursor ? ` from Cursor ${cursor}` : ''}: ${n(schema.messages)} messages, ${n(schema.enums)} enums, ${n(schema.services)} services` };
}

function parseArgs(argv) {
  const opts = { _: [] };
  const valued = new Set(['--day', '--grep', '--clip', '--root', '--schema', '--app', '--history', '--db']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valued.has(a)) opts[a.slice(2)] = argv[++i];
    else if (a.startsWith('--')) opts[a.slice(2)] = true;
    else opts._.push(a);
  }
  return opts;
}

const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)}M` : n >= 1024 ? `${(n / 1024).toFixed(1)}K` : String(n));

// The stable short name of a flow: "HHMMSS-<n>" of its directory, which `wire show` accepts.
const shortId = (f) => (/^\d{6}-\d+/.exec(f.id) || [f.id])[0];

function findFlow(ref, opts) {
  if (/^\d+$/.test(ref)) {
    const list = flows.listFlows({ root: opts.root, day: opts.day, grep: opts.grep });
    const f = list[Number(ref)];
    if (!f) throw new Error(`no flow #${ref} (${list.length} listed)`);
    return f.dir;
  }
  if (fs.existsSync(path.join(ref, 'meta.json'))) return path.resolve(ref);
  const all = flows.listFlows({ root: opts.root, day: opts.day });
  const name = ref.replace(/\/+$/, '');
  const exact = all.filter((f) => f.id === name || f.dir.endsWith(`${path.sep}${name}`));
  const matches = exact.length ? exact : all.filter((f) => f.id.includes(name));
  if (matches.length === 1) return matches[0].dir;
  throw new Error(matches.length ? `"${ref}" matches ${matches.length} flows: ${matches.slice(0, 5).map((f) => `${f.day}/${f.id}`).join(', ')}` : `no flow "${ref}"`);
}

async function run(argv, out = process.stdout) {
  const opts = parseArgs(argv);
  const [cmd, ref] = opts._;
  const print = (s) => out.write(`${s}\n`);
  if (cmd === 'ls') {
    const list = flows.listFlows({ root: opts.root, day: opts.day, grep: opts.grep });
    if (opts.json) {
      print(JSON.stringify(list, null, 2));
      return 0;
    }
    list.forEach((f, i) => {
      const status = `${f.status ?? (f.error ? 'ERR' : '...')}${f.grpcStatus !== undefined ? `/${f.grpcStatus}` : ''}`;
      const what = f.service ? `${f.service}/${f.rpc}` : String(f.url).split('?')[0];
      print(`${String(i).padStart(4)}  ${f.day} ${shortId(f).padEnd(12)}  ${String(f.method).padEnd(4)} ${status.padEnd(7)} ${kb(f.requestBytes).padStart(7)} ${kb(f.responseBytes).padStart(7)}  ${what}`);
    });
    if (!list.length) print(`no flows under ${opts.root || flows.defaultRoot()}`);
    return 0;
  }
  if (cmd === 'show' && ref) {
    const dir = findFlow(ref, opts);
    const { schema, note } = opts.raw ? { schema: null, note: 'schema-less (--raw): fields shown by number' } : loadSchema({ file: opts.schema, appDir: opts.app });
    const flow = flows.decodeFlow(dir, schema);
    if (opts.json) {
      print(JSON.stringify({ schema: note, ...flow }, null, 2));
      return 0;
    }
    const clip = opts.clip ? Number(opts.clip) : undefined;
    print(`${note}\n${renderFlow(flow, { clip })}`);
    return 0;
  }
  if (cmd === 'conv' || cmd === 'compare') {
    const { schema, note } = loadSchema({ file: opts.schema, appDir: opts.app });
    if (!schema) throw new Error(`agent conversations need the schema: ${note}`);
    const rebuilt = conversation.reconstruct({ root: opts.root, day: opts.day, schema });
    const clip = opts.full ? 0 : opts.clip ? Number(opts.clip) : 400;
    if (cmd === 'conv') {
      const list = rebuilt.conversations.filter((c) => !ref || c.conversationId.startsWith(ref));
      if (opts.json) {
        print(JSON.stringify({ schema: note, conversations: list, unassigned: rebuilt.unassigned, flowErrors: rebuilt.flowErrors }, jsonReplacer, 2));
        return 0;
      }
      print(note);
      for (const c of list) print(`\n${report.renderConversation(c, { clip })}`);
      if (rebuilt.unassigned.length) print(`\n${rebuilt.unassigned.length} runs without a conversation id: ${rebuilt.unassigned.map((r) => r.flow.id).join(', ')}`);
      for (const e of rebuilt.flowErrors) print(`flow ${e.flow.id}: ${e.error}`);
      if (!list.length) print('no agent conversations in the captures');
      return 0;
    }
    let historyDir = opts.history || require('../history.cjs').defaultHistoryDir();
    const db = opts['no-db'] ? null : openDb(opts.db);
    let fresh;
    try {
      if (opts['record-now']) {
        if (!db) throw new Error('--record-now needs Cursor\'s DB');
        const history = require('../history.cjs');
        fresh = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'cursor-context-record-'));
        for (const c of rebuilt.conversations) history.recordChat(db, c.conversationId, fresh);
        historyDir = fresh;
      }
      const results = compareLib.compare({ conversations: rebuilt.conversations, historyDir, db, ref });
      if (opts.json) {
        print(JSON.stringify({ schema: note, historyDir, db: !!db, comparisons: results, unassigned: rebuilt.unassigned.map((r) => r.flow), flowErrors: rebuilt.flowErrors }, jsonReplacer, 2));
        return 0;
      }
      print(`${note}\nrecord: ${historyDir}${db ? ' + Cursor DB' : ''}`);
      for (const r of results) print(`\n${report.renderComparison(r, { clip })}`);
      if (!results.length) print(ref ? `no captured agent conversation for "${ref}"` : 'no agent conversations in the captures');
      return 0;
    } finally {
      if (db) db.close();
      if (fresh) fs.rmSync(fresh, { recursive: true, force: true });
    }
  }
  process.stderr.write(`${USAGE}\n`);
  return 2;
}

// Cursor's DB, read-only, if it exists; compare works without it (fewer checks).
function openDb(file) {
  const store = require('../cursorStore.cjs');
  const p = file || store.defaultDatabasePath();
  if (!fs.existsSync(p)) return null;
  return store.openDatabase(p);
}

// Buffers (blob bytes) as base64, Maps as objects: --json keeps every byte.
function jsonReplacer(key, value) {
  if (value && value.type === 'Buffer' && Array.isArray(value.data)) return { base64: Buffer.from(value.data).toString('base64') };
  if (value instanceof Map) return Object.fromEntries(value);
  return value;
}

module.exports = { run, loadSchema, parseArgs };
