'use strict';

// Keeps a local history of agent sessions: every prompt message ever seen
// (stored once, by Cursor's own content hash) plus a snapshot per chat update.
// Cursor drops old messages when it summarizes a chat; the history keeps them.
//
// <dir>/
//   blobs/<sha256>.json            prompt message, exactly as Cursor stored it
//   context/<sha256>.bin|.md       context sent outside the prompt (rules, skills...), see sentContext.cjs
//   chats/<chat name>/             one folder per chat (<chat> below); "<name> (<id prefix>)" when names clash
//   index.json                     chats newest first, each with its subagent tree
//
// <chat>/
//   meta.json                      name, model, workspace, message hashes in first-seen order,
//                                  context sent with each user message (sentContext)
//   snapshots/<changedAt>.json     token breakdown + the root message hashes at that moment
//   snapshots/<lastUpdatedAt>-<n>.json  the first n of them: a model call's prompt, or a turn's end, before that update;
//                                  with "replaced": i, the prompt of the call after a tool result Cursor replaced, its earlier result at i
//   latest.json                    newest snapshot plus Cursor's usage tree
//   chat.md                        the conversation, readable: user, agent, thinking, tool calls
//   thinking.json                  the agent's readable thinking from Cursor's turn steps, placed on prompt messages;
//                                  thinking only a bubble kept, unplaced (source 'bubble')
//   transcript.md                  every message ever seen, raw text, in order; links subagents
//   subagents/<subagent name>/     a <chat> for each subagent it spawned (nested to any depth)
//
// Folders follow renames in Cursor; meta.json's composerId says which chat a folder holds.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('./cursorStore.cjs');
const turnSteps = require('./turnSteps.cjs');
const { chatMarkdown, userBlocks } = require('./chatMarkdown.cjs');
const sentContext = require('./sentContext.cjs');

function defaultHistoryDir() {
  return path.join(os.homedir(), '.cursor-context-history');
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// A chat name made safe as a folder name on any filesystem.
function folderName(name) {
  const safe = String(name || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
    .replace(/[. ]+$/, '')
    .trim();
  return safe || 'Untitled chat';
}

// Which chat each folder in `container` holds: meta.json's composerId, or the
// folder name itself for folders named by id (before 0.8.1). Only new entries are read.
const ownersCache = new Map();
function folderOwners(container) {
  const known = ownersCache.get(container) || new Map();
  const entries = fs.existsSync(container) ? fs.readdirSync(container) : [];
  const owners = new Map(entries.map((e) => [e, known.has(e) ? known.get(e) : readJson(path.join(container, e, 'meta.json'), {}).composerId || e]));
  ownersCache.set(container, owners);
  return owners;
}

// When a chat last changed. Cursor sets lastUpdatedAt when the user sends, and
// conversationCheckpointLastUpdatedAt when the agent stores its state (the run's
// last one when it ends); some subagent chats only have createdAt.
const CHANGED_AT = `MAX(COALESCE(json_extract(value, '$.lastUpdatedAt'), json_extract(value, '$.createdAt'), 0),
  COALESCE(json_extract(value, '$.conversationCheckpointLastUpdatedAt'), 0))`;
const changedAt = (composer) => Math.max(composer.lastUpdatedAt || 0, composer.conversationCheckpointLastUpdatedAt || 0);

function chatName(db, composerId) {
  const row = db.prepare("SELECT json_extract(value, '$.name') AS name FROM cursorDiskKV WHERE key = ?").get(`composerData:${composerId}`);
  return row ? row.name || 'Untitled chat' : undefined;
}

// The chat's folder inside `container`, named after the chat. Renames the folder
// when the chat was renamed; moves `from` (an older location) there when given.
function placeChat(container, composerId, name, from) {
  const owners = folderOwners(container);
  const base = folderName(name);
  const wanted = owners.has(base) && owners.get(base) !== composerId ? `${base} (${composerId.slice(0, 8)})` : base;
  const target = path.join(container, wanted);
  // A window still on an older version may have recorded the chat again in an id-named folder.
  if (owners.get(wanted) === composerId) return target;
  let current;
  for (const [entry, id] of owners) if (id === composerId) current = entry;
  const source = current !== undefined ? path.join(container, current) : from;
  if (source) {
    fs.mkdirSync(container, { recursive: true });
    fs.renameSync(source, target);
    owners.delete(current);
  }
  owners.set(wanted, composerId);
  // Without meta.json a folder no longer says which chat it holds.
  if (!fs.existsSync(path.join(target, 'meta.json'))) writeAtomic(path.join(target, 'meta.json'), JSON.stringify({ composerId, name }, null, 2));
  return target;
}

// Moves into `into` whatever `from` has that it lacks, folder by folder, then removes `from`.
// A placeholder meta.json is replaced; recorded ones join the messages they saw. Snapshots
// join as if recorded again: a state under a taken name is kept beside it, not twice.
function mergeInto(from, into) {
  for (const entry of fs.readdirSync(from)) {
    const src = path.join(from, entry);
    const dst = path.join(into, entry);
    if (entry === 'meta.json' && fs.existsSync(dst)) {
      const kept = readJson(dst, {});
      const other = readJson(src, {});
      if (!kept.seen) fs.renameSync(src, dst);
      else if (other.seen) writeAtomic(dst, JSON.stringify({ ...kept, seen: [...new Set([...kept.seen, ...other.seen])] }, null, 2));
    } else if (path.basename(into) === 'snapshots' && entry.endsWith('.json')) {
      writeSnapshot(path.dirname(into), entry.replace(/(-at\d+(-\d+)?)?\.json$/, ''), readJson(src, undefined), fs.readFileSync(src));
    } else if (!fs.existsSync(dst)) fs.renameSync(src, dst);
    else if (fs.statSync(src).isDirectory() && fs.statSync(dst).isDirectory()) mergeInto(src, dst);
  }
  fs.rmSync(from, { recursive: true, force: true });
}

// chats/<root>/subagents/<child>/…/subagents/<chat>, from Cursor's parent links.
function chatDirFor(db, dir, composerId, name = chatName(db, composerId), from = undefined) {
  const chain = [...store.ancestors(db, composerId), { composerId, name }];
  let container = path.join(dir, 'chats');
  let chatDir;
  chain.forEach((chat, i) => {
    chatDir = placeChat(container, chat.composerId, chat.name, i === chain.length - 1 ? from : undefined);
    container = path.join(chatDir, 'subagents');
  });
  return chatDir;
}

// Two recordings of one state differ only in recordedAt.
const sameState = (a, b) => JSON.stringify({ ...a, recordedAt: 0 }) === JSON.stringify({ ...b, recordedAt: 0 });

// Never overwrite a snapshot: a run recorded mid-way, or summarized, has several states under
// one timestamp. A taken name gets `-at<recordedAt>`, and `-at<recordedAt>-<k>` when several
// states are recorded in one ms; neither is to be read as `-<n>`. A state already recorded
// under the name is not written again. Returns whether the snapshot was written. `data`: the
// file's bytes, for a snapshot moved as it is (`snapshot` undefined when unreadable).
function writeSnapshot(chatDir, name, snapshot, data = JSON.stringify(snapshot, null, 2)) {
  const folder = path.join(chatDir, 'snapshots');
  fs.mkdirSync(folder, { recursive: true });
  const taken = new RegExp(`^${name}(-at\\d+(-\\d+)?)?\\.json$`);
  const recorded = (file) => {
    const old = readJson(file, undefined);
    return old && snapshot ? sameState(old, snapshot) : fs.readFileSync(file).equals(Buffer.from(data));
  };
  for (const f of fs.readdirSync(folder)) if (taken.test(f) && recorded(path.join(folder, f))) return false;
  const at = (snapshot && snapshot.recordedAt) ?? 0;
  const tmp = path.join(folder, `${name}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, data);
  try {
    for (let k = 1; ; k++) {
      const file = path.join(folder, k === 1 ? `${name}.json` : `${name}-at${at}${k > 2 ? `-${k - 1}` : ''}.json`);
      try {
        // A link is created whole, and only where no file is.
        fs.linkSync(tmp, file);
        return true;
      } catch (err) {
        if (err.code === 'EEXIST') continue;
        if (!['EPERM', 'ENOTSUP', 'ENOSYS'].includes(err.code)) throw err;
      }
      // A filesystem without links.
      try {
        fs.writeFileSync(file, data, { flag: 'wx' });
        return true;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
    }
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

// Record one chat and the subagents it spawned. Returns the number of new snapshots.
// options.sentContext: rebuild the context sent with new user messages (sentContext.record).
// options.clock: the time recordedAt is taken from (Date.now).
function recordChat(db, composerId, dir, visited = new Set(), options = {}) {
  if (visited.has(composerId)) return 0;
  visited.add(composerId);
  const raw = store.getValue(db, `composerData:${composerId}`);
  if (raw === undefined) return 0;
  const composer = JSON.parse(raw);
  // Some subagent chats never get lastUpdatedAt; createdAt identifies their only version.
  composer.lastUpdatedAt = composer.lastUpdatedAt || composer.createdAt;
  if (!composer.conversationState || !composer.lastUpdatedAt) return 0;
  // Subagents first, so the parent's transcript links to folders that exist.
  let recorded = 0;
  for (const id of composer.subagentComposerIds || []) recorded += recordChat(db, id, dir, visited, options);

  // Chats opened but never sent have no messages: nothing to keep.
  const hashes = store.rootMessageHashes(composer.conversationState);
  if (!hashes.length) return recorded;
  const chatDir = chatDirFor(db, dir, composerId, composer.name || 'Untitled chat');
  const breakdown = composer.promptTokenBreakdown || {};
  const totalUsedTokens = breakdown.totalUsedTokens ?? composer.contextTokensUsed;
  const metaFile = path.join(chatDir, 'meta.json');
  const previous = readJson(metaFile, {});
  // Messages Cursor kept that are no longer in the prompt. Two kinds: the ones summarization archived
  // (the state's summary archive names them), and the earlier version of a result that was replaced in
  // the prompt, which nothing in the state names: only a read of the whole store finds it, by its call
  // id. That read is costly, so it runs once per set of calls, and not while a run writes the chat.
  const archived = turnSteps.archivedHashes(db, composer.conversationState);
  const turns = turnSteps.loadTurns(db, composer.conversationState);
  const scanned = new Set(previous.scannedCalls || []);
  const unscanned = [...new Set(turns.flatMap((t) => t.steps).map(turnSteps.callIdOf).filter(Boolean))].filter((id) => !scanned.has(id));
  // The replies Cursor showed (bubble text) that no recorded message holds: an interrupted reply is kept
  // by Cursor outside the prompt. Each bubble is checked once (scannedReplies), and searched for with the calls.
  const repliedBefore = previous.scannedReplies || [];
  const replied = new Set(repliedBefore);
  const pending = turnSteps.bubbleReplies(db, composerId).filter((r) => !replied.has(r.bubble));
  const texts = pending.length ? recordedTexts(db, dir, [...hashes, ...archived, ...(previous.seen || [])]) : new Set();
  const matched = pending.filter((r) => texts.has(r.text.trim()));
  const missing = pending.filter((r) => !texts.has(r.text.trim()));
  // Not while a run writes the chat (the same test as unsettled()): its results and replies may still change.
  const writing = composer.status === 'generating' || (composer.generatingBubbleIds || []).length > 0;
  const scanNow = (unscanned.length > 0 || missing.length > 0) && options.scanCalls !== false && !writing;
  const replyMarks = (scanNow ? pending : matched).map((r) => r.bubble);
  const found = new Map();
  if (scanNow) {
    // Between the rows of the chat's own blobs (Cursor stores a run's messages as it goes).
    const own = [...hashes, ...archived, ...turns.flatMap((t) => [t.turn, ...t.steps.map((s) => s.hash)])]
      .map((h) => store.rowidOf(db, `agentKv:blob:${h}`)).filter((r) => r !== undefined);
    const ids = new Set(unscanned);
    // The text as Cursor stores it (JSON), a prefix of it: the candidates are checked below.
    const probes = missing.map((r) => JSON.stringify(r.text).slice(1, -1).slice(0, 120));
    const replyTexts = new Set(missing.map((r) => r.text.trim()));
    for (const { hash, value } of own.length ? store.blobsNaming(db, [...unscanned, ...probes], Math.min(...own), Math.max(...own)) : []) {
      let message;
      try { message = JSON.parse(value.toString('utf8')); } catch { continue; }
      if (!message || !Array.isArray(message.content)) continue;
      const call = message.content.some((p) => p && ids.has(p.toolCallId));
      const reply = message.role === 'assistant' && message.content.some((p) => p && p.type === 'text' && replyTexts.has(String(p.text).trim()));
      if (call || reply) found.set(hash, value);
    }
  }
  // Before the check below: Cursor may write a message after the prompt that lists it.
  const fetched = new Set();
  for (const hash of new Set([...hashes, ...archived, ...found.keys()])) {
    const blobFile = path.join(dir, 'blobs', `${hash}.json`);
    if (fs.existsSync(blobFile)) continue;
    const value = found.has(hash) ? found.get(hash) : store.getValue(db, `agentKv:blob:${hash}`);
    if (value === undefined) continue;
    writeAtomic(blobFile, value);
    fetched.add(hash);
  }
  // The messages that left the prompt, once their blobs are here. Summarized ones are the chat's start:
  // they go before the prompt's. A replaced result goes where its row puts it (see placeStored).
  const inPrompt = new Set(hashes);
  const summarized = new Set(archived);
  const earlier = [...new Set([...archived, ...found.keys()])]
    .filter((h) => !inPrompt.has(h) && fs.existsSync(path.join(dir, 'blobs', `${h}.json`)));
  const remember = (meta) => {
    const seen = new Set(meta.seen);
    const fresh = (list) => [...new Set(list)].filter((h) => !seen.has(h));
    for (const h of [...fresh(earlier.filter((x) => summarized.has(x))), ...hashes]) if (!seen.has(h)) { meta.seen.push(h); seen.add(h); }
    placeStored(db, meta.seen, fresh(earlier.filter((x) => !summarized.has(x))));
  };
  // A subagent's messages carry the same context parts as the root's (the wire shows the same
  // blob ids). A message seen before its blob was written is new when the blob arrives.
  const sent = sentContext.record({
    dir, composer: { ...composer, workspaceIdentifier: workspaceIdentifierOf(db, composer) }, hashes, db, userBlocks,
    seenBefore: new Set((previous.seen || []).filter((h) => !fetched.has(h))),
    readMessage: (hash) => readJson(path.join(dir, 'blobs', `${hash}.json`), undefined),
  }, options.sentContext);
  // Unchanged since the last snapshot. Mid-run the messages change while lastUpdatedAt
  // stays at the send time, so the messages are compared, not only the time.
  const latest = readJson(path.join(chatDir, 'latest.json'), undefined);
  if (latest && latest.lastUpdatedAt === composer.lastUpdatedAt && latest.totalUsedTokens === totalUsedTokens
    && (latest.messages || []).join() === hashes.join()) {
    const meta = previous;
    if (meta.seen) {
      const seenBefore = meta.seen.length;
      remember(meta);
      if (sent) meta.sentContext = [...(meta.sentContext || []), sent];
      if (scanNow) meta.scannedCalls = [...scanned, ...unscanned];
      if (replyMarks.length) meta.scannedReplies = [...new Set([...repliedBefore, ...replyMarks])];
      if (scanNow || meta.seen.length !== seenBefore) {
        const states = recordReplaced(dir, chatDir, composerId, composer, hashes, meta.seen, new Set(archived), options.clock || Date.now);
        if (states) meta.snapshots = (meta.snapshots || 0) + states;
      }
      const relinked = addToolCallId(meta, composer);
      const changed = meta.seen.length !== seenBefore;
      if (sent || scanNow || changed || relinked || replyMarks.length) writeAtomic(metaFile, JSON.stringify(meta, null, 2));
      // The late message may be the one a thinking belongs to.
      if (fetched.size || changed) {
        recordThinking(db, dir, chatDir, meta, turns, composerId);
        writeTranscript(db, dir, chatDir, meta, hashes);
      }
    }
    return recorded;
  }

  // The states the chat went through since the last snapshot, written before this update's
  // snapshot and latest.json, which mark the update as recorded.
  const summaries = store.summaryCount(composer.conversationState);
  const model = composer.modelConfig && composer.modelConfig.modelName;
  const clock = options.clock || Date.now;
  let written = 0;
  for (const { before, state } of earlierStates(dir, hashes, summaries, latest)) {
    written += writeSnapshot(chatDir, `${composer.lastUpdatedAt}-${before}`, {
      composerId, recordedAt: clock(), lastUpdatedAt: composer.lastUpdatedAt, model, state, before, messages: hashes.slice(0, before),
    });
  }
  written += recordReplaced(dir, chatDir, composerId, composer, hashes, [...new Set([...(previous.seen || []), ...earlier])], new Set(archived), clock);
  const snapshot = {
    composerId,
    recordedAt: clock(),
    lastUpdatedAt: composer.lastUpdatedAt,
    model,
    totalUsedTokens,
    maxTokens: breakdown.maxTokens ?? composer.contextTokenLimit,
    categories: breakdown.categories || [],
    summaries,
    messages: hashes,
    ...(sent ? { sentContext: sent } : {}),
  };
  written += writeSnapshot(chatDir, changedAt(composer), snapshot);
  writeAtomic(path.join(chatDir, 'latest.json'), JSON.stringify({ ...snapshot, usageTree: composer.promptContextUsageTree }, null, 2));

  const meta = { composerId, firstRecordedAt: snapshot.recordedAt, seen: [], ...previous };
  remember(meta);
  if (scanNow) meta.scannedCalls = [...scanned, ...unscanned];
  if (replyMarks.length) meta.scannedReplies = [...new Set([...repliedBefore, ...replyMarks])];
  Object.assign(meta, {
    name: composer.name || 'Untitled chat',
    model: snapshot.model,
    workspace: composer.workspaceIdentifier && composer.workspaceIdentifier.configPath
      ? composer.workspaceIdentifier.configPath.fsPath
      : composer.workspaceIdentifier && composer.workspaceIdentifier.uri && composer.workspaceIdentifier.uri.fsPath,
    createdAt: composer.createdAt,
    parentComposerId: composer.subagentInfo && composer.subagentInfo.parentComposerId,
    subagentType: composer.subagentInfo && composer.subagentInfo.subagentTypeName,
    subagentIds: composer.subagentComposerIds || [],
    lastUpdatedAt: composer.lastUpdatedAt,
    totalUsedTokens: snapshot.totalUsedTokens,
    snapshots: (meta.snapshots || 0) + written,
  });
  if (sent) meta.sentContext = [...(meta.sentContext || []), sent];
  addToolCallId(meta, composer);
  writeAtomic(metaFile, JSON.stringify(meta, null, 2));
  recordThinking(db, dir, chatDir, meta, turns, composerId);
  writeTranscript(db, dir, chatDir, meta, hashes);
  return recorded + 1;
}

// The workspace a chat ran in. A subagent runs in its parent's: Cursor stores none for some
// subagents, and every other one names its parent's folders, so the parent's is used then.
function workspaceIdentifierOf(db, composer) {
  let c = composer;
  const seen = new Set();
  while (c && !c.workspaceIdentifier && c.subagentInfo && c.subagentInfo.parentComposerId && !seen.has(c.subagentInfo.parentComposerId)) {
    seen.add(c.subagentInfo.parentComposerId);
    const row = store.getValue(db, `composerData:${c.subagentInfo.parentComposerId}`);
    c = row === undefined ? undefined : JSON.parse(row);
  }
  return c && c.workspaceIdentifier;
}

// The parent's Task call that spawned a subagent. Cursor keeps only the latest one (a resumed
// subagent is called again), so each one the recorder sees is added to meta.toolCallIds, and
// none is dropped. Returns whether one was added.
function addToolCallId(meta, composer) {
  const id = composer.subagentInfo && composer.subagentInfo.toolCallId;
  if (!id || (meta.toolCallIds || []).includes(id)) return false;
  meta.toolCallIds = [...(meta.toolCallIds || []), id];
  return true;
}

// Adds messages stored outside the prompt to the record `list` where their rows put them: before the
// first recorded message stored after them. Rows are in storage order, and storage is the chat's order.
function placeStored(db, list, hashes) {
  const rows = new Map();
  const rowOf = (h) => {
    if (!rows.has(h)) rows.set(h, store.rowidOf(db, `agentKv:blob:${h}`));
    return rows.get(h);
  };
  for (const h of hashes) {
    const row = rowOf(h);
    const at = row === undefined ? -1 : list.findIndex((x) => { const r = rowOf(x); return r !== undefined && r > row; });
    if (at === -1) list.push(h); else list.splice(at, 0, h);
  }
}

// The texts (trimmed) of the assistant messages under these hashes. A message not written yet is read from the store.
function recordedTexts(db, dir, hashes) {
  const out = new Set();
  for (const h of new Set(hashes)) {
    const file = path.join(dir, 'blobs', `${h}.json`);
    let message;
    if (fs.existsSync(file)) message = readJson(file, undefined);
    else { try { message = JSON.parse(store.getValue(db, `agentKv:blob:${h}`) || 'null'); } catch { message = undefined; } }
    if (message && message.role === 'assistant' && Array.isArray(message.content)) {
      for (const p of message.content) if (p && p.type === 'text' && typeof p.text === 'string') out.add(p.text.trim());
    }
  }
  return out;
}

// A tool result Cursor replaced in the prompt: the prompt of the model call that followed it still held
// the earlier version (the one the record kept, found by its call id). Returns, for each such version,
// { before, index, messages }: the prompt before the first assistant message after the result, with the
// earlier version at the result's index. `seen`: the chat's messages in the record; `archived`: the ones summarization
// took out (a summary, not a replacement).
function replacedStates(dir, hashes, seen, archived) {
  const read = (h) => readJson(path.join(dir, 'blobs', `${h}.json`), undefined);
  const callIds = (m) => (m && Array.isArray(m.content) ? m.content.filter((p) => p && typeof p.toolCallId === 'string').map((p) => p.toolCallId) : []);
  const inPrompt = new Set(hashes);
  // An archived message was in an earlier prompt, not a replaced result of this one.
  const outside = seen.filter((h) => !inPrompt.has(h) && !archived.has(h));
  if (!outside.length) return [];
  const resultAt = new Map(); // call id -> index of the prompt's tool result
  const messages = hashes.map((h) => read(h));
  messages.forEach((m, i) => { if (m && m.role === 'tool') for (const id of callIds(m)) resultAt.set(id, i); });
  const out = [];
  for (const h of outside) {
    const m = read(h);
    if (!m || m.role !== 'tool') continue;
    const id = callIds(m).find((x) => resultAt.has(x));
    if (id === undefined) continue;
    const index = resultAt.get(id);
    const before = messages.findIndex((x, k) => k > index && x && x.role === 'assistant');
    if (before === -1) continue;
    out.push({ before, index, messages: hashes.slice(0, before).map((x, k) => (k === index ? h : x)) });
  }
  return out;
}

// Writes the snapshots of replacedStates. Returns how many were new.
function recordReplaced(dir, chatDir, composerId, composer, hashes, seen, archived, clock) {
  const model = composer.modelConfig && composer.modelConfig.modelName;
  let written = 0;
  for (const r of replacedStates(dir, hashes, seen, archived)) {
    written += writeSnapshot(chatDir, `${composer.lastUpdatedAt}-${r.before}`, {
      composerId, recordedAt: clock(), lastUpdatedAt: composer.lastUpdatedAt, model, state: 'prompt', before: r.before, messages: r.messages, replaced: r.index,
    });
  }
  return written;
}

// Cursor keeps only the chat's newest state, but the states it went through are prefixes of it:
// each assistant message was written by a model call that saw exactly the messages before it,
// and a turn ended before each user message that follows the agent. Returns, for the states
// since the `previous` snapshot, { before: index, state: 'prompt'|'turn end' }. Only while the
// chat just grew: a summary rewrites the prompt, and prefixes of the rewritten one were never sent.
// An edit of an earlier message also stops it: that run's states are not derived.
function earlierStates(dir, hashes, summaries, previous) {
  const before = (previous && previous.messages) || [];
  if (before.length >= hashes.length || before.some((h, i) => hashes[i] !== h)) return [];
  // Older snapshots lack `summaries`: the unchanged prefix shows the chat only grew.
  if (summaries > (previous ? previous.summaries ?? summaries : 0)) return [];
  const role = (i) => readJson(path.join(dir, 'blobs', `${hashes[i]}.json`), {}).role;
  const states = [];
  for (let i = before.length + 1; i < hashes.length; i++) {
    const r = role(i);
    if (r === 'assistant') states.push({ before: i, state: 'prompt' });
    else if (r === 'user' && ['assistant', 'tool'].includes(role(i - 1))) states.push({ before: i, state: 'turn end' });
  }
  return states;
}

// The prompt holds the model's thinking only encrypted; Cursor keeps the readable text as turn
// steps (see turnSteps.cjs). Each entry: { step, turn, text, durationMs, message, part }. Thinking
// of turns Cursor no longer lists stays as recorded. Thinking Cursor showed on a bubble but kept
// in no turn step is recorded unplaced (source 'bubble'): its message is not known.
function recordThinking(db, dir, chatDir, meta, turns, composerId) {
  const file = path.join(chatDir, 'thinking.json');
  const messages = meta.seen.map((hash) => ({ hash, message: readJson(path.join(dir, 'blobs', `${hash}.json`), undefined) }));
  const bubbles = turnSteps.bubbleThinking(db, composerId, turns)
    .map(({ bubble, text }) => ({ step: `bubble:${bubble}`, turn: null, text, message: null, part: null, source: 'bubble' }));
  const current = [...turnSteps.placeThinking(turns, messages), ...bubbles];
  const fresh = new Map(current.map((e) => [e.step, e]));
  const kept = readJson(file, []).map((e) => fresh.get(e.step) || e);
  const known = new Set(kept.map((e) => e.step));
  writeAtomic(file, JSON.stringify([...kept, ...current.filter((e) => !known.has(e.step))], null, 2));
}

// The Task calls whose results name each subagent (its composer id is in the result): the calls
// a resumed subagent was started or resumed by, which Cursor's DB no longer points to. Returns
// Map(composerId -> [toolCallId]).
function taskCallsFor(messages, composerIds) {
  const out = new Map();
  for (const m of messages) {
    if (!m || m.role !== 'tool' || !Array.isArray(m.content)) continue;
    for (const part of m.content) {
      if (!part || !part.toolCallId || part.toolName !== 'Task') continue;
      const text = JSON.stringify(part);
      for (const id of composerIds) {
        const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        if (new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(text)) out.set(id, [...new Set([...(out.get(id) || []), part.toolCallId])]);
      }
    }
  }
  return out;
}

// Adds toolCallIds to a subagent's meta.json (a subagent recorded before, or with a call the DB
// no longer names). Never drops one.
function keepToolCallIds(file, ids) {
  const meta = readJson(file, undefined);
  if (!meta || !meta.seen) return;
  const merged = [...new Set([...(meta.toolCallIds || []), ...ids])];
  if (merged.length === (meta.toolCallIds || []).length) return;
  meta.toolCallIds = merged;
  writeAtomic(file, JSON.stringify(meta, null, 2));
}

function writeTranscript(db, dir, chatDir, meta, currentHashes) {
  const folders = new Map([...folderOwners(path.join(chatDir, 'subagents'))].map(([entry, id]) => [id, entry]));
  // The tool calls each subagent's own meta.json kept (see addToolCallId).
  const known = (id) => (folders.has(id) ? readJson(path.join(chatDir, 'subagents', folders.get(id), 'meta.json'), {}).toolCallIds || [] : []);
  const recorded = meta.seen.map((hash) => ({ hash, message: readJson(path.join(dir, 'blobs', `${hash}.json`), undefined) })).filter((m) => m.message);
  const ids = meta.subagentIds || [];
  const byResult = taskCallsFor(recorded.map((m) => m.message), ids);
  const subagents = store.loadSubagents(db, ids, known).map((s) => {
    const toolCallIds = [...new Set([...s.toolCallIds, ...(byResult.get(s.composerId) || [])])];
    const folder = folders.get(s.composerId);
    if (folder) keepToolCallIds(path.join(chatDir, 'subagents', folder, 'meta.json'), toolCallIds);
    return { ...s, toolCallIds, folder };
  });
  const parent = meta.parentComposerId && store.ancestors(db, meta.composerId).pop();
  const thinking = readJson(path.join(chatDir, 'thinking.json'), []);
  writeAtomic(path.join(chatDir, 'transcript.md'), transcript(dir, meta, new Set(currentHashes), subagents, parent, thinking));
  const sentWith = new Map((meta.sentContext || []).flatMap((e) => e.messages.map((h) => [h, e])));
  writeAtomic(path.join(chatDir, 'chat.md'), chatMarkdown(meta, recorded.map((m) => m.message), {
    subagents, parent, thinking: thinkingByMessage(thinking, recorded.map((m) => m.hash)),
    sentContext: recorded.map((m) => sentWith.get(m.hash)), contextDir: path.relative(chatDir, path.join(dir, 'context')).split(path.sep).join('/'),
  }));
}

// Thinking per message (aligned with `hashes`): placed thinking on its message; thinking whose
// message is not in the record after the message the previous thinking was on. Before any was
// placed (messages summarized before the chat was first recorded), after the message before the
// first placed one's; with none placed, after the last.
function thinkingByMessage(thinking, hashes) {
  const out = hashes.map(() => []);
  const at = new Map(hashes.map((h, i) => [h, i]));
  const first = thinking.map((e) => at.get(e.message)).find((i) => i !== undefined);
  let last = first === undefined ? hashes.length - 1 : Math.max(first - 1, 0);
  for (const e of thinking) {
    const i = at.get(e.message);
    if (i !== undefined) out[(last = i)].push(e);
    else if (last >= 0) out[last].push({ ...e, part: null, unplaced: true });
  }
  return out;
}

// Re-render every recorded transcript (after a layout change), refreshing
// subagent links from Cursor's DB. Metas written by 0.5 lack those fields.
function rebuildTranscripts(db, dir) {
  const walk = (chatDir) => {
    const metaFile = path.join(chatDir, 'meta.json');
    const meta = readJson(metaFile, undefined);
    if (meta && meta.seen) {
      const row = store.getValue(db, `composerData:${meta.composerId}`);
      const composer = row ? JSON.parse(row) : {};
      if (composer.subagentComposerIds) meta.subagentIds = composer.subagentComposerIds;
      if (composer.subagentInfo) {
        meta.parentComposerId = composer.subagentInfo.parentComposerId;
        meta.subagentType = composer.subagentInfo.subagentTypeName;
        addToolCallId(meta, composer);
      }
      writeAtomic(metaFile, JSON.stringify(meta, null, 2));
      for (const id of meta.subagentIds || []) recordChat(db, id, dir);
      if (row) recordThinking(db, dir, chatDir, meta, turnSteps.loadTurns(db, composer.conversationState), meta.composerId);
      const latest = readJson(path.join(chatDir, 'latest.json'), { messages: meta.seen });
      writeTranscript(db, dir, chatDir, meta, latest.messages);
    }
    const subDir = path.join(chatDir, 'subagents');
    if (fs.existsSync(subDir)) for (const id of fs.readdirSync(subDir)) walk(path.join(subDir, id));
  };
  const chatsDir = path.join(dir, 'chats');
  if (fs.existsSync(chatsDir)) for (const id of fs.readdirSync(chatsDir)) walk(path.join(chatsDir, id));
}

// Subagents Cursor saved no context for have no folder, so no link.
const subLink = (s) => {
  const name = s.name || 'Untitled subagent';
  const link = s.folder ? `[${name}](subagents/${encodeURIComponent(s.folder)}/transcript.md)` : name;
  return `${link}${s.type ? ` (${s.type})` : ''}`;
};

function transcript(dir, meta, current, subagents = [], parent, thinking = []) {
  const head = [
    `# ${meta.name}`,
    '',
    parent ? `- Subagent of: [${parent.name}](../../transcript.md)${meta.subagentType ? ` — type ${meta.subagentType}` : ''}` : undefined,
    `- Chat: ${meta.composerId}`,
    `- Model: ${meta.model || '?'}`,
    meta.workspace ? `- Workspace: ${meta.workspace}` : undefined,
    meta.lastUpdatedAt ? `- Last update: ${new Date(meta.lastUpdatedAt).toISOString()}` : undefined,
    `- Messages ever seen: ${meta.seen.length} (${current.size} in the latest prompt; others were dropped, e.g. by summarization)`,
    subagents.length ? `- Subagents (${subagents.length}):` : undefined,
    ...subagents.map((s) => `  - ${subLink(s)}`),
    '',
  ].filter((l) => l !== undefined);
  // Subagents are linked where they were spawned: the tool call carrying one of their toolCallIds
  // (a resumed subagent is linked from each Task call that resumed it).
  const spawnedBy = (message) => {
    const ids = Array.isArray(message.content) ? message.content.map((p) => p.toolCallId).filter(Boolean) : [];
    return subagents.filter((s) => (s.toolCallIds || []).some((c) => ids.some((id) => id.includes(c) || c.includes(id))));
  };
  // The readable thinking Cursor kept for a message, quoted after it: it is not prompt text.
  const thoughts = (hash) => thinking.filter((e) => e.message === hash).map((e) => {
    const where = e.part === null ? '' : ` (content[${e.part}])`;
    return `\n> Readable thinking${where}, from Cursor's turn step ${e.step.slice(0, 12)}:\n>\n> ${e.text.replace(/\n/g, '\n> ')}\n`;
  }).join('');
  const body = meta.seen.map((hash, i) => {
    const message = readJson(path.join(dir, 'blobs', `${hash}.json`), { role: 'missing', content: `(blob ${hash} not recorded)` });
    const status = current.has(hash) ? '' : ' (no longer in prompt)';
    const links = message.role === 'assistant' ? spawnedBy(message).map((s) => `\n> ↳ Subagent: ${subLink(s)}\n`).join('') : '';
    return `## #${i} ${message.role}${status}\n\n${store.messageText(message)}\n${thoughts(hash)}${links}`;
  });
  return `${head.join('\n')}\n${body.join('\n')}`;
}

// Earlier versions named folders by chat id (0.5–0.8.0) and stored subagents as
// top-level chats (0.5–0.6); rename them and move subagents under their parent.
// Each folder is checked once per recorder; recordChat renames chats that change.
const checkedFolders = new Set();
function migrateLayout(db, dir) {
  const chatsDir = path.join(dir, 'chats');
  let moved = 0;
  const walk = (from, id) => {
    if (checkedFolders.has(from)) return;
    // Parent links come from Cursor's DB: metas written by 0.5 lack parentComposerId.
    const name = chatName(db, id) || readJson(path.join(from, 'meta.json'), {}).name;
    const target = chatDirFor(db, dir, id, name, from);
    if (target !== from) moved++;
    // The target already exists: a placeholder holding nested subagents, or the
    // chat recorded again by a newer window. Either way, combine the two.
    if (fs.existsSync(from) && target !== from) mergeInto(from, target);
    const subDir = path.join(target, 'subagents');
    for (const [entry, subId] of [...folderOwners(subDir)]) walk(path.join(subDir, entry), subId);
    // Chats recorded before 0.10 have no chat.md yet; before thinking was kept, no thinking.json.
    const meta = readJson(path.join(target, 'meta.json'), {});
    const noThinking = meta.seen && !fs.existsSync(path.join(target, 'thinking.json'));
    if (noThinking) {
      const row = store.getValue(db, `composerData:${id}`);
      const state = row ? JSON.parse(row).conversationState : undefined;
      recordThinking(db, dir, target, meta, turnSteps.loadTurns(db, state), id);
    }
    if (meta.seen && (noThinking || !fs.existsSync(path.join(target, 'chat.md')))) {
      writeTranscript(db, dir, target, meta, readJson(path.join(target, 'latest.json'), { messages: meta.seen }).messages);
    }
    checkedFolders.add(target);
  };
  for (const [entry, id] of [...folderOwners(chatsDir)]) if (fs.existsSync(path.join(chatsDir, entry))) walk(path.join(chatsDir, entry), id);
  return moved;
}

function writeIndex(dir) {
  const entry = (chatDir) => {
    const meta = readJson(path.join(chatDir, 'meta.json'), undefined);
    const subDir = path.join(chatDir, 'subagents');
    const subagents = fs.existsSync(subDir) ? fs.readdirSync(subDir).map((id) => entry(path.join(subDir, id))) : [];
    subagents.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const { composerId, name, model, workspace, subagentType, createdAt, lastUpdatedAt, totalUsedTokens, snapshots, seen } = meta || {};
    return {
      composerId: composerId || path.basename(chatDir), name, model, workspace, subagentType, createdAt, lastUpdatedAt, totalUsedTokens, snapshots,
      messages: seen && seen.length,
      path: path.relative(dir, chatDir),
      ...(subagents.length ? { subagents } : {}),
    };
  };
  const chatsDir = path.join(dir, 'chats');
  const chats = fs.existsSync(chatsDir) ? fs.readdirSync(chatsDir).map((id) => entry(path.join(chatsDir, id))) : [];
  chats.sort((a, b) => (b.lastUpdatedAt || 0) - (a.lastUpdatedAt || 0));
  writeAtomic(path.join(dir, 'index.json'), JSON.stringify(chats, null, 2));
}

// A chat still running, or whose prompt messages Cursor has not all written yet.
// It can change without a newer timestamp, so it is checked again until it settles.
function unsettled(db, dir, composerId) {
  const raw = store.getValue(db, `composerData:${composerId}`);
  if (raw === undefined) return false;
  const composer = JSON.parse(raw);
  if (composer.status === 'generating' || (composer.generatingBubbleIds || []).length) return true;
  return store.rootMessageHashes(composer.conversationState).some((h) => !fs.existsSync(path.join(dir, 'blobs', `${h}.json`)));
}

// Record chats changed after `since` and up to `until` (ms), oldest first, at most
// `limit` of them. Returns { recorded, watermark, more, unsettled } (unsettled: { id: changedAt }).
function recordUpdatedSince(db, dir, since, { until = Number.MAX_SAFE_INTEGER, limit = -1, sentContext: sent, clock } = {}) {
  const rows = db.prepare(`
    SELECT id, t FROM (
      SELECT substr(key, 14) AS id, ${CHANGED_AT} AS t
      FROM cursorDiskKV
      WHERE key LIKE 'composerData:%' AND json_extract(value, '$.conversationState') IS NOT NULL)
    WHERE t > ? AND t <= ?
    ORDER BY t LIMIT ?`).all(since, until, limit);
  let recorded = 0;
  let watermark = since;
  const pending = {};
  for (const r of rows) {
    // One unreadable chat must not stop the others (or the backfill) for good.
    try {
      recorded += recordChat(db, r.id, dir, undefined, { sentContext: sent, clock });
      if (unsettled(db, dir, r.id)) pending[r.id] = r.t;
    } catch (err) {
      console.error(`[context-inspector] could not record chat ${r.id}:`, err);
    }
    watermark = Math.max(watermark, r.t);
  }
  if (recorded) writeIndex(dir);
  return { recorded, watermark, more: limit >= 0 && rows.length === limit, unsettled: pending };
}

// Records the chats left unsettled by earlier ticks again. `pending` maps each to when
// it was first found unsettled. Returns { recorded, pending }: those still unsettled.
// A chat stuck unsettled (e.g. a blob Cursor never wrote) is given up after
// `PENDING_MS`; its later changes still reach the recorder by timestamp.
const PENDING_MS = 86400000;
function recordPending(db, dir, pending, now, sent, clock) {
  let recorded = 0;
  const still = {};
  for (const [id, since] of Object.entries(pending)) {
    try {
      recorded += recordChat(db, id, dir, undefined, { sentContext: sent, clock });
      if (now - since < PENDING_MS && unsettled(db, dir, id)) still[id] = since;
    } catch (err) {
      console.error(`[context-inspector] could not record chat ${id}:`, err);
    }
  }
  if (recorded) writeIndex(dir);
  return { recorded, pending: still };
}

// One recorder per machine: several Cursor windows share the history directory.
function tryLock(dir, staleMs) {
  const file = path.join(dir, '.recorder.lock');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const held = readJson(file, undefined);
  if (held && held.pid !== process.pid && now - held.at < staleMs) return false;
  // Another window may have renamed folders while it held the lock.
  if (!held || held.pid !== process.pid) {
    ownersCache.clear();
    checkedFolders.clear();
  }
  writeAtomic(file, JSON.stringify({ pid: process.pid, at: now }));
  return true;
}

// 3: folders named after chats. 2: subagents nested in their parent.
const LAYOUT = 3;
// Bumped when a recorder bug may have left chats unrecorded: the backfill runs again.
// 1: chats whose run ended after the watermark had passed their send time.
const RESCAN = 1;

// Called periodically. Records chats updated since the last tick, then catches up
// on older ones `backfillBatch` at a time: all of them, or the last `backfillDays`.
// Returns `backfilling` while older chats remain.
// sentContext: options for sentContext.record ({ enabled, appDir }); rebuilt once per tick.
// clock: the time now (Date.now).
function tick(db, dir, { backfillDays = 0, backfillBatch = 50, staleMs = 90000, sentContext: sent, clock = Date.now } = {}) {
  if (!tryLock(dir, staleMs)) return { recorded: 0, skipped: 'another window is recording' };
  const stateFile = path.join(dir, 'state.json');
  const now = clock();
  const state = readJson(stateFile, { watermark: now, layout: LAYOUT });
  // Before 0.10 the first run went back only 7 days and never further.
  if (!state.backfill || state.rescan !== RESCAN) state.backfill = { from: backfillDays > 0 ? now - backfillDays * 86400000 : 0, until: state.watermark };
  const rescan = state.rescan !== RESCAN;
  // Every tick: windows still running an older version may write id-named or flat folders.
  const migrated = migrateLayout(db, dir);
  const relayout = migrated || state.layout !== LAYOUT;
  if (relayout) rebuildTranscripts(db, dir);
  const before = JSON.stringify([state.backfill, state.pending || {}]);
  const sentOptions = sent && { ...sent, cache: new Map() };
  const again = recordPending(db, dir, state.pending || {}, now, sentOptions, clock);
  const result = recordUpdatedSince(db, dir, state.watermark, { sentContext: sentOptions, clock });
  let recorded = again.recorded + result.recorded;
  const pending = { ...again.pending };
  for (const id of Object.keys(result.unsettled)) pending[id] = pending[id] || now;
  if (!state.backfill.done) {
    const older = recordUpdatedSince(db, dir, state.backfill.from, { until: state.backfill.until, limit: backfillBatch, sentContext: sentOptions, clock });
    recorded += older.recorded;
    // Only recent chats wait to settle: an old one stuck unsettled would be retried for nothing.
    for (const [id, t] of Object.entries(older.unsettled)) if (now - t < PENDING_MS) pending[id] = pending[id] || now;
    // One ms back: chats sharing the batch's last timestamp may not all be in it.
    state.backfill = older.more ? { ...state.backfill, from: older.watermark - 1 } : { done: true };
  }
  if (relayout && !recorded) writeIndex(dir);
  if (relayout || rescan || result.watermark !== state.watermark || JSON.stringify([state.backfill, pending]) !== before) {
    writeAtomic(stateFile, JSON.stringify({ watermark: result.watermark, layout: LAYOUT, rescan: RESCAN, backfill: state.backfill, pending }));
  }
  return { recorded, watermark: result.watermark, migrated, backfilling: !state.backfill.done, pending: Object.keys(pending).length };
}

module.exports = { defaultHistoryDir, folderName, chatDirFor, recordChat, recordUpdatedSince, migrateLayout, rebuildTranscripts, tick, writeIndex };
