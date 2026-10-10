'use strict';

// Compare agent conversations rebuilt from the wire (conversation.cjs) with what the plugin
// recorded for the same chat: the history folder (meta.seen + blobs/ + snapshots/) and, when
// given, Cursor's DB. Nothing here changes the recording; it only measures.
//
// The wire conversation id is matched to the chat's composerId. Per run (one Run/RunSSE flow) it
// checks the prompt (root_prompt_messages_json ids) against the record, every blob the wire
// carried against the recorded bytes, and the run's user text, agent text, thinking, tool calls
// and tool results against the recorded messages that run added. It then rates the plugin's
// assumptions (see ASSUMPTIONS) as holds / contradicted / unverified, with the evidence.

const fs = require('node:fs');
const path = require('node:path');
const { sha256 } = require('./conversation.cjs');
const { userBlocks } = require('../chatMarkdown.cjs');

const SUMMARY_PREFIX = '[Previous conversation summary]';
const MIN_LEAF = 24; // shorter wire strings (ids, flags, paths) are too common to look for in the record

const ASSUMPTIONS = {
  'root-hashes': 'conversationState lists the prompt as 32-byte sha256 blob ids, and agentKv:blob:<hex> holds exactly those bytes',
  'complete-record': 'every message the model was given is in the record (meta.seen + blobs/)',
  'seen-order': 'meta.seen, in first-seen order, is the order of the conversation',
  'snapshots': 'the recorded snapshots include every prompt the model was given',
  'user-text': "chat.md's user text (the <user_query> block, or untagged text) is what the user sent",
  'agent-text': 'the recorded assistant messages hold the text and thinking the model streamed',
  'tool-calls': 'every tool call and its result is in the record, under the same tool call id',
  'request-context': 'the context sent with a user message (rules, files, environment) is in the recorded prompt',
  'summary': `a summary is a user message starting with "${SUMMARY_PREFIX}" or a <summary> block; summarized messages leave the prompt`,
  'subagent-link': "a subagent belongs to the parent tool call whose id prefix-matches its subagentInfo.toolCallId",
  'tools-backend': 'tool definitions are attached by the backend; the client does not send them',
};

// --- plugin side -------------------------------------------------------------------------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Every recorded chat folder: [{ dir, meta }], subagents included.
function recordedChats(historyDir) {
  const out = [];
  const walk = (container) => {
    let entries;
    try { entries = fs.readdirSync(container, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const dir = path.join(container, e.name);
      const meta = readJson(path.join(dir, 'meta.json'), undefined);
      if (meta && meta.composerId) out.push({ dir, meta });
      walk(path.join(dir, 'subagents'));
    }
  };
  walk(path.join(historyDir, 'chats'));
  return out;
}

// A chat by composerId, composerId prefix, or name (exact, then case-insensitive substring).
function findChats(historyDir, ref) {
  const all = recordedChats(historyDir);
  if (!ref) return all;
  const byId = all.filter((c) => c.meta.composerId === ref);
  if (byId.length) return byId;
  const byPrefix = all.filter((c) => c.meta.composerId.startsWith(ref));
  if (byPrefix.length) return byPrefix;
  const exact = all.filter((c) => c.meta.name === ref);
  if (exact.length) return exact;
  const lower = ref.toLowerCase();
  return all.filter((c) => String(c.meta.name || '').toLowerCase().includes(lower));
}

function loadRecord(historyDir, chat, db) {
  const { dir, meta } = chat;
  const snapDir = path.join(dir, 'snapshots');
  let snapshots = [];
  try {
    snapshots = fs.readdirSync(snapDir).filter((f) => f.endsWith('.json')).sort((a, b) => parseFloat(a) - parseFloat(b))
      .map((f) => ({ file: f, ...readJson(path.join(snapDir, f), {}) }));
  } catch { /* none yet */ }
  const blobs = new Map();
  const blob = (hash) => {
    if (blobs.has(hash)) return blobs.get(hash);
    let data;
    try { data = fs.readFileSync(path.join(historyDir, 'blobs', `${hash}.json`)); } catch { /* not recorded */ }
    let b;
    if (data) {
      let message;
      try { message = JSON.parse(data.toString('utf8')); } catch { /* kept raw */ }
      b = { hash, data, message, sha256Ok: sha256(data) === hash };
    }
    blobs.set(hash, b);
    return b;
  };
  const rec = { dir, meta, seen: meta.seen || [], snapshots, latest: readJson(path.join(dir, 'latest.json'), undefined), blob };
  if (db) rec.db = dbSide(db, meta.composerId);
  return rec;
}

function dbSide(db, composerId) {
  const store = require('../cursorStore.cjs');
  const raw = store.getValue(db, `composerData:${composerId}`);
  if (raw === undefined) return { found: false };
  const c = JSON.parse(raw);
  const subagents = store.loadSubagents(db, c.subagentComposerIds || []);
  return {
    found: true,
    rootPrompt: store.rootMessageHashes(c.conversationState),
    subagentComposerIds: c.subagentComposerIds || [],
    subagents,
    subagentInfo: c.subagentInfo,
    hasBlob: (hash) => store.getValue(db, `agentKv:blob:${hash}`) !== undefined,
  };
}

// --- text helpers ----------------------------------------------------------------------

const asText = (v) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, 2));
const parts = (m) => (typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : Array.isArray(m.content) ? m.content : [{ type: 'text', text: asText(m.content) }]);

// Every string inside a value, with its path: [{ path, text }].
function leaves(v, at = '', out = []) {
  if (typeof v === 'string') out.push({ path: at, text: v });
  else if (Array.isArray(v)) v.forEach((x, i) => leaves(x, `${at}[${i}]`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) if (!k.startsWith('_')) leaves(x, at ? `${at}.${k}` : k, out);
  return out;
}

// A compact diff of two texts: common prefix/suffix trimmed, the middle diffed by line.
// Returns { same, prefix, suffix, lines: [{ op: ' '|'-'|'+', text }] } — '-' is the wire, '+' the record.
function diffText(a, b) {
  if (a === b) return { same: true };
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  // Widen to line boundaries so the lines read whole.
  const lineStart = (t, i) => t.lastIndexOf('\n', i - 1) + 1;
  const ps = lineStart(a, p);
  const aMid = a.slice(ps, a.length - s);
  const bMid = b.slice(ps, b.length - s);
  return { same: false, prefix: ps, suffix: s, firstDifference: p, lines: lineDiff(aMid.split('\n'), bMid.split('\n')) };
}

function lineDiff(a, b) {
  // LCS by dynamic programming; inputs past this size are shown as replaced whole (nothing dropped).
  if (a.length * b.length > 4e6) return [...a.map((t) => ({ op: '-', text: t })), ...b.map((t) => ({ op: '+', text: t }))];
  const n = a.length;
  const m = b.length;
  const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { out.push({ op: ' ', text: a[i] }); i++; j++; }
    else if (i < n && (j === m || L[i + 1][j] >= L[i][j + 1])) out.push({ op: '-', text: a[i++] });
    else out.push({ op: '+', text: b[j++] });
  }
  return out;
}

// Ids of `order` that break the order `ref` gives them (the fewest to move: outside a longest
// increasing run of ref positions).
function outOfOrder(order, ref) {
  const pos = new Map(ref.map((h, i) => [h, i]));
  const seq = order.filter((h) => pos.has(h));
  const p = seq.map((h) => pos.get(h));
  const len = new Array(p.length).fill(1);
  const prev = new Array(p.length).fill(-1);
  let best = -1;
  for (let i = 0; i < p.length; i++) {
    for (let j = 0; j < i; j++) if (p[j] < p[i] && len[j] + 1 > len[i]) { len[i] = len[j] + 1; prev[i] = j; }
    if (best === -1 || len[i] > len[best]) best = i;
  }
  const keep = new Set();
  for (let i = best; i !== -1; i = prev[i]) keep.add(i);
  return seq.filter((_, i) => !keep.has(i));
}

// --- per run -----------------------------------------------------------------------------

function runPrompt(run) {
  const state = run.finalState || run.initialState;
  return state ? state.rootPrompt : [];
}

function wireMessage(run, id) {
  const b = run.blobs.get(id);
  return b && b.decoded && b.decoded.json;
}

function compareRun(run, rec, ctx) {
  const out = { flow: run.flow, transport: run.transport, model: run.model, action: run.action && run.action.kind, findings: [] };
  const add = (kind, assumption, detail) => out.findings.push({ kind, assumption, ...detail });
  const seenSet = new Set(rec.seen);
  const before = run.initialState ? run.initialState.rootPrompt : [];
  const after = runPrompt(run);
  out.prompt = { before: before.length, after: after.length, checkpoints: run.checkpoints.length };

  // Wire sanity: every blob id is a sha256 of its bytes.
  for (const r of run.refs) if (r.id.length !== 64) add('blob-id-not-sha256', 'root-hashes', { id: r.id, ref: r.ref });
  for (const b of run.blobs.values()) {
    if (!b.sha256Ok) add('wire-blob-hash-mismatch', 'root-hashes', { id: b.id, sources: b.sources.map((s) => s.how), size: b.data.length });
    if (b.conflicts) add('wire-blob-sent-twice-differently', 'root-hashes', { id: b.id, sources: b.sources.map((s) => s.how) });
  }
  for (const e of run.server) if (e.kind === 'kv_get_blob_args' && e.missingOnClient) add('server-asked-blob-client-lacked', 'complete-record', { id: e.blobId, where: e.where });

  // The prompt: every id of every state the wire carried, against the record.
  const states = [run.initialState, ...run.checkpoints].filter(Boolean);
  const promptIds = [...new Set(states.flatMap((s) => s.rootPrompt))];
  for (const id of promptIds) {
    const wb = run.blobs.get(id);
    const rb = rec.blob(id);
    if (!seenSet.has(id)) {
      add('prompt-message-not-recorded', 'complete-record', { id, inFinalPrompt: after.includes(id), onWire: !!wb, inDb: rec.db && rec.db.found ? rec.db.hasBlob(id) : undefined, text: wb && wb.decoded.json ? messageSummary(wb.decoded.json) : undefined });
    } else if (!rb) {
      add('recorded-hash-without-blob', 'complete-record', { id, inDb: rec.db && rec.db.found ? rec.db.hasBlob(id) : undefined });
    }
    if (wb && rb && !wb.data.equals(rb.data)) add('blob-bytes-differ', 'root-hashes', { id, diff: diffText(wb.data.toString('utf8'), rb.data.toString('utf8')) });
  }
  // Each prompt state the wire carried, against the snapshots.
  const snapKeys = new Map(rec.snapshots.map((s) => [(s.messages || []).join(','), s.file]));
  out.prompt.states = states.map((s, i) => ({ state: i === 0 && run.initialState ? 'request' : `checkpoint#${i - (run.initialState ? 1 : 0)}`, messages: s.rootPrompt.length, snapshot: snapKeys.get(s.rootPrompt.join(',')) }));
  const unmatched = out.prompt.states.filter((s) => !s.snapshot);
  if (unmatched.length) add('prompt-state-without-snapshot', 'snapshots', { states: unmatched.map((s) => s.state) });
  const wrong = outOfOrder(after, rec.seen);
  if (wrong.length) add('order-differs', 'seen-order', { ids: wrong, wireOrder: after.filter((h) => wrong.includes(h)).map((h) => after.indexOf(h)), seenOrder: wrong.map((h) => rec.seen.indexOf(h)) });

  // What this run added to the prompt, as recorded (record blobs, else wire blobs).
  const added = after.filter((id) => !before.includes(id));
  const message = (id) => (rec.blob(id) && rec.blob(id).message) || wireMessage(run, id);
  const addedMsgs = added.map((id) => ({ id, m: message(id) })).filter((x) => x.m);
  out.added = addedMsgs.map(({ id, m }) => ({ id, role: m.role, parts: parts(m).map((p) => p.type) }));

  checkUserText(run, addedMsgs, add, ctx);
  checkAgentStream(run, addedMsgs, add);
  checkTools(run, addedMsgs, add);
  checkRequestContext(run, rec, add, ctx);
  checkSummary(run, before, after, message, add, out);
  return out;
}

function messageSummary(m) {
  return { role: m.role, parts: parts(m).map((p) => ({ type: p.type, text: asText(p.text ?? p.args ?? p.result) })) };
}

function checkUserText(run, addedMsgs, add, ctx) {
  const um = run.userMessage;
  if (!um || typeof um.text !== 'string') return;
  const users = addedMsgs.filter((x) => x.m.role === 'user');
  if (!users.length) return add('user-message-not-in-prompt', 'complete-record', { wireText: um.text });
  const shown = users.flatMap((x) => userBlocks(x.m).filter((b) => b.label === 'User').map((b) => ({ id: x.id, text: b.text })));
  const raw = users.map((x) => ({ id: x.id, text: parts(x.m).filter((p) => p.type === 'text').map((p) => p.text).join('\n\n') }));
  const exact = shown.find((s) => s.text === um.text.trim());
  ctx.userTextChecks++;
  if (exact) return;
  const inRaw = raw.find((r) => r.text.includes(um.text));
  if (!shown.length) {
    return add('chat-md-shows-no-user-text', 'user-text', { wireText: um.text, recordedVerbatim: !!inRaw, messageId: inRaw ? inRaw.id : users[0].id });
  }
  add('chat-md-user-text-differs', 'user-text', { wireText: um.text, chatMd: shown.map((s) => s.text), recordedVerbatim: !!inRaw, diff: diffText(um.text, shown[0].text) });
}

function checkAgentStream(run, addedMsgs, add) {
  const assistant = addedMsgs.filter((x) => x.m.role === 'assistant').flatMap((x) => parts(x.m).map((p) => ({ id: x.id, p })));
  const texts = assistant.filter((a) => a.p.type === 'text').map((a) => a.p.text || '');
  const thoughts = assistant.filter((a) => a.p.type === 'reasoning' || a.p.type === 'redacted-reasoning').map((a) => a.p.text || '');
  const check = (kind, recorded) => {
    const joined = recorded.join('\n');
    for (const e of run.server.filter((x) => x.kind === kind)) {
      if (!e.text.trim()) continue;
      if (recorded.some((t) => t === e.text) || joined.includes(e.text)) continue;
      const nearest = recorded.map((t) => diffText(e.text, t)).sort((a, b) => b.firstDifference - a.firstDifference)[0];
      add(`streamed-${kind}-not-recorded`, 'agent-text', { where: e.where, wireText: e.text, deltas: e.deltas, diff: nearest });
    }
  };
  check('text', texts);
  check('thinking', thoughts);
  // Recorded agent text the stream never carried (shown in chat.md as said by the agent).
  const streamed = run.server.filter((x) => x.kind === 'text').map((x) => x.text).join('');
  if (run.server.some((x) => x.kind === 'text')) {
    for (const a of assistant) if (a.p.type === 'text' && a.p.text && a.p.text.trim() && !streamed.includes(a.p.text.trim())) add('recorded-agent-text-not-streamed', 'agent-text', { id: a.id, recordedText: a.p.text });
  }
}

function checkTools(run, addedMsgs, add) {
  const calls = new Map(); // call id -> { started, completed, exec, model }
  const get = (id) => calls.get(id) || calls.set(id, {}).get(id);
  for (const e of run.server) {
    if (e.kind === 'tool_call' && e.callId) Object.assign(get(e.callId), { [e.phase]: e, modelCallId: e.modelCallId || get(e.callId).modelCallId });
    if (e.kind === 'exec' && e.args && e.args.tool_call_id) get(e.args.tool_call_id).exec = e;
  }
  const recCalls = new Map();
  const recResults = new Map();
  for (const { id, m } of addedMsgs) {
    for (const p of parts(m)) {
      if (p.type === 'tool-call' && p.toolCallId) recCalls.set(p.toolCallId, { id, p });
      if (p.type === 'tool-result' && p.toolCallId) recResults.set(p.toolCallId, { id, p });
    }
  }
  const findIn = (map, callId, modelId) => {
    for (const k of [callId, modelId].filter(Boolean)) {
      if (map.has(k)) return map.get(k);
      for (const [key, v] of map) if (key.includes(k) || k.includes(key)) return { ...v, prefixMatch: key };
    }
    return undefined;
  };
  for (const [callId, c] of calls) {
    const rc = findIn(recCalls, callId, c.modelCallId);
    const rr = findIn(recResults, callId, c.modelCallId);
    if (!rc) add('tool-call-not-recorded', 'tool-calls', { callId, modelCallId: c.modelCallId, tool: toolName(c) });
    else if (rc.prefixMatch) add('tool-call-id-differs', 'tool-calls', { callId, modelCallId: c.modelCallId, recordedId: rc.prefixMatch });
    if (c.completed && !rr) add('tool-result-not-recorded', 'tool-calls', { callId, tool: toolName(c) });
  }
  const wireIds = [...calls.entries()].flatMap(([k, c]) => [k, c.modelCallId]).filter(Boolean);
  for (const [id] of recCalls) if (calls.size && !wireIds.some((w) => w === id || w.includes(id) || id.includes(w))) add('recorded-tool-call-not-on-wire', 'tool-calls', { recordedId: id });

  // Tool output the client sent (exec results for a tool call): is it in the recorded tool results?
  // Exec requests without a tool call (request context, hooks) are context: see checkRequestContext.
  const recordedResults = [...recResults.values()].map((r) => asText(r.p.result)).join('\n');
  for (const e of run.client.filter((x) => x.kind === 'exec_result')) {
    const ask = run.server.find((s) => s.kind === 'exec' && s.id === e.id);
    if (!ask || !ask.args || !ask.args.tool_call_id) continue;
    for (const l of leaves(e.result)) {
      if (l.text.length < MIN_LEAF || recordedResults.includes(l.text)) continue;
      add('tool-output-not-in-recorded-result', 'tool-calls', { execId: e.id, op: e.op, toolCallId: ask && ask.args && ask.args.tool_call_id, path: l.path, text: l.text });
    }
  }
}

function toolName(c) {
  const tc = (c.completed || c.started || {}).toolCall;
  if (tc) return Object.keys(tc).find((k) => !k.startsWith('_'));
  return c.exec ? c.exec.op : undefined;
}

// Strings sent with the run's action that appear nowhere in this chat's recorded messages.
// Context comes with the action, by reference (request_context_parts blobs), or as the result of
// an exec the server asks for without a tool call (request_context_args).
function checkRequestContext(run, rec, add, ctx) {
  if (!run.action) return;
  const haystack = ctx.recordedText();
  const um = run.userMessage && run.userMessage.text;
  const sources = [
    ...leaves(run.action.value, run.action.kind),
    ...leaves(run.action.requestContextParts, 'request_context_parts'),
  ];
  for (const b of run.blobs.values()) {
    const role = (b.roles || []).find((r) => /^(context_|user_message_)/.test(r.ref));
    if (role) sources.push(...leaves(b.decoded.json !== undefined ? b.decoded.json : b.decoded.text, `blob ${b.id.slice(0, 12)} (${role.ref})`));
  }
  for (const e of run.client.filter((x) => x.kind === 'exec_result')) {
    const ask = run.server.find((s) => s.kind === 'exec' && s.id === e.id);
    if (!ask || !ask.args || !ask.args.tool_call_id) sources.push(...leaves(e.result, `exec #${e.id} ${e.op}`));
  }
  for (const l of sources) {
    if (l.text.length < MIN_LEAF || l.text === um || haystack.includes(l.text)) continue;
    add('sent-context-not-in-record', 'request-context', { path: l.path, text: l.text });
  }
  // Tool definitions the client sends: MCP tools with the request, or in a request context.
  const contexts = [((run.action.value || {}).request_context), (run.action.requestContextParts || {}).dynamic_context,
    ...run.client.filter((x) => x.kind === 'exec_result' && x.op === 'request_context_result').map((x) => x.result.success && x.result.success.request_context)];
  const tools = [...((run.request && run.request.mcp_tools && run.request.mcp_tools.mcp_tools) || []), ...contexts.flatMap((c) => (c && c.tools) || [])];
  if (tools.length) add('client-sent-tool-definitions', 'tools-backend', { count: tools.length, names: tools.map((x) => x.name || x.tool_name) });
}

function checkSummary(run, before, after, message, add, out) {
  const summarized = run.server.some((e) => /^summary/.test(e.kind)) || run.checkpoints.some((c) => c.summary) || (run.finalState && run.initialState && (run.finalState.selfSummaryCount || 0) > (run.initialState.selfSummaryCount || 0));
  if (!summarized) return;
  const dropped = before.filter((id) => !after.includes(id));
  const first = after.map(message).find((m) => m && m.role === 'user');
  const text = first ? parts(first).filter((p) => p.type === 'text').map((p) => p.text).join('\n') : '';
  out.summary = { dropped: dropped.length, firstUserStartsWithPrefix: text.startsWith(SUMMARY_PREFIX), firstUserHasSummaryTag: /^<summary(\s|>)/m.test(text) };
  if (!out.summary.firstUserStartsWithPrefix && !out.summary.firstUserHasSummaryTag) add('summary-shape-unrecognized', 'summary', { firstUserText: text });
  if (!dropped.length) add('summary-dropped-nothing', 'summary', {});
}

// --- whole conversation ----------------------------------------------------------------

function compareConversation(conv, rec) {
  const ctx = {
    userTextChecks: 0,
    recordedText: (() => {
      let cache;
      return () => {
        if (cache === undefined) cache = rec ? rec.seen.map((h) => (rec.blob(h) ? rec.blob(h).data.toString('utf8') + '\n' + textOf(rec.blob(h).message) : '')).join('\n') : '';
        return cache;
      };
    })(),
  };
  const report = { conversationId: conv.conversationId, runs: [], findings: [], related: conv.related.map((r) => r.flow.rpc) };
  if (!rec) {
    report.chat = null;
    report.findings.push({ kind: 'chat-not-recorded', assumption: 'complete-record', runs: conv.runs.length });
    report.runs = conv.runs.map((r) => ({ flow: r.flow, transport: r.transport, model: r.model, action: r.action && r.action.kind, findings: [] }));
    report.assumptions = rate(report);
    return report;
  }
  report.chat = { dir: rec.dir, name: rec.meta.name, composerId: rec.meta.composerId, seen: rec.seen.length, snapshots: rec.snapshots.length };
  for (const run of conv.runs) report.runs.push(compareRun(run, rec, ctx));

  // Recorded blobs whose bytes do not hash to their name.
  for (const h of rec.seen) {
    const b = rec.blob(h);
    if (b && !b.sha256Ok) report.findings.push({ kind: 'recorded-blob-hash-mismatch', assumption: 'root-hashes', id: h });
  }
  // Recorded messages the wire never referenced. Only meaningful when every run was captured.
  const onWire = new Set(conv.runs.flatMap((r) => r.refs.map((x) => x.id)));
  const never = rec.seen.filter((h) => !onWire.has(h));
  if (never.length && conv.runs.length) {
    const firstCaptured = Math.min(...conv.runs.map((r) => r.flow.started || Infinity)) * 1000;
    const createdAt = rec.meta.createdAt;
    report.findings.push({ kind: 'recorded-message-never-on-wire', assumption: 'complete-record', count: never.length, ids: never, chatOlderThanCapture: createdAt ? createdAt < firstCaptured : undefined });
  }
  checkSubagents(conv, rec, report);
  report.assumptions = rate(report, ctx);
  return report;
}

function textOf(m) {
  if (!m) return '';
  return parts(m).map((p) => asText(p.text ?? p.args ?? p.result ?? p.data)).join('\n');
}

// The wire's subagent links (parent tool call -> subagent id) against the DB and the plugin's rule.
function checkSubagents(conv, rec, report) {
  const links = new Map();
  for (const run of conv.runs) {
    for (const s of run.checkpoints.concat(run.initialState || []).flatMap((c) => c.subagentRuns)) if (s.parentToolCallId) links.set(s.parentToolCallId, { subagentId: s.subagentId, from: 'checkpoint' });
    for (const e of run.server) {
      const task = e.kind === 'tool_call' && e.toolCall && e.toolCall.task_tool_call;
      const ok = task && task.result && task.result.success;
      if (ok && ok.agent_id && !links.has(e.callId)) links.set(e.callId, { subagentId: ok.agent_id, from: 'task_result' });
    }
  }
  report.subagents = [...links].map(([toolCallId, l]) => ({ toolCallId, ...l }));
  if (!links.size || !rec.db || !rec.db.found) return;
  for (const [toolCallId, l] of links) {
    const pluginPick = rec.db.subagents.filter((s) => s.toolCallId && (toolCallId.includes(s.toolCallId) || s.toolCallId.includes(toolCallId)));
    const byId = rec.db.subagents.find((s) => s.composerId === l.subagentId);
    const ok = pluginPick.length === 1 && pluginPick[0].composerId === l.subagentId;
    if (!ok) {
      report.findings.push({ kind: 'subagent-link-differs', assumption: 'subagent-link', toolCallId, wireSubagentId: l.subagentId, pluginLinks: pluginPick.map((s) => s.composerId), subagentKnownToDb: !!byId, dbToolCallId: byId && byId.toolCallId });
    }
  }
}

// Each assumption: contradicted (findings name it), holds (it was checked and nothing failed), or unverified.
function rate(report, ctx = { userTextChecks: 0 }) {
  const all = [...report.findings, ...report.runs.flatMap((r) => r.findings)];
  const checked = {
    'root-hashes': report.runs.some((r) => r.prompt),
    'complete-record': !!report.chat,
    'seen-order': report.runs.some((r) => r.prompt && r.prompt.after > 1),
    'snapshots': report.runs.some((r) => r.prompt),
    'user-text': ctx.userTextChecks > 0,
    'agent-text': report.runs.some((r) => (r.added || []).some((a) => a.role === 'assistant')),
    'tool-calls': report.runs.some((r) => (r.added || []).some((a) => a.parts.includes('tool-call'))),
    'request-context': report.runs.some((r) => r.action),
    'summary': report.runs.some((r) => r.summary),
    'subagent-link': (report.subagents || []).length > 0,
    'tools-backend': report.runs.some((r) => r.action),
  };
  return Object.entries(ASSUMPTIONS).map(([id, statement]) => {
    const against = all.filter((f) => f.assumption === id);
    const verdict = against.length ? 'contradicted' : checked[id] ? 'holds' : 'unverified';
    return { id, statement, verdict, findings: against.length, kinds: [...new Set(against.map((f) => f.kind))] };
  });
}

// conversations: from conversation.reconstruct. `ref` limits to one chat (name, composerId or prefix).
function compare({ conversations, historyDir, db, ref }) {
  const chats = recordedChats(historyDir);
  const byId = new Map(chats.map((c) => [c.meta.composerId, c]));
  let list = conversations;
  if (ref) {
    const wanted = new Set(findChats(historyDir, ref).map((c) => c.meta.composerId));
    list = conversations.filter((c) => wanted.has(c.conversationId) || c.conversationId.startsWith(ref));
  }
  return list.map((conv) => {
    const chat = byId.get(conv.conversationId);
    return compareConversation(conv, chat ? loadRecord(historyDir, chat, db) : null);
  });
}

module.exports = { ASSUMPTIONS, compare, compareConversation, loadRecord, recordedChats, findChats, diffText, outOfOrder, leaves };
