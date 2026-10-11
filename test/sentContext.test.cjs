'use strict';

// The context Cursor sends beside the prompt: its rebuild from rule / skill / agent / MCP files
// (contextSources) and its record in the history (sentContext).

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const rc = require('../src/requestContext.cjs');
const sources = require('../src/contextSources.cjs');
const history = require('../src/history.cjs');

const APP = sources.DEFAULT_APP_DIR;
const haveCursor = fs.existsSync(path.join(APP, 'node_modules', 'gray-matter'));

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function tmp(t) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sent-context-')));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

// A home and a git workspace with every kind of source.
function sourcesFixture(root) {
  const home = path.join(root, 'home');
  const ws = path.join(home, 'work', 'repo');
  write(path.join(home, '.cursor', 'rules', 'always.mdc'), '---\nalwaysApply: true\n---\nAlways do this.\n');
  write(path.join(home, '.cursor', 'rules', 'ts.mdc'), '---\nglobs: "*.ts, src/{a,b}/*.ts"\nalwaysApply: false\n---\nFor TypeScript.\n');
  write(path.join(home, '.cursor', 'rules', 'fetched.mdc'), '---\ndescription: Read when asked about style\n---\nThe style guide.\n');
  write(path.join(home, 'work', 'AGENTS.md'), 'Work-wide agent notes.\n');
  write(path.join(ws, '.cursor', 'rules', 'repo.mdc'), '---\nalwaysApply: true\n---\nRepo rule.\n');
  write(path.join(ws, 'pkg', 'AGENTS.md'), 'Nested agent notes.\n');
  write(path.join(home, '.cursor', 'agents', 'helper.md'), '---\nname: helper\ndescription: Helps.\nreadonly: true\n---\nYou help.\n');
  write(path.join(home, '.claude', 'agents', 'helper.md'), '---\nname: helper\n---\nShadowed by the .cursor one.\n');
  write(path.join(home, '.cursor', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Deploys the app.\n---\nSteps.\n');
  write(path.join(home, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Same skill, other folder.\n---\nSteps.\n');
  write(path.join(home, '.cursor', 'skills', 'manual', 'SKILL.md'), '---\ndescription: Only on request.\ndisable-model-invocation: true\n---\nx\n');
  write(path.join(home, '.cursor', 'skills', 'broken', 'SKILL.md'), '---\nname: broken\n---\nNo description.\n');
  write(path.join(home, '.cursor', 'skills-cursor', 'builtin', 'SKILL.md'), '---\ndescription: Cursor\'s own.\n---\nx\n');
  const slug = ws.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  const mcps = path.join(home, '.cursor', 'projects', slug, 'mcps', 'srv');
  write(path.join(mcps, 'SERVER_METADATA.json'), JSON.stringify({ serverIdentifier: 'srv', serverName: 'Server' }));
  write(path.join(mcps, 'INSTRUCTIONS.md'), '  Use the server well.  \n');
  write(path.join(mcps, 'tools', 'zeta.json'), JSON.stringify({ name: 'zeta', description: 'Z.', arguments: { type: 'object', properties: {} } }));
  write(path.join(mcps, 'tools', 'alpha.json'), JSON.stringify({ name: 'alpha', description: 'A.' }));
  cp.spawnSync('git', ['init', '-q', ws]);
  return { home, ws };
}

test('rebuilds rules, skills, subagents and MCP tools from their files, as Cursor lists them', { skip: !haveCursor && 'needs Cursor\'s gray-matter' }, (t) => {
  const { home, ws } = sourcesFixture(tmp(t));
  const { parts, dynamic } = sources.buildParts([ws], { appDir: APP, home });
  const rel = (p) => path.relative(home, p);

  // The folder and its ancestors (rules dir, then AGENTS.md, level by level), then nested files.
  // Within a rules dir the order is ripgrep's.
  const listed = parts.rules.rules.map((r) => [rel(r.full_path), Object.keys(r.type)[0]]);
  assert.deepStrictEqual([listed.slice(0, 2), listed.slice(2, 5).sort(), listed.slice(5)], [
    [['work/repo/.cursor/rules/repo.mdc', 'global'], ['work/AGENTS.md', 'global']],
    [['.cursor/rules/always.mdc', 'global'], ['.cursor/rules/fetched.mdc', 'agent_fetched'], ['.cursor/rules/ts.mdc', 'file_globbed']],
    [['work/repo/pkg/AGENTS.md', 'global']],
  ]);
  const byName = (n) => parts.rules.rules.find((r) => r.full_path.endsWith(n));
  assert.deepStrictEqual(byName('ts.mdc').type, { file_globbed: { globs: ['*.ts', 'src/{a,b}/*.ts'] } });
  assert.strictEqual(byName('ts.mdc').frontmatter, '---\nglobs: "*.ts, src/{a,b}/*.ts"\nalwaysApply: false\n---');
  assert.strictEqual(byName('ts.mdc').content, 'For TypeScript.');
  // An agent-fetched rule goes without its content.
  assert.deepStrictEqual([byName('fetched.mdc').content, byName('fetched.mdc').type], ['', { agent_fetched: { description: 'Read when asked about style' } }]);
  assert.strictEqual(byName('work/AGENTS.md').content, 'Work-wide agent notes.\n');

  // Cursor's own skills first; one per name across .cursor/.claude; model-disabled ones left out.
  assert.deepStrictEqual(parts.skills.agent_skills.map((s) => [rel(s.full_path), s.description, s.parse_error]), [
    ['.cursor/skills-cursor/builtin/SKILL.md', 'Cursor\'s own.', undefined],
    ['.cursor/skills/broken/SKILL.md', '', 'Description is required'],
    ['.cursor/skills/deploy/SKILL.md', 'Deploys the app.', undefined],
  ]);
  assert.ok(parts.skills.agent_skills.every((s) => s.content === ''));

  assert.deepStrictEqual(parts.subagents.custom_subagents.map((s) => [rel(s.full_path), s.name, s.permission_mode, s.prompt, s.source, s.model]), [
    ['.cursor/agents/helper.md', 'helper', 'CUSTOM_SUBAGENT_PERMISSION_MODE_READONLY', 'You help.', 'user', 'inherit'],
  ]);

  // Only Cursor's built-in servers' tools go in the request in full; the others are listed by name (below).
  assert.deepStrictEqual(parts.mcps.tools, []);
  assert.deepStrictEqual(parts.mcps.mcp_meta_tool_options.mcp_descriptors.map((d) => d.tools.map((x) => x.tool_name).sort()), [['alpha', 'zeta']]);
  assert.deepStrictEqual(parts.mcps.mcp_instructions, [{ server_name: 'Server', instructions: 'Use the server well.', server_identifier: 'srv' }]);
  const [descriptor] = parts.mcps.mcp_file_system_options.mcp_descriptors;
  assert.deepStrictEqual([path.relative(home, descriptor.folder_path).split(path.sep).slice(0, 2), descriptor.server_use_instructions], [['.cursor', 'projects'], 'Use the server well.']);

  assert.deepStrictEqual(dynamic.git_repos, [{ path: ws }]);
  assert.deepStrictEqual(dynamic.env.workspace_paths, [ws]);
  // Every part encodes.
  assert.deepStrictEqual(Object.keys(rc.encodeParts(parts)), rc.PARTS);
});

test('workspace folders come from the chat\'s folder or .code-workspace file', (t) => {
  const d = tmp(t);
  const file = path.join(d, 'ws', 'a.code-workspace');
  write(file, '{\n  // folders\n  "folders": [{ "path": "../one" }, { "path": "/abs/two" }, { "uri": "file:///abs/three" },],\n}\n');
  assert.deepStrictEqual(sources.workspaceFolders({ configPath: { fsPath: file } }), [path.join(d, 'one'), '/abs/two', '/abs/three']);
  assert.deepStrictEqual(sources.workspaceFolders({ uri: { fsPath: '/x/y' } }), ['/x/y']);
  assert.deepStrictEqual(sources.workspaceFolders(undefined), []);
});

// A Cursor DB with one chat in `ws`, its messages as agentKv blobs.
function chatDb(ws) {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB)');
  const put = (k, v) => db.prepare('INSERT INTO cursorDiskKV VALUES (?, ?)').run(k, v);
  const save = (id, lastUpdatedAt, messages, extra = {}) => {
    const state = Buffer.concat(messages.flatMap((m) => {
      const raw = Buffer.from(JSON.stringify(m));
      const hash = crypto.createHash('sha256').update(raw).digest();
      put(`agentKv:blob:${hash.toString('hex')}`, raw);
      return [Buffer.from([0x0a, 0x20]), hash];
    }));
    put(`composerData:${id}`, JSON.stringify({ name: `Chat ${id}`, lastUpdatedAt, conversationState: `~${state.toString('base64')}`, workspaceIdentifier: { uri: { fsPath: ws } }, ...extra }));
  };
  return { db, put, save };
}

const hashOf = (m) => crypto.createHash('sha256').update(JSON.stringify(m)).digest('hex');

test('the recorder keeps the context sent with each new user message, once, and links it from chat.md', { skip: !haveCursor && 'needs Cursor\'s gray-matter' }, (t) => {
  const root = tmp(t);
  const { home, ws } = sourcesFixture(root);
  const dir = path.join(root, 'history');
  const { db, put, save } = chatDb(ws);
  const sys = { role: 'system', content: 'You are an agent.' };
  const q1 = { role: 'user', content: '<user_query>\nfirst\n</user_query>' };
  const a1 = { role: 'assistant', content: [{ type: 'text', text: 'one' }] };
  const summary = { role: 'user', content: '<summary>\nearlier\n</summary>' };
  const q2 = { role: 'user', content: '<user_query>\nsecond\n</user_query>' };
  const now = Date.now();
  const options = { sentContext: { enabled: true, appDir: APP, home, now } };

  save('c1', now - 1000, [sys, q1, a1]);
  history.recordChat(db, 'c1', dir, undefined, options);
  // A Cursor copy of a part under its id counts as kept by Cursor.
  const subagentsId = JSON.parse(fs.readFileSync(path.join(dir, 'chats', 'Chat c1', 'meta.json'), 'utf8')).sentContext[0].parts.subagents.id;
  put(`agentKv:blob:${subagentsId}`, fs.readFileSync(path.join(dir, 'context', `${subagentsId}.bin`)));
  save('c1', now, [sys, summary, q2]);
  history.recordChat(db, 'c1', dir, undefined, options);
  // Chats last updated long ago get nothing: the files may have changed since.
  save('old', now - 3600e3, [sys, q1]);
  history.recordChat(db, 'old', dir, undefined, options);

  const meta = JSON.parse(fs.readFileSync(path.join(dir, 'chats', 'Chat c1', 'meta.json'), 'utf8'));
  assert.deepStrictEqual(meta.sentContext.map((e) => e.messages), [[hashOf(q1)], [hashOf(q2)]], 'user turns only, not the summary');
  const [first, second] = meta.sentContext;
  assert.deepStrictEqual(Object.keys(first.parts), rc.PARTS);
  assert.deepStrictEqual(second.parts, first.parts, 'unchanged files: the same parts');
  assert.deepStrictEqual([first.storedByCursor, second.storedByCursor], [[], ['subagents']]);
  assert.strictEqual(first.parts.rules.items, 6);
  // Stored once, by sha256, with a readable copy (context/*.json are the caches: plugin ids, annotations).
  const files = fs.readdirSync(path.join(dir, 'context')).filter((f) => !f.endsWith('.json')).sort();
  assert.deepStrictEqual(files, rc.PARTS.flatMap((k) => [`${first.parts[k].id}.bin`, `${first.parts[k].id}.md`]).sort());
  for (const k of rc.PARTS) {
    const data = fs.readFileSync(path.join(dir, 'context', `${first.parts[k].id}.bin`));
    assert.strictEqual(crypto.createHash('sha256').update(data).digest('hex'), first.parts[k].id);
  }
  const rulesMd = fs.readFileSync(path.join(dir, 'context', `${first.parts.rules.id}.md`), 'utf8');
  assert.match(rulesMd, /<details><summary><code>[^<]*always\.mdc<\/code> — global<\/summary>/);
  assert.match(rulesMd, /Always do this\./);
  const snap = JSON.parse(fs.readFileSync(path.join(dir, 'chats', 'Chat c1', 'snapshots', `${now}.json`), 'utf8'));
  assert.deepStrictEqual(snap.sentContext.messages, [hashOf(q2)]);

  const md = fs.readFileSync(path.join(dir, 'chats', 'Chat c1', 'chat.md'), 'utf8');
  const sections = md.split('<details><summary>Context sent with this message, rebuilt (not in the prompt)</summary>');
  assert.strictEqual(sections.length, 3, 'one collapsed section per user message');
  assert.ok(md.indexOf('first') < md.indexOf(sections[1].slice(0, 40)));
  assert.ok(md.includes(`](../../context/${first.parts.rules.id}.md): 6 items`));
  assert.match(md, /Subagent definitions\]\([^)]*\): 1 items, \d+ bytes, `[0-9a-f]{12}` — Cursor kept a copy with this id/);
  assert.ok(!fs.existsSync(path.join(dir, 'chats', 'Chat old', 'meta.json')) || !JSON.parse(fs.readFileSync(path.join(dir, 'chats', 'Chat old', 'meta.json'), 'utf8')).sentContext);

  // The inspector panel shows the latest one as a category of its own, not counted in the usage.
  const category = require('../src/sentContext.cjs').panelCategory(dir, meta);
  assert.deepStrictEqual([category.estimatedTokens, category.items.map((i) => i.label)], [0, ['Rules (6)', 'Agent skills (3)', 'Subagent definitions (1)', 'MCP tools and instructions (2)']]);
  assert.match(category.items[0].text, /Always do this\./);

  // Without the option, nothing is rebuilt.
  const plain = path.join(root, 'plain');
  history.recordChat(db, 'c1', plain);
  assert.ok(!fs.existsSync(path.join(plain, 'context')));
});

test('a subagent chat keeps the context sent with its messages, the same parts as its root', { skip: !haveCursor && 'needs Cursor\'s gray-matter' }, (t) => {
  const root = tmp(t);
  const { home, ws } = sourcesFixture(root);
  const dir = path.join(root, 'history');
  const { db, save } = chatDb(ws);
  const sys = { role: 'system', content: 'You are an agent.' };
  const brief = { role: 'user', content: '<user_query>\nreview the cases\n</user_query>' };
  const now = Date.now();
  const options = { sentContext: { enabled: true, appDir: APP, home, now } };

  save('parent', now - 2000, [sys, { role: 'user', content: '<user_query>\nstart\n</user_query>' }], { subagentComposerIds: ['sub'] });
  save('sub', now - 1000, [sys, brief], { subagentInfo: { parentComposerId: 'parent', toolCallId: 'tool_1', subagentTypeName: 'explore' } });
  history.recordChat(db, 'parent', dir, undefined, options);

  const sub = JSON.parse(fs.readFileSync(path.join(dir, 'chats', 'Chat parent', 'subagents', 'Chat sub', 'meta.json'), 'utf8'));
  const parent = JSON.parse(fs.readFileSync(path.join(dir, 'chats', 'Chat parent', 'meta.json'), 'utf8'));
  assert.deepStrictEqual(sub.sentContext.map((e) => e.messages), [[hashOf(brief)]], 'the brief is the user message a subagent is sent with');
  assert.deepStrictEqual(Object.keys(sub.sentContext[0].parts), rc.PARTS);
  assert.strictEqual(sub.sentContext[0].parts.rules.items, 6);
  // Cursor sends a subagent the same parts it sends the root: the same ids, so the same bytes.
  assert.deepStrictEqual(sub.sentContext[0].parts, parent.sentContext[0].parts);
  // Stored once for the chat and its subagent.
  assert.ok(fs.existsSync(path.join(dir, 'context', `${sub.sentContext[0].parts.rules.id}.bin`)));
});

test('a subagent with no workspace of its own is rebuilt from its parent\'s folders, as it ran there', { skip: !haveCursor && 'needs Cursor\'s gray-matter' }, (t) => {
  const root = tmp(t);
  const { home, ws } = sourcesFixture(root);
  const dir = path.join(root, 'history');
  const { db, save } = chatDb(ws);
  const sys = { role: 'system', content: 'You are an agent.' };
  const brief = { role: 'user', content: '<user_query>\nreview the cases\n</user_query>' };
  const now = Date.now();
  const options = { sentContext: { enabled: true, appDir: APP, home, now } };

  save('parent', now - 2000, [sys, { role: 'user', content: '<user_query>\nstart\n</user_query>' }], { subagentComposerIds: ['sub'] });
  // Cursor stores no workspace for some subagents (10 of 1,092 in one install); the parent's is the one they ran in.
  save('sub', now - 1000, [sys, brief], { workspaceIdentifier: undefined, subagentInfo: { parentComposerId: 'parent', toolCallId: 'tool_1', subagentTypeName: 'explore' } });
  history.recordChat(db, 'parent', dir, undefined, options);

  const sub = JSON.parse(fs.readFileSync(path.join(dir, 'chats', 'Chat parent', 'subagents', 'Chat sub', 'meta.json'), 'utf8'));
  const parent = JSON.parse(fs.readFileSync(path.join(dir, 'chats', 'Chat parent', 'meta.json'), 'utf8'));
  assert.ok(parent.sentContext[0].workspaceFolders.length > 0, 'the parent has folders');
  assert.deepStrictEqual(sub.sentContext[0].workspaceFolders, parent.sentContext[0].workspaceFolders);
  assert.deepStrictEqual(sub.sentContext[0].parts, parent.sentContext[0].parts);
});

// Cursor's MCP servers as the request lists them: the built-in browser's tools in full, the other
// servers by name only, with the annotations the servers gave (here: from env.toolAnnotations).
test('MCP tools: built-in servers in full, the others by name with their annotations, in folder order', (t) => {
  const root = tmp(t);
  const home = path.join(root, 'home');
  const ws = path.join(home, 'work', 'repo');
  const slug = ws.replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  const mcps = path.join(home, '.cursor', 'projects', slug, 'mcps');
  write(path.join(mcps, 'srv', 'SERVER_METADATA.json'), JSON.stringify({ serverIdentifier: 'srv', serverName: 'Server' }));
  write(path.join(mcps, 'srv', 'tools', 'zeta.json'), JSON.stringify({ name: 'zeta', description: 'Z.', arguments: { type: 'object', properties: {} } }));
  write(path.join(mcps, 'srv', 'tools', 'alpha.json'), JSON.stringify({ name: 'alpha', description: 'A.', arguments: { type: 'object', properties: {} } }));
  write(path.join(mcps, 'cursor-ide-browser', 'SERVER_METADATA.json'), JSON.stringify({ serverIdentifier: 'cursor-ide-browser', serverName: 'cursor-ide-browser' }));
  write(path.join(mcps, 'cursor-ide-browser', 'tools', 'browse.json'), JSON.stringify({ name: 'browse', description: 'Browses.', arguments: { type: 'object' } }));
  fs.mkdirSync(ws, { recursive: true });
  const toolAnnotations = new Map([[sources.annotationKey('srv', 'alpha'), '{"readOnlyHint":true,"destructiveHint":false}']]);
  const { parts } = sources.buildParts([ws], { home, appDir: path.join(root, 'no-app'), toolAnnotations });

  assert.deepStrictEqual(parts.mcps.tools.map((x) => [x.name, x.provider_identifier, x.description, x.input_schema_json]), [
    ['cursor-ide-browser-browse', 'cursor-ide-browser', 'Browses.', '{"type":"object"}'],
  ]);
  // Meta-tool descriptors: Cursor's own servers by name, names only, the annotations where known.
  const meta = parts.mcps.mcp_meta_tool_options.mcp_descriptors;
  assert.deepStrictEqual(meta.map((d) => d.server_identifier), ['srv', 'cursor-ide-browser']);
  assert.deepStrictEqual(meta[0].tools.map((x) => x.tool_name).sort(), ['alpha', 'zeta']);
  assert.deepStrictEqual(meta[0].tools.find((x) => x.tool_name === 'alpha'), { tool_name: 'alpha', annotations_json: '{"readOnlyHint":true,"destructiveHint":false}' });
  assert.deepStrictEqual(meta[0].tools.find((x) => x.tool_name === 'zeta'), { tool_name: 'zeta' });
  assert.deepStrictEqual(meta[1].tools, [{ tool_name: 'browse' }]);
  // File-system descriptors: the folders in directory order, with the definition files and no annotations.
  const order = [];
  const h = fs.opendirSync(mcps);
  for (let e = h.readSync(); e; e = h.readSync()) order.push(e.name);
  h.closeSync();
  assert.deepStrictEqual(parts.mcps.mcp_file_system_options.mcp_descriptors.map((d) => d.server_identifier), order);
  const fsSrv = parts.mcps.mcp_file_system_options.mcp_descriptors.find((d) => d.server_identifier === 'srv');
  assert.deepStrictEqual(fsSrv.tools.map((x) => Object.keys(x)), [['tool_name', 'definition_path'], ['tool_name', 'definition_path']]);
  // Without the database the annotations are not known, and the note says so.
  const bare = sources.buildParts([ws], { home, appDir: path.join(root, 'no-app') });
  assert.ok(bare.notes.some((n) => /annotations not read/.test(n)));
  assert.strictEqual(bare.parts.mcps.mcp_meta_tool_options.mcp_descriptors[0].tools[0].annotations_json, undefined);
  // Every part encodes, with the annotations in the MCP tool descriptor's field.
  assert.ok(rc.encodeParts(parts).mcps.data.includes(Buffer.from('{"readOnlyHint":true,"destructiveHint":false}')));
});

test('tool annotations are read from the meta-tool parts Cursor kept: the last stored value is used, none is dropped', { skip: !haveCursor && 'needs Cursor\'s gray-matter' }, (t) => {
  const root = tmp(t);
  const { home, ws } = sourcesFixture(root);
  const { db, put, save } = chatDb(ws);
  const kept = (value) => rc.encode(rc.PART_TYPES.mcps, { mcp_meta_tool_options: { enabled: true, mcp_descriptors: [{ server_identifier: 'srv', server_name: 'Server', tools: [{ tool_name: 'alpha', annotations_json: value }, { tool_name: 'zeta' }] }] } });
  // Two older parts say readOnlyHint, then the server changed it: the newest part says the opposite.
  // The newest value is used (the most frequent one is the old one); the old one stays in the cache.
  put('agentKv:blob:a1', kept('{"readOnlyHint":true}'));
  put('agentKv:blob:a2', kept('{"readOnlyHint":true}'));
  put('agentKv:blob:a3', kept('{"readOnlyHint":false}'));
  save('c', Date.now(), [{ role: 'user', content: 'plain question' }]);
  const dir = path.join(root, 'history');
  history.recordChat(db, 'c', dir, undefined, { sentContext: { enabled: true, appDir: APP, home } });
  const entry = JSON.parse(fs.readFileSync(path.join(dir, 'chats', 'Chat c', 'meta.json'), 'utf8')).sentContext[0];
  const meta = rc.decodePart('mcps', fs.readFileSync(path.join(dir, 'context', `${entry.parts.mcps.id}.bin`))).mcp_meta_tool_options.mcp_descriptors;
  assert.deepStrictEqual(meta.find((d) => d.server_identifier === 'srv').tools.map((x) => [x.tool_name, x.annotations_json]).sort(), [['alpha', '{"readOnlyHint":false}'], ['zeta', undefined]]);
  assert.ok(entry.notes.some((n) => /1 MCP tools had different annotations/.test(n)));
  const known = JSON.parse(fs.readFileSync(path.join(dir, 'context', 'tool-annotations.json'), 'utf8'));
  const values = known.tools[sources.annotationKey('srv', 'alpha')];
  assert.deepStrictEqual(Object.entries(values).map(([v, e]) => [v, e.count]).sort(), [['{"readOnlyHint":false}', 1], ['{"readOnlyHint":true}', 2]]);
  assert.ok(known.lastRowid > 0);
  assert.deepStrictEqual(fs.readdirSync(path.join(dir, 'context')).filter((f) => f.endsWith('.tmp')), []);
});

test('an annotation file from before (one string per tool) keeps its value', { skip: !haveCursor && 'needs Cursor\'s gray-matter' }, (t) => {
  const root = tmp(t);
  const { home, ws } = sourcesFixture(root);
  const { db, save } = chatDb(ws);
  save('c', Date.now(), [{ role: 'user', content: 'plain question' }]);
  const dir = path.join(root, 'history');
  write(path.join(dir, 'context', 'tool-annotations.json'), JSON.stringify({ scannedAt: 0, tools: { [sources.annotationKey('srv', 'alpha')]: '{"readOnlyHint":true}' }, conflicts: 0 }));
  history.recordChat(db, 'c', dir, undefined, { sentContext: { enabled: true, appDir: APP, home } });
  const known = JSON.parse(fs.readFileSync(path.join(dir, 'context', 'tool-annotations.json'), 'utf8'));
  assert.deepStrictEqual(known.tools[sources.annotationKey('srv', 'alpha')], { '{"readOnlyHint":true}': { count: 1, lastRowid: 0 } });
});

test('plugin database ids are taken from a part Cursor kept', { skip: !haveCursor && 'needs Cursor\'s gray-matter' }, (t) => {
  const root = tmp(t);
  const { home, ws } = sourcesFixture(root);
  const rev = 'a'.repeat(40);
  const plugin = path.join(home, '.cursor', 'plugins', 'cache', 'market', 'tool', rev);
  write(path.join(plugin, '.cache-complete'), '');
  write(path.join(plugin, '.cursor-plugin', 'plugin.json'), JSON.stringify({ name: 'tool', skills: './skills/' }));
  write(path.join(plugin, 'skills', 'use-tool', 'SKILL.md'), '---\nname: use-tool\ndescription: Uses the tool.\n---\nx\n');
  write(path.join(plugin, 'skills', 'v1', 'use-tool', 'SKILL.md'), '---\ndescription: An older copy, not listed.\n---\nx\n');
  const { db, put, save } = chatDb(ws);
  const kept = rc.encode(rc.PART_TYPES.skills, { agent_skills: [{ full_path: '/x', description: 'd', git_remote_origin: `plugin:tool-${rev}`, plugin: 'tool', marketplace: 'market', plugin_id: '7', marketplace_id: '3' }] });
  put(`agentKv:blob:${rc.sha256(kept)}`, kept);
  save('c', Date.now(), [{ role: 'user', content: 'plain question' }]);
  const dir = path.join(root, 'history');
  history.recordChat(db, 'c', dir, undefined, { sentContext: { enabled: true, appDir: APP, home } });
  const entry = JSON.parse(fs.readFileSync(path.join(dir, 'chats', 'Chat c', 'meta.json'), 'utf8')).sentContext[0];
  const skills = rc.decodePart('skills', fs.readFileSync(path.join(dir, 'context', `${entry.parts.skills.id}.bin`))).agent_skills.filter((s) => s.plugin);
  assert.deepStrictEqual(skills.map((s) => [path.relative(plugin, s.full_path), s.plugin_id, s.marketplace_id, s.git_remote_origin]), [[path.join('skills', 'use-tool', 'SKILL.md'), '7', '3', `plugin:tool-${rev}`]]);
  assert.ok(!(entry.notes || []).some((n) => /plugin database ids/.test(n)));
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'context', 'plugin-ids.json'), 'utf8'))[`tool-${rev}`].pluginId, '7');
});

test('credentials in URLs and well-known tokens are replaced, an ssh user is not', () => {
  const { redactText, redactValue } = require('../src/redact.cjs');
  const token = `ghp_${'a1'.repeat(18)}`;
  assert.deepStrictEqual(redactText(`https://kat:${token}@github.com/o/r.git`), { text: 'https://[redacted]@github.com/o/r.git', count: 1 });
  assert.deepStrictEqual(redactText('clone https://user:pa%40ss@host.example/x and http://tok@h/y').text, 'clone https://[redacted]@host.example/x and http://[redacted]@h/y');
  for (const kept of ['ssh://git@github.com/o/r.git', 'git@github.com:o/r.git', 'https://github.com/o/r.git', 'https://[redacted]@h/p', 'mail me at a@b.c']) {
    assert.deepStrictEqual(redactText(kept), { text: kept, count: 0 }, kept);
  }
  assert.strictEqual(redactText('ssh://git:secret@host/r').text, 'ssh://[redacted]@host/r');
  assert.strictEqual(redactText(`token ${token}, key AKIA${'A'.repeat(16)}, sk-ant-${'x'.repeat(30)}`).text, 'token [redacted], key [redacted], [redacted]');
  assert.deepStrictEqual(redactValue({ a: [{ b: `x ${token}` }, 3], c: 'clean' }), { value: { a: [{ b: 'x [redacted]' }, 3], c: 'clean' }, count: 1, paths: ['a[0].b'] });
});

// Every file under `dir`, recursively.
const allFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(path.join(dir, e.name)) : [path.join(dir, e.name)]));

test('credentials in the context are never stored: the part keeps the sent id and says what was replaced', { skip: !haveCursor && 'needs Cursor\'s gray-matter' }, (t) => {
  const root = tmp(t);
  const { home, ws } = sourcesFixture(root);
  const token = `ghp_${'Zq'.repeat(18)}`;
  cp.spawnSync('git', ['remote', 'add', 'origin', `https://kat:${token}@github.com/o/r.git`], { cwd: ws });
  write(path.join(ws, '.cursor', 'rules', 'deploy.mdc'), `---\nalwaysApply: true\n---\nPush to https://ci:${token}@git.example.com/r.git\n`);
  const { db, save } = chatDb(ws);
  save('c', Date.now(), [{ role: 'user', content: '<user_query>\ngo\n</user_query>' }]);
  const dir = path.join(root, 'history');
  const options = { enabled: true, appDir: APP, home };
  history.recordChat(db, 'c', dir, undefined, { sentContext: options });

  for (const f of allFiles(dir)) assert.ok(!fs.readFileSync(f).includes(token), `no credential in ${path.relative(dir, f)}`);
  const entry = JSON.parse(fs.readFileSync(path.join(dir, 'chats', 'Chat c', 'meta.json'), 'utf8')).sentContext[0];
  assert.deepStrictEqual(entry.dynamic.git_repos, [{ path: ws, remote_url: 'https://[redacted]@github.com/o/r.git' }]);
  assert.deepStrictEqual(entry.dynamicRedacted, { count: 1, paths: ['git_repos[0].remote_url'] });

  // The id is the sha256 of the part as rebuilt, credentials included: the one Cursor's is compared with.
  const sent = rc.encodeParts(sources.buildParts([ws], { appDir: APP, home }).parts);
  const rules = entry.parts.rules;
  assert.strictEqual(rules.id, sent.rules.id);
  assert.strictEqual(rules.redacted.count, 1);
  assert.match(rules.redacted.paths[0], /^rules\[\d+\]\.content$/);
  assert.ok(!entry.parts.skills.redacted);
  assert.ok(!fs.existsSync(path.join(dir, 'context', `${rules.id}.bin`)), 'no file claims to be the sent bytes');
  const stored = require('../src/sentContext.cjs').loadPart(dir, 'rules', rules.id);
  assert.strictEqual(stored.redacted, true);
  assert.ok(stored.part.rules.some((r) => r.content === 'Push to https://[redacted]@git.example.com/r.git'));
  assert.match(fs.readFileSync(path.join(dir, 'context', `${rules.id}.md`), 'utf8'), /Credentials replaced by `\[redacted\]` in 1 place \(rules\[\d+\]\.content\)/);
  const md = fs.readFileSync(path.join(dir, 'chats', 'Chat c', 'chat.md'), 'utf8');
  assert.match(md, /Rules\]\([^)]*\): \d+ items, \d+ bytes, `[0-9a-f]{12}` — 1 credential redacted/);
  assert.match(md, /Credentials replaced by `\[redacted\]` in 1 place \(git_repos\[0\]\.remote_url\): the stored copy differs from what was rebuilt there only\./);
});

test('a user message whose blob Cursor writes late still gets its context', { skip: !haveCursor && 'needs Cursor\'s gray-matter' }, (t) => {
  const root = tmp(t);
  const { home, ws } = sourcesFixture(root);
  const { db, put, save } = chatDb(ws);
  const q = { role: 'user', content: '<user_query>\nlate\n</user_query>' };
  save('c', Date.now(), [{ role: 'system', content: 'You are an agent.' }, q]);
  const blob = db.prepare('SELECT value FROM cursorDiskKV WHERE key = ?').get(`agentKv:blob:${hashOf(q)}`).value;
  db.prepare('DELETE FROM cursorDiskKV WHERE key = ?').run(`agentKv:blob:${hashOf(q)}`);
  const dir = path.join(root, 'history');
  const options = { sentContext: { enabled: true, appDir: APP, home } };
  const meta = () => JSON.parse(fs.readFileSync(path.join(dir, 'chats', 'Chat c', 'meta.json'), 'utf8'));
  history.recordChat(db, 'c', dir, undefined, options);
  assert.strictEqual(meta().sentContext, undefined, 'not known as a user message yet');
  // The chat is otherwise unchanged: the blob alone arrives.
  put(`agentKv:blob:${hashOf(q)}`, blob);
  history.recordChat(db, 'c', dir, undefined, options);
  assert.deepStrictEqual(meta().sentContext.map((e) => e.messages), [[hashOf(q)]]);
  assert.match(fs.readFileSync(path.join(dir, 'chats', 'Chat c', 'chat.md'), 'utf8'), /Context sent with this message, rebuilt/);
});
