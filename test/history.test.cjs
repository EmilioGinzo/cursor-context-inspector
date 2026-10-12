'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const history = require('../src/history.cjs');
const pb = require('./protoEncode.cjs');

function setup() {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  const put = (k, v) => db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(k, v);
  // A blob keeps the row it was first stored at, as Cursor's store does: rowid order is storage order.
  const putOnce = (k, v) => db.prepare('INSERT OR IGNORE INTO cursorDiskKV VALUES (?, ?)').run(k, v);
  const blob = (m) => {
    const raw = Buffer.from(JSON.stringify(m));
    const hash = crypto.createHash('sha256').update(raw).digest();
    putOnce(`agentKv:blob:${hash.toString('hex')}`, raw);
    return hash;
  };
  const raw = (data) => {
    const hash = crypto.createHash('sha256').update(data).digest();
    putOnce(`agentKv:blob:${hash.toString('hex')}`, data);
    return hash;
  };
  // turns: each a list of ConversationStep bytes (see step below), stored as Cursor does.
  // archive: messages summarization took out of the prompt; the state's summary archive (field 13)
  // is a blob listing their blob ids.
  const save = (lastUpdatedAt, messages, { id = 'chat-1', name = 'History chat', summaries = 0, turns = [], archive = [], ...extra } = {}) => {
    // self_summary_count is field 17, varint: tag 0x88 0x01.
    const count = summaries ? [Buffer.from([0x88, 0x01, summaries])] : [];
    const archived = archive.length ? [pb.len(13, raw(Buffer.concat(archive.map((m) => pb.len(1, blob(m))))))] : [];
    const turnIds = turns.map((steps) => raw(pb.len(1, Buffer.concat(steps.map((st) => pb.len(2, raw(st)))))));
    const state = Buffer.concat([...messages.flatMap((m) => [Buffer.from([0x0a, 0x20]), blob(m)]), ...count, ...archived, ...turnIds.map((t) => pb.len(8, t))]);
    put(`composerData:${id}`, JSON.stringify({
      name, lastUpdatedAt, conversationState: `~${state.toString('base64')}`,
      promptTokenBreakdown: { totalUsedTokens: 10, maxTokens: 100, categories: [] }, ...extra,
    }));
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-history-'));
  return { db, save, dir };
}

// ConversationStep: 1 assistant_message { 1 text }, 2 tool_call, 3 thinking_message { 1 text, 2 duration_ms }.
const step = {
  thinking: (text, ms) => pb.len(3, Buffer.concat([pb.len(1, text), ...(ms ? [pb.v(2, ms)] : [])])),
  text: (text) => pb.len(1, pb.len(1, text)),
  tool: (args) => pb.len(2, pb.len(8, pb.len(1, Buffer.concat(Object.values(args).map((v, i) => pb.len(i + 1, v)))))),
};

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

  const chat = path.join(dir, 'chats', 'History chat');
  // 1000-2: the prompt that produced the answer (message #2).
  assert.deepStrictEqual(fs.readdirSync(path.join(chat, 'snapshots')).sort(), ['1000-2.json', '1000.json', '2000.json']);
  assert.strictEqual(fs.readdirSync(path.join(dir, 'blobs')).length, 4, 'system message stored once');
  const meta = JSON.parse(fs.readFileSync(path.join(chat, 'meta.json'), 'utf8'));
  assert.strictEqual(meta.seen.length, 4);
  assert.strictEqual(meta.snapshots, 3);

  const md = fs.readFileSync(path.join(chat, 'transcript.md'), 'utf8');
  assert.match(md, /## #1 user \(no longer in prompt\)\n\nfirst question/);
  assert.match(md, /## #2 assistant \(no longer in prompt\)\n\nfirst answer/);
  assert.match(md, /## #3 user\n\n\[Previous conversation summary\]/);
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
  assert.strictEqual(index[0].name, 'History chat');
});

const call = (id) => ({ role: 'assistant', content: [{ type: 'tool-call', toolName: 'Read', toolCallId: id, args: {} }] });
const result = (id) => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: id, result: 'ok' }] });
const snapshotMessages = (chat) => Object.fromEntries(fs.readdirSync(path.join(chat, 'snapshots')).map((f) => [f, JSON.parse(fs.readFileSync(path.join(chat, 'snapshots', f), 'utf8')).messages.length]));

test('records the prompt of every model call and the end of every turn, not only the newest state', () => {
  const { db, save, dir } = setup();
  // One run: three model calls, two of them with tool results; one more call in the next run.
  const run = [sys, first, call('a'), result('a'), call('b'), result('b'), result('c'), answer];
  save(1000, run);
  history.recordUpdatedSince(db, dir, 0);
  const chat = path.join(dir, 'chats', 'History chat');
  assert.deepStrictEqual(snapshotMessages(chat), { '1000-2.json': 2, '1000-4.json': 4, '1000-7.json': 7, '1000.json': 8 });
  const prompt = JSON.parse(fs.readFileSync(path.join(chat, 'snapshots', '1000-4.json'), 'utf8'));
  const full = JSON.parse(fs.readFileSync(path.join(chat, 'snapshots', '1000.json'), 'utf8'));
  assert.deepStrictEqual(prompt.messages, full.messages.slice(0, 4), 'a prompt refers to the stored blobs by id');
  assert.deepStrictEqual([prompt.state, prompt.before], ['prompt', 4]);

  const twoTurns = [...run, { role: 'user', content: 'second question' }, call('d'), result('d'), answer];
  save(2000, twoTurns);
  history.recordUpdatedSince(db, dir, 1000);
  const after = snapshotMessages(chat);
  assert.deepStrictEqual(Object.keys(after).filter((f) => f.startsWith('2000')).sort(), ['2000-11.json', '2000-9.json', '2000.json'], 'only states since the last snapshot');
  assert.strictEqual(fs.readdirSync(path.join(dir, 'blobs')).length, 11, 'each message stored once');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(chat, 'meta.json'), 'utf8')).snapshots, 7);

  // Both turns seen at once: the first turn's end is a state too.
  save(3000, twoTurns, { id: 'chat-2', name: 'Two turns' });
  history.recordUpdatedSince(db, dir, 2000);
  const both = path.join(dir, 'chats', 'Two turns');
  assert.deepStrictEqual(Object.keys(snapshotMessages(both)).sort(), ['3000-11.json', '3000-2.json', '3000-4.json', '3000-7.json', '3000-8.json', '3000-9.json', '3000.json']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(both, 'snapshots', '3000-8.json'), 'utf8')).state, 'turn end');
});

test('prompts are not derived across a summary', () => {
  const { db, save, dir } = setup();
  save(1000, [sys, first, call('a'), result('a')]);
  history.recordUpdatedSince(db, dir, 0);
  // The summary rewrote the prompt: its earlier prefixes were never sent.
  save(2000, [sys, summary, call('b'), result('b'), answer], { summaries: 1 });
  history.recordUpdatedSince(db, dir, 1000);
  const chat = path.join(dir, 'chats', 'History chat');
  assert.deepStrictEqual(snapshotMessages(chat), { '1000-2.json': 2, '1000.json': 4, '2000.json': 5 });

  // A chat first recorded after it was summarized, then growing again.
  const other = setup();
  other.save(1000, [sys, summary, call('b'), result('b'), answer], { summaries: 1 });
  history.recordUpdatedSince(other.db, other.dir, 0);
  other.save(2000, [sys, summary, call('b'), result('b'), answer, first, answer], { summaries: 1 });
  history.recordUpdatedSince(other.db, other.dir, 1000);
  assert.deepStrictEqual(snapshotMessages(path.join(other.dir, 'chats', 'History chat')), { '1000.json': 5, '2000-6.json': 6, '2000.json': 7 });
});

test('a history recorded before snapshots carried the summary count still gets the states since', () => {
  const { db, save, dir } = setup();
  save(1000, [sys, summary, call('a'), result('a')], { summaries: 1 });
  history.recordUpdatedSince(db, dir, 0);
  const chat = path.join(dir, 'chats', 'History chat');
  const latest = path.join(chat, 'latest.json');
  const old = JSON.parse(fs.readFileSync(latest, 'utf8'));
  delete old.summaries;
  fs.writeFileSync(latest, JSON.stringify(old));
  save(2000, [sys, summary, call('a'), result('a'), call('b'), result('b'), answer], { summaries: 1 });
  history.recordUpdatedSince(db, dir, 1000);
  assert.deepStrictEqual(snapshotMessages(chat), { '1000.json': 4, '2000-6.json': 6, '2000.json': 7 });

  // Summarized since that old snapshot: the prompt no longer extends it, nothing is derived.
  fs.writeFileSync(latest, JSON.stringify(old));
  save(3000, [sys, summary, answer, call('c'), result('c'), answer], { summaries: 2 });
  history.recordUpdatedSince(db, dir, 2000);
  assert.deepStrictEqual(Object.keys(snapshotMessages(chat)).filter((f) => f.startsWith('3000')), ['3000.json']);
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
  return { db, chat, dir: fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-history-')) };
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

test('a resumed subagent keeps every Task call that spawned it, and is linked from each', () => {
  const { db, chat, dir } = multi();
  const sys = { role: 'system', content: 'You are an agent.' };
  const spawnBy = (callId) => ({ role: 'assistant', content: [{ type: 'text', text: 'delegating' }, { type: 'tool-call', toolName: 'Subagent', toolCallId: callId, args: { prompt: 'go' } }] });
  history.recordUpdatedSince(db, dir, 0);
  const root = path.join(dir, 'chats', 'root');
  const childMeta = path.join(root, 'subagents', 'child', 'meta.json');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(childMeta, 'utf8')).toolCallIds, ['tool_aaa']);

  // Cursor now names the second Task call (a resume) and drops the first one from the subagent.
  // The subagent's last update is unchanged, so only its link moved.
  chat('child', 1001, [sys, { role: 'user', content: 'child task' }, spawnBy('tool_bbb')], { subagentComposerIds: ['grandchild'], subagentInfo: { parentComposerId: 'root', toolCallId: 'tool_ccc', subagentTypeName: 'explore' } });
  chat('root', 1003, [sys, { role: 'user', content: 'first' }, spawnBy('tool_aaa'), { role: 'user', content: 'again' }, spawnBy('tool_ccc')], { subagentComposerIds: ['child'] });
  history.recordChat(db, 'root', dir);

  assert.deepStrictEqual(JSON.parse(fs.readFileSync(childMeta, 'utf8')).toolCallIds, ['tool_aaa', 'tool_ccc'], 'kept, not overwritten');
  const rootMd = fs.readFileSync(path.join(root, 'transcript.md'), 'utf8');
  assert.strictEqual(rootMd.split('↳ Subagent: [child]').length - 1, 2, 'linked from both Task calls');
  const chatMd = fs.readFileSync(path.join(root, 'chat.md'), 'utf8');
  assert.strictEqual(chatMd.split('↳ Subagent: [child]').length - 1, 2, 'chat.md links both too');
});

test('the Task calls a resumed subagent was named in are kept from the recorded results', () => {
  const { db, chat, dir } = multi();
  const sys = { role: 'system', content: 'You are an agent.' };
  const spawnBy = (callId) => ({ role: 'assistant', content: [{ type: 'text', text: 'delegating' }, { type: 'tool-call', toolName: 'Subagent', toolCallId: callId, args: { prompt: 'go' } }] });
  const resultOf = (callId) => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: callId, toolName: 'Task', result: `Subagent child finished.\nagent_id: child\n` }] });
  // Cursor's DB names only the latest call; the first one is in the recorded messages.
  chat('child', 1001, [sys, { role: 'user', content: 'child task' }, spawnBy('tool_bbb')], { subagentComposerIds: ['grandchild'], subagentInfo: { parentComposerId: 'root', toolCallId: 'tool_ccc', subagentTypeName: 'explore' } });
  chat('root', 1003, [sys, { role: 'user', content: 'first' }, spawnBy('tool_aaa'), resultOf('tool_aaa'), spawnBy('tool_ccc'), resultOf('tool_ccc')], { subagentComposerIds: ['child'] });
  history.recordUpdatedSince(db, dir, 0);
  const root = path.join(dir, 'chats', 'root');
  const kept = JSON.parse(fs.readFileSync(path.join(root, 'subagents', 'child', 'meta.json'), 'utf8')).toolCallIds;
  assert.deepStrictEqual([...kept].sort(), ['tool_aaa', 'tool_ccc']);
  const rootMd = fs.readFileSync(path.join(root, 'transcript.md'), 'utf8');
  assert.strictEqual(rootMd.split('↳ Subagent: [child]').length - 1, 2, 'linked from both Task calls');
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
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')).layout, 3);
});

test('folders are named after the chat, follow renames and stay apart on clashes', () => {
  const { db, save, dir } = setup();
  save(1000, [sys], { id: 'aaaaaaaa-1', name: 'Fix: the "bug" / today?' });
  save(1000, [first], { id: 'bbbbbbbb-2', name: 'Fix: the "bug" / today?' });
  history.recordUpdatedSince(db, dir, 0);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'chats')).sort(), ['Fix- the -bug- - today-', 'Fix- the -bug- - today- (bbbbbbbb)']);

  save(2000, [sys, first], { id: 'aaaaaaaa-1', name: 'Renamed' });
  history.recordUpdatedSince(db, dir, 1000);
  const renamed = path.join(dir, 'chats', 'Renamed');
  assert.deepStrictEqual(fs.readdirSync(path.join(renamed, 'snapshots')).sort(), ['1000.json', '2000.json']);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(renamed, 'meta.json'), 'utf8')).composerId, 'aaaaaaaa-1');
  assert.strictEqual(history.folderName('..'), 'Untitled chat');
});

test('folders named by chat id (0.5–0.8.0) are renamed, with links rebuilt', () => {
  const { db, dir } = multi();
  db.prepare("UPDATE cursorDiskKV SET value = json_set(value, '$.name', 'Child task') WHERE key = 'composerData:child'").run();
  history.recordUpdatedSince(db, dir, 0);
  // Simulate 0.7/0.8.0: same nesting, folders named by id.
  const root = path.join(dir, 'chats', 'root');
  fs.renameSync(path.join(root, 'subagents', 'Child task'), path.join(root, 'subagents', 'child'));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ watermark: 5000, layout: 2 }));
  assert.strictEqual(history.tick(db, dir).migrated, 1);
  assert.deepStrictEqual(fs.readdirSync(path.join(root, 'subagents')), ['Child task']);
  assert.ok(fs.existsSync(path.join(root, 'subagents', 'Child task', 'subagents', 'grandchild', 'transcript.md')));
  assert.match(fs.readFileSync(path.join(root, 'transcript.md'), 'utf8'), /\[Child task\]\(subagents\/Child%20task\/transcript\.md\)/);
});

test('a chat recorded again by an older window is merged into its named folder', () => {
  const { db, save, dir } = setup();
  save(1000, [sys]);
  history.recordUpdatedSince(db, dir, 0);
  // A window still on 0.8.0 records the next update under the id.
  const old = path.join(dir, 'chats', 'chat-1');
  fs.mkdirSync(path.join(old, 'snapshots'), { recursive: true });
  fs.writeFileSync(path.join(old, 'snapshots', '2000.json'), '{}');
  fs.writeFileSync(path.join(old, 'meta.json'), JSON.stringify({ composerId: 'chat-1', seen: ['extra'] }));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ watermark: 5000, layout: 3 }));
  assert.strictEqual(history.tick(db, dir).migrated, 1);
  const chat = path.join(dir, 'chats', 'History chat');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'chats')), ['History chat']);
  assert.deepStrictEqual(fs.readdirSync(path.join(chat, 'snapshots')).sort(), ['1000.json', '2000.json']);
  assert.ok(JSON.parse(fs.readFileSync(path.join(chat, 'meta.json'), 'utf8')).seen.includes('extra'));
  assert.strictEqual(history.tick(db, dir).migrated, 0, 'nothing left to merge');
});

test('a snapshot an older window recorded under a taken name is kept when the folders are merged', () => {
  const { db, save, dir } = setup();
  save(1000, [sys]);
  history.recordUpdatedSince(db, dir, 0);
  const chat = path.join(dir, 'chats', 'History chat');
  const recorded = JSON.parse(fs.readFileSync(path.join(chat, 'snapshots', '1000.json'), 'utf8'));
  const old = path.join(dir, 'chats', 'chat-1');
  fs.mkdirSync(path.join(old, 'snapshots'), { recursive: true });
  // The same state recorded at another time, and another state under the same name.
  fs.writeFileSync(path.join(old, 'snapshots', '1000-at1.json'), JSON.stringify({ ...recorded, recordedAt: 1 }));
  fs.writeFileSync(path.join(old, 'snapshots', '1000.json'), JSON.stringify({ ...recorded, recordedAt: 1500, messages: ['other'] }));
  fs.writeFileSync(path.join(old, 'meta.json'), JSON.stringify({ composerId: 'chat-1', seen: [] }));
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ watermark: 5000, layout: 3 }));
  assert.strictEqual(history.tick(db, dir).migrated, 1);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'chats')), ['History chat']);
  assert.deepStrictEqual(fs.readdirSync(path.join(chat, 'snapshots')).sort(), ['1000-at1500.json', '1000.json']);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(chat, 'snapshots', '1000-at1500.json'), 'utf8')).messages, ['other']);
});

test('older chats are caught up in batches, also after an earlier 7-day backfill', () => {
  const { db, save, dir } = setup();
  for (let i = 1; i <= 5; i++) save(i * 1000, [sys, { role: 'user', content: `question ${i}` }], { id: `chat-${i}`, name: `Chat ${i}` });
  save(6000, [], { id: 'draft', name: 'Never sent' });
  // An earlier version recorded only chats newer than its watermark.
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ watermark: 4500, layout: 3 }));
  const first = history.tick(db, dir, { backfillBatch: 2 });
  assert.strictEqual(first.recorded, 3, 'chat 5 since the watermark, chats 1–2 from the backfill');
  assert.strictEqual(first.backfilling, true);
  let rest = 0;
  for (let ticks = 0, r = first; r.backfilling; ticks++) {
    assert.ok(ticks < 5, 'backfill finishes');
    r = history.tick(db, dir, { backfillBatch: 2 });
    rest += r.recorded;
  }
  assert.strictEqual(rest, 2, 'chats 3–4, each once');
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'chats')).sort(), ['Chat 1', 'Chat 2', 'Chat 3', 'Chat 4', 'Chat 5'], 'drafts without messages are skipped');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8')).length, 5);
  save(7000, [sys, first], { id: 'chat-6', name: 'Chat 6' });
  assert.deepStrictEqual([history.tick(db, dir).recorded, history.tick(db, dir).backfilling], [1, false], 'new chats still recorded after the backfill');
});

// Cursor sets lastUpdatedAt when the user sends and leaves it there when the run
// ends; a tick in between used to move the watermark past the chat for good.
const settledState = (dir, watermark) => fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ watermark, layout: 3, rescan: 1, backfill: { done: true } }));
const snapshots = (dir, name = 'History chat') => fs.readdirSync(path.join(dir, 'chats', name, 'snapshots')).sort();

test('a chat ticked before its run stored any state is recorded when the run ends', () => {
  const { db, save, dir } = setup();
  settledState(dir, 500);
  save(1000, [], { status: 'generating' });
  assert.deepStrictEqual([history.tick(db, dir).recorded, history.tick(db, dir).pending], [0, 1], 'nothing to record yet, kept for later');
  save(1000, [sys, first, answer], { status: 'completed', conversationCheckpointLastUpdatedAt: 1013 });
  assert.strictEqual(history.tick(db, dir).recorded, 1);
  assert.deepStrictEqual(snapshots(dir), ['1000-2.json', '1013.json'], 'with the prompt that wrote the answer');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'chats', 'History chat', 'meta.json'), 'utf8')).seen.length, 3);
  assert.deepStrictEqual([history.tick(db, dir).recorded, history.tick(db, dir).pending], [0, 0], 'settled: no longer re-checked');
});

test('a chat recorded mid-run is recorded again when the run ends without a newer timestamp', () => {
  const { db, save, dir } = setup();
  settledState(dir, 500);
  save(1000, [sys, first], { status: 'generating' });
  assert.strictEqual(history.tick(db, dir).recorded, 1);
  // No checkpoint time either: only the pending list brings the chat back.
  save(1000, [sys, first, answer], { status: 'completed' });
  assert.strictEqual(history.tick(db, dir).recorded, 1);
  const recorded = snapshots(dir).map((f) => JSON.parse(fs.readFileSync(path.join(dir, 'chats', 'History chat', 'snapshots', f), 'utf8')));
  assert.deepStrictEqual(recorded.map((x) => x.messages.length).sort(), [2, 3], 'the mid-run snapshot is kept, beside the complete one');
  assert.strictEqual(history.tick(db, dir).recorded, 0);
});

test('a chat whose run ended after the watermark passed its send time is caught by the checkpoint time', () => {
  const { db, save, dir } = setup();
  settledState(dir, 500);
  // Status not yet set when the tick ran: nothing marks the chat as running.
  save(1000, []);
  history.tick(db, dir);
  save(1000, [sys, first, answer], { status: 'completed', conversationCheckpointLastUpdatedAt: 1013 });
  assert.strictEqual(history.tick(db, dir).recorded, 1);
});

test('a history recorded before the fix is rescanned for chats it missed, without re-recording the others', () => {
  const { db, save, dir } = setup();
  save(1000, [sys, first], { id: 'kept', name: 'Kept chat' });
  history.recordUpdatedSince(db, dir, 0);
  save(2000, [sys, first, answer], { id: 'missed', name: 'Missed chat', status: 'completed', conversationCheckpointLastUpdatedAt: 2013 });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ watermark: 5000, layout: 3, backfill: { done: true } }));
  assert.deepStrictEqual([history.tick(db, dir).recorded, history.tick(db, dir).recorded], [1, 0]);
  assert.deepStrictEqual(snapshots(dir, 'Kept chat'), ['1000.json']);
  assert.deepStrictEqual(snapshots(dir, 'Missed chat'), ['2000-2.json', '2013.json']);
});

test('a chat stuck unsettled is given up after a day', () => {
  const { db, save, dir } = setup();
  save(1000, [sys], { status: 'generating' });
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ watermark: 5000, layout: 3, rescan: 1, backfill: { done: true }, pending: { 'chat-1': Date.now() - 2 * 86400000 } }));
  assert.deepStrictEqual([history.tick(db, dir).recorded, history.tick(db, dir).pending], [1, 0]);
});

test('a chat that cannot be read is skipped, the others are still recorded', () => {
  const { db, save, dir } = setup();
  save(1000, [sys, first], { id: 'good', name: 'Good chat' });
  // Field 1, length-delimited, length varint cut off.
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('composerData:bad', JSON.stringify({
    name: 'Bad chat', lastUpdatedAt: 2000, conversationState: `~${Buffer.from([0x0a, 0x80]).toString('base64')}`,
  }));
  save(3000, [sys, { role: 'assistant', content: [{ type: 'text' }, { type: 'reasoning' }] }], { id: 'odd', name: 'Odd chat' });
  const error = console.error;
  console.error = () => {};
  try {
    assert.strictEqual(history.tick(db, dir).backfilling, false);
  } finally {
    console.error = error;
  }
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'chats')).sort(), ['Good chat', 'Odd chat']);
});

test('historyBackfillDays limits the catch-up', () => {
  const { db, save, dir } = setup();
  save(1000, [sys], { id: 'old', name: 'Old chat' });
  save(Date.now() - 3600000, [sys], { id: 'recent', name: 'Recent chat' });
  history.tick(db, dir, { backfillDays: 1 });
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'chats')), ['Recent chat']);
});

test('chat.md shows the conversation without injected context, tool calls collapsed with results', () => {
  const { db, save, dir } = setup();
  save(1000, [
    sys,
    { role: 'user', content: [{ type: 'text', text: '<user_info>\nOS: linux\n</user_info>' }, { type: 'text', text: '<user_query>\nfix the bug\n</user_query>' }] },
    { role: 'assistant', content: [
      { type: 'reasoning', text: 'look at the file' },
      { type: 'redacted-reasoning', data: 'xyz' },
      { type: 'text', text: 'Reading it.' },
      { type: 'tool-call', toolCallId: 't1', toolName: 'Read', args: { path: '/a.js' } },
    ] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'Read', result: 'const a = ```1```;' }] },
  ]);
  history.recordUpdatedSince(db, dir, 0);
  const md = fs.readFileSync(path.join(dir, 'chats', 'History chat', 'chat.md'), 'utf8');
  assert.match(md, /_\*\*User\*\*_\n\nfix the bug\n/);
  assert.doesNotMatch(md, /user_info|You are an agent|xyz/);
  assert.match(md, /<summary>Thinking<\/summary>\n\nlook at the file/);
  assert.match(md, /<summary>Tool: <b>Read<\/b> — \/a.js<\/summary>/);
  assert.match(md, /````\nconst a = ```1```;\n````/, 'fence longer than the result\'s backticks');
  assert.strictEqual(md.match(/_\*\*Agent/g).length, 1, 'one heading per turn');
});

test('chats recorded before chat.md existed get one', () => {
  const { db, save, dir } = setup();
  save(1000, [sys, { role: 'user', content: '<summary>\nearlier we talked\n</summary>\n<user_query>hi</user_query>' }]);
  history.recordUpdatedSince(db, dir, 0);
  const file = path.join(dir, 'chats', 'History chat', 'chat.md');
  fs.rmSync(file);
  history.tick(db, dir);
  const md = fs.readFileSync(file, 'utf8');
  assert.match(md, /_\*\*User\*\*_\n\nhi\n/);
  assert.match(md, /<summary>Summarized by Cursor<\/summary>\n\nearlier we talked/);
});

test('a message Cursor writes after its chat is recorded reaches the record', () => {
  const { db, save, dir } = setup();
  settledState(dir, 500);
  save(1000, [sys, first, answer], { status: 'completed' });
  // The prompt already lists the answer, but its blob is not in the DB yet.
  const late = crypto.createHash('sha256').update(JSON.stringify(answer)).digest('hex');
  db.prepare('DELETE FROM cursorDiskKV WHERE key = ?').run(`agentKv:blob:${late}`);
  history.tick(db, dir);
  assert.strictEqual(history.tick(db, dir).pending, 1, 'kept until the message is written');
  save(1000, [sys, first, answer], { status: 'completed' });
  history.tick(db, dir);
  assert.ok(fs.existsSync(path.join(dir, 'blobs', `${late}.json`)));
  assert.match(fs.readFileSync(path.join(dir, 'chats', 'History chat', 'chat.md'), 'utf8'), /first answer/);
  assert.strictEqual(history.tick(db, dir).pending, 0, 'settled once the message is recorded');
});

test('a state recorded under a send time is not overwritten when the run is summarized and grows again', () => {
  const { db, save, dir } = setup();
  settledState(dir, 500);
  const next = { role: 'user', content: 'next question' };
  const second = { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] };
  save(1000, [sys, first, answer, next, second], { status: 'generating' });
  history.tick(db, dir);
  // Cursor summarizes mid-run, then the run goes on: same send time, new prompt.
  save(1000, [sys, summary], { status: 'generating', summaries: 1 });
  history.tick(db, dir);
  save(1000, [sys, summary, next, second], { status: 'completed', summaries: 1 });
  history.tick(db, dir);
  const chat = path.join(dir, 'chats', 'History chat', 'snapshots');
  const states = fs.readdirSync(chat).map((f) => JSON.parse(fs.readFileSync(path.join(chat, f), 'utf8')).messages.join());
  assert.strictEqual(states.length, 7, '3 + 1 derived states and 3 updates');
  assert.strictEqual(new Set(states).size, 7, 'every state kept');
});

test('states recorded under one name in the same ms are all kept, and a state recorded again is not', () => {
  const { db, save, dir } = setup();
  settledState(dir, 500);
  const clock = () => 2000;
  const next = { role: 'user', content: 'next question' };
  const second = { role: 'assistant', content: [{ type: 'text', text: 'second answer' }] };
  save(1000, [sys, first], { status: 'generating' });
  history.tick(db, dir, { clock });
  // Each update below is new under the send time, and recorded in the same ms.
  save(1000, [sys, first, answer], { status: 'generating' });
  history.tick(db, dir, { clock });
  save(1000, [sys, summary], { status: 'generating', summaries: 1 });
  history.tick(db, dir, { clock });
  save(1000, [sys, summary, next, second], { status: 'completed', summaries: 1 });
  history.tick(db, dir, { clock });
  const chat = path.join(dir, 'chats', 'History chat');
  const read = () => snapshots(dir).map((f) => [f, JSON.parse(fs.readFileSync(path.join(chat, 'snapshots', f), 'utf8')).messages.length]);
  const all = [['1000-3.json', 3], ['1000-at2000-2.json', 2], ['1000-at2000-3.json', 4], ['1000-at2000.json', 3], ['1000.json', 2]];
  assert.deepStrictEqual(read(), all);
  // A recorder stopped before latest.json records the same state again.
  fs.rmSync(path.join(chat, 'latest.json'));
  history.recordChat(db, 'chat-1', dir, undefined, { clock: () => 3000 });
  assert.deepStrictEqual(read(), all, 'no duplicate');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(chat, 'meta.json'), 'utf8')).snapshots, all.length);
});

test('the readable thinking from Cursor\'s turn steps is recorded and shown where the model thought it', () => {
  const { db, save, dir } = setup();
  const user = { role: 'user', content: [{ type: 'text', text: '<user_query>\nfix the bug\n</user_query>' }] };
  const read = { role: 'assistant', content: [
    { type: 'redacted-reasoning', data: Buffer.from('ciphertext').toString('base64') },
    { type: 'text', text: 'Reading it.' },
    { type: 'tool-call', toolCallId: 't1', toolName: 'Read', args: { path: '/a.js' } },
  ] };
  const result = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'Read', result: 'const a = 1;' }] };
  const done = { role: 'assistant', content: [{ type: 'redacted-reasoning', data: 'AAAA' }, { type: 'text', text: 'Fixed.' }] };
  const later = { role: 'assistant', content: [{ type: 'redacted-reasoning', data: 'AAAAAAAA' }] };
  save(1000, [sys, user, read, result, done, later], { turns: [[
    step.thinking('The bug is in a.js.', 2100), step.text('Reading it.'), step.tool({ path: '/a.js' }),
    step.thinking('One line fixes it.'), step.text('Fixed.'),
  ]] });
  history.recordUpdatedSince(db, dir, 0);
  const chat = path.join(dir, 'chats', 'History chat');
  const thinking = JSON.parse(fs.readFileSync(path.join(chat, 'thinking.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(chat, 'meta.json'), 'utf8'));
  assert.deepStrictEqual(thinking.map((e) => [e.text, e.durationMs, meta.seen.indexOf(e.message), e.part]), [
    ['The bug is in a.js.', 2100, 2, 0],
    ['One line fixes it.', undefined, 4, 0],
  ]);

  const md = fs.readFileSync(path.join(chat, 'chat.md'), 'utf8');
  const first = md.indexOf('<summary>Thinking · 2 s <i>(sent to the model encrypted, 10 bytes)</i></summary>\n\nThe bug is in a.js.');
  assert.ok(first !== -1, 'readable thinking on the encrypted part, with its size');
  assert.ok(first < md.indexOf('Reading it.') && md.indexOf('Reading it.') < md.indexOf('One line fixes it.') && md.indexOf('One line fixes it.') < md.indexOf('Fixed.'), 'in order');
  assert.match(md, /<summary>Thinking <i>\(encrypted, 6 bytes\)<\/i><\/summary>\n\n_Encrypted by the model's provider/, 'encrypted thinking without a readable copy is labelled');
  const transcript = fs.readFileSync(path.join(chat, 'transcript.md'), 'utf8');
  assert.match(transcript, /## #2 assistant\n[\s\S]*> Readable thinking \(content\[0\]\), from Cursor's turn step [0-9a-f]{12}:\n>\n> The bug is in a.js.\n/);

  // Cursor stops listing the turn: the thinking stays recorded.
  save(2000, [sys, user, read, result, done, later]);
  history.recordUpdatedSince(db, dir, 1000);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(chat, 'thinking.json'), 'utf8')).length, 2);
  assert.match(fs.readFileSync(path.join(chat, 'chat.md'), 'utf8'), /One line fixes it\./);
});

test('chats recorded before thinking was kept get it', () => {
  const { db, save, dir } = setup();
  const answer = { role: 'assistant', content: [{ type: 'redacted-reasoning', data: 'AAAA' }, { type: 'text', text: 'Hello.' }] };
  save(1000, [sys, first, answer], { turns: [[step.thinking('Say hello.'), step.text('Hello.')]] });
  history.recordUpdatedSince(db, dir, 0);
  const chat = path.join(dir, 'chats', 'History chat');
  fs.rmSync(path.join(chat, 'thinking.json'));
  fs.writeFileSync(path.join(chat, 'chat.md'), 'old');
  history.tick(db, dir);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(chat, 'thinking.json'), 'utf8'))[0].text, 'Say hello.');
  assert.match(fs.readFileSync(path.join(chat, 'chat.md'), 'utf8'), /<\/i><\/summary>\n\nSay hello\./);
});

test('thinking whose message was never recorded is shown before the first placed one, not after the chat', () => {
  const { db, save, dir } = setup();
  const answer = { role: 'assistant', content: [{ type: 'redacted-reasoning', data: 'AAAA' }, { type: 'text', text: 'Hello.' }] };
  const more = { role: 'user', content: 'and then?' };
  const end = { role: 'assistant', content: [{ type: 'text', text: 'The end.' }] };
  // The first turn's answer was summarized away before the chat was recorded.
  save(1000, [sys, first, answer, more, end], { turns: [
    [step.thinking('Long gone.'), step.text('An answer nobody recorded.')],
    [step.thinking('Say hello.'), step.text('Hello.')],
    [step.text('The end.')],
  ] });
  history.recordUpdatedSince(db, dir, 0);
  const md = fs.readFileSync(path.join(dir, 'chats', 'History chat', 'chat.md'), 'utf8');
  const gone = md.indexOf('<summary>Thinking <i>(its message is not in the record)</i></summary>\n\nLong gone.');
  assert.ok(gone !== -1, 'labelled as unplaced');
  assert.ok(md.indexOf('first question') < gone && gone < md.indexOf('Say hello.') && md.indexOf('Say hello.') < md.indexOf('The end.'), 'in order');
});

test('thinking whose message Cursor writes after the chat is recorded is placed on it', () => {
  const { db, save, dir } = setup();
  settledState(dir, 500);
  const reply = { role: 'assistant', content: [{ type: 'redacted-reasoning', data: 'AAAA' }, { type: 'text', text: 'Late.' }] };
  const turns = [[step.thinking('Thought late.'), step.text('Late.')]];
  save(1000, [sys, first, reply], { status: 'completed', turns });
  const late = crypto.createHash('sha256').update(JSON.stringify(reply)).digest('hex');
  db.prepare('DELETE FROM cursorDiskKV WHERE key = ?').run(`agentKv:blob:${late}`);
  history.tick(db, dir);
  const chat = path.join(dir, 'chats', 'History chat');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(chat, 'thinking.json'), 'utf8'))[0].message, null);
  save(1000, [sys, first, reply], { status: 'completed', turns });
  history.tick(db, dir);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(chat, 'thinking.json'), 'utf8'))[0].message, late);
  assert.match(fs.readFileSync(path.join(chat, 'chat.md'), 'utf8'), /sent to the model encrypted, 3 bytes\)<\/i><\/summary>\n\nThought late\./);
});


const hashOf = (m) => crypto.createHash('sha256').update(JSON.stringify(m)).digest('hex');
// A tool-call step: the call's id is field 57 of the call (the id its tool-call and tool-result parts share).
const callStep = (id) => pb.len(2, pb.len(57, id));

test('messages summarization archived are recorded, though no tick saw them in the prompt', () => {
  const { db, save, dir } = setup();
  // The first exchange was summarized away before the recorder ever saw it.
  save(1000, [sys, summary], { archive: [first, answer] });
  history.recordUpdatedSince(db, dir, 0);
  const chat = path.join(dir, 'chats', 'History chat');
  const meta = JSON.parse(fs.readFileSync(path.join(chat, 'meta.json'), 'utf8'));
  for (const m of [first, answer]) assert.ok(fs.existsSync(path.join(dir, 'blobs', `${hashOf(m)}.json`)));
  assert.deepStrictEqual(meta.seen, [hashOf(first), hashOf(answer), hashOf(sys), hashOf(summary)], 'before the prompt, in archive order');
  assert.match(fs.readFileSync(path.join(chat, 'transcript.md'), 'utf8'), /## #0 user \(no longer in prompt\)\n\nfirst question/);
});

test('a tool result replaced in the prompt is recorded from the store, found by its call id', () => {
  const { db, save, dir } = setup();
  const call = { role: 'assistant', content: [{ type: 'tool-call', toolName: 'Read', toolCallId: 'tool_read_1', args: {} }] };
  const oldResult = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tool_read_1', result: 'the old read' }] };
  const newResult = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tool_read_1', result: 'the new read' }] };
  const turns = [[callStep('tool_read_1')]];
  // Cursor stored the call, then the old result, then replaced the result in the prompt by the new one.
  save(1000, [sys, first, call], { turns });
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(`agentKv:blob:${hashOf(oldResult)}`, Buffer.from(JSON.stringify(oldResult)));
  save(2000, [sys, first, call, newResult], { turns });
  history.recordUpdatedSince(db, dir, 0);
  const chat = path.join(dir, 'chats', 'History chat');
  assert.ok(fs.existsSync(path.join(dir, 'blobs', `${hashOf(oldResult)}.json`)));
  const meta = JSON.parse(fs.readFileSync(path.join(chat, 'meta.json'), 'utf8'));
  assert.ok(meta.seen.includes(hashOf(oldResult)));
  assert.deepStrictEqual(meta.scannedCalls, ['tool_read_1']);
  assert.match(fs.readFileSync(path.join(chat, 'transcript.md'), 'utf8'), /the old read/);
});

test('a replaced result joins the record where it was in the chat, not before the start', () => {
  const { db, save, dir } = setup();
  const call = { role: 'assistant', content: [{ type: 'tool-call', toolName: 'Read', toolCallId: 'tool_read_4', args: {} }] };
  const oldResult = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tool_read_4', result: 'the old read' }] };
  const newResult = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tool_read_4', result: 'the new read' }] };
  const reply = { role: 'assistant', content: [{ type: 'text', text: 'Read it.' }] };
  const turns = [[callStep('tool_read_4')]];
  save(1000, [sys, first, call], { turns });
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(`agentKv:blob:${hashOf(oldResult)}`, Buffer.from(JSON.stringify(oldResult)));
  save(2000, [sys, first, call, newResult, reply], { turns });
  history.recordUpdatedSince(db, dir, 0);
  const chat = path.join(dir, 'chats', 'History chat');
  const meta = JSON.parse(fs.readFileSync(path.join(chat, 'meta.json'), 'utf8'));
  assert.deepStrictEqual(meta.seen, [sys, first, call, oldResult, newResult, reply].map(hashOf));
  const transcript = fs.readFileSync(path.join(chat, 'transcript.md'), 'utf8');
  assert.ok(transcript.indexOf('the old read') < transcript.indexOf('the new read'));
});

// The index's lookups of the store (storeIndex.cjs), counted by kind.
function countLookups(dir) {
  const index = require('../src/storeIndex.cjs').open(dir);
  const counts = { calls: 0, texts: 0 };
  const callHashes = index.callHashes;
  const textHashes = index.textHashes;
  index.callHashes = (id) => { counts.calls++; return callHashes(id); };
  index.textHashes = (text) => { counts.texts++; return textHashes(text); };
  return counts;
}

test('the store is searched for replaced results only once a run has ended, and once per call', () => {
  const { db, save, dir } = setup();
  const counts = countLookups(dir);
  const call = { role: 'assistant', content: [{ type: 'tool-call', toolName: 'Read', toolCallId: 'tool_read_2', args: {} }] };
  const oldResult = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tool_read_2', result: 'first read' }] };
  const newResult = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tool_read_2', result: 'second read' }] };
  const turns = [[callStep('tool_read_2')]];
  const running = { turns, generatingBubbleIds: ['bubble-running'] };
  save(1000, [sys, first, call], running);
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(`agentKv:blob:${hashOf(oldResult)}`, Buffer.from(JSON.stringify(oldResult)));
  save(1500, [sys, first, call, newResult], running);
  // A run is writing the chat: its results may still change, so the store is not searched yet.
  history.recordUpdatedSince(db, dir, 0);
  assert.strictEqual(counts.calls, 0);
  assert.ok(!fs.existsSync(path.join(dir, 'blobs', `${hashOf(oldResult)}.json`)));
  // The run ends: searched once, and not again for the same call.
  save(2000, [sys, first, call, newResult], { turns });
  history.recordUpdatedSince(db, dir, 1000);
  assert.ok(fs.existsSync(path.join(dir, 'blobs', `${hashOf(oldResult)}.json`)));
  save(3000, [sys, first, call, newResult], { turns });
  history.recordUpdatedSince(db, dir, 2000);
  assert.strictEqual(counts.calls, 1);
});

test('the store is not searched while the chat is marked generating, before any bubble is', () => {
  const { db, save, dir } = setup();
  const counts = countLookups(dir);
  const call = { role: 'assistant', content: [{ type: 'tool-call', toolName: 'Read', toolCallId: 'tool_read_5', args: {} }] };
  const oldResult = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tool_read_5', result: 'first read' }] };
  const newResult = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tool_read_5', result: 'second read' }] };
  const turns = [[callStep('tool_read_5')]];
  save(1000, [sys, first, call], { turns, status: 'generating' });
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(`agentKv:blob:${hashOf(oldResult)}`, Buffer.from(JSON.stringify(oldResult)));
  save(1500, [sys, first, call, newResult], { turns, status: 'generating' });
  history.recordUpdatedSince(db, dir, 0);
  assert.strictEqual(counts.calls, 0);
  save(2000, [sys, first, call, newResult], { turns });
  history.recordUpdatedSince(db, dir, 1000);
  assert.strictEqual(counts.calls, 1);
});

test('a reply interrupted by the next prompt is recorded from the store, where it was in the chat', () => {
  const { db, save, dir } = setup();
  const counts = countLookups(dir);
  const interrupted = { role: 'assistant', content: [{ type: 'redacted-reasoning', data: 'AAAA' }, { type: 'text', text: 'Session is up and responding.' }] };
  const second = { role: 'user', content: 'second question' };
  save(1000, [sys, first]);
  // Cursor stored the reply (not in any prompt: the run was interrupted), then the next prompt.
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(`agentKv:blob:${hashOf(interrupted)}`, Buffer.from(JSON.stringify(interrupted)));
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('bubbleId:chat-1:reply-1', JSON.stringify({ type: 2, text: 'Session is up and responding.' }));
  save(2000, [sys, first, second]);
  history.recordUpdatedSince(db, dir, 0);
  const chat = path.join(dir, 'chats', 'History chat');
  const meta = JSON.parse(fs.readFileSync(path.join(chat, 'meta.json'), 'utf8'));
  assert.deepStrictEqual(meta.seen, [sys, first, interrupted, second].map(hashOf));
  assert.deepStrictEqual(meta.scannedReplies, ['reply-1']);
  assert.strictEqual(meta.scanPending, undefined);
  assert.match(fs.readFileSync(path.join(chat, 'chat.md'), 'utf8'), /Session is up and responding\./);
  assert.strictEqual(counts.texts, 1);
  // Looked for once: a later tick does not look for the same bubble again.
  save(3000, [sys, first, second]);
  history.recordUpdatedSince(db, dir, 2000);
  assert.strictEqual(counts.texts, 1);
});

test('a reply Cursor has not stored yet is looked for again, and recorded once it is stored', () => {
  const { db, save, dir } = setup();
  const chat = path.join(dir, 'chats', 'History chat');
  const second = { role: 'user', content: 'second question' };
  const late = { role: 'assistant', content: [{ type: 'text', text: 'Stored late.' }] };
  save(1000, [sys, first]);
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('bubbleId:chat-1:reply-2', JSON.stringify({ type: 2, text: 'Stored late.' }));
  history.recordUpdatedSince(db, dir, 0);
  let meta = JSON.parse(fs.readFileSync(path.join(chat, 'meta.json'), 'utf8'));
  assert.deepStrictEqual(meta.seen, [sys, first].map(hashOf));
  assert.deepStrictEqual(Object.keys(meta.scanPending.replies), ['reply-2']);
  assert.strictEqual(meta.scannedReplies, undefined);
  // Cursor writes the reply between the prompt's messages: the chat is looked at again and finds it.
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(`agentKv:blob:${hashOf(late)}`, Buffer.from(JSON.stringify(late)));
  save(2000, [sys, first, second]);
  history.recordUpdatedSince(db, dir, 1000);
  meta = JSON.parse(fs.readFileSync(path.join(chat, 'meta.json'), 'utf8'));
  assert.deepStrictEqual(meta.seen, [sys, first, late, second].map(hashOf));
  assert.strictEqual(meta.scanPending, undefined);
  assert.deepStrictEqual(meta.scannedReplies, ['reply-2']);
});

test('a lookup that finds nothing is given up once the store has grown RETRY_ROWS rows past it', () => {
  const { db, save, dir } = setup();
  save(1000, [sys, first]);
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('bubbleId:chat-1:reply-3', JSON.stringify({ type: 2, text: 'Never stored.' }));
  history.recordUpdatedSince(db, dir, 0);
  const chat = path.join(dir, 'chats', 'History chat');
  assert.ok(JSON.parse(fs.readFileSync(path.join(chat, 'meta.json'), 'utf8')).scanPending);
  db.exec('BEGIN');
  for (let i = 0; i < history.RETRY_ROWS; i++) db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(`other:${i}`, 'x');
  db.exec('COMMIT');
  save(2000, [sys, first, { role: 'user', content: 'second question' }]);
  history.recordUpdatedSince(db, dir, 1000);
  const meta = JSON.parse(fs.readFileSync(path.join(chat, 'meta.json'), 'utf8'));
  assert.strictEqual(meta.scanPending, undefined);
  assert.deepStrictEqual(meta.scannedReplies, ['reply-3']);
  assert.deepStrictEqual(meta.seen, [sys, first, { role: 'user', content: 'second question' }].map(hashOf));
});

test('a reply in the prompt is matched without a look in the store', () => {
  const { db, save, dir } = setup();
  const counts = countLookups(dir);
  save(1000, [sys, first, answer]);
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('bubbleId:chat-1:reply-4', JSON.stringify({ type: 2, text: 'first answer' }));
  history.recordUpdatedSince(db, dir, 0);
  assert.strictEqual(counts.texts + counts.calls, 0);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'chats', 'History chat', 'meta.json'), 'utf8')).scannedReplies, ['reply-4']);
});

test('a short thought Cursor showed on a bubble is not held by a longer step that contains it', () => {
  const { db, save, dir } = setup();
  const reply = { role: 'assistant', content: [{ type: 'text', text: 'Hi.' }] };
  save(1000, [sys, first, reply], { turns: [[step.thinking('Ok.'), step.text('Hi.')]] });
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('bubbleId:chat-1:bubble-3',
    JSON.stringify({ type: 2, text: '', thinking: { text: 'Ok. Then I check the folder first.', signature: 'sig' } }));
  history.recordUpdatedSince(db, dir, 0);
  const thinking = JSON.parse(fs.readFileSync(path.join(dir, 'chats', 'History chat', 'thinking.json'), 'utf8'));
  assert.deepStrictEqual(thinking.filter((e) => e.source === 'bubble').map((e) => e.text), ['Ok. Then I check the folder first.']);
});

test('thinking Cursor showed on a bubble, and no turn step kept, is recorded with its place not known', () => {
  const { db, save, dir } = setup();
  const reply = { role: 'assistant', content: [{ type: 'text', text: 'Hi.' }] };
  save(1000, [sys, first, reply], { turns: [[step.thinking('Kept thought.'), step.text('Hi.')]] });
  const bubble = (id, thinking) => db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)')
    .run(`bubbleId:chat-1:${id}`, JSON.stringify({ type: 2, text: '', thinking: { text: thinking, signature: 'sig' } }));
  bubble('bubble-1', 'Shown only on the bubble.');
  bubble('bubble-2', 'Kept thought.'); // the same thought as the turn step: not recorded twice
  history.recordUpdatedSince(db, dir, 0);
  const chat = path.join(dir, 'chats', 'History chat');
  const thinking = JSON.parse(fs.readFileSync(path.join(chat, 'thinking.json'), 'utf8'));
  assert.deepStrictEqual(thinking.filter((e) => e.source === 'bubble').map((e) => [e.step, e.text, e.message]),
    [['bubble:bubble-1', 'Shown only on the bubble.', null]]);
  assert.strictEqual(thinking.length, 2);
  assert.match(fs.readFileSync(path.join(chat, 'chat.md'), 'utf8'), /<summary>Thinking <i>\(its place in the chat is not known\)<\/i><\/summary>\n\nShown only on the bubble\./);
});

test('the prompt of the model call after a replaced tool result is recorded with the earlier result', () => {
  const { db, save, dir } = setup();
  const call = { role: 'assistant', content: [{ type: 'tool-call', toolName: 'Read', toolCallId: 'tool_read_3', args: {} }] };
  const oldResult = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tool_read_3', result: 'the old read' }] };
  const newResult = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tool_read_3', result: 'the new read' }] };
  const reply = { role: 'assistant', content: [{ type: 'text', text: 'Done.' }] };
  const turns = [[callStep('tool_read_3')]];
  save(1000, [sys, first, call], { turns });
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(`agentKv:blob:${hashOf(oldResult)}`, Buffer.from(JSON.stringify(oldResult)));
  save(2000, [sys, first, call, newResult, reply], { turns });
  history.recordUpdatedSince(db, dir, 0);
  const snapshots = path.join(dir, 'chats', 'History chat', 'snapshots');
  const replaced = fs.readdirSync(snapshots).map((f) => JSON.parse(fs.readFileSync(path.join(snapshots, f), 'utf8'))).filter((s) => s.replaced !== undefined);
  assert.strictEqual(replaced.length, 1);
  // The model call that followed the result (before the reply) still had the earlier result at its index.
  assert.strictEqual(replaced[0].replaced, 3);
  assert.strictEqual(replaced[0].before, 4);
  assert.deepStrictEqual(replaced[0].messages, [hashOf(sys), hashOf(first), hashOf(call), hashOf(oldResult)]);
});

// A chat with a bit of everything the levels tell apart: a model call with a tool result, the model's
// readable thinking, a summarized exchange, and a reply interrupted by the next prompt.
function detailedChat() {
  const t = setup();
  const user = { role: 'user', content: [{ type: 'text', text: '<user_query>\nfix the bug\n</user_query>' }] };
  const read = { role: 'assistant', content: [{ type: 'redacted-reasoning', data: 'AAAA' }, { type: 'tool-call', toolCallId: 't1', toolName: 'Read', args: {} }] };
  const readResult = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'Read', result: 'const a = 1;' }] };
  const interrupted = { role: 'assistant', content: [{ type: 'text', text: 'Halfway through the fix.' }] };
  const second = { role: 'user', content: 'second question' };
  t.save(1000, [sys, summary, user, read, readResult], { archive: [first, answer], turns: [[step.thinking('The bug is in a.js.'), callStep('t1')]] });
  t.db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(`agentKv:blob:${hashOf(interrupted)}`, Buffer.from(JSON.stringify(interrupted)));
  t.db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('bubbleId:chat-1:reply-1', JSON.stringify({ type: 2, text: 'Halfway through the fix.' }));
  t.save(2000, [sys, summary, user, read, readResult, second], { archive: [first, answer], turns: [[step.thinking('The bug is in a.js.'), callStep('t1')]] });
  return { ...t, prompt: [sys, summary, user, read, readResult, second], messages: [first, answer, sys, summary, user, read, readResult, second], interrupted };
}
const chatFiles = (dir) => fs.readdirSync(path.join(dir, 'chats', 'History chat')).sort();

test('historyDetail conversation keeps the messages and chat.md, and does not search the store', () => {
  const { db, dir, messages } = detailedChat();
  history.recordUpdatedSince(db, dir, 0, { detail: 'conversation' });
  assert.deepStrictEqual(chatFiles(dir), ['chat.md', 'latest.json', 'meta.json']);
  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'chats', 'History chat', 'meta.json'), 'utf8'));
  assert.deepStrictEqual(meta.seen, messages.map(hashOf), 'summarized messages too, but not the interrupted reply');
  assert.strictEqual(meta.snapshots, 0);
  assert.strictEqual(meta.scannedCalls, undefined, 'the calls stay to be looked up at full');
  assert.strictEqual(meta.scannedReplies, undefined);
  assert.ok(!fs.existsSync(path.join(dir, require('../src/storeIndex.cjs').FILE)), 'the store is not indexed');
  assert.match(fs.readFileSync(path.join(dir, 'chats', 'History chat', 'chat.md'), 'utf8'), /second question/);
});

test('historyDetail standard adds thinking, transcript.md and a snapshot per update, not per model call', () => {
  const { db, dir } = detailedChat();
  history.recordUpdatedSince(db, dir, 0, { detail: 'standard' });
  assert.deepStrictEqual(chatFiles(dir), ['chat.md', 'latest.json', 'meta.json', 'snapshots', 'thinking.json', 'transcript.md']);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'chats', 'History chat', 'snapshots')), ['2000.json']);
  assert.match(fs.readFileSync(path.join(dir, 'chats', 'History chat', 'chat.md'), 'utf8'), /The bug is in a\.js\./);
  assert.doesNotMatch(fs.readFileSync(path.join(dir, 'chats', 'History chat', 'transcript.md'), 'utf8'), /Halfway through the fix/);
});

test('a chat recorded below full gets the full detail on its next update at full; nothing recorded is removed', () => {
  const { db, dir, save, prompt, interrupted } = detailedChat();
  history.recordUpdatedSince(db, dir, 0, { detail: 'conversation' });
  const third = { role: 'user', content: 'third question' };
  save(3000, [...prompt, third], { archive: [first, answer], turns: [[step.thinking('The bug is in a.js.'), callStep('t1')]] });
  history.recordUpdatedSince(db, dir, 2000);
  assert.ok(chatFiles(dir).includes('thinking.json') && chatFiles(dir).includes('transcript.md'));
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'chats', 'History chat', 'meta.json'), 'utf8'));
  assert.ok(after.seen.includes(hashOf(interrupted)), 'the interrupted reply is looked for now');
  assert.deepStrictEqual(after.scannedCalls, ['t1']);

  // Back down: what full recorded stays.
  save(4000, [...prompt, third, { role: 'user', content: 'fourth question' }], { archive: [first, answer] });
  history.recordUpdatedSince(db, dir, 3000, { detail: 'conversation' });
  assert.ok(chatFiles(dir).includes('thinking.json') && chatFiles(dir).includes('transcript.md'));
  assert.ok(!fs.readdirSync(path.join(dir, 'chats', 'History chat', 'snapshots')).some((f) => f.startsWith('4000')));
});

test('a tick below full does not read the store into its index, and records at once', () => {
  const { db, dir } = detailedChat();
  const result = history.tick(db, dir, { detail: 'standard' });
  assert.strictEqual(result.storeIndexed, false);
  assert.strictEqual(result.recorded, 1);
  assert.ok(!fs.existsSync(path.join(dir, require('../src/storeIndex.cjs').FILE)));
});

test('below standard chat.md has no thinking, even one a higher level recorded, and a late blob rewrites chat.md only', () => {
  const { db, dir, save, prompt } = detailedChat();
  const chat = path.join(dir, 'chats', 'History chat');
  history.recordUpdatedSince(db, dir, 0);
  const thinking = fs.readFileSync(path.join(chat, 'thinking.json'), 'utf8');
  const transcript = fs.readFileSync(path.join(chat, 'transcript.md'), 'utf8');
  const snapshots = fs.readdirSync(path.join(chat, 'snapshots')).sort();
  // The next prompt arrives before its blob is stored.
  const third = { role: 'user', content: 'third question' };
  save(3000, [...prompt, third], { archive: [first, answer], turns: [[step.thinking('The bug is in a.js.'), callStep('t1')]] });
  db.prepare('DELETE FROM cursorDiskKV WHERE key = ?').run(`agentKv:blob:${hashOf(third)}`);
  history.recordUpdatedSince(db, dir, 2000, { detail: 'conversation' });
  assert.doesNotMatch(fs.readFileSync(path.join(chat, 'chat.md'), 'utf8'), /The bug is in a\.js\./);
  // The unchanged chat gets the blob: chat.md is written again, and nothing a higher level keeps.
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(`agentKv:blob:${hashOf(third)}`, Buffer.from(JSON.stringify(third)));
  history.recordChat(db, 'chat-1', dir, undefined, { detail: 'conversation' });
  const md = fs.readFileSync(path.join(chat, 'chat.md'), 'utf8');
  assert.match(md, /third question/);
  assert.doesNotMatch(md, /The bug is in a\.js\./);
  assert.strictEqual(fs.readFileSync(path.join(chat, 'thinking.json'), 'utf8'), thinking);
  assert.strictEqual(fs.readFileSync(path.join(chat, 'transcript.md'), 'utf8'), transcript);
  assert.deepStrictEqual(fs.readdirSync(path.join(chat, 'snapshots')).sort(), snapshots);
});

test('a lookup still waiting at full is dropped below full, so the chat settles; full looks it up again', () => {
  const { db, save, dir } = setup();
  const clock = () => 5000;
  save(1000, [sys, first]);
  db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run('bubbleId:chat-1:reply-3', JSON.stringify({ type: 2, text: 'Never stored.' }));
  const meta = () => JSON.parse(fs.readFileSync(path.join(dir, 'chats', 'History chat', 'meta.json'), 'utf8'));
  assert.strictEqual(history.tick(db, dir, { clock }).pending, 1);
  assert.ok(meta().scanPending);
  assert.strictEqual(history.tick(db, dir, { clock, detail: 'standard' }).pending, 0);
  assert.strictEqual(meta().scanPending, undefined);
  assert.strictEqual(meta().scannedReplies, undefined, 'not given up: left for full');
  // Back at full, the unchanged chat is looked up again when it is recorded (here by Record History of All Chats).
  history.recordUpdatedSince(db, dir, 0);
  assert.deepStrictEqual(Object.keys(meta().scanPending.replies), ['reply-3']);
});
