'use strict';

// The context of one chat as a Markdown file an agent can read: the breakdown by category, then
// every item's exact text. "Debug with Agent" writes it and points a new chat at it.

const fence = (text) => {
  const longest = Math.max(2, ...(text.match(/`+/g) || []).map((r) => r.length));
  const f = '`'.repeat(longest + 1);
  return `${f}text\n${text}\n${f}`;
};

const tokens = (n) => `~${Math.round(n || 0).toLocaleString('en-US')} tokens`;

function renderReport(ctx) {
  const out = [];
  const pct = ctx.maxTokens ? Math.round((ctx.totalUsedTokens / ctx.maxTokens) * 100) : 0;
  out.push(`# Context usage report: ${ctx.name}`, '');
  out.push(`- Chat id: ${ctx.composerId}`);
  if (ctx.model) out.push(`- Model: ${ctx.model}`);
  out.push(`- Tokens used: ${tokens(ctx.totalUsedTokens)} of ${tokens(ctx.maxTokens)} (${pct}% full)`);
  out.push(`- Prompt messages: ${ctx.messageCount}`);
  out.push('- Category sizes are Cursor\'s counts; item sizes are estimates (4 characters per token).', '');

  out.push('## Breakdown', '', '| Category | Tokens | Items |', '| --- | ---: | ---: |');
  for (const c of ctx.categories) out.push(`| ${c.label} | ${Math.round(c.estimatedTokens || 0).toLocaleString('en-US')} | ${c.items.length} |`);
  out.push('');

  for (const c of ctx.categories) {
    if (!c.items.length && !c.estimatedTokens) continue;
    out.push(`## ${c.label} (${tokens(c.estimatedTokens)})`, '');
    if (c.note) out.push(c.note, '');
    for (const item of c.items) section(out, item, 3);
  }
  return out.join('\n');
}

// A block with text (e.g. <rules>) holds its parts' text and its own around them: it is written
// whole, its parts listed above it. A part without text of its own is written part by part.
function section(out, item, level) {
  out.push(`${'#'.repeat(Math.min(level, 6))} ${item.label} (${tokens(item.estimatedTokens)})`, '');
  const parts = item.children || [];
  if (item.text === undefined && parts.length) {
    for (const child of parts) section(out, child, level + 1);
    return;
  }
  if (parts.length) out.push('Parts:', ...parts.map((p) => `- ${p.label} (${tokens(p.estimatedTokens)})`), '');
  if (item.text !== undefined) out.push(fence(item.text), '');
  else out.push(item.unavailable || '(text not stored)', '');
}

function debugPrompt({ name, composerId, reportPath, historyPath }) {
  return [
    `Look at the context usage of the Cursor agent chat "${name}" (id ${composerId}).`,
    `The full report, with the exact text of every part of its context (system prompt, tools, rules, skills, MCP, subagents, conversation), is in ${reportPath}.`,
    historyPath
      ? `The chat's recorded history is in ${historyPath}: chat.md is the readable conversation, transcript.md the raw one.`
      : 'The chat has no recorded history yet.',
    'Are there opportunities to reduce its context usage? Name the largest items, say which ones are mine to change (rules, skills, MCP servers, subagents, the way I prompt), and estimate what each change would save.',
  ].join('\n\n');
}

module.exports = { renderReport, debugPrompt };
