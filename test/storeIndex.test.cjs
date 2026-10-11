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
