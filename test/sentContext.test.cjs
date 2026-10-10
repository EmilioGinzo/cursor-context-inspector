'use strict';

// The context Cursor sends beside the prompt: its rebuild from rule / skill / agent / MCP files
// (contextSources) and its record in the history (sentContext).

const test = require('node:test');
const assert = require('node:assert');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const rc = require('../src/requestContext.cjs');
const sources = require('../src/contextSources.cjs');

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

  const tools = parts.mcps.tools.map((x) => [x.name, x.provider_identifier, x.input_schema_json]);
  assert.deepStrictEqual(tools.sort(), [['srv-alpha', 'Server', undefined], ['srv-zeta', 'Server', '{"type":"object","properties":{}}']]);
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
