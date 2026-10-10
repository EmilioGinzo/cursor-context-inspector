'use strict';

// Agent conversations as they travel on the wire, rebuilt from captured flows.
//
// agent.v1.AgentService/Run is a bidi stream: AgentClientMessage up, AgentServerMessage down.
// The conversation itself is not sent as text. The first client message, run_request, holds a
// ConversationStateStructure of blob ids (sha256 of the blob bytes):
//   root_prompt_messages_json  the model prompt, one JSON message per blob, in order
//   turns                      ConversationTurnStructure blobs -> user_message / steps blobs
//   summary, todos, plan, file_states*, subagent_state_refs, ...
// plus the action (the new user message and its request_context). Blob bytes move over a KV
// side channel in the same stream: the server asks kv get_blob_args{id} and the client answers
// get_blob_result{data}; the server sends set_blob_args{id, data} for the client to store, and
// conversation_checkpoint_update with the new state. Results of tools the server asks the client
// to run (exec_server_message) come back as exec_client_message.
//
// When HTTP/2 streaming is unavailable Cursor falls back to RunSSE/RunPoll for the server side,
// and sends each client message with aiserver.v1.BidiService/BidiAppend (hex `data` or
// `data_binary`, ordered by append_seqno), keyed by the same BidiRequestId.
//
// proto3 leaves zero values out: the first append (append_seqno 0) and kv / exec id 0 decode as
// absent, and are read as 0 here.
//
// Captures carry no per-frame timestamps: the client and server streams of a run are kept as two
// ordered lists, tied together by kv / exec ids.

const crypto = require('node:crypto');
const flowsLib = require('./flows.cjs');
const protobuf = require('./protobuf.cjs');

const AGENT = 'agent.v1.AgentService';
const RUN_RPCS = new Set(['Run', 'RunSSE', 'RunPoll']);

const hex = (b64) => Buffer.from(b64 || '', 'base64').toString('hex');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// The member set in a decoded oneof-only message ({ shell_args: {...} } -> ['shell_args', {...}]).
function only(msg, skip = []) {
  if (!msg || typeof msg !== 'object') return [undefined, undefined];
  const k = Object.keys(msg).find((n) => !n.startsWith('_') && !skip.includes(n));
  return k ? [k, msg[k]] : [undefined, undefined];
}

// Hex or base64 text (BidiAppendRequest.data, BidiPollResponse.data) -> bytes.
function textBytes(s) {
  if (typeof s !== 'string' || !s) return Buffer.alloc(0);
  if (s.length % 2 === 0 && /^[0-9a-f]+$/i.test(s)) return Buffer.from(s, 'hex');
  return Buffer.from(s, 'base64');
}

// Every blob id a ConversationStateStructure refers to, as [{ id, ref, index?, key? }].
function stateRefs(state, prefix = '') {
  if (!state) return [];
  const out = [];
  const add = (b64, ref, extra = {}) => { if (b64) out.push({ id: hex(b64), ref: prefix + ref, ...extra }); };
  (state.root_prompt_messages_json || []).forEach((b, index) => add(b, 'root_prompt', { index }));
  (state.turns || []).forEach((b, index) => add(b, 'turn', { index }));
  (state.todos || []).forEach((b, index) => add(b, 'todo', { index }));
  add(state.summary, 'summary');
  add(state.plan, 'plan');
  add(state.summary_archive, 'summary_archive');
  (state.summary_archives || []).forEach((b, index) => add(b, 'summary_archive', { index }));
  for (const [key, b] of Object.entries(state.file_states || {})) add(b, 'file_state', { key });
  for (const [key, v] of Object.entries(state.file_states_v2 || {})) {
    add(v && v.content, 'file_state_content', { key });
    add(v && v.initial_content, 'file_state_initial', { key });
  }
  for (const [key, b] of Object.entries(state.subagent_state_refs || {})) add(b, 'subagent_state', { key });
  add(state.token_details && state.token_details.prompt_context_usage_snapshot_blob_id, 'usage_snapshot');
  for (const [key, v] of Object.entries(state.subagent_states || {})) out.push(...stateRefs(v && v.conversation_state, `${prefix}subagent[${key}].`));
  return out;
}

// Blob ids the action refers to: context parts sent by reference, and the user message's own blobs.
function actionRefs(action, userMessage) {
  const out = [];
  const parts = (action && action.request_context_parts) || {};
  for (const k of ['rules', 'skills', 'subagents', 'mcps']) if (parts[`${k}_blob_id`]) out.push({ id: hex(parts[`${k}_blob_id`]), ref: `context_${k}`, bytes: parts[`${k}_byte_length`] });
  for (const k of ['text_blob_id', 'rich_text_blob_id', 'conversation_state_blob_id']) {
    if (userMessage && userMessage[k]) out.push({ id: hex(userMessage[k]), ref: `user_message_${k.replace(/_blob_id$/, '')}` });
  }
  return out;
}

// What a state looks like, with ids in hex (the full decoded state stays in `raw`).
function summarizeState(state) {
  if (!state) return undefined;
  return {
    rootPrompt: (state.root_prompt_messages_json || []).map(hex),
    turns: (state.turns || []).map(hex),
    summary: state.summary ? hex(state.summary) : undefined,
    summaryArchives: [state.summary_archive, ...(state.summary_archives || [])].filter(Boolean).map(hex),
    selfSummaryCount: state.self_summary_count,
    messageCountAtLastCompaction: state.message_count_at_last_compaction,
    tokens: state.token_details ? { used: state.token_details.used_tokens, max: state.token_details.max_tokens } : undefined,
    subagentRuns: Object.values(state.subagent_runs_by_parent_tool_call_id || {}).map((r) => ({
      parentToolCallId: r.parent_tool_call_id, subagentId: r.subagent_id, status: r.status, title: r.title,
    })),
    subagentThreads: state.subagent_threads,
    subagentStates: Object.keys(state.subagent_states || {}),
    raw: state,
  };
}

// --- one run -------------------------------------------------------------------------

function newRun(flow, transport) {
  return {
    flow: flowRef(flow),
    transport,
    requestId: undefined,
    conversationId: undefined,
    request: undefined, // decoded AgentRunRequest
    initialState: undefined,
    action: undefined, // { kind, value }
    userMessage: undefined, // UserMessage of a user_message_action
    model: undefined,
    client: [],
    server: [],
    checkpoints: [],
    blobs: new Map(), // id hex -> { id, data, sources: [], sha256Ok }
    refs: [], // { id, ref, from: 'request'|'checkpoint#n'|'turn <id>', index?, key? }
    usage: undefined,
    errors: [],
    notes: [],
    truncated: false,
  };
}

function flowRef(f) {
  return { id: f.id, day: f.day, dir: f.dir, rpc: f.service ? `${f.service}/${f.rpc}` : f.url, started: f.started, ended: f.ended, status: f.status, grpcStatus: f.grpcStatus, error: f.error };
}

function addBlob(run, id, b64, source) {
  const data = Buffer.from(b64 || '', 'base64');
  let b = run.blobs.get(id);
  if (!b) run.blobs.set(id, (b = { id, data, sources: [], sha256Ok: sha256(data) === id }));
  else if (!b.data.equals(data)) b.conflicts = [...(b.conflicts || []), { source, data }];
  b.sources.push(source);
}

function clientEvent(run, msg, where) {
  const [kind, value] = only(msg);
  const ev = { where, kind };
  switch (kind) {
    case 'run_request': {
      run.request = value;
      run.conversationId = value.conversation_id || run.conversationId;
      run.model = (value.requested_model && value.requested_model.model_id) || (value.model_details && value.model_details.model_id) || run.model;
      run.initialState = summarizeState(value.conversation_state);
      for (const r of stateRefs(value.conversation_state)) run.refs.push({ ...r, from: 'request' });
      const [ak, av] = only(value.action, ['triggering_auth_id', 'triggering_user_info', 'request_context_parts']);
      run.action = { kind: ak, value: av, requestContextParts: value.action && value.action.request_context_parts };
      if (ak === 'user_message_action') run.userMessage = av.user_message;
      for (const r of actionRefs(value.action, run.userMessage)) run.refs.push({ ...r, from: 'request' });
      for (const b of value.pre_fetched_blobs || []) addBlob(run, hex(b.id), b.value, { side: 'client', how: 'pre_fetched', where });
      Object.assign(ev, { conversationId: value.conversation_id, runId: value.run_id, model: run.model, action: ak, rootPrompt: run.initialState.rootPrompt.length, turns: run.initialState.turns.length });
      break;
    }
    case 'kv_client_message': {
      const [k, v] = only(value, ['id']);
      Object.assign(ev, { kind: `kv_${k}`, id: value.id ?? 0, error: v && v.error && v.error.message });
      if (k === 'get_blob_result') {
        ev.hasData = v.blob_data !== undefined;
        ev.size = Buffer.from(v.blob_data || '', 'base64').length;
        ev.blobData = v.blob_data; // resolved to an id once the server's request is known
      }
      break;
    }
    case 'exec_client_message': {
      const [op, result] = only(value, ['id', 'exec_id', 'local_execution_time_ms', 'hook_additional_contexts']);
      Object.assign(ev, { kind: 'exec_result', id: value.id ?? 0, execId: value.exec_id, op, result, hookContexts: value.hook_additional_contexts });
      break;
    }
    case 'conversation_action': {
      const [ak, av] = only(value, ['triggering_auth_id', 'triggering_user_info', 'request_context_parts']);
      Object.assign(ev, { kind: 'action', action: ak, value: av });
      break;
    }
    case 'client_heartbeat':
      break;
    default:
      ev.value = value;
  }
  run.client.push(ev);
}

// Consecutive deltas of one kind become one event whose text is their exact concatenation.
function pushDelta(run, kind, text, where, extra = {}) {
  const last = run.server[run.server.length - 1];
  if (last && last.kind === kind && !last.closed && (kind !== 'tool_args' || last.callId === extra.callId)) {
    last.text += text;
    last.deltas++;
    last.whereEnd = where;
    return;
  }
  run.server.push({ where, kind, text, deltas: 1, ...extra });
}

function serverEvent(run, msg, where) {
  if (msg.ttft_breakdown) run.ttft = msg.ttft_breakdown;
  const [kind, value] = only(msg, ['ttft_breakdown']);
  if (kind === 'interaction_update') {
    const [k, v] = only(value, ['message_started_at_ms']);
    switch (k) {
      case 'text_delta':
        return pushDelta(run, v.is_server_notice ? 'notice' : 'text', v.text || '', where);
      case 'thinking_delta':
        return pushDelta(run, 'thinking', v.text || '', where, { style: v.thinking_style });
      case 'thinking_completed': {
        const last = [...run.server].reverse().find((e) => e.kind === 'thinking' && !e.closed);
        if (last) Object.assign(last, { closed: true, durationMs: v.thinking_duration_ms });
        else run.server.push({ where, kind: 'thinking_completed', durationMs: v.thinking_duration_ms });
        return;
      }
      case 'partial_tool_call':
        if (v.args_text_delta !== undefined) return pushDelta(run, 'tool_args', v.args_text_delta, where, { callId: v.call_id, modelCallId: v.model_call_id });
        return run.server.push({ where, kind: 'tool_call_partial', callId: v.call_id, toolCall: v.tool_call });
      case 'tool_call_started':
      case 'tool_call_completed':
        return run.server.push({ where, kind: 'tool_call', phase: k === 'tool_call_started' ? 'started' : 'completed', callId: v.call_id, modelCallId: v.model_call_id, toolCall: v.tool_call });
      case 'tool_call_delta':
        return run.server.push({ where, kind: 'tool_call_delta', callId: v.call_id, delta: v.tool_call_delta });
      case 'token_delta':
        run.tokenDeltas = (run.tokenDeltas || 0) + (v.tokens || 0);
        return;
      case 'heartbeat':
        run.heartbeats = (run.heartbeats || 0) + 1;
        return;
      case 'turn_ended':
        run.usage = v;
        return run.server.push({ where, kind: 'turn_ended', usage: v });
      case 'summary':
        return pushDelta(run, 'summary', v.summary || '', where);
      case 'user_message_appended':
        return run.server.push({ where, kind: 'user_message_appended', userMessage: v.user_message });
      default:
        return run.server.push({ where, kind: k || 'interaction_update', value: v });
    }
  }
  if (kind === 'kv_server_message') {
    const [k, v] = only(value, ['id', 'span_context']);
    const ev = { where, kind: `kv_${k}`, id: value.id ?? 0 };
    if (k === 'get_blob_args' || k === 'set_blob_args') ev.blobId = hex(v.blob_id);
    if (k === 'set_blob_args') {
      ev.size = Buffer.from(v.blob_data || '', 'base64').length;
      addBlob(run, ev.blobId, v.blob_data, { side: 'server', how: 'set_blob', where });
    }
    return run.server.push(ev);
  }
  if (kind === 'exec_server_message') {
    const [op, args] = only(value, ['id', 'exec_id', 'machine_id', 'span_context', 'accept_hook_additional_contexts']);
    return run.server.push({ where, kind: 'exec', id: value.id ?? 0, execId: value.exec_id, op, args });
  }
  if (kind === 'conversation_checkpoint_update') {
    const n = run.checkpoints.length;
    const state = summarizeState(value);
    run.checkpoints.push(state);
    for (const r of stateRefs(value)) run.refs.push({ ...r, from: `checkpoint#${n}` });
    return run.server.push({ where, kind: 'checkpoint', index: n, rootPrompt: state.rootPrompt.length, turns: state.turns.length });
  }
  run.server.push({ where, kind: kind || 'unknown', value });
}

// Frames that are not messages: Connect end-stream ({error?, metadata?}), gRPC-web trailers, damage.
function frameNotes(run, side, frame, where) {
  if (frame.truncated) run.truncated = true;
  if (frame.json && frame.json.error) run.errors.push({ side, where, error: frame.json.error });
  if (frame.decompressError) run.errors.push({ side, where, error: { message: `frame not decompressed: ${frame.decompressError}` } });
  if (frame.message && frame.message._error) run.errors.push({ side, where, error: { message: `decode: ${frame.message._error.message}` } });
}

// Pair kv get_blob_result (client) with the server's get_blob_args by id, and store the data.
function resolveKv(run) {
  const asked = new Map(run.server.filter((e) => e.kind === 'kv_get_blob_args').map((e) => [e.id, e]));
  for (const ev of run.client) {
    if (ev.kind !== 'kv_get_blob_result') continue;
    const q = asked.get(ev.id);
    if (!q) {
      run.notes.push(`client blob answer #${ev.id} has no matching server request`);
      continue;
    }
    ev.blobId = q.blobId;
    q.answered = true;
    if (ev.hasData) addBlob(run, ev.blobId, ev.blobData, { side: 'client', how: 'get_blob_result', where: ev.where });
    else q.missingOnClient = true;
    delete ev.blobData;
  }
  for (const ev of run.server) if (ev.kind === 'exec') ev.answered = run.client.some((c) => c.kind === 'exec_result' && c.id === ev.id);
}

// Decode the blobs whose role is known; turn blobs add refs to their user message and steps.
function decodeBlobs(run, schema) {
  const roles = new Map();
  const queue = [...run.refs];
  while (queue.length) {
    const r = queue.shift();
    if (!roles.has(r.id)) roles.set(r.id, []);
    const list = roles.get(r.id);
    if (list.some((x) => x.ref === r.ref && x.index === r.index && x.key === r.key)) continue;
    list.push(r);
    const blob = run.blobs.get(r.id);
    if (!blob || blob.decoded !== undefined) continue;
    blob.decoded = decodeBlob(blob.data, r.ref, schema);
    // A user message blob refers to its text and to the conversation state when it was sent.
    if (/(^|\.)turn_user_message$/.test(r.ref) && blob.decoded.message) {
      for (const ref of actionRefs(undefined, blob.decoded.message)) {
        const x = { ...ref, from: `user message ${r.id}` };
        queue.push(x);
        run.refs.push(x);
      }
    }
    if (/(^|\.)turn$/.test(r.ref) && blob.decoded.message) {
      const t = blob.decoded.message.agent_conversation_turn;
      const s = blob.decoded.message.shell_conversation_turn;
      const from = `turn ${r.id}`;
      if (t && t.user_message) {
        const ref = { id: hex(t.user_message), ref: 'turn_user_message', turn: r.id, from };
        queue.push(ref);
        run.refs.push(ref);
      }
      (t && t.steps ? t.steps : []).forEach((b, index) => {
        const ref = { id: hex(b), ref: 'turn_step', turn: r.id, index, from };
        queue.push(ref);
        run.refs.push(ref);
      });
      for (const [k, b] of [['shell_command', s && s.shell_command], ['shell_output', s && s.shell_output]]) {
        if (b) {
          const ref = { id: hex(b), ref: `turn_${k}`, turn: r.id, from };
          queue.push(ref);
          run.refs.push(ref);
        }
      }
    }
  }
  for (const blob of run.blobs.values()) {
    blob.roles = (roles.get(blob.id) || []).map(({ ref, index, key, from }) => ({ ref, index, key, from }));
    if (blob.decoded === undefined) blob.decoded = decodeBlob(blob.data, undefined, schema);
  }
}

const BLOB_TYPES = {
  turn: 'agent.v1.ConversationTurnStructure',
  turn_user_message: 'agent.v1.UserMessage',
  turn_step: 'agent.v1.ConversationStep',
  user_message_conversation_state: 'agent.v1.ConversationStateStructure',
};

function decodeBlob(data, ref, schema) {
  const base = ref ? ref.replace(/^.*\./, '') : undefined;
  const type = BLOB_TYPES[base];
  if (type && schema) return { type, message: protobuf.decodeMessage(schema, type, data) };
  const s = data.toString('utf8');
  if (Buffer.from(s, 'utf8').equals(data)) {
    try {
      return { json: JSON.parse(s) };
    } catch {
      return { text: s };
    }
  }
  return { raw: protobuf.decodeRaw(data) };
}

// --- flows -> runs -------------------------------------------------------------------

function decodeBytesAs(schema, type, buf) {
  return protobuf.decodeMessage(schema, type, buf);
}

function runFromBidi(flow, decoded) {
  const run = newRun(flow, 'bidi');
  run.requestId = requestIdOf(decoded.meta);
  (decoded.request.frames || []).forEach((fr, i) => {
    frameNotes(run, 'client', fr, `c${i}`);
    if (fr.message) clientEvent(run, fr.message, `c${i}`);
  });
  (decoded.response.frames || []).forEach((fr, i) => {
    frameNotes(run, 'server', fr, `s${i}`);
    if (fr.message) serverEvent(run, fr.message, `s${i}`);
  });
  if (decoded.request.truncated || decoded.response.truncated) run.truncated = true;
  return run;
}

function runFromSse(flow, decoded, schema, appends) {
  const run = newRun(flow, flow.rpc === 'RunPoll' ? 'poll' : 'sse');
  // RunSSE sends a BidiRequestId, RunPoll a BidiPollRequest wrapping one.
  const reqMsg = (decoded.request.frames[0] && decoded.request.frames[0].message) || {};
  run.requestId = typeof reqMsg.request_id === 'object' ? reqMsg.request_id.request_id : reqMsg.request_id;
  (decoded.response.frames || []).forEach((fr, i) => {
    frameNotes(run, 'server', fr, `s${i}`);
    if (!fr.message) return;
    if (run.transport === 'poll') {
      if (fr.message.data) serverEvent(run, decodeBytesAs(schema, 'agent.v1.AgentServerMessage', textBytes(fr.message.data)), `s${i}`);
      if (fr.message.eof) run.server.push({ where: `s${i}`, kind: 'eof' });
    } else serverEvent(run, fr.message, `s${i}`);
  });
  const mine = (appends.get(run.requestId) || []).slice().sort((a, b) => Number(a.seqno) - Number(b.seqno) || a.started - b.started);
  run.appendFlows = mine.map((a) => ({ id: a.flow.id, day: a.flow.day, seqno: a.seqno, status: a.flow.status }));
  for (const a of mine) clientEvent(run, a.message, `a${a.seqno}`);
  if (!mine.length) run.notes.push('no BidiAppend flows captured for this request id: client messages unknown');
  return run;
}

function requestIdOf(meta) {
  for (const [k, v] of (meta && meta.request_headers) || []) if (String(k).toLowerCase() === 'x-request-id') return String(v);
  return undefined;
}

function finishRun(run, schema) {
  resolveKv(run);
  decodeBlobs(run, schema);
  run.finalState = run.checkpoints[run.checkpoints.length - 1];
  return run;
}

// Rebuild every agent conversation in the captures. Returns
// { conversations: [{ conversationId, runs, uploads, related }], unassigned: [run], flowErrors }.
function reconstruct({ root, day, schema, decode = flowsLib.decodeFlow } = {}) {
  const all = flowsLib.listFlows({ root, day });
  const appends = new Map();
  const runs = [];
  const uploads = [];
  const related = [];
  const flowErrors = [];
  for (const f of all) {
    const isAppend = f.service === 'aiserver.v1.BidiService' && f.rpc === 'BidiAppend';
    if (f.service !== AGENT && !isAppend) continue;
    let d;
    try {
      d = decode(f.dir, schema);
    } catch (e) {
      flowErrors.push({ flow: flowRef(f), error: e.message });
      continue;
    }
    if (isAppend) {
      const m = d.request.frames && d.request.frames[0] && d.request.frames[0].message;
      if (!m) continue;
      const reqId = m.request_id && m.request_id.request_id;
      const bytes = m.data_binary ? Buffer.from(m.data_binary, 'base64') : textBytes(m.data);
      const list = appends.get(reqId) || [];
      list.push({ flow: f, seqno: m.append_seqno ?? '0', started: f.started, message: decodeBytesAs(schema, 'agent.v1.AgentClientMessage', bytes) });
      appends.set(reqId, list);
      continue;
    }
    if (f.rpc === 'Run') runs.push(runFromBidi(f, d));
    else if (RUN_RPCS.has(f.rpc)) runs.push({ sse: true, flow: f, decoded: d });
    else if (f.rpc === 'UploadConversationBlobs') {
      const m = d.request.frames[0] && d.request.frames[0].message;
      if (m) uploads.push({ flow: flowRef(f), conversationId: m.conversation_id, chunk: m.chunk_index, chunks: m.total_chunks, blobs: (m.blobs || []).map((b) => ({ id: hex(b.id), value: b.value })) });
    } else {
      const m = d.request.frames[0] && d.request.frames[0].message;
      related.push({ flow: flowRef(f), conversationId: m && m.conversation_id, request: m, response: d.response.frames.map((x) => x.message || x.json).filter(Boolean) });
    }
  }
  const done = runs.map((r) => (r.sse ? runFromSse(r.flow, r.decoded, schema, appends) : r));

  const byConv = new Map();
  const conv = (id) => {
    if (!byConv.has(id)) byConv.set(id, { conversationId: id, runs: [], uploads: [], related: [] });
    return byConv.get(id);
  };
  const unassigned = [];
  for (const r of done) (r.conversationId ? conv(r.conversationId).runs : unassigned).push(r);
  for (const u of uploads) {
    const c = conv(u.conversationId || '(none)');
    c.uploads.push(u);
  }
  for (const x of related) if (x.conversationId) conv(x.conversationId).related.push(x);
  const conversations = [...byConv.values()].filter((c) => c.runs.length || c.uploads.length);
  for (const c of conversations) {
    c.runs.sort((a, b) => (a.flow.started ?? 0) - (b.flow.started ?? 0));
    c.started = c.runs.length ? c.runs[0].flow.started : undefined;
    // Uploaded blobs join every run of their conversation as a client-side source.
    for (const u of c.uploads) for (const r of c.runs) for (const b of u.blobs) addBlob(r, b.id, b.value, { side: 'client', how: 'upload', flow: u.flow.id });
  }
  for (const r of done) finishRun(r, schema);
  conversations.sort((a, b) => (a.started ?? 0) - (b.started ?? 0));
  return { conversations, unassigned, flowErrors };
}

module.exports = { reconstruct, stateRefs, summarizeState, decodeBlob, textBytes, sha256, hex };
