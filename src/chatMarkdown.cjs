'use strict';

// A recorded chat as a readable conversation (chat.md): what the user asked, what
// the agent said and did. The system prompt and the context Cursor injects into
// user messages (rules, skills, open files, reminders) are left out; transcript.md
// keeps them, raw. The context sent beside the prompt is linked, collapsed.

const { chatSection } = require('./sentContext.cjs');

const asText = (v) => (v === undefined || v === null ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, 2));

// The text inside every <tag>…</tag> block of `text` that opens at a line start.
function tagged(text, tag) {
  const re = new RegExp(`^<${tag}(?:\\s[^>]*)?>\\n?([\\s\\S]*?)\\n?</${tag}>`, 'gm');
  return [...text.matchAll(re)].map((m) => m[1].trim()).filter(Boolean);
}

function parts(message) {
  const c = message.content;
  if (typeof c === 'string') return [{ type: 'text', text: c }];
  return Array.isArray(c) ? c : [{ type: 'text', text: asText(c) }];
}

// A fence longer than any backtick run inside `text`.
function fenced(text, lang = '') {
  const longest = Math.max(2, ...(String(text).match(/`+/g) || []).map((r) => r.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang}\n${text}\n${fence}`;
}

// What a tool call worked on, for its one-line summary.
function toolHint(args) {
  if (!args || typeof args !== 'object') return '';
  const keys = ['description', 'command', 'path', 'target_file', 'file_path', 'pattern', 'query', 'glob_pattern', 'url', 'subagent_type'];
  const key = keys.find((k) => typeof args[k] === 'string' && args[k].trim());
  const hint = key ? args[key].trim().split('\n')[0] : '';
  return hint.length > 100 ? `${hint.slice(0, 99)}…` : hint;
}

const html = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function details(summary, body) {
  return `<details><summary>${summary}</summary>\n\n${body}\n\n</details>`;
}

// What a user message says, as [{ label, text }]: the user's own words, a
// subagent's task, a notification, Cursor's summary of the earlier conversation.
// Empty when it only carries context.
function userBlocks(message) {
  const text = parts(message).filter((p) => p.type === 'text').map((p) => p.text).join('\n\n');
  const blocks = [];
  for (const [tag, label] of [['summary', 'Summary'], ['user_query', 'User'], ['task', 'Task'], ['system_notification', 'Notification']]) {
    const found = tagged(text, tag);
    if (found.length) blocks.push({ label, text: found.join('\n\n') });
  }
  // Plain text without Cursor's tags was typed as is.
  if (!blocks.length && text.trim() && !/^\s*</.test(text)) blocks.push({ label: 'User', text: text.trim() });
  return blocks;
}

// Thinking the model's provider returned encrypted (redacted-reasoning): its size, decoded.
const encryptedBytes = (p) => Buffer.from(String(p.data || ''), 'base64').length;
const seconds = (ms) => (typeof ms === 'number' ? ` · ${ms < 1000 ? '<1' : Math.round(ms / 1000)} s` : '');

// meta: { name, composerId, model, workspace, createdAt, lastUpdatedAt }.
// messages: in first-seen order. subagents: [{ name, type, toolCallIds, folder }].
// thinking: aligned with messages, the readable thinking Cursor kept for each (history.cjs
// thinking.json): [{ text, durationMs, part, unplaced }], part the index of its reasoning part.
// sentContext: per message, the context recorded as sent with it (files under contextDir).
function chatMarkdown(meta, messages, { subagents = [], parent, thinking = [], sentContext = [], contextDir = 'context' } = {}) {
  const results = new Map();
  for (const m of messages) {
    if (m.role === 'tool') for (const p of parts(m)) if (p.toolCallId) results.set(p.toolCallId, p);
  }
  const spawned = (id) => subagents.filter((s) => id && (s.toolCallIds || []).some((c) => id.includes(c) || c.includes(id)));
  const subLink = (s) => (s.folder ? `[${s.name || 'Untitled subagent'}](subagents/${encodeURIComponent(s.folder)}/chat.md)` : s.name || 'Untitled subagent');

  const out = [`# ${meta.name || 'Untitled chat'}`, ''];
  if (parent) out.push(`Subagent of [${parent.name}](../../chat.md)${meta.subagentType ? ` (${meta.subagentType})` : ''}  `);
  if (meta.createdAt) out.push(`Started ${new Date(meta.createdAt).toISOString().replace('T', ' ').slice(0, 16)} UTC  `);
  if (meta.workspace) out.push(`Workspace \`${meta.workspace}\`  `);
  out.push(`Model ${meta.model || '?'} · Chat ${meta.composerId}`, '');

  let speaker;
  const say = (who, block) => {
    if (who !== speaker) out.push('---', '', `_**${who}**_`, '');
    speaker = who;
    out.push(block, '');
  };
  const agent = `Agent${meta.model ? ` (${meta.model})` : ''}`;
  messages.forEach((m, mi) => {
    const thoughts = thinking[mi] || [];
    const onPart = new Map(thoughts.filter((t) => t.part !== null && t.part !== undefined).map((t) => [t.part, t]));
    const loose = thoughts.filter((t) => !onPart.has(t.part));
    if (m.role === 'user') {
      const blocks = userBlocks(m);
      for (const b of blocks) {
        if (b.label === 'Summary') say('Earlier conversation', details('Summarized by Cursor', b.text));
        else if (b.label === 'Notification') say(b.label, `> ${b.text.replace(/\n/g, '\n> ')}`);
        // A subagent's prompt comes from the agent that spawned it.
        else say(parent && b.label === 'User' ? 'Task' : b.label, b.text);
      }
      for (const p of parts(m)) if (p.type === 'image') say('User', '_[image]_');
      if (sentContext[mi]) say('User', chatSection(sentContext[mi], contextDir));
    } else if (m.role === 'assistant') {
      for (const t of loose.filter((x) => !x.unplaced)) say(agent, details(`Thinking${seconds(t.durationMs)}`, t.text.trim()));
      parts(m).forEach((p, pi) => {
        const text = asText(p.text).trim();
        const t = onPart.get(pi);
        if (p.type === 'text' && text) say(agent, text);
        else if (p.type === 'reasoning' && (text || t)) say(agent, details(`Thinking${seconds(t && t.durationMs)}`, text || t.text.trim()));
        else if (p.type === 'redacted-reasoning') {
          // The model got this thinking encrypted; Cursor's turn step keeps what it showed as readable text.
          const size = `${encryptedBytes(p)} bytes`;
          say(agent, t
            ? details(`Thinking${seconds(t.durationMs)} <i>(sent to the model encrypted, ${size})</i>`, t.text.trim())
            : details(`Thinking <i>(encrypted, ${size})</i>`, '_Encrypted by the model\'s provider and passed back to it unread; Cursor kept no readable copy._'));
        } else if (p.type === 'tool-call') {
          const hint = toolHint(p.args);
          const result = results.get(p.toolCallId);
          const body = [`**Input**\n\n${fenced(asText(p.args), 'json')}`];
          if (result) body.push(`**Result**\n\n${fenced(asText(result.result))}`);
          say(agent, details(`Tool: <b>${html(p.toolName)}</b>${hint ? ` — ${html(hint)}` : ''}`, body.join('\n\n')));
          for (const s of spawned(p.toolCallId)) say(agent, `↳ Subagent: ${subLink(s)}${s.type ? ` (${s.type})` : ''}`);
        }
      });
    }
    for (const t of loose.filter((x) => x.unplaced)) {
      const why = t.source === 'bubble' ? 'its place in the chat is not known' : 'its message is not in the record';
      say(agent, details(`Thinking${seconds(t.durationMs)} <i>(${why})</i>`, t.text.trim()));
    }
  });
  return `${out.join('\n').trimEnd()}\n`;
}

module.exports = { chatMarkdown, userBlocks, toolHint, fenced };
