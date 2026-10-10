'use strict';

// cursor-context wire ls   [--day YYYY-MM-DD] [--grep text] [--root dir] [--json]
// cursor-context wire show <flow> [--raw] [--json] [--clip N] [--schema file.json | --app dir] [--root dir]
// <flow> is a flow directory, or its name (e.g. 101500-00002-aiserver.v1.AiService_ServerTime, or a
// unique part of it). An index into the `wire ls` listing (with the same --day/--grep) also works,
// but shifts while the proxy is recording.

const fs = require('node:fs');
const path = require('node:path');
const flows = require('./flows.cjs');
const { renderFlow } = require('./render.cjs');

const USAGE = `usage:
  cursor-context wire ls [--day YYYY-MM-DD] [--grep text] [--json]
  cursor-context wire show <flow dir or name> [--raw] [--json] [--clip N] [--schema file.json | --app dir]
      <flow> may also be a \`wire ls\` index (same --day/--grep), but indexes shift while recording
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
  const valued = new Set(['--day', '--grep', '--clip', '--root', '--schema', '--app']);
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
  process.stderr.write(`${USAGE}\n`);
  return 2;
}

module.exports = { run, loadSchema, parseArgs };
