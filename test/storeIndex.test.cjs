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
