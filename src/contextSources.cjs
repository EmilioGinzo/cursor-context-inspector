'use strict';

// Rebuilds the four request-context parts (see requestContext.cjs) from their sources, the way
// Cursor's client builds them (Cursor 3.x: cursor-agent-exec's LocalCursorRulesService,
// AgentSkillsCursorRulesService, subagents services and MCP file-system snapshots, then the
// workbench's WorkbenchRequestContextExecutor). Cursor does not store what it sent, so this is the
// only local way to get it; whether the result is byte-exact can only be told by its sha256 (the
// ids the client sends, seen with `cursor-context wire compare`, or a copy Cursor kept in agentKv).
//
// It reads what Cursor reads: rules (.cursor/rules/**/*.mdc of each workspace folder and its
// ancestors, AGENTS.md / CLAUDE.md / CLAUDE.local.md, .cursorrules, nested ones in git repos),
// skills (SKILL.md under .cursor/skills, .claude/skills, .codex/skills, .grok/skills,
// .agents/skills of the home and each workspace, ~/.cursor/skills-cursor, installed plugins),
// subagents (.cursor/agents, .claude/agents, .grok/agents) and the MCP servers' tool snapshots
// Cursor writes under ~/.cursor/projects/<workspace>/mcps. It uses Cursor's own ripgrep and
// gray-matter (from the app folder) so files are found in the same order and parsed the same way.
//
// Not reproducible from disk, so possibly different from what Cursor sent: plugin and marketplace
// database ids (only Cursor's server knows them; the caller may pass ones found in parts Cursor
// kept, see sentContext.cjs), tool annotations (the caller may pass ones found the same way), the
// order of MCP servers in the meta-tool descriptors (the order they connected in), team rules,
// Agent Store skills, and anything that changed between the send and the rebuild. Nor the order of
// rule files: ripgrep lists them with two threads, so its order differs from run to run (ripwalk
// takes the most frequent order of a few runs). Nor the order of a rule edited while Cursor ran:
// Cursor keeps its list and moves a changed rule to its end (LocalCursorRulesService.reloadAtPath).
// Files .cursorignore excludes are not left out here.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

const DEFAULT_APP_DIR = '/usr/share/cursor/resources/app';
const DESCRIPTION_MAX = 1536;
const THIRD_PARTY = true; // Cursor's "third-party extensibility" (.claude, .codex, CLAUDE.md...), on by default

// --- file discovery ------------------------------------------------------------------------

const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'dist', 'build']);

// Cursor's own directory walk (subagents, skills): depth-first from a stack, dot folders and build
// folders skipped, symlinks followed once, the result sorted with localeCompare.
function walk(root, include, containmentRoot) {
  const out = [];
  const stack = [{ dir: root, depth: 0 }];
  const seen = new Set();
  let contain = null;
  if (containmentRoot !== undefined) {
    try {
      contain = fs.realpathSync(containmentRoot);
    } catch {
      return [];
    }
  }
  while (stack.length) {
    const { dir, depth } = stack.pop();
    if (depth > 10) continue;
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      continue;
    }
    if (contain !== null) {
      const rel = path.relative(contain, real);
      if (rel !== '' && (rel.startsWith('..') || path.isAbsolute(rel))) continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      let isDir = e.isDirectory();
      let isFile = e.isFile();
      if (e.isSymbolicLink()) {
        try {
          const st = fs.statSync(p);
          isDir = st.isDirectory();
          isFile = st.isFile();
        } catch {
          continue;
        }
      }
      if (isDir) {
        if (!e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) stack.push({ dir: p, depth: depth + 1 });
      } else if (isFile && include(e.name)) out.push(p);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

// Cursor's "ripwalk": its bundled ripgrep listing files, in ripgrep's order. Returns relative paths,
// or undefined when ripgrep is not available. Ripgrep walks with two threads, so the order can vary
// from run to run (Cursor lists once and keeps that order): the most frequent of a few runs is taken,
// a guess only the part's sha256 can confirm. When the runs disagreed, a note says so.
const RIPWALK_RUNS = 5;

function ripwalk(env, { root, includeGlobs = [], excludeGlobs = [], follow = false }) {
  if (!env.rg) return undefined;
  const args = ['--files', '--hidden', '--no-require-git', '--no-config', '--color=never', '--threads', '2'];
  if (follow) args.push('--follow');
  for (const g of includeGlobs) args.push('--iglob', g);
  for (const g of excludeGlobs) args.push('--iglob', `!${g}`);
  const seen = new Map();
  for (let i = 0; i < RIPWALK_RUNS; i++) {
    const r = cp.spawnSync(env.rg, args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 30 });
    if (r.error || (r.status !== 0 && r.status !== 1)) return [];
    seen.set(r.stdout, (seen.get(r.stdout) || 0) + 1);
    if (seen.size === 1 && i >= 1 && r.stdout.split('\n').length <= 2) break; // one file or none: no order to vote on
  }
  const ranked = [...seen].sort((a, b) => b[1] - a[1]);
  if (ranked.length > 1) env.notes.push(`ripgrep listed ${root} in ${ranked.length} orders over ${RIPWALK_RUNS} runs: the most frequent (${ranked[0][1]}) was taken`);
  return ranked[0][0].split('\n').filter(Boolean);
}

function gitRoot(dir) {
  const r = cp.spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' });
  return r.status === 0 && !r.error ? r.stdout.trim() : undefined;
}

const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};
const isDir = (p) => {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
};
const read = (p) => fs.readFileSync(p, 'utf8');

// --- frontmatter -------------------------------------------------------------------------

// Cursor's own .mdc frontmatter reader (not YAML): keys, quoted values, `globs:` lists, `metadata:`.
function unquote(v) {
  const t = v.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  return (t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")) ? t.slice(1, -1) : t;
}

const LIST_KEYS = new Set(['metadata.environments', 'metadata.disabledEnvironments', 'metadata.scopedTo']);

function parseMdc(text) {
  const t = text.trimStart();
  if (!t.startsWith('---')) return null;
  const chunks = t.split('---').filter(Boolean);
  if (chunks.length < 2) return null;
  const head = chunks[0].trim();
  const body = chunks.slice(1).join('---').trim();
  const fm = {};
  let section = null;
  let listKey = null;
  for (const raw of head.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      let v = item[1].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (Array.isArray(fm[listKey])) fm[listKey].push(v);
      continue;
    }
    const indented = line.startsWith('  ') || line.startsWith('\t');
    if (section && indented) {
      const s = line.trim();
      const i = s.indexOf(':');
      if (i === -1) continue;
      const key = `${section}.${s.slice(0, i).trim()}`;
      const value = s.slice(i + 1).trim();
      if (value === '') {
        fm[key] = [];
        listKey = key;
      } else {
        fm[key] = LIST_KEYS.has(key) ? String(unquote(value)).split(',').map((x) => x.trim()).filter(Boolean) : unquote(value);
        listKey = null;
      }
      continue;
    }
    section = null;
    listKey = null;
    const i = line.indexOf(':');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim();
    if (value === '' && key === 'metadata') {
      section = key;
      continue;
    }
    if (key === 'globs' && value === '') {
      fm.globs = [];
      listKey = 'globs';
      continue;
    }
    const u = unquote(value);
    fm[key] = LIST_KEYS.has(key) ? String(u).split(',').map((x) => x.trim()).filter(Boolean) : u;
  }
  return { frontmatter: fm, rawFrontmatter: `---\n${head}\n---`, body };
}

// Globs as a list: a string splits at commas outside braces.
function globList(v) {
  if (typeof v === 'string') {
    const out = [];
    let start = 0;
    let depth = 0;
    for (let i = 0; i < v.length; i++) {
      const c = v[i];
      if (c === '{') depth++;
      else if (c === '}' && depth > 0) depth--;
      else if (c === ',' && depth === 0) {
        const g = v.slice(start, i).trim();
        if (g) out.push(g);
        start = i + 1;
      }
    }
    const g = v.slice(start).trim();
    if (g) out.push(g);
    return out.length ? out : undefined;
  }
  if (Array.isArray(v)) {
    const out = v.filter((x) => typeof x === 'string').map((x) => x.trim()).filter(Boolean);
    return out.length ? out : undefined;
  }
  return undefined;
}

function stringList(v) {
  if (Array.isArray(v)) {
    const out = v.filter((x) => typeof x === 'string' && x.length > 0);
    return out.length ? out : undefined;
  }
  if (typeof v === 'string') {
    const out = v.split(',').map((x) => x.trim()).filter((x) => x.length > 0);
    return out.length ? out : undefined;
  }
  return undefined;
}

// --- rules -------------------------------------------------------------------------------

const MARKDOWN_RULES = THIRD_PARTY ? ['CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md'] : ['AGENTS.md'];
const NESTED_EXCLUDES = ['**/node_modules/**', '**/.git/**', '**/.turbo/**', '**/.next/**', '**/.cache/**', '**/.pnpm/**', '**/.yarn/**', '**/dist/**', '**/build/**',
  '**/out/**', '**/target/**', '**/.vscode/**', '**/.idea/**', '**/venv/**', '**/__pycache__/**', '**/logs/**', '**/tmp/**', '**/temp/**'];

function mdcRule(file) {
  try {
    const parsed = parseMdc(read(file));
    return parsed ? [{ path: file, ...parsed }] : [];
  } catch {
    return [];
  }
}

function markdownRule(file) {
  return isFile(file) ? [{ path: file, frontmatter: { alwaysApply: true }, body: read(file) }] : [];
}

function rulesDirectory(env, dir) {
  const root = path.join(dir, '.cursor', 'rules');
  if (!isDir(root)) return [];
  const files = ripwalk(env, { root, includeGlobs: ['**/*.mdc'], follow: true })
    ?? walk(root, (n) => n.endsWith('.mdc')).map((f) => path.relative(root, f));
  return files.flatMap((f) => mdcRule(path.join(root, f)));
}

// Rules and agent files in sub-folders of a git workspace (Cursor's NestedExtensibilityService).
// One walk per folder and environment: rules and skills both use it.
function nested(env, root) {
  env.nested = env.nested || new Map();
  if (!env.nested.has(root)) env.nested.set(root, nestedWalk(env, root));
  return env.nested.get(root);
}

function nestedWalk(env, root) {
  const out = { rules: [], markdown: [], skills: [] };
  if (path.resolve(root) === path.resolve(env.home) || !gitRoot(root)) return out;
  const include = ['*/**/.cursor/**', '*/**/.agents/**', '*/**/AGENTS.md'];
  if (THIRD_PARTY) include.push('*/**/.claude/**', '*/**/.codex/**', '*/**/.grok/**', '*/**/CLAUDE.md', '*/**/CLAUDE.local.md');
  for (const line of ripwalk(env, { root, includeGlobs: include, excludeGlobs: NESTED_EXCLUDES, follow: true }) || []) {
    const rel = line.replace(/\\/g, '/');
    const name = path.posix.basename(rel);
    const abs = path.resolve(root, line);
    if (['AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md'].includes(name)) {
      if (name === 'AGENTS.md' || THIRD_PARTY) out.markdown.push(abs);
    } else if (/[/\\]\.cursor[/\\]rules[/\\]/i.test(rel) && name.endsWith('.mdc')) out.rules.push(abs);
    else if (name === 'SKILL.md' && SKILL_ROOTS.some((r) => (THIRD_PARTY || !r.thirdParty) && r.pattern.test(rel))) out.skills.push(abs);
  }
  return out;
}

function toCursorRule(e) {
  let type;
  if (e.frontmatter.alwaysApply === true) type = { global: {} };
  else {
    const globs = globList(e.frontmatter.globs);
    if (globs && globs.length) type = { file_globbed: { globs } };
    else if (typeof e.frontmatter.description === 'string' && e.frontmatter.description.trim().length) type = { agent_fetched: { description: e.frontmatter.description.slice(0, DESCRIPTION_MAX) } };
    else type = { manually_attached: {} };
  }
  const list = (k) => (Array.isArray(e.frontmatter[k]) ? e.frontmatter[k] : []);
  return {
    full_path: e.path, content: e.body, type, environments: list('metadata.environments'), disabled_environments: list('metadata.disabledEnvironments'),
    scoped_to: list('metadata.scopedTo'), frontmatter: e.rawFrontmatter ?? '',
  };
}

// One workspace folder: .cursorrules, then the folder and each ancestor (rules dir, markdown rules),
// then nested rules; one entry per path.
function folderRules(env, folder) {
  const dir = path.resolve(folder);
  const found = [];
  const cursorrules = path.join(gitRoot(dir) || dir, '.cursorrules');
  if (isFile(cursorrules)) found.push({ path: cursorrules, frontmatter: { alwaysApply: true }, body: read(cursorrules) });
  for (let d = dir; ;) {
    found.push(...rulesDirectory(env, d));
    for (const name of MARKDOWN_RULES) found.push(...markdownRule(path.join(d, name)));
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  const n = nested(env, dir);
  found.push(...n.rules.flatMap(mdcRule), ...n.markdown.flatMap(markdownRule));
  const byPath = new Map();
  for (const e of found) byPath.set(e.path, e);
  return [...byPath.values()].map(toCursorRule);
}

// Cursor's dedupe key: the same file under .cursor, .claude, .codex, .grok or .agents of one root.
function dedupeKey(file) {
  const t = file.replace(/\\/g, '/');
  const low = t.toLowerCase();
  for (const [marker, n] of [['/.cursor/', 9], ['/.claude/', 9], ['/.codex/', 8], ['/.grok/', 7], ['/.agents/', 9]]) {
    const i = low.indexOf(marker);
    if (i !== -1) return `${t.slice(0, i)}::${t.slice(i + n)}`;
  }
  return file;
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((x) => {
    const k = dedupeKey(x.full_path);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// An agent-fetched rule's content is not sent, unless it is a custom mode (mode, icon, color, reminder).
function frontmatterValue(text, key) {
  const line = text.split(/\r?\n/).find((l) => new RegExp(`^\\s*${key}\\s*:`).test(l));
  const raw = line && line.replace(new RegExp(`^\\s*${key}\\s*:\\s*`), '');
  if (!raw) return undefined;
  let quote;
  let v = raw;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if ((c === '"' || c === "'") && (i === 0 || raw[i - 1] !== '\\')) quote = quote === c ? undefined : quote ?? c;
    else if (c === '#' && quote === undefined) {
      v = raw.slice(0, i);
      break;
    }
  }
  v = v.trim();
  const m = v.match(/^(['"])(.*)\1$/);
  return m ? m[2].trim() : v;
}

function isCustomMode(content) {
  const m = content.match(/^\s*---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return false;
  const head = m[1] || '';
  return String(frontmatterValue(head, 'mode')).toLowerCase() === 'true' && ['icon', 'color', 'reminder'].every((k) => (frontmatterValue(head, k) || '').length > 0);
}

// --- skills ------------------------------------------------------------------------------

const SKILL_DIRS = [
  { configDir: '.cursor', subdir: 'skills', thirdParty: false },
  { configDir: '.claude', subdir: 'skills', thirdParty: true },
  { configDir: '.codex', subdir: 'skills', thirdParty: true },
  { configDir: '.grok', subdir: 'skills', thirdParty: true },
  { configDir: '.agents', subdir: 'skills', thirdParty: false },
];
const BUILTIN_SKILLS = { configDir: '.cursor', subdir: 'skills-cursor' };
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SKILL_ROOTS = [...SKILL_DIRS, { ...BUILTIN_SKILLS, thirdParty: false }].map((d) => ({ ...d, pattern: new RegExp(`[/\\\\]${escapeRe(d.configDir)}[/\\\\]${escapeRe(d.subdir)}[/\\\\]`, 'i') }));
const CODEX_SYSTEM_SKILLS = new Set(['imagegen', 'openai-docs', 'opneai-docs', 'plugin-creator', 'skill-creator', 'skill-installer']);
const userSkillDirs = (home) => SKILL_DIRS.filter((d) => THIRD_PARTY || !d.thirdParty).map((d) => path.join(home, d.configDir, d.subdir));

// Skill files Cursor ignores: below a dot folder inside a skills dir, or Codex's own system skills.
function ignoredSkill(file) {
  const parts = file.replace(/\\/g, '/').split('/').filter(Boolean);
  const i = parts.findIndex((p, k) => SKILL_ROOTS.some((r) => r.configDir === p && r.subdir === parts[k + 1]));
  if (i !== -1 && parts.slice(i + 2).some((p) => p.startsWith('.'))) return true;
  const c = parts.lastIndexOf('.codex');
  if (c === -1 || parts[c + 1] !== 'skills') return false;
  const last = parts.at(-1);
  const name = last === 'SKILL.md' ? parts.at(-2) : last;
  return name !== undefined && CODEX_SYSTEM_SKILLS.has(name);
}

function loadSkill(env, file) {
  let real = file;
  try {
    real = fs.realpathSync(file);
  } catch {
    /* keep the path */
  }
  try {
    const content = read(file);
    const parsed = env.matter(content);
    return { file, real, content, parsed, data: parsed.data || {} };
  } catch (e) {
    return { file, real, error: e instanceof Error ? e.message : String(e) };
  }
}

function skillSurfaces(data) {
  const s = data.metadata && data.metadata.surfaces;
  return Array.isArray(s) ? s : typeof s === 'string' ? s.split(',').map((x) => x.trim()).filter(Boolean) : [];
}

function toSkill(s) {
  const d = s.data;
  const description = typeof d.description === 'string' ? d.description.slice(0, DESCRIPTION_MAX) : '';
  return {
    full_path: s.file, content: s.content, description, globs: globList(d.paths ?? d.globs) ?? [], parse_error: description ? undefined : 'Description is required',
    environments: stringList(d.environments ?? (d.metadata && d.metadata.environments)) ?? [],
    disabled_environments: stringList(d['disabled-environments'] ?? (d.metadata && d.metadata.disabledEnvironments)) ?? [],
    scoped_to: stringList((d.metadata && d.metadata.scopedTo) ?? d['metadata.scopedTo']) ?? [],
    disable_model_invocation: d['disable-model-invocation'] === true,
  };
}

// A skill is also a rule: always applied, or fetched by the agent (dropped later, see rulesPart).
function skillRule(s) {
  const d = s.data;
  const fm = frontmatterString(s);
  const base = { full_path: s.file, frontmatter: fm, environments: stringList(d.environments ?? (d.metadata && d.metadata.environments)) ?? [], disabled_environments: stringList(d['disabled-environments'] ?? (d.metadata && d.metadata.disabledEnvironments)) ?? [], scoped_to: stringList((d.metadata && d.metadata.scopedTo) ?? d['metadata.scopedTo']) ?? [] };
  if (d.alwaysApply === true) return { ...base, content: s.content, type: { global: {} } };
  const description = typeof d.description === 'string' ? d.description.slice(0, DESCRIPTION_MAX) : undefined;
  if (description) return { ...base, content: s.content, type: { agent_fetched: { description } } };
  return { full_path: s.file, parse_error: 'Description is required', frontmatter: fm, scoped_to: base.scoped_to, type: { agent_fetched: {} } };
}

// The frontmatter as Cursor keeps it: the raw block, or the parsed data written back.
function frontmatterString(s) {
  const parsed = s.parsed;
  const m = (parsed.matter || '').trim();
  const lang = parsed.language && parsed.language.toLowerCase();
  return m.length > 0 && lang !== 'js' && lang !== 'javascript' ? `---\n${m}\n---` : s.env.matter.stringify('', parsed.data || {}).trim();
}

// Skills (and the rules they make) of the home's and the workspaces' skill folders.
function localSkills(env, workspacePaths) {
  const folders = new Set();
  for (const w of workspacePaths) {
    folders.add(path.join(w, '.cursor', 'rules'));
    for (const d of SKILL_DIRS) if (THIRD_PARTY || !d.thirdParty) folders.add(path.join(w, d.configDir, d.subdir));
  }
  for (const d of userSkillDirs(env.home)) folders.add(d);
  folders.add(path.join(env.home, BUILTIN_SKILLS.configDir, BUILTIN_SKILLS.subdir));
  const loaded = [];
  const seen = new Set();
  const take = (s) => {
    if (seen.has(s.real)) return;
    seen.add(s.real);
    loaded.push(s);
  };
  for (const folder of folders) for (const f of walk(folder, (n) => n === 'SKILL.md').filter((f) => !ignoredSkill(f))) take(loadSkill(env, f));
  for (const w of workspacePaths) for (const f of nested(env, w).skills.filter((f) => !ignoredSkill(f))) take(loadSkill(env, f));
  const rules = [];
  const skills = [];
  for (const s of loaded) {
    if (s.error) {
      const parse_error = `Failed to read skill file: ${s.error}`;
      rules.push({ full_path: s.file, parse_error, type: { agent_fetched: {} } });
      skills.push({ full_path: s.file, parse_error });
      continue;
    }
    const surfaces = skillSurfaces(s.data);
    if (surfaces.length > 0 && !surfaces.includes('ide')) continue;
    rules.push(skillRule({ ...s, env }));
    if (s.data.alwaysApply !== true) skills.push(toSkill(s));
  }
  return { rules, skills };
}

// --- plugins -----------------------------------------------------------------------------

// Installed plugins, from Cursor's plugin cache (~/.cursor/plugins/cache/<marketplace>/<plugin>/<rev>,
// the newest complete revision). Their database ids come from env.pluginIds:
// { "<plugin>-<rev>": { pluginId, marketplaceId } }, when the caller knows them.
function plugins(env) {
  const root = path.join(env.home, '.cursor', 'plugins', 'cache');
  const out = [];
  for (const marketplace of safeList(root)) {
    for (const name of safeList(path.join(root, marketplace))) {
      const revs = safeList(path.join(root, marketplace, name))
        .map((rev) => ({ rev, dir: path.join(root, marketplace, name, rev) }))
        .filter((r) => isFile(path.join(r.dir, '.cache-complete')))
        .sort((a, b) => fs.statSync(b.dir).mtimeMs - fs.statSync(a.dir).mtimeMs);
      if (!revs.length) continue;
      let manifest = {};
      for (const m of ['.cursor-plugin/plugin.json', 'plugin.json']) {
        try {
          manifest = JSON.parse(read(path.join(revs[0].dir, m)));
          break;
        } catch {
          /* next */
        }
      }
      const ids = (env.pluginIds && env.pluginIds[`${manifest.name || name}-${revs[0].rev}`]) || {};
      out.push({ name: manifest.name || name, marketplace, rev: revs[0].rev, dir: revs[0].dir, manifest, id: ids.pluginId, marketplaceId: ids.marketplaceId });
    }
  }
  return out;
}

function safeList(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => !n.startsWith('.'));
  } catch {
    return [];
  }
}

function pluginSkills(env) {
  const out = [];
  for (const p of plugins(env)) {
    const skillsDir = path.join(p.dir, typeof p.manifest.skills === 'string' ? p.manifest.skills : 'skills');
    // One skill per folder directly under the plugin's skills folder.
    const files = safeList(skillsDir).sort((a, b) => a.localeCompare(b)).map((n) => path.join(skillsDir, n, 'SKILL.md')).filter(isFile);
    for (const f of files) {
      let data = {};
      let content;
      try {
        content = read(f);
        data = env.matter(content).data || {};
      } catch {
        continue;
      }
      if (data.alwaysApply === true) continue;
      out.push({
        full_path: f, content, description: typeof data.description === 'string' ? data.description.slice(0, DESCRIPTION_MAX) : '',
        environments: stringList(data.environments) ?? [], disabled_environments: stringList(data['disabled-environments']) ?? [],
        git_remote_origin: `plugin:${p.name}-${p.rev}`, plugin: p.name, marketplace: p.marketplace, plugin_id: p.id, marketplace_id: p.marketplaceId,
        disable_model_invocation: data['disable-model-invocation'] === true,
      });
    }
  }
  return out;
}

// --- parts -------------------------------------------------------------------------------

// Skills in the order Cursor lists them: Cursor's built-in skills, the home's, the workspaces', plugins'.
function skillTier(s, env) {
  if ((s.plugin || '').trim() || (s.plugin_id || '').trim() || (s.marketplace_id || '').trim()) return 4;
  const p = s.full_path.replace(/\\/g, '/');
  const under = (d) => p === d.replace(/\\/g, '/') || p.startsWith(`${d.replace(/\\/g, '/')}/`);
  if (under(path.join(env.home, BUILTIN_SKILLS.configDir, BUILTIN_SKILLS.subdir))) return 0;
  if (SKILL_DIRS.some((d) => under(path.join(env.home, d.configDir, d.subdir)))) return 2;
  return 3;
}

function skillsPart(env, local) {
  const all = dedupe([...local.skills, ...pluginSkills(env)]);
  const ordered = all.map((s, i) => ({ s, i, t: skillTier(s, env) })).sort((a, b) => a.t - b.t || a.i - b.i).map((x) => x.s);
  // Sent without content; skills the model may not invoke are left out, except plugins'.
  const agent_skills = ordered.filter((s) => !s.disable_model_invocation || s.plugin !== undefined).map((s) => ({
    scoped_to: s.scoped_to, content: '', description: s.description, disabled_environments: s.disabled_environments, disable_model_invocation: s.disable_model_invocation,
    environments: s.environments, full_path: s.full_path, git_remote_origin: s.git_remote_origin, globs: s.globs, marketplace: s.marketplace, marketplace_id: s.marketplace_id,
    parse_error: s.parse_error, plugin: s.plugin, plugin_id: s.plugin_id,
  }));
  return { part: { agent_skills }, all };
}

function rulesPart(env, workspacePaths, local, skills) {
  const merged = dedupe([...workspacePaths.flatMap((w) => folderRules(env, w)), ...local.rules]);
  const skillPaths = new Set(skills.map((s) => s.full_path).filter((p) => p.length > 0));
  const rules = merged
    .map((r) => (r.type.agent_fetched && r.content && !isCustomMode(r.content) ? { ...r, content: '' } : r))
    .filter((r) => !(r.type.agent_fetched && skillPaths.has(r.full_path)));
  return { rules };
}

function parseAgent(text) {
  const m = text.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/m);
  if (!m) return null;
  const prompt = (m[2] ?? '').trim();
  if (!prompt.length) return null;
  const f = {};
  for (const raw of (m[1] ?? '').split('\n')) {
    const line = raw.trim();
    if (!line.length || line.startsWith('#')) continue;
    const i = line.indexOf(':');
    if (i === -1) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    if (k.length) f[k] = line.slice(i + 1).trim();
  }
  const yes = (v) => (v ?? '').trim().toLowerCase() === 'true';
  return {
    name: f.name ?? '', description: f.description, tools: f.tools !== undefined && f.tools.length > 0 ? f.tools.split(',').map((x) => x.trim()).filter((x) => x.length > 0) : [],
    model: f.model, force_default_model: yes(f['force-default-model']), prompt,
    permission_mode: yes(f.readonly) ? 'CUSTOM_SUBAGENT_PERMISSION_MODE_READONLY' : 'CUSTOM_SUBAGENT_PERMISSION_MODE_DEFAULT', is_background: yes(f.background ?? f.is_background),
  };
}

function subagentsPart(env, workspacePaths) {
  const roots = [...workspacePaths.map((w) => ({ root: path.resolve(w), source: 'workspace' })), { root: path.resolve(env.home), source: 'user' }];
  const byName = new Map();
  for (const { root, source } of roots) {
    const dirs = [{ dir: path.join(root, '.cursor', 'agents'), source }];
    if (THIRD_PARTY) dirs.push({ dir: path.join(root, '.claude', 'agents'), source: 'claude' }, { dir: path.join(root, '.grok', 'agents'), source: 'grok' });
    for (const d of dirs) {
      for (const f of walk(d.dir, (n) => ['.md', '.mdc', '.markdown'].includes(path.extname(n).toLowerCase()), root)) {
        if (!isFile(f)) continue;
        let a;
        try {
          a = parseAgent(read(f));
        } catch {
          continue;
        }
        if (!a) continue;
        const name = a.name || path.basename(f, path.extname(f)).replace(/[\s_]+/g, '-');
        if (name === 'claude-code-tutor' || byName.has(name)) continue;
        byName.set(name, { full_path: f, ...a, name, description: a.description ?? '', model: a.model ?? 'inherit', source: d.source });
      }
    }
  }
  return { custom_subagents: [...byName.values()] };
}

// ~/.cursor/projects/<slug of the first workspace folder>, where Cursor keeps the MCP snapshots.
function projectDir(env, workspacePaths) {
  if (!workspacePaths.length) return undefined;
  const slug = workspacePaths[0].replace(/[^a-zA-Z0-9]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return path.join(env.cursorDataDir, 'projects', slug);
}

// Directory entries in the order the file system keeps them (readdirSync sorts; Cursor's writer
// creates one file per tool, in the server's order).
function entries(dir) {
  const out = [];
  let h;
  try {
    h = fs.opendirSync(dir);
  } catch {
    return out;
  }
  try {
    for (let e = h.readSync(); e; e = h.readSync()) out.push(e.name);
  } finally {
    h.closeSync();
  }
  return out;
}

// Cursor's built-in servers whose tools go in the request in full (inline): Cursor's AU.rFE in
// cursor-agent-exec's request context. With the meta-tool descriptors on (Cursor sends them with
// every request, in all 72 captured runs), the other servers' tools are listed by name only, and
// read from their definition files when the model asks for them.
const INLINE_MCP_SERVERS = new Set(['cursor-dev-control', 'cursor-ide-browser']);

// Tool annotations (readOnlyHint...) are not in the MCP folders: they come from the servers, and
// Cursor keeps them only inside the meta-tool parts it stored (sentContext.cjs reads them).
// env.toolAnnotations: Map of `${serverIdentifier}\n${toolName}` -> annotations_json, as sent.
const annotationKey = (server, tool) => `${server}\n${tool}`;

function mcpsPart(env, workspacePaths) {
  const dir = projectDir(env, workspacePaths);
  if (!dir) return { tools: [], mcp_instructions: [] };
  const mcps = path.join(dir, 'mcps');
  const pluginList = plugins(env);
  // The file-system descriptors list the servers and their tools in directory order, as the
  // folders are read (checked against the wire: the folders' own order, for servers and tools).
  const folders = entries(mcps).filter((n) => isDir(path.join(mcps, n))).map((n) => {
    const folder = path.join(mcps, n);
    let meta = {};
    try {
      meta = JSON.parse(read(path.join(folder, 'SERVER_METADATA.json')));
    } catch {
      /* folder name only */
    }
    let instructions;
    try {
      instructions = read(path.join(folder, 'INSTRUCTIONS.md')).trim() || undefined;
    } catch {
      /* none */
    }
    const tools = entries(path.join(folder, 'tools')).filter((f) => f.endsWith('.json')).flatMap((f) => {
      try {
        return [{ file: path.join(folder, 'tools', f), ...JSON.parse(read(path.join(folder, 'tools', f))) }];
      } catch {
        return [];
      }
    });
    const plugin = /^plugin-/.test(n) ? pluginList.find((p) => n.startsWith(`plugin-${p.name}-`)) : undefined;
    return { folder, folderId: n, id: meta.serverIdentifier || n, name: meta.serverName || n, instructions, tools, plugin };
  });
  // The order of the meta-tool descriptors and instructions is the order servers connected in, not on
  // disk: Cursor's own servers first, by name, then plugins (the one order seen in the wire matches).
  const servers = [...folders].sort((a, b) => (!!a.plugin - !!b.plugin) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const pluginFields = (s) => (s.plugin ? { plugin: s.plugin.name, marketplace: s.plugin.marketplace, plugin_db_id: s.plugin.id, marketplace_id: s.plugin.marketplaceId } : {});
  const annotated = (s, t) => {
    const a = env.toolAnnotations && env.toolAnnotations.get(annotationKey(s.id, t.name));
    return a === undefined ? {} : { annotations_json: a };
  };
  return {
    tools: servers.filter((s) => INLINE_MCP_SERVERS.has(s.id)).flatMap((s) => s.tools.map((t) => ({
      name: `${s.id}-${t.name}`, provider_identifier: s.name, tool_name: t.name, description: t.description,
      input_schema_json: t.arguments === undefined ? undefined : JSON.stringify(t.arguments),
    }))),
    mcp_instructions: servers.filter((s) => s.instructions).map((s) => ({ server_name: s.name, instructions: s.instructions, server_identifier: s.id })),
    mcp_file_system_options: {
      enabled: true, workspace_project_dir: dir,
      mcp_descriptors: folders.map((s) => ({ server_identifier: s.folderId, server_name: s.name, ...pluginFields(s), folder_path: s.folder, server_use_instructions: s.instructions, tools: s.tools.map((t) => ({ tool_name: t.name, definition_path: t.file })) })),
    },
    mcp_meta_tool_options: {
      enabled: true,
      mcp_descriptors: servers.map((s) => ({ server_identifier: s.id, server_name: s.name, ...pluginFields(s), server_use_instructions: s.instructions, tools: s.tools.map((t) => ({ tool_name: t.name, ...annotated(s, t) })) })),
    },
  };
}

// The small, per-request part of the context (sent inline, never by id), as far as it is on disk:
// the environment's folders, OS and time zone, and each workspace folder's git repo and remote URL
// (as git has it: with any credentials it holds, which sentContext.cjs redacts before storing).
// Flags and settings Cursor adds are not rebuilt.
function dynamicContext(env, workspacePaths) {
  const project = projectDir(env, workspacePaths);
  let timeZone;
  try {
    timeZone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    /* unknown */
  }
  const git_repos = [];
  for (const w of workspacePaths) {
    const root = gitRoot(w);
    if (!root) continue;
    const remotes = cp.spawnSync('git', ['remote'], { cwd: root, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
    const remote = remotes.includes('origin') ? 'origin' : remotes[0];
    const url = remote && cp.spawnSync('git', ['remote', 'get-url', remote], { cwd: root, encoding: 'utf8' }).stdout.trim();
    git_repos.push({ path: root, ...(url ? { remote_url: url } : {}) });
  }
  return {
    env: {
      os_version: `${os.platform()} ${os.release()}`, workspace_paths: workspacePaths, time_zone: timeZone,
      ...(project ? { project_folder: project, terminals_folder: path.join(project, 'terminals'), agent_transcripts_folder: path.join(project, 'agent-transcripts') } : {}),
    },
    git_repos,
  };
}

// --- entry point ---------------------------------------------------------------------------

// The environment the rebuild reads: Cursor's app (for ripgrep and gray-matter), the home folder.
function environment({ appDir = DEFAULT_APP_DIR, home = os.homedir(), cursorDataDir, pluginIds, toolAnnotations } = {}) {
  const env = { appDir, home, cursorDataDir: cursorDataDir || process.env.CURSOR_DATA_DIR || path.join(home, '.cursor'), pluginIds, toolAnnotations, notes: [] };
  const rg = path.join(appDir, 'node_modules', '@vscode', 'ripgrep', 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg');
  if (isFile(rg)) env.rg = rg;
  else env.notes.push('Cursor\'s ripgrep not found: rule files listed in sorted order, not Cursor\'s');
  try {
    const grayMatter = require(path.join(appDir, 'node_modules', 'gray-matter'));
    env.matter = (text) => grayMatter(text, { engines: { js: () => ({}), javascript: () => ({}) } });
    env.matter.stringify = grayMatter.stringify;
  } catch {
    env.notes.push('Cursor\'s gray-matter not found: skills not rebuilt');
  }
  return env;
}

// The four parts for a chat in these workspace folders: { rules, skills, subagents, mcps } (plain
// objects in requestContext's shape; a part that could not be rebuilt is left out), the dynamic
// context (see dynamicContext), plus notes on what may differ.
function buildParts(workspacePaths, options = {}) {
  const env = options.env || environment(options);
  const parts = {};
  const local = env.matter ? localSkills(env, workspacePaths) : { rules: [], skills: [] };
  let allSkills = [];
  if (env.matter) {
    const s = skillsPart(env, local);
    parts.skills = s.part;
    allSkills = s.all;
  }
  parts.rules = rulesPart(env, workspacePaths, local, allSkills);
  parts.subagents = subagentsPart(env, workspacePaths);
  parts.mcps = mcpsPart(env, workspacePaths);
  // After the walks: they add notes of their own.
  const notes = [...new Set(env.notes)];
  let dynamic;
  try {
    dynamic = dynamicContext(env, workspacePaths);
  } catch (err) {
    notes.push(`environment not rebuilt: ${err.message}`);
  }
  if (plugins(env).some((p) => p.id === undefined || p.marketplaceId === undefined)) notes.push('plugin database ids unknown: plugin skills and MCP servers may differ from what Cursor sent');
  if (!env.toolAnnotations) notes.push('MCP tool annotations not read (no Cursor database): MCP tools may differ from what Cursor sent');
  else if (env.annotationConflicts) notes.push(`${env.annotationConflicts} MCP tools had different annotations in the parts Cursor kept (the servers changed them): the most frequent was taken, which may not be the one sent`);
  return { parts, dynamic, notes };
}

// Workspace folders of a chat, from composerData.workspaceIdentifier: a folder, or the folders of
// a .code-workspace file (relative ones resolved against it).
function workspaceFolders(workspaceIdentifier) {
  if (!workspaceIdentifier) return [];
  const config = workspaceIdentifier.configPath && workspaceIdentifier.configPath.fsPath;
  if (config) {
    let parsed;
    try {
      parsed = JSON.parse(stripJsonComments(read(config)));
    } catch {
      return [];
    }
    return (parsed.folders || []).map((f) => f.path ?? (f.uri && f.uri.startsWith('file://') ? decodeURIComponent(new URL(f.uri).pathname) : undefined))
      .filter((p) => typeof p === 'string')
      .map((p) => path.resolve(path.dirname(config), p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p));
  }
  const folder = workspaceIdentifier.uri && workspaceIdentifier.uri.fsPath;
  return folder ? [folder] : [];
}

// JSONC: drop comments and trailing commas outside strings.
function stripJsonComments(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i === -1) break;
      i++;
    } else out += c;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

// Installed plugins: [{ name, marketplace, rev }] (the keys of env.pluginIds are `${name}-${rev}`).
const installedPlugins = (env) => plugins(env).map(({ name, marketplace, rev }) => ({ name, marketplace, rev }));

module.exports = { DEFAULT_APP_DIR, environment, buildParts, installedPlugins, workspaceFolders, parseMdc, walk, dedupeKey, projectDir, stripJsonComments, annotationKey };
