'use strict';

// Human views of a rebuilt conversation (conversation.cjs) and of a comparison (compare.cjs).
// Texts are clipped to `clip` characters, with the full length shown; clip 0/Infinity shows all.
// --json output (in cli.cjs) is never clipped.

const short = (id) => (id ? String(id).slice(0, 12) : '?');

function clipText(s, clip) {
  s = String(s);
  if (!clip || s.length <= clip) return s;
  return `${s.slice(0, clip)}… [${s.length - clip} more chars of ${s.length}; --full shows all]`;
}

function indent(s, pad) {
  return String(s).split('\n').map((l) => pad + l).join('\n');
}

const when = (t) => (t ? new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 19) : '?');

function eventLine(e, clip) {
  switch (e.kind) {
    case 'text':
    case 'thinking':
    case 'notice':
    case 'summary':
      return `${e.kind}${e.durationMs !== undefined ? ` (${e.durationMs} ms)` : ''} [${e.deltas} deltas, ${e.text.length} chars]\n${indent(clipText(e.text, clip), '    ')}`;
    case 'tool_args':
      return `tool args ${e.callId} [${e.deltas} deltas]\n${indent(clipText(e.text, clip), '    ')}`;
    case 'tool_call':
      return `tool call ${e.phase} ${e.callId}${e.modelCallId ? ` (model ${e.modelCallId})` : ''}: ${e.toolCall ? Object.keys(e.toolCall).filter((k) => !k.startsWith('_')).join(',') : '?'}`;
    case 'exec':
      return `exec #${e.id} ${e.op}${e.args && e.args.tool_call_id ? ` for ${e.args.tool_call_id}` : ''}${e.answered ? '' : ' (no client result)'}`;
    case 'exec_result':
      return `exec result #${e.id} ${e.op}\n${indent(clipText(JSON.stringify(e.result), clip), '    ')}`;
    case 'kv_get_blob_args':
      return `kv get #${e.id} ${short(e.blobId)}${e.missingOnClient ? ' (client had none)' : e.answered ? '' : ' (unanswered)'}`;
    case 'kv_set_blob_args':
      return `kv set #${e.id} ${short(e.blobId)} (${e.size} B)`;
    case 'kv_get_blob_result':
      return `kv blob #${e.id} ${short(e.blobId)} (${e.hasData ? `${e.size} B` : 'none'}${e.error ? `, error ${e.error}` : ''})`;
    case 'checkpoint':
      return `checkpoint #${e.index}: ${e.rootPrompt} prompt messages, ${e.turns} turns`;
    case 'run_request':
      return `run_request conversation ${e.conversationId} model ${e.model || '?'} action ${e.action || '-'}; state: ${e.rootPrompt} prompt messages, ${e.turns} turns`;
    case 'turn_ended':
      return `turn ended ${JSON.stringify(e.usage)}`;
    case 'action':
      return `action ${e.action}`;
    default:
      return `${e.kind}${e.value !== undefined ? ` ${clipText(JSON.stringify(e.value), clip)}` : ''}`;
  }
}

function renderConversation(conv, { clip = 400 } = {}) {
  const out = [`== conversation ${conv.conversationId}: ${conv.runs.length} runs${conv.uploads.length ? `, ${conv.uploads.length} blob uploads` : ''}${conv.related.length ? `, related: ${conv.related.map((r) => r.flow.rpc.split('/').pop()).join(', ')}` : ''}`];
  conv.runs.forEach((run, i) => {
    out.push('', `-- run ${i + 1}: ${run.flow.day} ${run.flow.id} (${run.transport}) ${when(run.flow.started)} model ${run.model || '?'}${run.truncated ? ' TRUNCATED' : ''}`);
    if (run.userMessage) out.push(`   user text:\n${indent(clipText(run.userMessage.text || '', clip), '     ')}`);
    const blobs = [...run.blobs.values()];
    out.push(`   blobs on the wire: ${blobs.length} (${blobs.filter((b) => b.sources.some((s) => s.side === 'client')).length} from client, ${blobs.filter((b) => b.sources.some((s) => s.side === 'server')).length} from server, ${blobs.filter((b) => !b.sha256Ok).length} hash mismatches)`);
    out.push('   client:');
    for (const e of run.client) out.push(indent(`${e.where} ${eventLine(e, clip)}`, '     '));
    out.push('   server:');
    for (const e of run.server) out.push(indent(`${e.where} ${eventLine(e, clip)}`, '     '));
    for (const n of run.notes) out.push(`   note: ${n}`);
    for (const e of run.errors) out.push(`   error (${e.side} ${e.where}): ${JSON.stringify(e.error)}`);
  });
  return out.join('\n');
}

function renderDiff(d, clip) {
  if (!d) return '';
  if (d.same) return 'identical';
  const lines = d.lines.map((l) => `${l.op === '-' ? '-wire ' : l.op === '+' ? '+rec  ' : '      '}${clipText(l.text, clip)}`);
  return `first difference at char ${d.firstDifference} (${d.prefix} chars before, ${d.suffix} after are equal)\n${lines.join('\n')}`;
}

function findingText(f, clip) {
  const { kind, assumption, diff, ...rest } = f;
  const fields = Object.entries(rest).map(([k, v]) => {
    if (typeof v === 'string' && (v.length > 80 || v.includes('\n'))) return `${k}:\n${indent(clipText(v, clip), '    ')}`;
    const s = JSON.stringify(v);
    return `${k}: ${clipText(s, clip)}`;
  });
  if (diff) fields.push(`diff:\n${indent(renderDiff(diff, clip), '    ')}`);
  return `! ${kind}${assumption ? ` [${assumption}]` : ''}${fields.length ? `\n${indent(fields.join('\n'), '    ')}` : ''}`;
}

// Findings in order; a kind with many { path, text } items prints one line per item.
function renderFindings(list, clip) {
  const out = [];
  const byKind = new Map();
  for (const f of list) byKind.set(f.kind, [...(byKind.get(f.kind) || []), f]);
  for (const [kind, fs] of byKind) {
    if (fs.length > 3 && fs.every((f) => f.path !== undefined && typeof f.text === 'string')) {
      const chars = fs.reduce((n, f) => n + f.text.length, 0);
      const matches = fs.reduce((m, f) => ({ ...m, [f.match || '-']: (m[f.match || '-'] || 0) + 1 }), {});
      out.push(`! ${kind}${fs[0].assumption ? ` [${fs[0].assumption}]` : ''}: ${fs.length} items, ${chars} chars, match ${JSON.stringify(matches)}`);
      const lineClip = clip ? Math.min(clip, 100) : 0;
      for (const f of fs) out.push(`    ${f.path} (${f.text.length} chars${f.match ? `, ${f.match}` : ''}): ${JSON.stringify(clipText(f.text, lineClip))}`);
    } else for (const f of fs) out.push(findingText(f, clip));
  }
  return out;
}

function renderComparison(r, { clip = 400 } = {}) {
  const out = [`== conversation ${r.conversationId}`];
  out.push(r.chat ? `   recorded as "${r.chat.name}" (${r.chat.dir}): ${r.chat.seen} messages seen, ${r.chat.snapshots} snapshots` : '   not recorded by the plugin');
  r.runs.forEach((run, i) => {
    out.push('', `-- run ${i + 1}: ${run.flow.day} ${run.flow.id} (${run.transport}) model ${run.model || '?'} action ${run.action || '-'}`);
    if (run.prompt) {
      out.push(`   prompt: ${run.prompt.before} -> ${run.prompt.after} messages, ${run.prompt.checkpoints} checkpoints`);
      for (const s of run.prompt.states) out.push(`     ${s.state}: ${s.messages} messages, ${s.snapshot ? `= snapshot ${s.snapshot}` : 'no matching snapshot'}`);
    }
    if (run.added && run.added.length) out.push(`   added: ${run.added.map((a) => `${short(a.id)} ${a.role}[${a.parts.join(',')}]`).join('  ')}`);
    if (run.summary) out.push(`   summary: ${JSON.stringify(run.summary)}`);
    for (const l of renderFindings(run.findings, clip)) out.push(indent(l, '   '));
    if (!run.findings.length) out.push('   no differences');
  });
  if (r.subagents && r.subagents.length) out.push('', `subagents on the wire: ${r.subagents.map((s) => `${s.toolCallId} -> ${s.subagentId} (${s.from})`).join(', ')}`);
  if (r.findings.length) {
    out.push('', 'conversation:');
    for (const l of renderFindings(r.findings, clip)) out.push(indent(l, '   '));
  }
  out.push('', 'plugin assumptions:');
  for (const a of r.assumptions) out.push(`   ${a.verdict.toUpperCase().padEnd(12)} ${a.id}${a.findings ? ` (${a.findings}: ${a.kinds.join(', ')})` : ''}\n${' '.repeat(16)}${a.statement}`);
  return out.join('\n');
}

module.exports = { renderConversation, renderComparison, renderDiff, clipText };
