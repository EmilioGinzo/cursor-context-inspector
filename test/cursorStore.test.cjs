'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const store = require('../src/cursorStore.cjs');

function fixture({ withTree, schema2 }) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  const put = (k, v) => db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(k, v);

  const system = 'You are an agent.\n<tone>be brief</tone>\n<dynamic_tools>\nUse GetDynamicTools.\n</dynamic_tools>';
  const preamble =
    '<user_info>\nOS: linux\n</user_info>\n' +
    '<rules>\n<always_applied_workspace_rules>\n<always_applied_workspace_rule name="Style">Use tabs.</always_applied_workspace_rule>\n</always_applied_workspace_rules>\n</rules>\n' +
    '<agent_skills>\n<agent_skill fullPath="/s/a/SKILL.md">Skill A</agent_skill>\n</agent_skills>\n' +
    '<available_subagent_types>\n- explore: reads code\n</available_subagent_types>';
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: preamble },
    { role: 'user', content: [{ type: 'text', text: '<timestamp>now</timestamp>\n<user_query>\nshow me the context\n</user_query>' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool-call', toolName: 'Shell', args: { command: 'ls' } }] },
    { role: 'tool', content: [{ type: 'tool-result', toolName: 'Shell', result: 'a.txt' }] },
  ];

  const header = [];
  for (const m of messages) {
    const raw = Buffer.from(JSON.stringify(m));
    const hash = crypto.createHash('sha256').update(raw).digest();
    put(`agentKv:blob:${hash.toString('hex')}`, raw);
    header.push(Buffer.from([0x0a, 0x20]), hash);
  }
  const ruleStart = preamble.indexOf('<always_applied_workspace_rule ');
  const ruleEnd = preamble.indexOf('</always_applied_workspace_rules>') - 1;
  const composer = {
    name: 'Fixture chat',
    lastUpdatedAt: 1,
    conversationState: `~${Buffer.concat(header).toString('base64')}`,
    promptTokenBreakdown: {
      totalUsedTokens: 500,
      maxTokens: 1000,
      categories: [{ id: 'system_prompt', label: 'System prompt', estimatedTokens: 20 }, { id: 'tools', label: 'Tool definitions', estimatedTokens: 300 }],
    },
  };
  if (withTree) {
    composer.promptContextUsageTree = {
      schemaVersion: 1,
      nodes: [
        { id: 'category:rules', kind: 'category', categoryId: 'rules', label: 'Rules' },
        { id: 'category:tools', kind: 'category', categoryId: 'tools', label: 'Tool definitions' },
        { id: 'category:conversation', kind: 'category', categoryId: 'conversation', label: 'Conversation' },
        { id: 'r1', parentId: 'category:rules', kind: 'rule', label: 'Style', estimatedTokens: 5, contentAvailable: true,
          source: { sourceType: 'root_prompt_message', messageIndex: 1, contentPath: 'content', startOffset: ruleStart, endOffset: ruleEnd } },
        { id: 'tool:0', parentId: 'category:tools', kind: 'tool_definition', label: 'Shell', estimatedTokens: 300, contentAvailable: false },
        { id: 'pair', parentId: 'category:conversation', kind: 'tool_call_pair', label: 'Shell Tool', contentAvailable: false },
        { id: 'pair:call', parentId: 'pair', kind: 'tool_call', label: 'Call', estimatedTokens: 4, contentAvailable: true,
          source: { sourceType: 'root_prompt_message', messageIndex: 3, contentPath: 'content[1].args', startOffset: 0, endOffset: 22 } },
        { id: 'pair:result', parentId: 'pair', kind: 'tool_result', label: 'Result', estimatedTokens: 2, contentAvailable: true,
          source: { sourceType: 'root_prompt_message', messageIndex: 4, contentPath: 'content[0].result', startOffset: 0, endOffset: 5 } },
      ],
    };
  }
  if (schema2) {
    // Cursor 3.25: no category nodes, and only the tool definitions, which carry no text.
    composer.promptContextUsageTree = {
      schemaVersion: 2,
      nodes: [
        { id: 'tool:0', parentId: 'category:tools', kind: 'tool_definition', label: 'Shell', categoryId: 'tools', estimatedTokens: 120, characterCount: 800, contentAvailable: false },
        { id: 'tool:1', parentId: 'category:tools', kind: 'tool_definition', label: 'Read', categoryId: 'tools', estimatedTokens: 60, characterCount: 400, contentAvailable: false },
      ],
    };
  }
  put('composerData:chat-1', JSON.stringify(composer));
  return db;
}

const byId = (ctx, id) => ctx.categories.find((c) => c.id === id);

test('parsed mode splits the stored prompt into categories', () => {
  const ctx = store.loadContext(fixture({ withTree: false }), 'chat-1');
  assert.strictEqual(ctx.messageCount, 5);
  const system = byId(ctx, 'system_prompt');
  assert.match(system.items[0].text, /You are an agent/);
  assert.doesNotMatch(system.items[0].text, /GetDynamicTools/);
  assert.match(byId(ctx, 'mcp').items[0].text, /GetDynamicTools/);

  const rules = byId(ctx, 'rules').items[0];
  assert.strictEqual(rules.children[0].children[0].label, 'Style');
  assert.match(rules.children[0].children[0].text, /Use tabs/);
  assert.strictEqual(byId(ctx, 'skills').items[0].children[0].label, '/s/a/SKILL.md');
  assert.match(byId(ctx, 'subagents').items[0].text, /explore/);

  const convo = byId(ctx, 'conversation').items.map((i) => i.label);
  assert.deepStrictEqual(convo, ['User message (context preamble)', 'User: show me the context', 'Agent message', 'Shell result']);
  assert.match(byId(ctx, 'tools').note, /not stored/);
  assert.strictEqual(byId(ctx, 'system_prompt').estimatedTokens, 20, 'official token count is kept');
});

test('tree mode slices exact spans, including pretty-printed tool args', () => {
  const ctx = store.loadContext(fixture({ withTree: true }), 'chat-1');
  assert.ok(ctx.hasTree);
  assert.strictEqual(byId(ctx, 'rules').source, 'cursor-tree');
  assert.strictEqual(byId(ctx, 'rules').items[0].text, '<always_applied_workspace_rule name="Style">Use tabs.</always_applied_workspace_rule>');
  const pair = byId(ctx, 'conversation').items[0];
  assert.strictEqual(pair.children[0].text, JSON.stringify({ command: 'ls' }, null, 2));
  assert.strictEqual(pair.children[1].text, 'a.txt');
  const tool = byId(ctx, 'tools').items[0];
  assert.strictEqual(tool.label, 'Shell');
  assert.strictEqual(tool.text, undefined);
  assert.match(tool.unavailable, /not stored/);
  // Text no tree node covers is attributed by tag and marked untracked.
  const system = byId(ctx, 'system_prompt');
  assert.strictEqual(system.source, 'uncovered-text');
  assert.ok(system.items.every((i) => i.untracked));
  assert.match(system.items.map((i) => i.text).join(''), /You are an agent/);
  const mcp = byId(ctx, 'mcp').items;
  assert.strictEqual(mcp.length, 1);
  assert.match(mcp[0].text, /^<dynamic_tools>[\s\S]*GetDynamicTools[\s\S]*<\/dynamic_tools>$/);
  assert.strictEqual(byId(ctx, 'skills').items[0].label, '<agent_skills>', 'uncovered preamble sections land in their category');
});

test('a schema 2 tree lists the tool definitions and the prompt is parsed', () => {
  const ctx = store.loadContext(fixture({ schema2: true }), 'chat-1');
  const tools = byId(ctx, 'tools');
  // Cursor's own counts, not scaled to the category total (300 here; they sum to 180).
  assert.deepStrictEqual(tools.items.map((i) => [i.label, i.estimatedTokens, i.characterCount]), [['Shell', 120, 800], ['Read', 60, 400]]);
  assert.match(tools.items[0].unavailable, /not stored/);
  assert.strictEqual(tools.note, undefined);
  assert.strictEqual(byId(ctx, 'rules').source, 'parsed');
  assert.strictEqual(byId(ctx, 'rules').items[0].children[0].children[0].label, 'Style');
  assert.deepStrictEqual(byId(ctx, 'conversation').items.map((i) => i.label), ['User message (context preamble)', 'User: show me the context', 'Agent message', 'Shell result']);
  assert.ok(ctx.categories.every((c) => c.items.every((i) => !i.untracked)));
});

test('tree mode accounts for every non-blank character of the prompt', () => {
  const ctx = store.loadContext(fixture({ withTree: true }), 'chat-1');
  const shown = [];
  const walk = (items) => items.forEach((i) => (i.children && !i.untracked ? walk(i.children) : i.text && shown.push(i.text)));
  ctx.categories.forEach((c) => walk(c.items));
  const all = shown.join('\n');
  for (const m of ctx.rawMessages) {
    for (const line of m.text.split('\n')) {
      if (line.startsWith('[tool ') || !line.trim()) continue;
      assert.ok(all.includes(line), `missing from categories: ${line}`);
    }
  }
});

test('listComposers returns chats newest first', () => {
  const chats = store.listComposers(fixture({ withTree: true }));
  assert.strictEqual(chats.length, 1);
  assert.strictEqual(chats[0].name, 'Fixture chat');
  assert.strictEqual(chats[0].hasTree, true);
});
