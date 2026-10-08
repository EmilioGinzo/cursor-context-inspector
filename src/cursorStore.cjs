'use strict';

// Reads Cursor's local agent state (state.vscdb) and reconstructs the exact
// prompt text behind each category of the "Context Usage" popover.
//
// Data used (all local, read-only):
//   cursorDiskKV['composerData:<id>']   chat record: promptTokenBreakdown,
//                                       promptContextUsageTree, conversationState
//   cursorDiskKV['agentKv:blob:<sha>']  content-addressed prompt messages (JSON)

const os = require('node:os');
const path = require('node:path');

const CATEGORY_ORDER = [
  ['system_prompt', 'System prompt'],
  ['tools', 'Tool definitions'],
  ['rules', 'Rules'],
  ['skills', 'Skills'],
  ['mcp', 'MCP & dynamic tools'],
  ['subagents', 'Subagent definitions'],
  ['summarized_conversation', 'Summarized conversation'],
  ['conversation', 'Conversation'],
];

const TOOLS_UNAVAILABLE =
  'Tool definitions are attached by Cursor\'s backend and are not stored on this machine. ' +
  'Only the tool name and Cursor\'s token estimate are recorded locally.';

function defaultDatabasePath() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Cursor', 'User', 'globalStorage', 'state.vscdb');
  }
  return path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

function openDatabase(dbPath) {
  const { DatabaseSync } = require('node:sqlite');
  return new DatabaseSync(dbPath, { readOnly: true });
}

function estimateTokens(chars) {
  return Math.ceil(chars / 4);
}

function getValue(db, key) {
  const row = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(key);
  if (!row) return undefined;
  const v = row.value;
  return typeof v === 'string' ? v : Buffer.from(v).toString('utf8');
}

function listComposers(db, limit = 60) {
  const rows = db.prepare(`
    SELECT substr(key, 14) AS id,
           json_extract(value, '$.name') AS name,
           json_extract(value, '$.lastUpdatedAt') AS lastUpdatedAt,
           json_extract(value, '$.contextTokensUsed') AS used,
           json_extract(value, '$.contextTokenLimit') AS max,
           json_extract(value, '$.promptContextUsageTree') IS NOT NULL AS hasTree,
           json_extract(value, '$.subtitle') AS subtitle
    FROM cursorDiskKV
    WHERE key LIKE 'composerData:%'
      AND json_extract(value, '$.conversationState') IS NOT NULL
      AND json_extract(value, '$.promptTokenBreakdown') IS NOT NULL
    ORDER BY lastUpdatedAt DESC
    LIMIT ?`).all(limit);
  return rows.map((r) => ({ ...r, hasTree: !!r.hasTree }));
}

// --- protobuf (conversationState) -------------------------------------------

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = buf[pos++];
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (byte < 0x80) return [result, pos];
  }
}

// Field 1 of the conversation state is the ordered list of root prompt
// message blob hashes (32-byte SHA-256 each).
function rootMessageHashes(conversationState) {
  if (typeof conversationState !== 'string' || !conversationState.startsWith('~')) return [];
  const buf = Buffer.from(conversationState.slice(1), 'base64');
  const hashes = [];
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    if (wire === 0) [, pos] = readVarint(buf, pos);
    else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      if (field === 1 && len === 32) hashes.push(buf.subarray(pos, pos + 32).toString('hex'));
      pos += len;
    } else break;
  }
  return hashes;
}

function loadMessages(db, conversationState) {
  return rootMessageHashes(conversationState).map((hash) => {
    const raw = getValue(db, `agentKv:blob:${hash}`);
    if (raw === undefined) return { role: 'missing', content: `(blob ${hash} not found)` };
    try {
      return JSON.parse(raw);
    } catch {
      return { role: 'unknown', content: raw };
    }
  });
}

// --- text extraction ---------------------------------------------------------

function resolvePath(message, contentPath) {
  let v = message;
  for (const part of contentPath.match(/[A-Za-z_]+|\[\d+\]/g) || []) {
    if (v === undefined || v === null) return undefined;
    v = part.startsWith('[') ? v[Number(part.slice(1, -1))] : v[part];
  }
  return v;
}

// Cursor measures structured values as pretty-printed JSON.
function asText(v) {
  if (v === undefined || v === null) return '';
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}

function partText(part) {
  switch (part.type) {
    case 'text':
      return part.text;
    case 'reasoning':
      return `[reasoning]\n${part.text}`;
    case 'tool-call':
      return `[tool call: ${part.toolName}]\n${asText(part.args)}`;
    case 'tool-result':
      return `[tool result: ${part.toolName}]\n${asText(part.result)}`;
    case 'image':
      return '[image]';
    default:
      return `[${part.type}]\n${asText(part)}`;
  }
}

function messageText(message) {
  const c = message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(partText).join('\n\n');
  return asText(c);
}

// --- tag parsing (fallback when Cursor saved no usage tree) -----------------

// Top-level <tag ...>...</tag> blocks that start at a line beginning.
function topLevelBlocks(text) {
  const blocks = [];
  const open = /^<([a-z][a-z0-9_-]*)(\s[^>]*)?>/gm;
  let m;
  while ((m = open.exec(text))) {
    const close = `</${m[1]}>`;
    const end = text.indexOf(close, open.lastIndex);
    if (end === -1) continue;
    const stop = end + close.length;
    blocks.push({ tag: m[1], attrs: m[2] || '', start: m.index, end: stop, text: text.slice(m.index, stop) });
    open.lastIndex = stop;
  }
  return blocks;
}

function attr(attrs, name) {
  const m = new RegExp(`${name}="([^"]*)"`).exec(attrs);
  return m ? m[1] : undefined;
}

function childBlocks(block) {
  const inner = block.text.slice(block.text.indexOf('>') + 1, block.text.length - block.tag.length - 3);
  return topLevelBlocks(inner.replace(/^[ \t]+</gm, '<'));
}

function blockLabel(b) {
  return attr(b.attrs, 'fullPath') || attr(b.attrs, 'name') || attr(b.attrs, 'id') || `<${b.tag}>`;
}

function textItem(id, label, kind, text, extra = {}) {
  return { id, label, kind, characterCount: text.length, estimatedTokens: estimateTokens(text.length), text, ...extra };
}

function blockItem(id, b, label = `<${b.tag}>`) {
  const item = textItem(id, label, b.tag, b.text);
  const children = childBlocks(b);
  if (children.length) item.children = children.map((c, i) => blockItem(`${id}/${i}`, c, blockLabel(c)));
  return item;
}

function classifyTag(tag) {
  if (/rule/.test(tag)) return 'rules';
  if (/skill/.test(tag)) return 'skills';
  if (/subagent/.test(tag)) return 'subagents';
  if (/mcp|dynamic_tool/.test(tag)) return 'mcp';
  return 'conversation';
}

const SUMMARY_PREFIX = '[Previous conversation summary]';

function parsedItems(messages) {
  const out = Object.fromEntries(CATEGORY_ORDER.map(([id]) => [id, []]));
  messages.forEach((message, index) => {
    const text = messageText(message);
    if (message.role === 'system') {
      let rest = text;
      for (const b of topLevelBlocks(text)) {
        if (classifyTag(b.tag) === 'mcp') {
          out.mcp.push(blockItem(`m${index}:${b.start}`, b));
          rest = rest.replace(b.text, '');
        }
      }
      out.system_prompt.push(textItem(`m${index}`, 'System message', 'system', rest));
      return;
    }
    if (message.role === 'user' && text.startsWith(SUMMARY_PREFIX)) {
      out.summarized_conversation.push(textItem(`m${index}`, 'Conversation summary', 'summary', text));
      return;
    }
    if (message.role === 'user') {
      const blocks = topLevelBlocks(text);
      let rest = text;
      for (const b of blocks) {
        const cat = classifyTag(b.tag);
        if (cat === 'conversation') continue;
        out[cat].push(blockItem(`m${index}:${b.start}`, b));
        rest = rest.replace(b.text, '');
      }
      out.conversation.push(textItem(`m${index}`, userLabel(blocks), 'user', rest.trim()));
      return;
    }
    const label = message.role === 'assistant' ? 'Agent message' : message.role === 'tool' ? toolLabel(message) : message.role;
    out.conversation.push(textItem(`m${index}`, label, message.role, text));
  });
  return out;
}

function userLabel(blocks) {
  const query = blocks.find((b) => b.tag === 'user_query');
  if (!query) return 'User message (context preamble)';
  const body = query.text.slice(query.text.indexOf('>') + 1, -'</user_query>'.length).trim().replace(/\s+/g, ' ');
  return `User: ${body.length > 60 ? `${body.slice(0, 60)}…` : body}`;
}

function toolLabel(message) {
  const part = Array.isArray(message.content) ? message.content.find((p) => p.toolName) : undefined;
  return part ? `${part.toolName} result` : 'Tool result';
}

// --- tree mode -----------------------------------------------------------------

function treeItems(tree, messages) {
  const nodes = tree.nodes || [];
  const byParent = new Map();
  for (const n of nodes) {
    if (!n.parentId) continue;
    if (!byParent.has(n.parentId)) byParent.set(n.parentId, []);
    byParent.get(n.parentId).push(n);
  }
  const build = (n) => {
    const item = {
      id: n.id,
      label: n.label || n.kind,
      kind: n.kind,
      estimatedTokens: n.estimatedTokens || 0,
      characterCount: n.characterCount || 0,
    };
    if (n.inlineContent !== undefined) item.text = n.inlineContent;
    else if (n.contentAvailable && n.source && n.source.sourceType === 'root_prompt_message') {
      const msg = messages[n.source.messageIndex];
      item.text = msg ? asText(resolvePath(msg, n.source.contentPath)).slice(n.source.startOffset, n.source.endOffset) : undefined;
    }
    if (item.text === undefined && n.kind === 'tool_definition') item.unavailable = TOOLS_UNAVAILABLE;
    const kids = byParent.get(n.id);
    if (kids) {
      item.children = kids.map(build);
      if (!item.estimatedTokens) item.estimatedTokens = item.children.reduce((s, c) => s + c.estimatedTokens, 0);
    }
    return item;
  };
  const out = {};
  for (const n of nodes) if (n.kind === 'category') out[n.categoryId] = (byParent.get(n.id) || []).map(build);
  return out;
}

// --- public ----------------------------------------------------------------------

function loadContext(db, composerId) {
  const raw = getValue(db, `composerData:${composerId}`);
  if (raw === undefined) throw new Error(`Chat ${composerId} not found`);
  const composer = JSON.parse(raw);
  const messages = loadMessages(db, composer.conversationState);
  const breakdown = composer.promptTokenBreakdown || {};
  const tree = composer.promptContextUsageTree;
  const parsed = parsedItems(messages);
  const fromTree = tree ? treeItems(tree, messages) : undefined;

  const official = new Map((breakdown.categories || []).map((c) => [c.id, c]));
  const categories = CATEGORY_ORDER.map(([id, label]) => {
    const treeList = fromTree && fromTree[id];
    const treeHasText = treeList && treeList.some(hasText);
    const items = treeHasText || (treeList && id === 'tools') ? treeList : parsed[id];
    const o = official.get(id);
    if (!treeHasText && o) scaleEstimates(items, o.estimatedTokens);
    return {
      id,
      label: (o && o.label) || label,
      estimatedTokens: o ? o.estimatedTokens : items.reduce((s, i) => s + i.estimatedTokens, 0),
      source: treeHasText ? 'cursor-tree' : 'parsed',
      note: id === 'tools' && !(treeList && treeList.length) ? TOOLS_UNAVAILABLE : undefined,
      items,
    };
  });

  const rawMessages = messages.map((m, i) => textItem(`raw${i}`, `#${i} ${m.role}`, m.role, messageText(m)));

  return {
    composerId,
    name: composer.name || 'Untitled chat',
    lastUpdatedAt: composer.lastUpdatedAt,
    model: composer.modelConfig && composer.modelConfig.modelName,
    totalUsedTokens: breakdown.totalUsedTokens ?? composer.contextTokensUsed ?? 0,
    maxTokens: breakdown.maxTokens ?? composer.contextTokenLimit ?? 0,
    hasTree: !!tree,
    messageCount: messages.length,
    categories,
    rawMessages,
  };
}

// Parsed items only know their length; distribute Cursor's category total
// (which reflects the model's real tokenizer) over them by character share.
function scaleEstimates(items, categoryTokens) {
  const chars = items.reduce((s, i) => s + i.characterCount, 0);
  if (!chars) return;
  const ratio = categoryTokens / chars;
  const apply = (list) => {
    for (const i of list) {
      i.estimatedTokens = Math.round(i.characterCount * ratio);
      if (i.children) apply(i.children);
    }
  };
  apply(items);
}

function hasText(item) {
  return item.text !== undefined || (item.children || []).some(hasText);
}

module.exports = {
  defaultDatabasePath,
  openDatabase,
  listComposers,
  loadContext,
  rootMessageHashes,
  topLevelBlocks,
};
