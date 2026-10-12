#!/usr/bin/env node
'use strict';

// CLI: extract Cursor's protobuf schema from its JS bundles.
//   cursor-wire-schema [--app <dir>] [--cache <dir>] [--fresh] [--out <file|->]
// Prints a summary; --out writes the schema JSON (- for stdout).
// Cached in ~/.cursor-wire/schema/<version>-<commit>.v<format>.json; --fresh
// re-extracts and refreshes the cache.

const fs = require('node:fs');
const schemaLib = require('../src/wire/schema.cjs');

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const appDir = opt('--app') || schemaLib.DEFAULT_APP_DIR;
const cacheDir = opt('--cache') || schemaLib.DEFAULT_CACHE_DIR;
const out = opt('--out');

if (!fs.existsSync(appDir)) {
  console.error(`Cursor app directory not found: ${appDir} (use --app <dir>)`);
  process.exit(1);
}

const started = Date.now();
const schema = schemaLib.loadSchema({ appDir, cacheDir, fresh: args.includes('--fresh') });
const ms = Date.now() - started;

if (out === '-') {
  process.stdout.write(`${JSON.stringify(schema, null, 2)}\n`);
  process.exit(0);
}
if (out) fs.writeFileSync(out, `${JSON.stringify(schema, null, 2)}\n`);

const count = (o) => Object.keys(o).length;
const methods = Object.values(schema.services).reduce((n, s) => n + count(s.methods), 0);
const log = (s) => process.stderr.write(`${s}\n`);
log(`Cursor ${schema.cursor.version} (${schema.cursor.commit}) at ${schema.cursor.appDir}`);
log(`  messages   ${count(schema.messages)}`);
log(`  enums      ${count(schema.enums)}`);
log(`  services   ${count(schema.services)} (${methods} methods)`);
log(`  unresolved ${schema.unresolved.length}`);
for (const u of schema.unresolved.slice(0, 20)) log(`    ${u.type} ${u.field ?? ''} -> ${u.ref}  (${u.file})`);
if (schema.unresolved.length > 20) log(`    ... ${schema.unresolved.length - 20} more`);
log(`  ${ms} ms${out ? `, written to ${out}` : ''}`);
