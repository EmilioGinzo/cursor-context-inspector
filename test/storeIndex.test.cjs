'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const storeIndex = require('../src/storeIndex.cjs');
const history = require('../src/history.cjs');

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-index-'));
  return { db, dir };
}

// A clock that moves one ms per call: a budget of n ms allows about n steps.
function stepClock() {
  let now = 0;
  return () => ++now;
}

const hashOf = (m) => crypto.createHash('sha256').update(JSON.stringify(m)).digest('hex');
const putBlob = (db, m) => {
  const raw = Buffer.from(JSON.stringify(m));
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(`agentKv:blob:${hashOf(m)}`, raw);
  return hashOf(m);
};
const fill = (db, n) => {
  db.exec('BEGIN');
  for (let i = 0; i < n; i++) db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(`bubbleId:filler:${i}`, 'x'.repeat(50));
  db.exec('COMMIT');
};

test('the index reads each row once, and a second advance reads none', () => {
  const { db, dir } = setup();
  const index = storeIndex.open(dir);
  const call = { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tool_a', args: {} }] };
  const result = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tool_a', result: 'read' }] };
  const callHash = putBlob(db, call);
  const resultHash = putBlob(db, result);
  fill(db, 40);
  const first = index.advance(db);
  assert.strictEqual(first.caughtUp, true);
  assert.strictEqual(index.stats.rowsRead, 42);
  assert.deepStrictEqual(index.callHashes('tool_a').sort(), [callHash, resultHash].sort());
  index.advance(db);
  assert.strictEqual(index.stats.rowsRead, 42, 'no row is read twice');
  // Rows written later are read once more, and only those.
  putBlob(db, { role: 'user', content: 'later' });
  index.advance(db);
  assert.strictEqual(index.stats.rowsRead, 43);
});

test('an advance stops at its time budget and resumes where it stopped', () => {
  const { db, dir } = setup();
  const index = storeIndex.open(dir);
  fill(db, 1000); // four steps of 256 rows
  const step = index.advance(db, { budgetMs: 2, clock: stepClock(), chunkRows: 256 });
  assert.strictEqual(step.caughtUp, false);
  assert.ok(step.steps >= 1 && step.steps < 4, `steps: ${step.steps}`);
  assert.strictEqual(index.watermark(), step.watermark);
  const rest = index.advance(db, { budgetMs: Infinity, chunkRows: 256 });
  assert.strictEqual(rest.caughtUp, true);
  assert.strictEqual(index.stats.rowsRead, 1000, 'every row once across the steps');
});

test('a step always runs, even with no budget left', () => {
  const { db, dir } = setup();
  const index = storeIndex.open(dir);
  fill(db, 10);
  const step = index.advance(db, { budgetMs: 0, clock: stepClock() });
  assert.strictEqual(step.steps, 1);
  assert.strictEqual(step.caughtUp, true);
});

test('rows renumbered or removed under the watermark are read again', () => {
  const { db, dir } = setup();
  const index = storeIndex.open(dir);
  const call = { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tool_b', args: {} }] };
  putBlob(db, call);
  fill(db, 5);
  index.advance(db);
  const read = index.stats.rowsRead;
  // The last row is removed and another written: its rowid is reused, and nothing is indexed for it.
  db.prepare("DELETE FROM cursorDiskKV WHERE key LIKE 'bubbleId:filler:4'").run();
  putBlob(db, { role: 'user', content: 'after a vacuum' });
  index.advance(db);
  assert.ok(index.stats.rowsRead > read, 'the rows are read again');
  assert.strictEqual(index.watermark(), db.prepare('SELECT max(rowid) AS m FROM cursorDiskKV').get().m);
  assert.strictEqual(index.callHashes('tool_b').length, 1, 'entries already there are kept once');
});

test('a chat row Cursor replaces at the end of the store does not read the store again', () => {
  const { db, dir } = setup();
  const index = storeIndex.open(dir);
  putBlob(db, { role: 'user', content: 'hi' });
  fill(db, 300);
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('composerData:a', '{}');
  index.advance(db);
  const read = index.stats.rowsRead;
  // UNIQUE ON CONFLICT REPLACE: the row is removed, and written again with the next rowid.
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('composerData:a', '{"lastUpdatedAt":1}');
  index.advance(db);
  assert.strictEqual(index.stats.rowsRead - read, 1, 'only the new row is read');
});

test('rows renumbered by a vacuum are read again', () => {
  const { db, dir } = setup();
  const index = storeIndex.open(dir);
  fill(db, 5);
  putBlob(db, { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tool_c', args: {} }] });
  index.advance(db);
  // The fillers before the blob are removed and the rows renumbered: the blob is now at rowid 1.
  db.exec("DELETE FROM cursorDiskKV WHERE key LIKE 'bubbleId:filler:%'; CREATE TABLE t AS SELECT key, value FROM cursorDiskKV; DELETE FROM cursorDiskKV; INSERT INTO cursorDiskKV SELECT * FROM t; DROP TABLE t;");
  putBlob(db, { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tool_d', args: {} }] });
  index.advance(db);
  assert.strictEqual(index.callHashes('tool_d').length, 1);
  assert.strictEqual(index.callHashes('tool_c').length, 1);
});

test('chats are recorded while the store is read again, once it was read in full', () => {
  const { db, dir } = setup();
  const message = { role: 'user', content: 'hi' };
  putBlob(db, message);
  fill(db, 600);
  const budget = { index: 0, record: Infinity };
  const clock = stepClock();
  while (history.tick(db, dir, { clock, budgetMs: budget }).indexing);
  // Renumbered rows (the blob read last is gone): the store is read again, three ticks of 256 rows.
  db.exec("DELETE FROM cursorDiskKV WHERE key LIKE 'agentKv:blob:%'");
  putBlob(db, message);
  fill(db, 10);
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('composerData:a', composerOf('chat a', Date.now() + 1000, message));
  const tick = history.tick(db, dir, { clock, budgetMs: budget });
  assert.strictEqual(tick.indexing, true);
  assert.strictEqual(tick.recorded, 1);
});

test('the last rows removed, the index keeps its place and reads the rows given their rowids again', () => {
  const { db, dir } = setup();
  const index = storeIndex.open(dir);
  putBlob(db, { role: 'user', content: 'first' });
  fill(db, 300);
  index.advance(db);
  const read = index.stats.rowsRead;
  db.prepare("DELETE FROM cursorDiskKV WHERE key IN ('bubbleId:filler:298', 'bubbleId:filler:299')").run();
  index.advance(db);
  assert.strictEqual(index.stats.rowsRead, read, 'nothing is read again');
  // The next rows are given the removed rowids.
  putBlob(db, { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tool_e', args: {} }] });
  index.advance(db);
  assert.strictEqual(index.callHashes('tool_e').length, 1);
  assert.ok(index.stats.rowsRead - read < 300);
});

test('an index that read no blob yet still finds a blob given a removed rowid', () => {
  const { db, dir } = setup();
  const index = storeIndex.open(dir);
  for (const k of ['a', 'b', 'c']) db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(`composerData:${k}`, '{}');
  index.advance(db);
  db.prepare("DELETE FROM cursorDiskKV WHERE key IN ('composerData:b', 'composerData:c')").run();
  putBlob(db, { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tool_x', args: {} }] });
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('composerData:d', '{}');
  index.advance(db);
  assert.strictEqual(index.callHashes('tool_x').length, 1);
});

test('a blob row without a value does not make each advance read again', () => {
  const { db, dir } = setup();
  const index = storeIndex.open(dir);
  putBlob(db, { role: 'user', content: 'first' });
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, NULL)').run('agentKv:blob:empty');
  fill(db, 300);
  index.advance(db);
  const read = index.stats.rowsRead;
  index.advance(db);
  index.advance(db);
  assert.strictEqual(index.stats.rowsRead, read);
});

test('a tick records the chats asked for, changed or not, and says which', () => {
  const { db, dir } = setup();
  const message = { role: 'user', content: 'hi' };
  putBlob(db, message);
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('composerData:old', composerOf('old chat', 5, message));
  const now = Date.now();
  assert.deepStrictEqual(history.tick(db, dir, { clock: () => now }).requested, []);
  fs.rmSync(path.join(dir, 'index.json'));
  // Unchanged since the last tick: recorded again only because it is asked for.
  const tick = history.tick(db, dir, { clock: () => now, record: ['old'] });
  assert.deepStrictEqual(tick.requested, ['old']);
  assert.ok(fs.existsSync(path.join(dir, 'chats', 'old chat', 'chat.md')));
  assert.ok(JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).some((c) => c.composerId === 'old'));
});

// The conversation state of a chat whose prompt is this one message (field 1: its blob hash).
const stateOf = (message) => {
  const digest = crypto.createHash('sha256').update(JSON.stringify(message)).digest();
  return `~${Buffer.concat([Buffer.from([0x0a, 0x20]), digest]).toString('base64')}`;
};
const composerOf = (name, lastUpdatedAt, message) => JSON.stringify({
  name, lastUpdatedAt, conversationState: stateOf(message), promptTokenBreakdown: { totalUsedTokens: 1, maxTokens: 10, categories: [] },
});

test('a tick records nothing until the store is read, then records every chat', () => {
  const { db, dir } = setup();
  const message = { role: 'user', content: 'hi' };
  putBlob(db, message);
  fill(db, 600);
  for (const id of ['a', 'b']) db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(`composerData:${id}`, composerOf(`chat ${id}`, 500, message));
  const budget = { index: 0, record: Infinity };
  const clock = stepClock();
  // 600 filler rows are three steps of 256: the store is read over three ticks, and nothing is recorded before.
  const first = history.tick(db, dir, { clock, budgetMs: budget });
  assert.strictEqual(first.storeIndexed, false);
  assert.strictEqual(first.recorded, 0);
  assert.strictEqual(history.tick(db, dir, { clock, budgetMs: budget }).storeIndexed, false);
  const third = history.tick(db, dir, { clock, budgetMs: budget });
  assert.strictEqual(third.storeIndexed, true);
  assert.strictEqual(third.recorded, 2);
  assert.ok(fs.existsSync(path.join(dir, 'chats', 'chat a')));
});

test('a tick that runs out of time says it is behind, and the next records the rest', () => {
  const { db, dir } = setup();
  const message = { role: 'user', content: 'hi' };
  putBlob(db, message);
  const now = Date.now();
  history.tick(db, dir, { clock: () => now });
  for (const [i, id] of ['a', 'b'].entries()) db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(`composerData:${id}`, composerOf(`chat ${id}`, now + 1 + i, message));
  const first = history.tick(db, dir, { clock: stepClock(), budgetMs: { index: Infinity, record: 0 } });
  assert.strictEqual(first.recorded, 1);
  assert.strictEqual(first.behind, true);
  const second = history.tick(db, dir, { clock: stepClock(), budgetMs: { index: Infinity, record: 0 } });
  assert.strictEqual(second.recorded, 1);
  assert.strictEqual(second.behind, false);
});

test('a record stops at its deadline, after the chats that share its time, and resumes with the next', () => {
  const { db, dir } = setup();
  const message = { role: 'user', content: 'hi' };
  putBlob(db, message);
  for (const id of ['a', 'b', 'c']) db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(`composerData:${id}`, composerOf(`chat ${id}`, 100, message));
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('composerData:d', composerOf('chat d', 200, message));
  const index = storeIndex.open(dir);
  index.advance(db);
  // The clock moves one ms per call and the deadline is 2: after a, the deadline has passed, but b and c
  // share a's time, so they are recorded too; d is left for the next call.
  const first = history.recordUpdatedSince(db, dir, 0, { clock: stepClock(), deadline: 2, index });
  assert.strictEqual(first.stopped, true);
  assert.strictEqual(first.more, true);
  assert.strictEqual(first.recorded, 3);
  assert.strictEqual(first.watermark, 100);
  const second = history.recordUpdatedSince(db, dir, first.watermark, { clock: () => 0, index });
  assert.strictEqual(second.recorded, 1);
  assert.strictEqual(second.more, false);
  const all = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).map((c) => c.composerId).sort();
  assert.deepStrictEqual(all, ['a', 'b', 'c', 'd']);
});

test('a record always records at least one chat, even past its deadline', () => {
  const { db, dir } = setup();
  const message = { role: 'user', content: 'hi' };
  putBlob(db, message);
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('composerData:a', composerOf('chat a', 100, message));
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('composerData:b', composerOf('chat b', 200, message));
  const result = history.recordUpdatedSince(db, dir, 0, { clock: () => 10, deadline: 0 });
  assert.strictEqual(result.recorded, 1);
  assert.strictEqual(result.watermark, 100);
});

test('a chat another connection writes is recorded, though the chat list was read before', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-shared-'));
  const file = path.join(dir, 'state.vscdb');
  const writer = new DatabaseSync(file);
  writer.exec('CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  const message = { role: 'user', content: 'hi' };
  writer.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(`agentKv:blob:${hashOf(message)}`, Buffer.from(JSON.stringify(message)));
  writer.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('composerData:a', composerOf('chat a', 100, message));
  const reader = new DatabaseSync(file, { readOnly: true });
  const historyDir = path.join(dir, 'history');
  history.recordUpdatedSince(reader, historyDir, 0);
  // Cursor's connection writes a chat later: the reader's list is stale unless the change is seen.
  writer.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('composerData:b', composerOf('chat b', 300, message));
  const next = history.recordUpdatedSince(reader, historyDir, 200);
  assert.strictEqual(next.recorded, 1);
  const all = JSON.parse(fs.readFileSync(path.join(historyDir, 'index.json'), 'utf8')).map((c) => c.composerId).sort();
  assert.deepStrictEqual(all, ['a', 'b']);
  reader.close();
  writer.close();
});
