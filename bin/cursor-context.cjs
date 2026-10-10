#!/usr/bin/env node
'use strict';

// CLI: print the context breakdown of a Cursor chat, or the text of one item.
//   cursor-context [--list] [--chat <id>] [--show <categoryId|itemId>] [--db <path>]
// and inspect captured client<->server traffic (see src/wire/cli.cjs):
//   cursor-context wire ls [--day YYYY-MM-DD] [--grep text]
//   cursor-context wire show <flowdir|index> [--raw] [--json] [--clip N]

const args = process.argv.slice(2);

if (args[0] === 'wire') {
  require('../src/wire/cli.cjs').run(args.slice(1)).then(
    (code) => { process.exitCode = code; },
    (e) => { console.error(e.message); process.exitCode = 1; },
  );
  return;
}

const store = require('../src/cursorStore.cjs');
const opt = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};

const db = store.openDatabase(opt('--db') || store.defaultDatabasePath());
const chats = store.listComposers(db, 30);

if (args.includes('--list')) {
  for (const c of chats) {
    console.log(`${c.id}  ${new Date(c.lastUpdatedAt).toISOString()}  ${String(c.used ?? '?').padStart(7)} tok  ${c.hasTree ? 'tree' : '    '}  ${c.name}`);
  }
  process.exit(0);
}

const chatId = opt('--chat') || (chats[0] && chats[0].id);
if (!chatId) {
  console.error('No Cursor agent chats found.');
  process.exit(1);
}
const ctx = store.loadContext(db, chatId);

function flatten(items, out = []) {
  for (const i of items) {
    out.push(i);
    if (i.children) flatten(i.children, out);
  }
  return out;
}

const show = opt('--show');
if (show) {
  const cat = ctx.categories.find((c) => c.id === show);
  const items = cat ? cat.items : flatten(ctx.categories.flatMap((c) => c.items)).filter((i) => i.id === show);
  if (!items.length) {
    console.error(`No category or item "${show}"`);
    process.exit(1);
  }
  for (const i of items) {
    console.log(`===== ${i.label} (~${i.estimatedTokens} tok)`);
    console.log(i.text ?? i.unavailable ?? (i.children || []).map((c) => c.text).join('\n'));
  }
  process.exit(0);
}

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
console.log(`${ctx.name}  [${ctx.composerId}]  model=${ctx.model}  tree=${ctx.hasTree}  messages=${ctx.messageCount}`);
console.log(`${k(ctx.totalUsedTokens)} / ${k(ctx.maxTokens)} tokens`);
for (const c of ctx.categories) {
  const chars = flatten(c.items).filter((i) => !i.children).reduce((s, i) => s + (i.text ? i.text.length : 0), 0);
  console.log(`  ${c.label.padEnd(26)} ${k(c.estimatedTokens).padStart(7)}   ${String(c.items.length).padStart(4)} items  ${String(chars).padStart(8)} chars  (${c.source})`);
}
