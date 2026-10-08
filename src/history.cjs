'use strict';

// Keeps a local history of agent sessions: every prompt message ever seen
// (stored once, by Cursor's own content hash) plus a snapshot per chat update.
// Cursor drops old messages when it summarizes a chat; the history keeps them.
//
// <dir>/
//   blobs/<sha256>.json            prompt message, exactly as Cursor stored it
//   chats/<chatId>/                one folder per chat (<chat> below)
//   index.json                     chats newest first, each with its subagent tree
//
// <chat>/
//   meta.json                      name, model, workspace, message hashes in first-seen order
//   snapshots/<lastUpdatedAt>.json token breakdown + the root message hashes at that moment
//   latest.json                    newest snapshot plus Cursor's usage tree
//   transcript.md                  every message ever seen, raw text, in order; links subagents
//   subagents/<subagentId>/        a <chat> for each subagent it spawned (nested to any depth)

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

// chats/<root>/subagents/<child>/…/subagents/<composerId>, from Cursor's parent links.
function chatDirFor(db, dir, composerId) {
  const chain = [...store.ancestors(db, composerId).map((a) => a.composerId), composerId];
  return path.join(dir, 'chats', ...chain.flatMap((id, i) => (i === 0 ? [id] : ['subagents', id])));
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
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

  const chatDir = chatDirFor(db, dir, composerId);
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
  const meta = readJson(metaFile, { composerId, firstRecordedAt: snapshot.recordedAt, seen: [] });
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
  const subagents = store.loadSubagents(db, meta.subagentIds || []);
  const parent = meta.parentComposerId && store.ancestors(db, meta.composerId).pop();
  writeAtomic(path.join(chatDir, 'transcript.md'), transcript(dir, meta, new Set(currentHashes), subagents, parent));
}

// Re-render every recorded transcript (after a layout change), refreshing
// subagent links from Cursor's DB. Metas written by 0.5 lack those fields.
function rebuildTranscripts(db, dir) {
  const walk = (chatDir) => {
    const metaFile = path.join(chatDir, 'meta.json');
    const meta = readJson(metaFile, undefined);
    if (meta) {
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

const subLink = (s) => `[${s.name || 'Untitled subagent'}](subagents/${s.composerId}/transcript.md)${s.type ? ` (${s.type})` : ''}`;

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

// Earlier versions stored subagents as top-level chats; move them under their parent.
function migrateLayout(db, dir) {
  const chatsDir = path.join(dir, 'chats');
  if (!fs.existsSync(chatsDir)) return 0;
  let moved = 0;
  for (const id of fs.readdirSync(chatsDir)) {
    // Parent links come from Cursor's DB: metas written by 0.5 lack parentComposerId.
    const target = chatDirFor(db, dir, id);
    if (target === path.join(chatsDir, id)) continue;
    if (fs.existsSync(path.join(target, 'meta.json'))) continue; // already recorded in place
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) {
      // Only nested subagent folders exist there; bring them along.
      for (const entry of fs.readdirSync(target)) fs.renameSync(path.join(target, entry), path.join(chatsDir, id, entry));
      fs.rmdirSync(target);
    }
    fs.renameSync(path.join(chatsDir, id), target);
    moved++;
  }
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
  writeAtomic(file, JSON.stringify({ pid: process.pid, at: now }));
  return true;
}

// Called periodically. First run records the last `backfillDays` of chats.
function tick(db, dir, { backfillDays = 7, staleMs = 90000 } = {}) {
  if (!tryLock(dir, staleMs)) return { recorded: 0, skipped: 'another window is recording' };
  const stateFile = path.join(dir, 'state.json');
  const state = readJson(stateFile, { watermark: Date.now() - backfillDays * 86400000, layout: 2 });
  // Every tick: windows still running an older version may write flat subagent folders.
  const migrated = migrateLayout(db, dir);
  if (migrated || state.layout !== 2) rebuildTranscripts(db, dir);
  const result = recordUpdatedSince(db, dir, state.watermark);
  if ((migrated || state.layout !== 2) && !result.recorded) writeIndex(dir);
  if (migrated || state.layout !== 2 || result.watermark !== state.watermark) writeAtomic(stateFile, JSON.stringify({ watermark: result.watermark, layout: 2 }));
  return { ...result, migrated };
}

module.exports = { defaultHistoryDir, chatDirFor, recordChat, recordUpdatedSince, migrateLayout, rebuildTranscripts, tick, writeIndex };
