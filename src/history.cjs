'use strict';

// Keeps a local history of agent sessions: every prompt message ever seen
// (stored once, by Cursor's own content hash) plus a snapshot per chat update.
// Cursor drops old messages when it summarizes a chat; the history keeps them.
//
// <dir>/
//   blobs/<sha256>.json            prompt message, exactly as Cursor stored it
//   chats/<chatId>/meta.json       name, model, workspace, message hashes in first-seen order
//   chats/<chatId>/snapshots/<lastUpdatedAt>.json
//                                  token breakdown + the root message hashes at that moment
//   chats/<chatId>/latest.json     newest snapshot plus Cursor's usage tree
//   chats/<chatId>/transcript.md   every message ever seen, raw text, in order
//   index.json                     chats with name and last update, newest first

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

// Record one chat. Returns true when a new snapshot was written.
function recordChat(db, composerId, dir) {
  const raw = store.getValue(db, `composerData:${composerId}`);
  if (raw === undefined) return false;
  const composer = JSON.parse(raw);
  if (!composer.conversationState || !composer.lastUpdatedAt) return false;

  const chatDir = path.join(dir, 'chats', composerId);
  const snapshotFile = path.join(chatDir, 'snapshots', `${composer.lastUpdatedAt}.json`);
  if (fs.existsSync(snapshotFile)) return false;

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
  writeAtomic(path.join(chatDir, 'transcript.md'), transcript(dir, meta, new Set(hashes)));
  return true;
}

function transcript(dir, meta, current) {
  const head = [
    `# ${meta.name}`,
    '',
    `- Chat: ${meta.composerId}`,
    `- Model: ${meta.model || '?'}`,
    meta.workspace ? `- Workspace: ${meta.workspace}` : undefined,
    `- Last update: ${new Date(meta.lastUpdatedAt).toISOString()}`,
    `- Messages ever seen: ${meta.seen.length} (${current.size} in the latest prompt; others were dropped, e.g. by summarization)`,
    '',
  ].filter((l) => l !== undefined);
  const body = meta.seen.map((hash, i) => {
    const message = readJson(path.join(dir, 'blobs', `${hash}.json`), { role: 'missing', content: `(blob ${hash} not recorded)` });
    const status = current.has(hash) ? '' : ' (no longer in prompt)';
    return `## #${i} ${message.role}${status}\n\n${store.messageText(message)}\n`;
  });
  return `${head.join('\n')}\n${body.join('\n')}`;
}

function writeIndex(dir) {
  const chatsDir = path.join(dir, 'chats');
  const chats = fs.existsSync(chatsDir)
    ? fs.readdirSync(chatsDir).map((id) => readJson(path.join(chatsDir, id, 'meta.json'), undefined)).filter(Boolean)
    : [];
  chats.sort((a, b) => (b.lastUpdatedAt || 0) - (a.lastUpdatedAt || 0));
  const index = chats.map(({ composerId, name, model, workspace, parentComposerId, lastUpdatedAt, totalUsedTokens, snapshots, seen }) => ({
    composerId, name, model, workspace, parentComposerId, lastUpdatedAt, totalUsedTokens, snapshots, messages: seen.length,
  }));
  writeAtomic(path.join(dir, 'index.json'), JSON.stringify(index, null, 2));
}

// Record every chat updated after `since` (ms). Returns { recorded, watermark }.
function recordUpdatedSince(db, dir, since) {
  const rows = db.prepare(`
    SELECT substr(key, 14) AS id, json_extract(value, '$.lastUpdatedAt') AS t
    FROM cursorDiskKV
    WHERE key LIKE 'composerData:%'
      AND json_extract(value, '$.lastUpdatedAt') > ?
      AND json_extract(value, '$.conversationState') IS NOT NULL`).all(since);
  let recorded = 0;
  let watermark = since;
  for (const r of rows) {
    if (recordChat(db, r.id, dir)) recorded++;
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
  const state = readJson(stateFile, { watermark: Date.now() - backfillDays * 86400000 });
  const result = recordUpdatedSince(db, dir, state.watermark);
  if (result.watermark !== state.watermark) writeAtomic(stateFile, JSON.stringify({ watermark: result.watermark }));
  return result;
}

module.exports = { defaultHistoryDir, recordChat, recordUpdatedSince, tick, writeIndex };
