'use strict';

// Keeps a local history of agent sessions: every prompt message ever seen
// (stored once, by Cursor's own content hash) plus a snapshot per chat update.
// Cursor drops old messages when it summarizes a chat; the history keeps them.
//
// <dir>/
//   blobs/<sha256>.json            prompt message, exactly as Cursor stored it
//   chats/<chat name>/             one folder per chat (<chat> below); "<name> (<id prefix>)" when names clash
//   index.json                     chats newest first, each with its subagent tree
//
// <chat>/
//   meta.json                      name, model, workspace, message hashes in first-seen order
//   snapshots/<lastUpdatedAt>.json token breakdown + the root message hashes at that moment
//   latest.json                    newest snapshot plus Cursor's usage tree
//   transcript.md                  every message ever seen, raw text, in order; links subagents
//   subagents/<subagent name>/     a <chat> for each subagent it spawned (nested to any depth)
//
// Folders follow renames in Cursor; meta.json's composerId says which chat a folder holds.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('./cursorStore.cjs');

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
// A placeholder meta.json is replaced; recorded ones join the messages they saw.
function mergeInto(from, into) {
  for (const entry of fs.readdirSync(from)) {
    const src = path.join(from, entry);
    const dst = path.join(into, entry);
    if (entry === 'meta.json' && fs.existsSync(dst)) {
      const kept = readJson(dst, {});
      const other = readJson(src, {});
      if (!kept.seen) fs.renameSync(src, dst);
      else if (other.seen) writeAtomic(dst, JSON.stringify({ ...kept, seen: [...new Set([...kept.seen, ...other.seen])] }, null, 2));
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

// Record one chat and the subagents it spawned. Returns the number of new snapshots.
function recordChat(db, composerId, dir, visited = new Set()) {
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
  for (const id of composer.subagentComposerIds || []) recorded += recordChat(db, id, dir, visited);

  const chatDir = chatDirFor(db, dir, composerId, composer.name || 'Untitled chat');
  const snapshotFile = path.join(chatDir, 'snapshots', `${composer.lastUpdatedAt}.json`);
  if (fs.existsSync(snapshotFile)) return recorded;

  const hashes = store.rootMessageHashes(composer.conversationState);
  for (const hash of hashes) {
    const blobFile = path.join(dir, 'blobs', `${hash}.json`);
    if (fs.existsSync(blobFile)) continue;
    const value = store.getValue(db, `agentKv:blob:${hash}`);
    if (value !== undefined) writeAtomic(blobFile, value);
  }

  const breakdown = composer.promptTokenBreakdown || {};
  const snapshot = {
    composerId,
    recordedAt: Date.now(),
    lastUpdatedAt: composer.lastUpdatedAt,
    model: composer.modelConfig && composer.modelConfig.modelName,
    totalUsedTokens: breakdown.totalUsedTokens ?? composer.contextTokensUsed,
    maxTokens: breakdown.maxTokens ?? composer.contextTokenLimit,
    categories: breakdown.categories || [],
    messages: hashes,
  };
  writeAtomic(snapshotFile, JSON.stringify(snapshot, null, 2));
  writeAtomic(path.join(chatDir, 'latest.json'), JSON.stringify({ ...snapshot, usageTree: composer.promptContextUsageTree }, null, 2));

  const metaFile = path.join(chatDir, 'meta.json');
  const meta = { composerId, firstRecordedAt: snapshot.recordedAt, seen: [], ...readJson(metaFile, {}) };
  const seen = new Set(meta.seen);
  for (const h of hashes) if (!seen.has(h)) meta.seen.push(h);
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
    snapshots: (meta.snapshots || 0) + 1,
  });
  writeAtomic(metaFile, JSON.stringify(meta, null, 2));
  writeTranscript(db, dir, chatDir, meta, hashes);
  return recorded + 1;
}

function writeTranscript(db, dir, chatDir, meta, currentHashes) {
  const folders = new Map([...folderOwners(path.join(chatDir, 'subagents'))].map(([entry, id]) => [id, entry]));
  const subagents = store.loadSubagents(db, meta.subagentIds || []).map((s) => ({ ...s, folder: folders.get(s.composerId) }));
  const parent = meta.parentComposerId && store.ancestors(db, meta.composerId).pop();
  writeAtomic(path.join(chatDir, 'transcript.md'), transcript(dir, meta, new Set(currentHashes), subagents, parent));
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
      }
      writeAtomic(metaFile, JSON.stringify(meta, null, 2));
      for (const id of meta.subagentIds || []) recordChat(db, id, dir);
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

function transcript(dir, meta, current, subagents = [], parent) {
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
  // Subagents are linked where they were spawned: the tool call carrying their toolCallId.
  const spawnedBy = (message) => {
    const ids = Array.isArray(message.content) ? message.content.map((p) => p.toolCallId).filter(Boolean) : [];
    return subagents.filter((s) => s.toolCallId && ids.some((id) => id.includes(s.toolCallId) || s.toolCallId.includes(id)));
  };
  const body = meta.seen.map((hash, i) => {
    const message = readJson(path.join(dir, 'blobs', `${hash}.json`), { role: 'missing', content: `(blob ${hash} not recorded)` });
    const status = current.has(hash) ? '' : ' (no longer in prompt)';
    const links = message.role === 'assistant' ? spawnedBy(message).map((s) => `\n> ↳ Subagent: ${subLink(s)}\n`).join('') : '';
    return `## #${i} ${message.role}${status}\n\n${store.messageText(message)}\n${links}`;
  });
  return `${head.join('\n')}\n${body.join('\n')}`;
}

// Earlier versions named folders by chat id (0.5–0.8.0) and stored subagents as
// top-level chats (0.5–0.6); rename them and move subagents under their parent.
function migrateLayout(db, dir) {
  const chatsDir = path.join(dir, 'chats');
  let moved = 0;
  const walk = (from, id) => {
    // Parent links come from Cursor's DB: metas written by 0.5 lack parentComposerId.
    const name = chatName(db, id) || readJson(path.join(from, 'meta.json'), {}).name;
    const target = chatDirFor(db, dir, id, name, from);
    if (target !== from) moved++;
    // The target already exists: a placeholder holding nested subagents, or the
    // chat recorded again by a newer window. Either way, combine the two.
    if (fs.existsSync(from) && target !== from) mergeInto(from, target);
    const subDir = path.join(target, 'subagents');
    for (const [entry, subId] of [...folderOwners(subDir)]) walk(path.join(subDir, entry), subId);
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

// Record every chat updated after `since` (ms). Returns { recorded, watermark }.
function recordUpdatedSince(db, dir, since) {
  const rows = db.prepare(`
    SELECT substr(key, 14) AS id, COALESCE(json_extract(value, '$.lastUpdatedAt'), json_extract(value, '$.createdAt')) AS t
    FROM cursorDiskKV
    WHERE key LIKE 'composerData:%'
      AND COALESCE(json_extract(value, '$.lastUpdatedAt'), json_extract(value, '$.createdAt')) > ?
      AND json_extract(value, '$.conversationState') IS NOT NULL`).all(since);
  let recorded = 0;
  let watermark = since;
  for (const r of rows) {
    recorded += recordChat(db, r.id, dir);
    watermark = Math.max(watermark, r.t);
  }
  if (recorded) writeIndex(dir);
  return { recorded, watermark };
}

// One recorder per machine: several Cursor windows share the history directory.
function tryLock(dir, staleMs) {
  const file = path.join(dir, '.recorder.lock');
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const held = readJson(file, undefined);
  if (held && held.pid !== process.pid && now - held.at < staleMs) return false;
  // Another window may have renamed folders while it held the lock.
  if (!held || held.pid !== process.pid) ownersCache.clear();
  writeAtomic(file, JSON.stringify({ pid: process.pid, at: now }));
  return true;
}

// 3: folders named after chats. 2: subagents nested in their parent.
const LAYOUT = 3;

// Called periodically. First run records the last `backfillDays` of chats.
function tick(db, dir, { backfillDays = 7, staleMs = 90000 } = {}) {
  if (!tryLock(dir, staleMs)) return { recorded: 0, skipped: 'another window is recording' };
  const stateFile = path.join(dir, 'state.json');
  const state = readJson(stateFile, { watermark: Date.now() - backfillDays * 86400000, layout: LAYOUT });
  // Every tick: windows still running an older version may write id-named or flat folders.
  const migrated = migrateLayout(db, dir);
  const relayout = migrated || state.layout !== LAYOUT;
  if (relayout) rebuildTranscripts(db, dir);
  const result = recordUpdatedSince(db, dir, state.watermark);
  if (relayout && !result.recorded) writeIndex(dir);
  if (relayout || result.watermark !== state.watermark) writeAtomic(stateFile, JSON.stringify({ watermark: result.watermark, layout: LAYOUT }));
  return { ...result, migrated };
}

module.exports = { defaultHistoryDir, folderName, chatDirFor, recordChat, recordUpdatedSince, migrateLayout, rebuildTranscripts, tick, writeIndex };
