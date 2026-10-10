'use strict';

// Agent conversations rebuilt from synthetic captures (encoded with Cursor's own message shapes,
// test/fixtures/agent-schema.json), and compared with a synthetic plugin record.

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const pb = require('./protoEncode.cjs');
const schema = require('./fixtures/agent-schema.json');
const { prune } = require('./fixtures/make-agent-schema.cjs');
const conversation = require('../src/wire/conversation.cjs');
const compareLib = require('../src/wire/compare.cjs');
const report = require('../src/wire/report.cjs');
const cli = require('../src/wire/cli.cjs');

const enc = (type, obj) => pb.encodeMessage(schema, type, obj);
const client = (obj) => enc('agent.v1.AgentClientMessage', obj);
const server = (obj) => enc('agent.v1.AgentServerMessage', obj);
const sha = (b) => crypto.createHash('sha256').update(b).digest();
const DAY = '2026-01-02';
const CID = 'c0ffee00-1111-4222-8333-444455556666';

// A prompt message blob, as Cursor stores it: JSON bytes named by their sha256.
function blob(message) {
  const data = Buffer.from(JSON.stringify(message));
  return { data, id: sha(data), hex: sha(data).toString('hex'), message };
}

const RULE = 'Rule: every answer starts with a short summary line, then details.';
const RULE_PATH = '/repo/.cursor/rules/style.mdc';
const STDOUT = 'alpha.txt\nbeta.txt\ngamma.txt\ndelta.txt\n';
const M = {
  sys: blob({ role: 'system', content: 'You are a coding agent.' }),
  u0: blob({ role: 'user', content: [{ type: 'text', text: '<user_query>\nhello\n</user_query>' }] }),
  a0: blob({ role: 'assistant', content: [{ type: 'text', text: 'Hi!' }] }),
  u1: blob({ role: 'user', content: [{ type: 'text', text: `<rules>\n<rule path="${RULE_PATH}">\n${RULE}\n</rule>\n</rules>\n<user_query>\nlist the files\n</user_query>` }] }),
  a1: blob({ role: 'assistant', content: [{ type: 'reasoning', text: 'Let me look.' }, { type: 'tool-call', toolCallId: 'tc1', toolName: 'Shell', args: { command: 'ls' } }] }),
  t1: blob({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'tc1', toolName: 'Shell', result: STDOUT }] }),
  a2: blob({ role: 'assistant', content: [{ type: 'text', text: 'Here are the files.' }] }),
};
const ids = (...names) => names.map((n) => M[n].id);
const hexes = (...names) => names.map((n) => M[n].hex);

function writeFlow(root, name, { url, reqCt = 'application/connect+proto', respCt = 'application/connect+proto', reqBody, respBody, started, reqHeaders = [] }) {
  const dir = path.join(root, DAY, name);
  fs.mkdirSync(dir, { recursive: true });
  const meta = {
    method: 'POST', url, http_version: 'HTTP/2.0', started, ended: started + 1, status: 200,
    request_headers: [['content-type', reqCt], ...reqHeaders], response_headers: [['content-type', respCt]],
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(dir, 'request.bin.gz'), zlib.gzipSync(reqBody));
  fs.writeFileSync(path.join(dir, 'response.bin.gz'), zlib.gzipSync(respBody));
}

const stream = (msgs, end = true) => Buffer.concat([...msgs.map((m) => pb.envelope(0, m)), ...(end ? [pb.envelope(2, Buffer.from('{}'))] : [])]);
const ts = (...vals) => vals;

// The client messages and server messages of one user turn with a shell tool call.
function turnMessages() {
  const clientMsgs = [
    client({ run_request: {
      conversation_id: CID,
      conversation_state: { root_prompt_messages_json: ids('sys', 'u0', 'a0') },
      action: { user_message_action: { user_message: { text: 'list the files', message_id: 'm1' }, request_context: { rules: [{ full_path: RULE_PATH, content: RULE }] } } },
      requested_model: { model_id: 'composer-2' },
    } }),
    client({ kv_client_message: { id: 1, get_blob_result: { blob_data: M.sys.data } } }),
    client({ exec_client_message: { id: 7, shell_result: { success: { command: 'ls', exit_code: 0, stdout: STDOUT } } } }),
  ];
  const serverMsgs = [
    server({ kv_server_message: { id: 1, get_blob_args: { blob_id: M.sys.id } } }),
    server({ interaction_update: { thinking_delta: { text: 'Let me ' } } }),
    server({ interaction_update: { thinking_delta: { text: 'look.' } } }),
    server({ interaction_update: { thinking_completed: { thinking_duration_ms: 120 } } }),
    server({ interaction_update: { tool_call_started: { call_id: 'tc1', tool_call: { shell_tool_call: { args: { command: 'ls', tool_call_id: 'tc1' } } } } } }),
    server({ exec_server_message: { id: 7, shell_args: { command: 'ls', tool_call_id: 'tc1' } } }),
    server({ interaction_update: { tool_call_completed: { call_id: 'tc1', tool_call: { shell_tool_call: { args: { command: 'ls' } } } } } }),
    server({ interaction_update: { text_delta: { text: 'Here are ' } } }),
    server({ interaction_update: { text_delta: { text: 'the files.' } } }),
    ...['u1', 'a1', 't1', 'a2'].map((n, i) => server({ kv_server_message: { id: 10 + i, set_blob_args: { blob_id: M[n].id, blob_data: M[n].data } } })),
    server({ conversation_checkpoint_update: { root_prompt_messages_json: ids('sys', 'u0', 'a0', 'u1', 'a1', 't1', 'a2') } }),
    server({ interaction_update: { turn_ended: { input_tokens: 1200, output_tokens: 40 } } }),
  ];
  return { clientMsgs, serverMsgs };
}

function writeRunFlow(root, started = 1767312000) {
  const { clientMsgs, serverMsgs } = turnMessages();
  writeFlow(root, '100000-00001-agent.v1.AgentService_Run', {
    url: 'https://agent.api5.cursor.sh/agent.v1.AgentService/Run', started,
    reqBody: stream(clientMsgs, false), respBody: stream(serverMsgs),
  });
}

// The plugin's record of the chat: history folder, optionally altered by `edit`.
function writeRecord(dir, { seen = ['sys', 'u0', 'a0', 'u1', 'a1', 't1', 'a2'], snapshots = [['sys', 'u0', 'a0'], ['sys', 'u0', 'a0', 'u1', 'a1', 't1', 'a2']], blobs = seen, edit = {} } = {}) {
  const chat = path.join(dir, 'chats', 'Files');
  fs.mkdirSync(path.join(chat, 'snapshots'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'blobs'), { recursive: true });
  fs.writeFileSync(path.join(chat, 'meta.json'), JSON.stringify({ composerId: CID, name: 'Files', createdAt: 1767311000000, seen: hexes(...seen) }));
  snapshots.forEach((s, i) => fs.writeFileSync(path.join(chat, 'snapshots', `${1767311000000 + i}.json`), JSON.stringify({ composerId: CID, messages: hexes(...s) })));
  for (const n of blobs) fs.writeFileSync(path.join(dir, 'blobs', `${M[n].hex}.json`), edit[n] || M[n].data);
}

function tmp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-conv-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return { wire: path.join(d, 'wire'), history: path.join(d, 'history') };
}

const kinds = (r) => [...r.findings, ...r.runs.flatMap((x) => x.findings)].map((f) => f.kind).sort();
const verdict = (r, id) => r.assumptions.find((a) => a.id === id).verdict;

test('a bidi Run becomes one run: client and server streams, blobs from both sides, checkpoint', (t) => {
  const { wire } = tmp(t);
  writeRunFlow(wire);
  const { conversations, unassigned } = conversation.reconstruct({ root: wire, schema });
  assert.strictEqual(unassigned.length, 0);
  assert.strictEqual(conversations.length, 1);
  const [run] = conversations[0].runs;
  assert.strictEqual(conversations[0].conversationId, CID);
  assert.strictEqual(run.transport, 'bidi');
  assert.strictEqual(run.model, 'composer-2');
  assert.strictEqual(run.userMessage.text, 'list the files');
  assert.deepStrictEqual(run.initialState.rootPrompt, hexes('sys', 'u0', 'a0'));
  assert.deepStrictEqual(run.finalState.rootPrompt, hexes('sys', 'u0', 'a0', 'u1', 'a1', 't1', 'a2'));

  // Deltas are joined exactly; thinking keeps its duration.
  const thinking = run.server.find((e) => e.kind === 'thinking');
  assert.deepStrictEqual([thinking.text, thinking.deltas, thinking.durationMs], ['Let me look.', 2, 120]);
  const text = run.server.find((e) => e.kind === 'text');
  assert.deepStrictEqual([text.text, text.deltas], ['Here are the files.', 2]);

  // The blob the client served is tied to the server's request by kv id.
  const kv = run.client.find((e) => e.kind === 'kv_get_blob_result');
  assert.strictEqual(kv.blobId, M.sys.hex);
  const sys = run.blobs.get(M.sys.hex);
  assert.deepStrictEqual(sys.sources.map((s) => `${s.side}:${s.how}`), ['client:get_blob_result']);
  assert.ok(sys.sha256Ok);
  assert.deepStrictEqual(run.blobs.get(M.a1.hex).decoded.json, M.a1.message);
  assert.deepStrictEqual(run.blobs.get(M.a1.hex).roles.map((r) => r.ref), ['root_prompt']);
  // The exec request and its result pair up.
  assert.ok(run.server.find((e) => e.kind === 'exec').answered);
  assert.strictEqual(run.client.find((e) => e.kind === 'exec_result').result.success.stdout, STDOUT);
  assert.deepStrictEqual(run.usage, { input_tokens: '1200', output_tokens: '40' }); // int64 as strings
  assert.deepStrictEqual(run.errors, []);
});

test('turn blobs are followed to their user message and steps', (t) => {
  const { wire } = tmp(t);
  const um = enc('agent.v1.UserMessage', { text: 'list the files', message_id: 'm1' });
  const step = enc('agent.v1.ConversationStep', { assistant_message: { text: 'Here are the files.' } });
  const turn = enc('agent.v1.ConversationTurnStructure', { agent_conversation_turn: { user_message: sha(um), steps: [sha(step)] } });
  writeFlow(wire, '100000-00001-agent.v1.AgentService_Run', {
    url: 'https://x/agent.v1.AgentService/Run', started: 1,
    reqBody: stream([client({ run_request: { conversation_id: CID, conversation_state: { turns: [sha(turn)] } } })], false),
    respBody: stream([turn, um, step].map((d, i) => server({ kv_server_message: { id: i + 1, set_blob_args: { blob_id: sha(d), blob_data: d } } }))),
  });
  const [run] = conversation.reconstruct({ root: wire, schema }).conversations[0].runs;
  const role = (d) => run.blobs.get(sha(d).toString('hex')).roles.map((r) => r.ref);
  assert.deepStrictEqual([role(turn), role(um), role(step)], [['turn'], ['turn_user_message'], ['turn_step']]);
  assert.strictEqual(run.blobs.get(sha(step).toString('hex')).decoded.message.assistant_message.text, 'Here are the files.');
});

test('RunSSE: client messages come from BidiAppend flows, in append_seqno order, hex or binary', (t) => {
  const { wire } = tmp(t);
  const { clientMsgs, serverMsgs } = turnMessages();
  const reqId = 'req-42';
  writeFlow(wire, '100000-00001-agent.v1.AgentService_RunSSE', {
    url: 'https://x/agent.v1.AgentService/RunSSE', started: 10,
    reqBody: pb.envelope(0, enc('aiserver.v1.BidiRequestId', { request_id: reqId })), respBody: stream(serverMsgs),
  });
  // Appended out of order (seqno 2 captured first), alternating encodings. Like Cursor, seqno 0 is
  // left out (the proto3 default).
  clientMsgs.map((m, i) => ({ m, i })).reverse().forEach(({ m, i }, k) => {
    const seqno = i ? { append_seqno: i } : {};
    const body = i % 2
      ? enc('aiserver.v1.BidiAppendRequest', { request_id: { request_id: reqId }, ...seqno, data_binary: m })
      : enc('aiserver.v1.BidiAppendRequest', { request_id: { request_id: reqId }, ...seqno, data: m.toString('hex') });
    writeFlow(wire, `10000${k}-0000${k + 2}-aiserver.v1.BidiService_BidiAppend`, { url: 'https://x/aiserver.v1.BidiService/BidiAppend', reqCt: 'application/proto', respCt: 'application/proto', started: 11 + k, reqBody: body, respBody: Buffer.alloc(0) });
  });
  const { conversations } = conversation.reconstruct({ root: wire, schema });
  const [run] = conversations[0].runs;
  assert.strictEqual(run.transport, 'sse');
  assert.strictEqual(run.requestId, reqId);
  assert.deepStrictEqual(run.client.map((e) => `${e.where} ${e.kind}`), ['a0 run_request', 'a1 kv_get_blob_result', 'a2 exec_result']);
  assert.strictEqual(run.client[1].blobId, M.sys.hex);
  assert.strictEqual(conversations[0].conversationId, CID);
});

test('compare: a faithful record has no findings and the checked assumptions hold', (t) => {
  const { wire, history } = tmp(t);
  writeRunFlow(wire);
  writeRecord(history);
  const { conversations } = conversation.reconstruct({ root: wire, schema });
  const [r] = compareLib.compare({ conversations, historyDir: history });
  assert.deepStrictEqual(kinds(r), []);
  assert.strictEqual(r.chat.composerId, CID);
  assert.deepStrictEqual(r.runs[0].prompt.states.map((s) => !!s.snapshot), [true, true]);
  for (const id of ['root-hashes', 'complete-record', 'seen-order', 'snapshots', 'user-text', 'agent-text', 'tool-calls', 'request-context', 'tools-backend']) {
    assert.strictEqual(verdict(r, id), 'holds', id);
  }
  assert.strictEqual(verdict(r, 'summary'), 'unverified');
  // Found by name too; the human view renders.
  assert.strictEqual(compareLib.compare({ conversations, historyDir: history, ref: 'fil' }).length, 1);
  assert.match(report.renderComparison(r), /HOLDS +user-text/);
});

test('compare: missing, altered, reordered and misread messages are each reported', (t) => {
  const { wire, history } = tmp(t);
  writeRunFlow(wire);
  // a2 never recorded, t1's blob altered, u1/a1 seen in the wrong order, no snapshot of the final
  // prompt, and u1 recorded with text chat.md cannot see as the user's.
  const u1 = Buffer.from(M.u1.data.toString().replace('list the files', 'list the filez'));
  writeRecord(history, { seen: ['sys', 'u0', 'a0', 'a1', 'u1', 't1'], snapshots: [['sys', 'u0', 'a0']], edit: { t1: Buffer.from('{"role":"tool","content":[]}'), u1 } });
  const { conversations } = conversation.reconstruct({ root: wire, schema });
  const [r] = compareLib.compare({ conversations, historyDir: history });
  const k = kinds(r);
  for (const want of ['prompt-message-not-recorded', 'blob-bytes-differ', 'order-differs', 'prompt-state-without-snapshot', 'recorded-blob-hash-mismatch', 'chat-md-user-text-differs']) {
    assert.ok(k.includes(want), `${want} in ${k}`);
  }
  const userDiff = r.runs[0].findings.find((f) => f.kind === 'chat-md-user-text-differs');
  assert.deepStrictEqual(userDiff.diff.lines.filter((l) => l.op !== ' '), [{ op: '-', text: 'list the files' }, { op: '+', text: 'list the filez' }]);
  assert.strictEqual(verdict(r, 'complete-record'), 'contradicted');
  assert.strictEqual(verdict(r, 'user-text'), 'contradicted');
  // The record's lost message is shown from the wire's copy.
  const lost = r.runs[0].findings.find((f) => f.kind === 'prompt-message-not-recorded');
  assert.strictEqual(lost.id, M.a2.hex);
  assert.strictEqual(lost.text.parts[0].text, 'Here are the files.');
});

test('compare: streamed text, thinking, tool calls and sent context missing from the record', (t) => {
  const { wire, history } = tmp(t);
  writeRunFlow(wire);
  // The record holds a different prompt for the same ids: u1 without the rule, a1 without its
  // reasoning and with another call id, t1 without the output, a2 with other text.
  const edit = {
    u1: Buffer.from(JSON.stringify({ role: 'user', content: [{ type: 'text', text: 'list the files' }] })),
    a1: Buffer.from(JSON.stringify({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'other', toolName: 'Shell', args: {} }] })),
    t1: Buffer.from(JSON.stringify({ role: 'tool', content: [{ type: 'tool-result', toolCallId: 'other', result: '' }] })),
    a2: Buffer.from(JSON.stringify({ role: 'assistant', content: [{ type: 'text', text: 'Something else.' }] })),
  };
  writeRecord(history, { edit });
  const { conversations } = conversation.reconstruct({ root: wire, schema });
  const [r] = compareLib.compare({ conversations, historyDir: history });
  const k = kinds(r);
  for (const want of ['streamed-text-not-recorded', 'streamed-thinking-not-recorded', 'tool-call-not-recorded', 'tool-result-not-recorded', 'recorded-tool-call-not-on-wire', 'tool-output-not-in-recorded-result', 'sent-context-not-in-record', 'recorded-agent-text-not-streamed']) {
    assert.ok(k.includes(want), `${want} in ${k}`);
  }
  const ctx = r.runs[0].findings.filter((f) => f.kind === 'sent-context-not-in-record');
  assert.deepStrictEqual(ctx.map((f) => [f.path, f.text]), [
    ['user_message_action.request_context.rules[0].full_path', RULE_PATH],
    ['user_message_action.request_context.rules[0].content', RULE],
  ]);
});

test('compare: summarization, subagent links from the wire against the DB', (t) => {
  const { wire, history } = tmp(t);
  const s = blob({ role: 'user', content: [{ type: 'text', text: '[Previous conversation summary]\nThe user listed files.' }] });
  const u2 = blob({ role: 'user', content: [{ type: 'text', text: '<user_query>\nnow explore\n</user_query>' }] });
  const a3 = blob({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'tc9', toolName: 'Task', args: { prompt: 'explore' } }] });
  Object.assign(M, { s, u2, a3 });
  writeFlow(wire, '100000-00001-agent.v1.AgentService_Run', {
    url: 'https://x/agent.v1.AgentService/Run', started: 5,
    reqBody: stream([client({ run_request: { conversation_id: CID, conversation_state: { root_prompt_messages_json: ids('sys', 'u0', 'a0', 'u1', 'a1', 't1', 'a2') }, action: { user_message_action: { user_message: { text: 'now explore' } } } } })], false),
    respBody: stream([
      server({ interaction_update: { summary_started: {} } }),
      server({ interaction_update: { summary: { summary: 'The user listed files.' } } }),
      server({ interaction_update: { summary_completed: {} } }),
      ...['s', 'u2', 'a3'].map((n, i) => server({ kv_server_message: { id: i + 1, set_blob_args: { blob_id: M[n].id, blob_data: M[n].data } } })),
      server({ interaction_update: { tool_call_completed: { call_id: 'tc9', tool_call: { task_tool_call: { args: { prompt: 'explore' }, result: { success: { agent_id: 'sub-1' } } } } } } }),
      server({ conversation_checkpoint_update: { root_prompt_messages_json: ids('sys', 's', 'u2', 'a3'), self_summary_count: 1, subagent_runs_by_parent_tool_call_id: { tc9: { parent_tool_call_id: 'tc9', subagent_id: 'sub-1' } } } }),
    ]),
  });
  const all = ['sys', 'u0', 'a0', 'u1', 'a1', 't1', 'a2', 's', 'u2', 'a3'];
  writeRecord(history, { seen: all, snapshots: [all.slice(0, 7), ['sys', 's', 'u2', 'a3']] });

  // Cursor's DB: the subagent is linked to a different tool call than the wire says.
  const { DatabaseSync } = require('node:sqlite');
  const dbFile = path.join(history, 'state.vscdb');
  const db = new DatabaseSync(dbFile);
  db.exec('CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)');
  const put = db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)');
  put.run(`composerData:${CID}`, JSON.stringify({ name: 'Files', subagentComposerIds: ['sub-1'] }));
  put.run('composerData:sub-1', JSON.stringify({ name: 'Explore', subagentInfo: { parentComposerId: CID, toolCallId: 'tc8' } }));
  t.after(() => db.close());

  const { conversations } = conversation.reconstruct({ root: wire, schema });
  const [r] = compareLib.compare({ conversations, historyDir: history, db });
  assert.deepStrictEqual(r.runs[0].summary, { dropped: 6, firstUserStartsWithPrefix: true, firstUserHasSummaryTag: false });
  assert.strictEqual(verdict(r, 'summary'), 'holds');
  assert.deepStrictEqual(r.subagents, [{ toolCallId: 'tc9', subagentId: 'sub-1', from: 'checkpoint' }]);
  const link = r.findings.find((f) => f.kind === 'subagent-link-differs');
  assert.deepStrictEqual([link.wireSubagentId, link.pluginLinks, link.dbToolCallId], ['sub-1', [], 'tc8']);
  assert.strictEqual(verdict(r, 'subagent-link'), 'contradicted');
});

test('compare: context the server asks for by exec is checked against the whole record', (t) => {
  const { wire, history } = tmp(t);
  const { clientMsgs, serverMsgs } = turnMessages();
  const toolDescription = 'Search the team wiki for pages that match a query string.';
  serverMsgs.unshift(server({ exec_server_message: { id: 3, request_context_args: { workspace_id: 'w1' } } }));
  clientMsgs.push(client({ exec_client_message: { id: 3, request_context_result: { success: { request_context: {
    env: { workspace_paths: ['/home/someone/projects/example-repo'] },
    tools: [{ name: 'wiki_search', description: toolDescription }],
    // Starts like the recorded rule, then goes on differently: not a shortened copy of it.
    rules: [{ full_path: RULE_PATH, content: `${RULE.slice(0, 50)} Then a clause the record never had.` }],
  } } } } }));
  writeFlow(wire, '100000-00001-agent.v1.AgentService_Run', { url: 'https://x/agent.v1.AgentService/Run', started: 1, reqBody: stream(clientMsgs, false), respBody: stream(serverMsgs) });
  writeRecord(history);
  const [r] = compareLib.compare({ conversations: conversation.reconstruct({ root: wire, schema }).conversations, historyDir: history });
  const f = r.runs[0].findings;
  assert.deepStrictEqual(f.filter((x) => x.kind === 'sent-context-not-in-record').map((x) => [x.path, x.text]), [
    ['exec #3 request_context_result.success.request_context.env.workspace_paths[0]', '/home/someone/projects/example-repo'],
    ['exec #3 request_context_result.success.request_context.tools[0].description', toolDescription],
    ['exec #3 request_context_result.success.request_context.rules[0].content', `${RULE.slice(0, 50)} Then a clause the record never had.`],
  ]);
  // Not mistaken for a tool's output.
  assert.ok(!f.some((x) => x.kind === 'tool-output-not-in-recorded-result'));
  assert.deepStrictEqual(f.find((x) => x.kind === 'client-sent-tool-definitions').names, ['wiki_search']);
  assert.strictEqual(verdict(r, 'tools-backend'), 'contradicted');
});

test('compare: thinking kept only as turn steps, and context reformatted in the prompt, are told apart', (t) => {
  const { wire, history } = tmp(t);
  const { clientMsgs, serverMsgs } = turnMessages();
  // The step blobs Cursor stores under the turn: the visible thinking and text, and the user message
  // (whose own state blob is followed too).
  const state = enc('agent.v1.ConversationStateStructure', { root_prompt_messages_json: ids('sys', 'u0', 'a0') });
  const um = enc('agent.v1.UserMessage', { text: 'list the files', conversation_state_blob_id: sha(state) });
  const st = [enc('agent.v1.ConversationStep', { thinking_message: { text: 'Let me look.' } }), enc('agent.v1.ConversationStep', { assistant_message: { text: 'Here are the files.' } })];
  const turn = enc('agent.v1.ConversationTurnStructure', { agent_conversation_turn: { user_message: sha(um), steps: st.map(sha) } });
  const cp = serverMsgs.findIndex((m) => m.equals(server({ conversation_checkpoint_update: { root_prompt_messages_json: ids('sys', 'u0', 'a0', 'u1', 'a1', 't1', 'a2') } })));
  serverMsgs.splice(cp, 1,
    ...[state, um, ...st, turn].map((d, i) => server({ kv_server_message: { id: 30 + i, set_blob_args: { blob_id: sha(d), blob_data: d } } })),
    server({ conversation_checkpoint_update: { root_prompt_messages_json: ids('sys', 'u0', 'a0', 'u1', 'a1', 't1', 'a2'), turns: [sha(turn)] } }));
  writeFlow(wire, '100000-00001-agent.v1.AgentService_Run', { url: 'https://x/agent.v1.AgentService/Run', started: 1, reqBody: stream(clientMsgs, false), respBody: stream(serverMsgs) });
  // Recorded: reasoning only encrypted; the rule shortened; the shell output numbered.
  const short = `${RULE.slice(0, 45)}…`;
  writeRecord(history, { edit: {
    u1: Buffer.from(M.u1.data.toString().replace(RULE, short)),
    a1: Buffer.from(JSON.stringify({ ...M.a1.message, content: [{ type: 'redacted-reasoning', data: 'opaque' }, M.a1.message.content[1]] })),
    t1: Buffer.from(JSON.stringify({ ...M.t1.message, content: [{ ...M.t1.message.content[0], result: STDOUT.split('\n').map((l, i) => `${i + 1}|${l}`).join('\n') }] })),
  } });
  const { conversations } = conversation.reconstruct({ root: wire, schema });
  const [run] = conversations[0].runs;
  assert.ok([...run.blobs.values()].every((b) => b.roles.length), 'every blob is referenced');
  assert.deepStrictEqual(run.blobs.get(sha(state).toString('hex')).roles.map((r) => r.ref), ['user_message_conversation_state']);
  const [r] = compareLib.compare({ conversations, historyDir: history });
  const f = r.runs[0].findings;
  const thinking = f.find((x) => x.kind === 'streamed-thinking-not-recorded');
  assert.deepStrictEqual([thinking.inTurnSteps, thinking.recordedAs], [true, ['redacted-reasoning']]);
  assert.deepStrictEqual(f.filter((x) => /reformatted/.test(x.kind)).map((x) => [x.kind, x.match]), [
    ['tool-output-reformatted-in-record', 'lines'],
    ['sent-context-reformatted-in-record', 'prefix'],
  ]);
  assert.ok(!f.some((x) => x.kind === 'sent-context-not-in-record'));
  assert.strictEqual(verdict(r, 'tool-calls'), 'holds');
});

test('compare: context sent only by reference is reported with its size', (t) => {
  const { wire, history } = tmp(t);
  const rules = sha(Buffer.from('rules part'));
  writeFlow(wire, '100000-00001-agent.v1.AgentService_Run', {
    url: 'https://x/agent.v1.AgentService/Run', started: 1,
    reqBody: stream([client({ run_request: { conversation_id: CID, conversation_state: { root_prompt_messages_json: ids('sys', 'u0', 'a0') },
      action: { user_message_action: { user_message: { text: 'again' } }, request_context_parts: { rules_blob_id: rules, rules_byte_length: 10 } } } })], false),
    respBody: stream([]),
  });
  writeRecord(history, { seen: ['sys', 'u0', 'a0'], snapshots: [['sys', 'u0', 'a0']] });
  const [r] = compareLib.compare({ conversations: conversation.reconstruct({ root: wire, schema }).conversations, historyDir: history });
  const f = r.runs[0].findings.filter((x) => x.kind === 'context-sent-by-reference');
  assert.deepStrictEqual(f.map((x) => [x.ref, x.id, x.bytes]), [['context_rules', rules.toString('hex'), 10]]);
  assert.strictEqual(verdict(r, 'request-context'), 'contradicted');
});

test('compare: settings, the editor\'s rich text and a new conversation\'s empty state are not findings', (t) => {
  const { wire, history } = tmp(t);
  const richText = JSON.stringify({ root: { children: [{ type: 'paragraph', children: [{ type: 'text', text: 'hello' }] }] } });
  writeFlow(wire, '100000-00001-agent.v1.AgentService_Run', {
    url: 'https://x/agent.v1.AgentService/Run', started: 1,
    reqBody: stream([client({ run_request: { conversation_id: CID, conversation_state: {},
      action: { user_message_action: { user_message: { text: 'hello', rich_text: richText, simulated_msg_reason: 'SIMULATED_MSG_REASON_PLAN_EXECUTION' } } } } })], false),
    respBody: stream([
      ...['sys', 'u0', 'a0'].map((n, i) => server({ kv_server_message: { id: i, set_blob_args: { blob_id: M[n].id, blob_data: M[n].data } } })),
      server({ interaction_update: { text_delta: { text: 'Hi!' } } }),
      server({ conversation_checkpoint_update: { root_prompt_messages_json: ids('sys', 'u0', 'a0') } }),
    ]),
  });
  writeRecord(history, { seen: ['sys', 'u0', 'a0'], snapshots: [['sys', 'u0', 'a0']] });
  const [r] = compareLib.compare({ conversations: conversation.reconstruct({ root: wire, schema }).conversations, historyDir: history });
  assert.deepStrictEqual(r.runs[0].prompt.states.map((s) => [s.state, s.messages, !!s.snapshot]), [['request', 0, false], ['checkpoint#0', 3, true]]);
  assert.deepStrictEqual(kinds(r), []);
});

test('diffText and outOfOrder', () => {
  assert.deepStrictEqual(compareLib.diffText('same', 'same'), { same: true });
  const d = compareLib.diffText('a\nb\nc\nd', 'a\nB\nc\nd');
  assert.strictEqual(d.firstDifference, 2);
  assert.deepStrictEqual(d.lines, [{ op: '-', text: 'b' }, { op: '+', text: 'B' }]);
  assert.deepStrictEqual(compareLib.outOfOrder(['a', 'b', 'c', 'd', 'e'], ['b', 'c', 'd', 'a', 'e']), ['a']);
  assert.deepStrictEqual(compareLib.outOfOrder(['a', 'x', 'b'], ['a', 'b']), []);
});

test('wire conv / compare CLI: human view clips only with --clip, --json keeps everything', async (t) => {
  const { wire, history } = tmp(t);
  writeRunFlow(wire);
  writeRecord(history, { seen: ['sys', 'u0', 'a0'] });
  const schemaFile = path.join(path.dirname(wire), 'schema.json');
  fs.writeFileSync(schemaFile, JSON.stringify(schema));
  const run = async (...args) => {
    let s = '';
    const code = await cli.run([...args, '--root', wire, '--schema', schemaFile], { write: (x) => { s += x; } });
    return { code, s };
  };
  const conv = await run('conv', '--clip', '5');
  assert.strictEqual(conv.code, 0);
  assert.match(conv.s, /Here … \[14 more chars of 19; --full shows all\]/);
  const cmp = await run('compare', '--history', history, '--no-db', '--json');
  const json = JSON.parse(cmp.s);
  const lost = json.comparisons[0].runs[0].findings.filter((f) => f.kind === 'prompt-message-not-recorded');
  assert.deepStrictEqual(lost.map((f) => f.id).sort(), hexes('u1', 'a1', 't1', 'a2').sort());
  const human = await run('compare', 'Files', '--history', history, '--no-db');
  assert.match(human.s, /CONTRADICTED complete-record/);
});

// The fixture is Cursor's schema, pruned; when Cursor is installed, check it has not drifted.
test('the agent schema fixture matches the installed Cursor', (t) => {
  let full;
  try {
    full = require('../src/wire/schema.cjs').loadSchema();
  } catch {
    return t.skip('Cursor is not installed');
  }
  if (!full.cursor || full.cursor.version !== schema.cursor.version.replace(/ \(subset for tests\)$/, '')) return t.skip('another Cursor version');
  assert.deepStrictEqual(prune(full).messages, schema.messages);
});
