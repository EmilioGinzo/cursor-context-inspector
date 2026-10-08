'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const history = require('../src/history.cjs');

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  const put = (k, v) => db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(k, v);
  const blob = (m) => {
    const raw = Buffer.from(JSON.stringify(m));
    const hash = crypto.createHash('sha256').update(raw).digest();
    put(`agentKv:blob:${hash.toString('hex')}`, raw);
    return hash;
  };
  const save = (lastUpdatedAt, messages) => {
    const state = Buffer.concat(messages.flatMap((m) => [Buffer.from([0x0a, 0x20]), blob(m)]));
    put('composerData:chat-1', JSON.stringify({
      name: 'History chat', lastUpdatedAt, conversationState: `~${state.toString('base64')}`,
      promptTokenBreakdown: { totalUsedTokens: 10, maxTokens: 100, categories: [] },
    }));
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-history-'));
  return { db, save, dir };
}

const sys = { role: 'system', content: 'You are an agent.' };
const first = { role: 'user', content: 'first question' };
const answer = { role: 'assistant', content: [{ type: 'text', text: 'first answer' }] };
const summary = { role: 'user', content: '[Previous conversation summary]: asked and answered' };

test('records snapshots, dedupes blobs, keeps messages dropped by summarization', () => {
  const { db, save, dir } = setup();
  save(1000, [sys, first, answer]);
  assert.strictEqual(history.recordUpdatedSince(db, dir, 0).recorded, 1);
  assert.strictEqual(history.recordUpdatedSince(db, dir, 0).recorded, 0, 'unchanged chat is not re-recorded');

  save(2000, [sys, summary]);
  assert.strictEqual(history.recordUpdatedSince(db, dir, 1000).recorded, 1);

  const chat = path.join(dir, 'chats', 'chat-1');
  assert.deepStrictEqual(fs.readdirSync(path.join(chat, 'snapshots')).sort(), ['1000.json', '2000.json']);
  assert.strictEqual(fs.readdirSync(path.join(dir, 'blobs')).length, 4, 'system message stored once');
  const meta = JSON.parse(fs.readFileSync(path.join(chat, 'meta.json'), 'utf8'));
  assert.strictEqual(meta.seen.length, 4);
  assert.strictEqual(meta.snapshots, 2);

  const md = fs.readFileSync(path.join(chat, 'transcript.md'), 'utf8');
  assert.match(md, /## #1 user \(no longer in prompt\)\n\nfirst question/);
  assert.match(md, /## #2 assistant \(no longer in prompt\)\n\nfirst answer/);
  assert.match(md, /## #3 user\n\n\[Previous conversation summary\]/);
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.strictEqual(index[0].name, 'History chat');
});

test('only one recorder holds the lock', () => {
  const { db, save, dir } = setup();
  save(1000, [sys]);
  fs.writeFileSync(path.join(dir, '.recorder.lock'), JSON.stringify({ pid: -1, at: Date.now() }));
  assert.strictEqual(history.tick(db, dir).skipped, 'another window is recording');
  fs.writeFileSync(path.join(dir, '.recorder.lock'), JSON.stringify({ pid: -1, at: Date.now() - 200000 }));
  assert.strictEqual(history.tick(db, dir, { backfillDays: 1e6 }).recorded, 1, 'stale lock is taken over');
});
