'use strict';

// cursor-context wire ls   [--day YYYY-MM-DD] [--grep text] [--root dir] [--json]
// cursor-context wire show <flowdir|index|id> [--day ..] [--grep ..] [--raw] [--json] [--clip N] [--root dir]
// An index refers to the `wire ls` listing with the same --day/--grep filters.

const fs = require('node:fs');
const path = require('node:path');
const flows = require('./flows.cjs');
const { renderFlow } = require('./render.cjs');

const USAGE = `usage:
  cursor-context wire ls [--day YYYY-MM-DD] [--grep text] [--json]
  cursor-context wire show <flowdir|index|id> [--day ..] [--grep ..] [--raw] [--json] [--clip N]
  (captures are read from --root, $CURSOR_WIRE_DIR or ~/.cursor-wire)`;

// Returns { schema, note }. Uses src/wire/schema.cjs when that module exists.
async function loadSchema() {
  let mod;
  try {
    mod = require('./schema.cjs');
  } catch (e) {
    if (e.code === 'MODULE_NOT_FOUND' && String(e.message).includes('schema.cjs')) {
      return { schema: null, note: 'schema-less (src/wire/schema.cjs is not available): fields shown by number' };
    }
    return { schema: null, note: `schema-less (loading src/wire/schema.cjs failed: ${e.message})` };
  }
  try {
    const schema = await mod.loadSchema();
    if (!schema || !schema.messages) return { schema: null, note: 'schema-less (no schema found): fields shown by number' };
    const cursor = schema.cursor && (schema.cursor.version || schema.cursor.path);
    const n = (o) => Object.keys(o || {}).length;
    return { schema, note: `schema${cursor ? ` from Cursor ${cursor}` : ''}: ${n(schema.messages)} messages, ${n(schema.enums)} enums, ${n(schema.services)} services` };
  } catch (e) {
    return { schema: null, note: `schema-less (loadSchema failed: ${e.message})` };
  }
}

function parseArgs(argv) {
  const opts = { _: [] };
  const valued = new Set(['--day', '--grep', '--clip', '--root']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (valued.has(a)) opts[a.slice(2)] = argv[++i];
    else if (a.startsWith('--')) opts[a.slice(2)] = true;
    else opts._.push(a);
  }
  return opts;
}

const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)}M` : n >= 1024 ? `${(n / 1024).toFixed(1)}K` : String(n));

function time(started) {
  if (!started) return '        ';
  const d = new Date(started * 1000);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':');
}

function findFlow(ref, opts) {
  if (/^\d+$/.test(ref)) {
    const list = flows.listFlows({ root: opts.root, day: opts.day, grep: opts.grep });
    const f = list[Number(ref)];
    if (!f) throw new Error(`no flow #${ref} (${list.length} listed)`);
    return f.dir;
  }
  if (fs.existsSync(path.join(ref, 'meta.json'))) return path.resolve(ref);
  const matches = flows.listFlows({ root: opts.root, day: opts.day }).filter((f) => f.id === ref || f.dir.endsWith(ref) || f.id.includes(ref));
  if (matches.length === 1) return matches[0].dir;
  throw new Error(matches.length ? `"${ref}" matches ${matches.length} flows` : `no flow "${ref}"`);
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
      print(`${String(i).padStart(4)}  ${f.day} ${time(f.started)}  ${String(f.method).padEnd(4)} ${status.padEnd(7)} ${kb(f.requestBytes).padStart(7)} ${kb(f.responseBytes).padStart(7)}  ${what}`);
    });
    if (!list.length) print(`no flows under ${opts.root || flows.defaultRoot()}`);
    return 0;
  }
  if (cmd === 'show' && ref) {
    const dir = findFlow(ref, opts);
    const { schema, note } = opts.raw ? { schema: null, note: 'schema-less (--raw): fields shown by number' } : await loadSchema();
    const flow = flows.decodeFlow(dir, schema);
    if (opts.json) {
      print(JSON.stringify({ schema: note, ...flow }, null, 2));
      return 0;
    }
    const clip = opts.clip ? Number(opts.clip) : undefined;
    print(`${note}\n${renderFlow(flow, { clip })}`);
    return 0;
  }
  process.stderr.write(`${USAGE}\n`);
  return 2;
}

module.exports = { run, loadSchema, parseArgs };
