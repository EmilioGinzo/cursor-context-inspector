'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { renderReport, debugPrompt } = require('../src/contextReport.cjs');

const ctx = {
  composerId: 'chat-1',
  name: 'Fixture chat',
  model: 'm',
  totalUsedTokens: 500,
  maxTokens: 1000,
  messageCount: 3,
  categories: [
    { id: 'system_prompt', label: 'System prompt', estimatedTokens: 20, items: [{ label: 'System message', estimatedTokens: 20, text: 'You are an agent.\n```js\nx\n```' }] },
    { id: 'tools', label: 'Tool definitions', estimatedTokens: 300, items: [{ label: 'Shell', estimatedTokens: 300, unavailable: 'Not stored on this machine.' }] },
    {
      id: 'rules', label: 'Rules', estimatedTokens: 30,
      items: [{ label: '<rules>', estimatedTokens: 30, text: '<rules>\nIntro.\n<rule>Use tabs.</rule>\n</rules>', children: [{ label: 'Style', estimatedTokens: 5, text: '<rule>Use tabs.</rule>' }] }],
    },
    { id: 'conversation', label: 'Conversation', estimatedTokens: 10, items: [{ label: 'Shell Tool', estimatedTokens: 10, children: [{ label: 'Call', estimatedTokens: 4, text: '{"command":"ls"}' }, { label: 'Result', estimatedTokens: 6, text: 'a.txt' }] }] },
    { id: 'summarized_conversation', label: 'Summarized conversation', estimatedTokens: 0, items: [] },
  ],
};

test('the report has the breakdown and every exact text', () => {
  const md = renderReport(ctx);
  assert.match(md, /^# Context usage report: Fixture chat/);
  assert.match(md, /50% full/);
  assert.match(md, /\| Tool definitions \| 300 \| 1 \|/);
  assert.ok(md.includes('````text\nYou are an agent.\n```js\nx\n```\n````'), 'a text holding a fence gets a longer one');
  assert.match(md, /### Shell \(~300 tokens\)\n\nNot stored on this machine\./);
  // A block with text is written whole, its parts listed; a part without text is written part by part.
  assert.match(md, /Parts:\n- Style \(~5 tokens\)/);
  assert.ok(md.includes('<rules>\nIntro.\n<rule>Use tabs.</rule>\n</rules>'));
  assert.match(md, /#### Call \(~4 tokens\)\n\n```text\n\{"command":"ls"\}\n```/);
  assert.doesNotMatch(md, /## Summarized conversation \(/, 'an empty category has no section');
});

test('the prompt links the report and the recorded history', () => {
  const p = debugPrompt({ name: 'Fixture chat', composerId: 'chat-1', reportPath: '/r/chat-1.md', historyPath: '/h/chats/Fixture chat' });
  assert.match(p, /"Fixture chat" \(id chat-1\)/);
  assert.match(p, /\/r\/chat-1\.md/);
  assert.match(p, /\/h\/chats\/Fixture chat: chat\.md/);
  assert.match(debugPrompt({ name: 'x', composerId: 'y', reportPath: '/r' }), /no recorded history yet/);
});
