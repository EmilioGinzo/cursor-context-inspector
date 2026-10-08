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

function multi() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  const put = (k, v) => db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(k, v);
  const chat = (id, t, messages, extra = {}) => {
    const state = Buffer.concat(messages.flatMap((m) => {
      const raw = Buffer.from(JSON.stringify(m));
      const hash = crypto.createHash('sha256').update(raw).digest();
      put(`agentKv:blob:${hash.toString('hex')}`, raw);
      return [Buffer.from([0x0a, 0x20]), hash];
    }));
    put(`composerData:${id}`, JSON.stringify({ name: id, lastUpdatedAt: t, createdAt: t, conversationState: `~${state.toString('base64')}`, promptTokenBreakdown: { categories: [] }, ...extra }));
  };
  const spawn = (callId) => ({ role: 'assistant', content: [{ type: 'text', text: 'delegating' }, { type: 'tool-call', toolName: 'Subagent', toolCallId: callId, args: { prompt: 'go' } }] });
  const sub = (parent, callId, type = 'explore') => ({ subagentInfo: { parentComposerId: parent, toolCallId: callId, subagentTypeName: type } });
  chat('root', 1000, [sys, first, spawn('tool_aaa')], { subagentComposerIds: ['child'] });
  chat('child', 1001, [sys, { role: 'user', content: 'child task' }, spawn('tool_bbb')], { subagentComposerIds: ['grandchild'], ...sub('root', 'tool_aaa') });
  chat('grandchild', 1002, [sys, { role: 'user', content: 'grandchild task' }], sub('child', 'tool_bbb', 'generalPurpose'));
  return { db, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-history-')) };
}

test('subagents are stored inside their parent folder, nested, and linked where spawned', () => {
  const { db, dir } = multi();
  assert.strictEqual(history.recordUpdatedSince(db, dir, 0).recorded, 3);
  const root = path.join(dir, 'chats', 'root');
  const child = path.join(root, 'subagents', 'child');
  const grandchild = path.join(child, 'subagents', 'grandchild');
  for (const d of [root, child, grandchild]) assert.ok(fs.existsSync(path.join(d, 'transcript.md')), d);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'chats')), ['root']);

  const rootMd = fs.readFileSync(path.join(root, 'transcript.md'), 'utf8');
  assert.match(rootMd, /- Subagents \(1\):\n {2}- \[child\]\(subagents\/child\/transcript\.md\) \(explore\)/);
  assert.match(rootMd, /\[tool call: Subagent\][\s\S]*\n> ↳ Subagent: \[child\]\(subagents\/child\/transcript\.md\) \(explore\)/);
  const childMd = fs.readFileSync(path.join(child, 'transcript.md'), 'utf8');
  assert.match(childMd, /- Subagent of: \[root\]\(\.\.\/\.\.\/transcript\.md\) — type explore/);
  assert.match(childMd, /> ↳ Subagent: \[grandchild\]\(subagents\/grandchild\/transcript\.md\) \(generalPurpose\)/);
  assert.match(fs.readFileSync(path.join(grandchild, 'transcript.md'), 'utf8'), /## #1 user\n\ngrandchild task/);

  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.strictEqual(index.length, 1);
  assert.strictEqual(index[0].subagents[0].subagents[0].composerId, 'grandchild');
  assert.strictEqual(index[0].subagents[0].path, path.join('chats', 'root', 'subagents', 'child'));
});

test('flat layout from earlier versions is moved under the parent', () => {
  const { db, dir } = multi();
  // Simulate 0.5/0.6: every chat at chats/<id>.
  for (const id of ['root', 'child', 'grandchild']) {
    const parent = { child: 'root', grandchild: 'child' }[id];
    fs.mkdirSync(path.join(dir, 'chats', id, 'snapshots'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'chats', id, 'meta.json'), JSON.stringify({ composerId: id, name: id, seen: [], parentComposerId: parent }));
    fs.writeFileSync(path.join(dir, 'chats', id, 'snapshots', '1.json'), '{}');
  }
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ watermark: 5000 }));
  const result = history.tick(db, dir);
  assert.strictEqual(result.migrated, 2);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'chats')), ['root']);
  assert.ok(fs.existsSync(path.join(dir, 'chats', 'root', 'subagents', 'child', 'subagents', 'grandchild', 'snapshots', '1.json')));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).layout, 2);
});
