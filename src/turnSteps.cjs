'use strict';

// The agent's steps as Cursor stores them beside the prompt, and the readable thinking among them.
//
// The prompt messages keep the model's thinking only as `redacted-reasoning` parts: reasoning the
// model's provider returned encrypted (Anthropic's redacted_thinking, OpenAI's encrypted_content,
// Cursor's own models alike). Cursor passes it back to the model verbatim and never decrypts it;
// its UI shows "[REDACTED]". What Cursor showed as thinking lives in the conversation's turns:
//
//   conversationState field 8 (turns)    agentKv:blob ids of ConversationTurnStructure
//   ConversationTurnStructure            1 agent_conversation_turn { 1 user_message, 2 steps (blob ids) }
//   ConversationStep                     1 assistant_message { 1 text }  2 tool_call  3 thinking_message { 1 text, 2 duration_ms }
//
// These are protobuf (not JSON). placeThinking puts each thinking step on the prompt message the
// model wrote with it, and on that message's reasoning part.

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  for (;;) {
    const byte = buf[pos++];
    if (byte === undefined) throw new Error('truncated varint');
    result += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (byte < 0x80) return [result, pos];
  }
}

// The top-level fields of a protobuf message: [{ no, value }], value a number or a Buffer.
function fields(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    let tag;
    [tag, pos] = readVarint(buf, pos);
    const no = Math.floor(tag / 8);
    const wire = tag & 7;
    let value;
    if (wire === 0) [value, pos] = readVarint(buf, pos);
    else if (wire === 1) { value = buf.subarray(pos, pos + 8); pos += 8; }
    else if (wire === 5) { value = buf.subarray(pos, pos + 4); pos += 4; }
    else if (wire === 2) {
      let len;
      [len, pos] = readVarint(buf, pos);
      value = buf.subarray(pos, pos + len);
      pos += len;
    } else throw new Error(`unsupported wire type ${wire}`);
    if (pos > buf.length) throw new Error('truncated field');
    out.push({ no, value });
  }
  return out;
}

const field = (buf, no) => { const f = fields(buf).find((x) => x.no === no); return f && f.value; };
const text = (buf, no) => { const v = field(buf, no); return Buffer.isBuffer(v) ? v.toString('utf8') : ''; };

function getBytes(db, key) {
  const row = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(key);
  if (!row) return undefined;
  return typeof row.value === 'string' ? Buffer.from(row.value, 'utf8') : Buffer.from(row.value);
}

// A state this cannot parse has no turns: the recorder keeps going (it runs after the snapshot is written).
function turnHashes(conversationState) {
  if (typeof conversationState !== 'string' || !conversationState.startsWith('~')) return [];
  try {
    return fields(Buffer.from(conversationState.slice(1), 'base64')).filter((f) => f.no === 8 && Buffer.isBuffer(f.value) && f.value.length === 32).map((f) => f.value.toString('hex'));
  } catch {
    return [];
  }
}

// The state's summary archive (conversationState field 13): a blob listing, as message blob ids, the
// messages summarization took out of the prompt. The prompt names none of them; Cursor keeps the blobs.
function archivedHashes(db, conversationState) {
  if (typeof conversationState !== 'string' || !conversationState.startsWith('~')) return [];
  const out = [];
  try {
    for (const f of fields(Buffer.from(conversationState.slice(1), 'base64'))) {
      if (f.no !== 13 || !Buffer.isBuffer(f.value) || f.value.length !== 32) continue;
      const archive = getBytes(db, `agentKv:blob:${f.value.toString('hex')}`);
      if (!archive) continue;
      for (const e of fields(archive)) if (e.no === 1 && Buffer.isBuffer(e.value) && e.value.length === 32) out.push(e.value.toString('hex'));
    }
  } catch { /* a state this cannot read archives nothing */ }
  return [...new Set(out)];
}

// The call id of a tool-call step (field 57 of the call): the id its tool-call part and its tool-result
// message share. Undefined for other steps.
function callIdOf(step) {
  if (step.kind !== 'tool-call') return undefined;
  const call = fields(step.data)[0];
  const id = call && Buffer.isBuffer(call.value) ? field(call.value, 57) : undefined;
  return Buffer.isBuffer(id) ? id.toString('utf8') : undefined;
}

// The thinking Cursor's UI keeps on the chat's assistant bubbles (bubbleId:<chat>:<bubble>, thinking.text).
// Returns { bubble, text } for each one no turn step of `turns` holds: the thinking Cursor showed but did
// not keep as a step. Bubbles are read by key range, so the chat's keys are found without a table scan.
function bubbleThinking(db, composerId, turns) {
  const steps = turns.flatMap((t) => t.steps).filter((s) => s.kind === 'thinking' && s.text).map((s) => s.text);
  const out = [];
  for (const { bubble, value } of chatBubbles(db, composerId)) {
    const text = value.thinking && value.thinking.text;
    if (typeof text !== 'string' || !text.trim()) continue;
    if (!steps.some((t) => t.trim().includes(text.trim().slice(0, 200)) || text.trim().includes(t.trim().slice(0, 200)))) out.push({ bubble, text });
  }
  return out;
}

// Assistant replies Cursor showed on the chat's bubbles: [{ bubble, text }]. A reply interrupted by the
// next prompt is kept by Cursor in a message outside the prompt; its bubble is the only other place its text is.
function bubbleReplies(db, composerId) {
  return chatBubbles(db, composerId)
    .filter(({ value }) => value.type === 2 && typeof value.text === 'string' && value.text.trim())
    .map(({ bubble, value }) => ({ bubble, text: value.text }));
}

// The chat's bubbles (bubbleId:<chat>:<bubble>), parsed: [{ bubble, value }]. Read by key range.
function chatBubbles(db, composerId) {
  const prefix = `bubbleId:${composerId}:`;
  const out = [];
  for (const row of db.prepare('SELECT key, value FROM cursorDiskKV WHERE key >= ? AND key < ?').all(prefix, `bubbleId:${composerId};`)) {
    let value;
    try {
      value = JSON.parse(typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8'));
    } catch { continue; }
    if (value && typeof value === 'object') out.push({ bubble: row.key.slice(prefix.length), value });
  }
  return out;
}


// One step: { hash, kind: 'thinking' | 'text' | 'tool-call' | 'missing', text?, durationMs?, data? }.
// data (tool calls only) is the step's bytes, to find the call's id and arguments in.
function decodeStep(hash, data) {
  if (!data) return { hash, kind: 'missing' };
  const f = fields(data)[0];
  if (!f || !Buffer.isBuffer(f.value)) return { hash, kind: 'unknown' };
  if (f.no === 3) {
    const duration = field(f.value, 2);
    return { hash, kind: 'thinking', text: text(f.value, 1), ...(typeof duration === 'number' ? { durationMs: duration } : {}) };
  }
  if (f.no === 1) return { hash, kind: 'text', text: text(f.value, 1) };
  if (f.no === 2) return { hash, kind: 'tool-call', data };
  return { hash, kind: 'unknown' };
}

// The chat's turns, in order: [{ turn, steps }]. Shell turns (commands the user ran) have no steps.
function loadTurns(db, conversationState) {
  return turnHashes(conversationState).map((turn) => {
    const data = getBytes(db, `agentKv:blob:${turn}`);
    let steps = [];
    try {
      const agentTurn = data && field(data, 1);
      if (Buffer.isBuffer(agentTurn)) {
        steps = fields(agentTurn).filter((f) => f.no === 2 && Buffer.isBuffer(f.value)).map((f) => {
          const hash = f.value.toString('hex');
          try {
            return decodeStep(hash, getBytes(db, `agentKv:blob:${hash}`));
          } catch {
            return { hash, kind: 'unknown' };
          }
        });
      }
    } catch { /* not a turn Cursor's way: no steps */ }
    return { turn, missing: !data, steps };
  });
}

const reasoningLike = (p) => p.type === 'redacted-reasoning' || p.type === 'reasoning';

// Whether a prompt part is the one this step produced: the same agent text, or a tool call whose id
// appears in the step's bytes. Every tool call step Cursor stores holds its call's id; matching by
// arguments instead would take another call that ran the same command, in a later message.
function anchor(step) {
  if (step.kind === 'text') {
    const t = step.text.trim();
    return t ? (p) => p.type === 'text' && typeof p.text === 'string' && p.text.trim() === t : undefined;
  }
  if (step.kind !== 'tool-call') return undefined;
  return (p) => p.type === 'tool-call' && typeof p.toolCallId === 'string' && p.toolCallId.length > 0 && step.data.includes(Buffer.from(p.toolCallId, 'utf8'));
}

// turns: from loadTurns. messages: [{ hash, message }], the chat's prompt messages in conversation
// order. Returns the thinking steps in order: [{ step, turn, text, durationMs?, message, part }],
// message being the hash of the prompt message the model wrote with that thinking and part the index
// of its reasoning part (both null when not found).
//
// The steps of a model response are its thinking, then its text and tool calls; the prompt keeps
// that response as one assistant message. Each run of thinking goes to the message holding the
// first text or tool call after it that the record has; when nothing identifiable followed it, to
// the next message with a reasoning part. Messages are searched forward from the last one placed,
// which itself can hold more: a response that thought again between its tool calls.
function placeThinking(turns, messages) {
  const out = [];
  let cursor = -1;
  const find = (pred, from) => {
    for (let i = from; i < messages.length; i++) {
      const m = messages[i].message;
      if (m && m.role === 'assistant' && Array.isArray(m.content) && m.content.some(pred)) return i;
    }
    return -1;
  };
  const placed = new Map(); // message index -> thinking entries, in order
  for (const { turn, steps } of turns) {
    const groups = [];
    for (const step of steps) {
      const thinking = step.kind === 'thinking';
      if (!groups.length || (thinking && groups[groups.length - 1].rest.length)) groups.push({ thinking: [], rest: [] });
      groups[groups.length - 1][thinking ? 'thinking' : 'rest'].push(step);
    }
    for (const g of groups) {
      let i = -1;
      const anchors = g.rest.map(anchor).filter(Boolean);
      for (const pred of anchors) if ((i = find(pred, Math.max(cursor, 0))) !== -1) break;
      if (!anchors.length && g.thinking.length) i = find(reasoningLike, cursor + 1);
      const entries = g.thinking.map((s) => ({ step: s.hash, turn, text: s.text, ...(s.durationMs !== undefined ? { durationMs: s.durationMs } : {}), message: null, part: null }));
      out.push(...entries);
      if (i === -1) continue;
      cursor = i;
      if (entries.length) placed.set(i, [...(placed.get(i) || []), ...entries]);
    }
  }
  for (const [i, entries] of placed) {
    const { hash, message } = messages[i];
    const parts = message.content.map((p, k) => (reasoningLike(p) ? k : -1)).filter((k) => k !== -1);
    entries.forEach((e, k) => {
      e.message = hash;
      e.part = k < parts.length ? parts[k] : null;
    });
  }
  return out;
}

module.exports = { fields, turnHashes, archivedHashes, callIdOf, bubbleThinking, bubbleReplies, loadTurns, placeThinking };
