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

// Subagent chats are excluded by default; they are reached through their parent.
function listComposers(db, limit = 60, { includeSubagents = false } = {}) {
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
      AND (? OR json_extract(value, '$.subagentInfo.parentComposerId') IS NULL)
    ORDER BY lastUpdatedAt DESC
    LIMIT ?`).all(includeSubagents ? 1 : 0, limit);
  return rows.map((r) => ({ ...r, hasTree: !!r.hasTree }));
}

function hasContext(db, composerId) {
  return !!db.prepare(`SELECT 1 FROM cursorDiskKV WHERE key = ?
    AND json_extract(value, '$.conversationState') IS NOT NULL
    AND json_extract(value, '$.promptTokenBreakdown') IS NOT NULL`).get(`composerData:${composerId}`);
}

function lastUpdatedAt(db, composerId) {
  const row = db.prepare("SELECT json_extract(value, '$.lastUpdatedAt') AS t FROM cursorDiskKV WHERE key = ?").get(`composerData:${composerId}`);
  return row ? row.t : undefined;
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
    const item = textItem(`m${index}`, label, message.role, text);
    const callIds = Array.isArray(message.content) ? message.content.map((p) => p.toolCallId).filter(Boolean) : [];
    if (callIds.length) item.toolCallIds = callIds;
    out.conversation.push(item);
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

// --- coverage (tree mode) ----------------------------------------------------------

// Every string the model received, addressed the way Cursor's tree addresses it.
function messageLeaves(message) {
  const c = message.content;
  if (typeof c === 'string') return [{ path: 'content', text: c }];
  if (!Array.isArray(c)) return [{ path: 'content', text: asText(c) }];
  const leaves = [];
  c.forEach((part, i) => {
    // Redacted reasoning is the model's encrypted reasoning, passed back verbatim.
    for (const key of part.type === 'redacted-reasoning' ? ['data'] : ['text', 'args', 'result']) {
      if (part[key] !== undefined) leaves.push({ path: `content[${i}].${key}`, text: asText(part[key]) });
    }
  });
  return leaves;
}

// Text that no tree node covers, attributed to a category by its tag. Cursor's
// tree leaves some sections out (e.g. MCP blocks in the system message); without
// this they would appear in the raw messages but nowhere in the breakdown.
function uncoveredItems(tree, messages) {
  const covered = new Map();
  for (const n of tree.nodes || []) {
    const src = n.source;
    if (!src || src.sourceType !== 'root_prompt_message') continue;
    const key = `${src.messageIndex}|${src.contentPath}`;
    if (!covered.has(key)) covered.set(key, []);
    covered.get(key).push([src.startOffset, src.endOffset]);
  }
  const out = {};
  const add = (cat, item) => (out[cat] = out[cat] || []).push(item);

  messages.forEach((message, mi) => {
    for (const leaf of messageLeaves(message)) {
      const ranges = (covered.get(`${mi}|${leaf.path}`) || []).sort((a, b) => a[0] - b[0]);
      let pos = 0;
      const gaps = [];
      for (const [start, end] of ranges) {
        if (start > pos) gaps.push([pos, start]);
        pos = Math.max(pos, end);
      }
      if (pos < leaf.text.length) gaps.push([pos, leaf.text.length]);

      for (const [start, end] of gaps) {
        const text = leaf.text.slice(start, end);
        if (!text.trim()) continue;
        const where = `#${mi} ${message.role}${leaf.path === 'content' ? '' : ` ${leaf.path}`}`;
        const fallback = message.role === 'system' ? 'system_prompt'
          : text.trimStart().startsWith(SUMMARY_PREFIX) ? 'summarized_conversation' : 'conversation';
        // Cut at tags opening a line; each piece goes to its tag's category. A piece
        // may be an unclosed fragment (e.g. a section intro whose children the tree has).
        for (const piece of splitAtTags(text)) {
          if (!piece.text.trim()) continue;
          const id = `gap:${mi}:${leaf.path}:${start + piece.start}`;
          const cat = piece.tag ? classifyTag(piece.tag) : 'conversation';
          const target = cat === 'conversation' ? fallback : cat;
          const block = piece.tag && topLevelBlocks(piece.text).find((b) => b.start === 0 && !piece.text.slice(b.end).trim());
          const label = piece.tag ? `<${piece.tag}>${block ? '' : ' (part)'}`
            : fallback === 'system_prompt' ? 'System message'
            : leaf.path.endsWith('.data') ? `Encrypted reasoning · #${mi}` : where;
          add(target, untracked(block ? blockItem(id, block, label) : textItem(id, label, 'text', piece.text)));
        }
      }
    }
  });
  return out;
}

function splitAtTags(text) {
  const cuts = [0];
  const re = /^<([a-z][a-z0-9_-]*)(\s[^>]*)?>/gm;
  let m;
  while ((m = re.exec(text))) {
    if (m.index > 0) cuts.push(m.index);
    // Skip past a closed block so its nested tags stay inside it.
    const close = text.indexOf(`</${m[1]}>`, re.lastIndex);
    if (close !== -1) re.lastIndex = close;
  }
  cuts.push(text.length);
  const pieces = [];
  for (let i = 0; i < cuts.length - 1; i++) {
    const piece = text.slice(cuts[i], cuts[i + 1]);
    const tag = piece.match(/^<([a-z][a-z0-9_-]*)/);
    pieces.push({ start: cuts[i], text: piece, tag: tag && tag[1] });
  }
  return pieces;
}

function untracked(item) {
  item.untracked = true;
  return item;
}

// --- public ----------------------------------------------------------------------

function loadContext(db, composerId) {
  const raw = getValue(db, `composerData:${composerId}`);
  if (raw === undefined) throw new Error(`Chat ${composerId} not found`);
  const composer = JSON.parse(raw);
  const messages = loadMessages(db, composer.conversationState);
  const breakdown = composer.promptTokenBreakdown || {};
  const tree = composer.promptContextUsageTree;
  // With a tree: Cursor's exact spans plus whatever text they leave uncovered.
  // Without one: the prompt split by its tagged sections (covers everything).
  const fromTree = tree ? treeItems(tree, messages) : undefined;
  const leftover = tree ? uncoveredItems(tree, messages) : {};
  const parsed = tree ? undefined : parsedItems(messages);

  const official = new Map((breakdown.categories || []).map((c) => [c.id, c]));
  const categories = CATEGORY_ORDER.map(([id, label]) => {
    const treeList = (fromTree && fromTree[id]) || [];
    const treeHasText = treeList.some(hasText);
    const items = parsed ? parsed[id] : [...(treeHasText || id === 'tools' ? treeList : []), ...(leftover[id] || [])];
    const o = official.get(id);
    if (!treeHasText && o) scaleEstimates(items, o.estimatedTokens);
    return {
      id,
      label: (o && o.label) || label,
      estimatedTokens: o ? o.estimatedTokens : items.reduce((s, i) => s + i.estimatedTokens, 0),
      source: parsed ? 'parsed' : treeHasText ? 'cursor-tree' : 'uncovered-text',
      note: id === 'tools' && !treeList.length ? TOOLS_UNAVAILABLE : undefined,
      items,
    };
  });

  const rawMessages = messages.map((m, i) => textItem(`raw${i}`, `#${i} ${m.role}`, m.role, messageText(m)));
  const subagents = loadSubagents(db, composer.subagentComposerIds || []);
  linkSubagents(categories.find((c) => c.id === 'conversation').items, subagents);
  const info = composer.subagentInfo;

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
    subagents,
    parent: info && info.parentComposerId ? { composerId: info.parentComposerId, type: info.subagentTypeName } : undefined,
  };
}

// Parent chain of a subagent chat, root first: [{ composerId, name, type }].
function ancestors(db, composerId) {
  const get = db.prepare(`
    SELECT json_extract(value, '$.name') AS name,
           json_extract(value, '$.subagentInfo.parentComposerId') AS parent,
           json_extract(value, '$.subagentInfo.subagentTypeName') AS type
    FROM cursorDiskKV WHERE key = ?`);
  const chain = [];
  const seen = new Set([composerId]);
  let row = get.get(`composerData:${composerId}`);
  while (row && row.parent && !seen.has(row.parent)) {
    seen.add(row.parent);
    const parent = get.get(`composerData:${row.parent}`);
    chain.unshift({ composerId: row.parent, name: (parent && parent.name) || 'Untitled chat', type: parent && parent.type });
    row = parent;
  }
  return chain;
}

// Subagent chats are full chats of their own; subagentInfo.toolCallId is the
// parent's tool call that spawned each one.
function loadSubagents(db, ids) {
  if (!ids.length) return [];
  const get = db.prepare(`
    SELECT json_extract(value, '$.name') AS name,
           json_extract(value, '$.subagentInfo.subagentTypeName') AS type,
           json_extract(value, '$.subagentInfo.toolCallId') AS toolCallId,
           json_extract(value, '$.contextTokensUsed') AS used,
           json_extract(value, '$.contextTokenLimit') AS max,
           json_extract(value, '$.createdAt') AS createdAt,
           json_array_length(json_extract(value, '$.subagentComposerIds')) AS nested,
           json_extract(value, '$.conversationState') IS NOT NULL
             AND json_extract(value, '$.promptTokenBreakdown') IS NOT NULL AS hasContext
    FROM cursorDiskKV WHERE key = ?`);
  return ids
    .map((id) => {
      const r = get.get(`composerData:${id}`);
      return r && { composerId: id, ...r, hasContext: !!r.hasContext, nested: r.nested || 0 };
    })
    .filter(Boolean);
}

// Tree ids embed the tool call id ("tool_call_pair:<msg>:<callId>…"); parsed
// items carry toolCallIds. Cursor may store a truncated id, so match by prefix.
function linkSubagents(items, subagents) {
  const withCall = subagents.filter((s) => s.toolCallId);
  if (!withCall.length) return;
  const matches = (ids) => withCall.filter((s) => ids.some((id) => id.includes(s.toolCallId) || s.toolCallId.includes(id)));
  const walk = (list) => {
    for (const item of list) {
      const ids = item.toolCallIds || (item.kind === 'tool_call_pair' ? [item.id] : []);
      const subs = ids.length ? matches(ids) : [];
      if (subs.length) item.subagents = subs.map((s) => ({ composerId: s.composerId, name: s.name }));
      if (item.children) walk(item.children);
    }
  };
  walk(items);
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
  getValue,
  messageText,
  ancestors,
  listComposers,
  hasContext,
  lastUpdatedAt,
  loadContext,
  rootMessageHashes,
  topLevelBlocks,
};
