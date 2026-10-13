'use strict';

// Cursor runs the `stop` hooks in ~/.cursor/hooks.json when an agent turn ends, through the user's shell,
// with the turn (conversation_id, status, ...) as JSON on stdin. Our hook writes that JSON to a signal file
// in the history folder; the recorder watches the file and records at once instead of at its next poll.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Marks our entry in hooks.json, so it is found again and the user's own hooks are left alone.
const MARK = 'context-inspector-agent-stopped';

function defaultHooksFile() {
  return path.join(os.homedir(), '.cursor', 'hooks.json');
}

function signalFile(historyDir) {
  return path.join(historyDir, `.${MARK}.json`);
}

// The shell command that copies stdin to the signal file; the file name carries the mark.
function hookCommand(historyDir, platform = process.platform) {
  const file = signalFile(historyDir);
  if (platform === 'win32') {
    const quoted = `'${file.replace(/'/g, "''")}'`;
    return `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path (Split-Path ${quoted}) | Out-Null; [Console]::In.ReadToEnd() | Set-Content -LiteralPath ${quoted}"`;
  }
  const quote = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  return `mkdir -p ${quote(path.dirname(file))} && cat > ${quote(file)}`;
}

// Adds our stop hook to hooks.json (or removes it when enabled is false), keeping every other hook.
// Returns 'written', 'removed', 'unchanged', or 'unreadable' when the file is not JSON we can safely edit.
function syncHook({ historyDir, enabled, hooksFile = defaultHooksFile(), platform = process.platform }) {
  let config;
  try {
    config = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') return 'unreadable';
    if (!enabled) return 'unchanged';
    config = { version: 1, hooks: {} };
  }
  if (!config || typeof config !== 'object' || (config.hooks !== undefined && typeof config.hooks !== 'object')) return 'unreadable';
  const hooks = config.hooks || {};
  const stop = Array.isArray(hooks.stop) ? hooks.stop : [];
  const others = stop.filter((h) => !(h && typeof h.command === 'string' && h.command.includes(MARK)));
  const wanted = enabled ? [...others, { command: hookCommand(historyDir, platform), timeout: 10 }] : others;
  if (JSON.stringify(wanted) === JSON.stringify(stop)) return 'unchanged';

  if (wanted.length) hooks.stop = wanted;
  else delete hooks.stop;
  config.hooks = hooks;
  if (config.version === undefined) config.version = 1;
  fs.mkdirSync(path.dirname(hooksFile), { recursive: true });
  const tmp = `${hooksFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
  fs.renameSync(tmp, hooksFile);
  return enabled ? 'written' : 'removed';
}

module.exports = { MARK, defaultHooksFile, signalFile, hookCommand, syncHook };
