'use strict';

// Writes agent-schema.json: the part of Cursor's protobuf schema the agent-conversation tests use.
// Each kept type keeps its scalar and enum fields and the fields whose message type is also kept,
// with Cursor's own numbers and names. Regenerate after a Cursor update:
//   node test/fixtures/make-agent-schema.cjs [schema.json]   (default: extracted from the installed Cursor)

const fs = require('node:fs');
const path = require('node:path');

const TYPES = [
  'agent.v1.AgentClientMessage', 'agent.v1.AgentServerMessage', 'agent.v1.AgentRunRequest',
  'agent.v1.ConversationStateStructure', 'agent.v1.ConversationTokenDetails', 'agent.v1.SubagentRunState',
  'agent.v1.FileStateStructure', 'agent.v1.ConversationAction', 'agent.v1.UserMessageAction', 'agent.v1.ResumeAction',
  'agent.v1.UserMessage', 'agent.v1.RequestContext', 'agent.v1.CursorRule', 'agent.v1.RequestContextEnv', 'agent.v1.McpToolDefinition',
  'agent.v1.McpTools', 'agent.v1.RequestContextArgs', 'agent.v1.RequestContextResult', 'agent.v1.RequestContextSuccess', 'agent.v1.RequestedModel', 'agent.v1.ModelDetails',
  'agent.v1.PreFetchedBlob', 'agent.v1.RequestContextPartReferences',
  'agent.v1.KvClientMessage', 'agent.v1.KvServerMessage', 'agent.v1.GetBlobArgs', 'agent.v1.SetBlobArgs',
  'agent.v1.GetBlobResult', 'agent.v1.SetBlobResult', 'agent.v1.Error',
  'agent.v1.ExecClientMessage', 'agent.v1.ExecServerMessage', 'agent.v1.ShellArgs', 'agent.v1.ReadArgs', 'agent.v1.SubagentArgs',
  'agent.v1.ShellResult', 'agent.v1.ShellSuccess', 'agent.v1.ShellFailure', 'agent.v1.ReadResult', 'agent.v1.ReadSuccess',
  'agent.v1.InteractionUpdate', 'agent.v1.TextDeltaUpdate', 'agent.v1.ThinkingDeltaUpdate', 'agent.v1.ThinkingCompletedUpdate',
  'agent.v1.ToolCallStartedUpdate', 'agent.v1.ToolCallCompletedUpdate', 'agent.v1.PartialToolCallUpdate',
  'agent.v1.TurnEndedUpdate', 'agent.v1.HeartbeatUpdate', 'agent.v1.TokenDeltaUpdate', 'agent.v1.SummaryUpdate',
  'agent.v1.SummaryStartedUpdate', 'agent.v1.SummaryCompletedUpdate', 'agent.v1.UserMessageAppendedUpdate',
  'agent.v1.ToolCall', 'agent.v1.ShellToolCall', 'agent.v1.ReadToolCall', 'agent.v1.ReadToolArgs', 'agent.v1.TaskToolCall',
  'agent.v1.TaskArgs', 'agent.v1.TaskResult', 'agent.v1.TaskSuccess', 'agent.v1.TaskError',
  'agent.v1.ConversationTurnStructure', 'agent.v1.AgentConversationTurnStructure', 'agent.v1.ConversationStep',
  'agent.v1.AssistantMessage', 'agent.v1.ThinkingMessage',
  'agent.v1.UploadConversationBlobsRequest', 'agent.v1.UploadConversationBlobsResponse', 'agent.v1.BlobEntry',
  'aiserver.v1.BidiRequestId', 'aiserver.v1.BidiAppendRequest', 'aiserver.v1.BidiAppendResponse',
  'aiserver.v1.BidiPollRequest', 'aiserver.v1.BidiPollResponse',
];
const METHODS = {
  'agent.v1.AgentService': ['Run', 'RunSSE', 'RunPoll', 'UploadConversationBlobs'],
  'aiserver.v1.BidiService': ['BidiAppend'],
};

function prune(full) {
  const keep = new Set(TYPES);
  const out = { cursor: { version: `${(full.cursor && full.cursor.version) || '?'} (subset for tests)` }, messages: {}, enums: {}, services: {} };
  const useEnum = (T) => { if (T && full.enums[T]) out.enums[T] = full.enums[T]; };
  for (const t of TYPES) {
    const m = full.messages[t];
    if (!m) throw new Error(`${t} is not in the schema`);
    const fields = m.fields.filter((f) => {
      if (f.kind === 'scalar') return true;
      if (f.kind === 'enum') return useEnum(f.T), true;
      if (f.kind === 'message') return keep.has(f.T);
      if (f.kind === 'map') {
        const V = f.V || {};
        if (V.kind === 'enum') useEnum(V.T);
        return V.kind !== 'message' || keep.has(V.T);
      }
      return false;
    });
    out.messages[t] = { ...m, fields };
  }
  for (const [svc, names] of Object.entries(METHODS)) {
    out.services[svc] = { methods: Object.fromEntries(names.map((n) => [n, full.services[svc].methods[n]])) };
  }
  return out;
}

if (require.main === module) {
  const full = process.argv[2] ? JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) : require('../../src/wire/schema.cjs').loadSchema();
  fs.writeFileSync(path.join(__dirname, 'agent-schema.json'), `${JSON.stringify(prune(full), null, 1)}\n`);
}

module.exports = { prune, TYPES };
