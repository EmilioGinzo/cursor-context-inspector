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

// The hook runs in another working directory than the extension: the path is made absolute.
function signalFile(historyDir, paths = path) {
  return paths.resolve(historyDir, `.${MARK}.json`);
}

// The shell command that copies stdin to the signal file; the file name carries the mark.
function hookCommand(historyDir, platform = process.platform) {
  const file = signalFile(historyDir, platform === 'win32' ? path.win32 : path.posix);
  if (platform === 'win32') {
    // Encoded, so no shell (cmd or PowerShell) expands anything in the path.
    const quoted = `'${file.replace(/'/g, "''")}'`;
    const script = `New-Item -ItemType Directory -Force -Path (Split-Path -LiteralPath ${quoted}) | Out-Null; [IO.File]::WriteAllText(${quoted}, [Console]::In.ReadToEnd()) # ${MARK}`;
    return `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
  }
  const quote = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  return `mkdir -p ${quote(path.posix.dirname(file))} && cat > ${quote(file)}`;
}

const isObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const ours = (h) => isObject(h) && typeof h.command === 'string' && (h.command.includes(MARK) || isOurEncoded(h.command));
// The Windows command carries the mark inside its encoded script.
function isOurEncoded(command) {
  const m = /-EncodedCommand ([A-Za-z0-9+/=]+)/.exec(command);
  return !!m && Buffer.from(m[1], 'base64').toString('utf16le').includes(MARK);
}

// Adds our stop hook to hooks.json (or removes it when enabled is false), keeping every other hook and
// the place of ours. Returns 'written', 'removed', 'unchanged', or 'unreadable' when the file is not JSON
// of the shape Cursor reads (an object, whose hooks is an object of arrays): it is then left alone.
// Writes through a symlink, and keeps the file's mode.
function syncHook({ historyDir, enabled, hooksFile = defaultHooksFile(), platform = process.platform }) {
  let config;
  let target = hooksFile;
  try {
    target = fs.realpathSync(hooksFile);
    config = JSON.parse(fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    if (err.code !== 'ENOENT') return 'unreadable';
    if (!enabled) return 'unchanged';
    config = { version: 1, hooks: {} };
  }
  if (!isObject(config) || (config.hooks !== undefined && !isObject(config.hooks))) return 'unreadable';
  const hooks = config.hooks || {};
  if (hooks.stop !== undefined && !Array.isArray(hooks.stop)) return 'unreadable';
  const stop = hooks.stop || [];
  const entry = { command: hookCommand(historyDir, platform), timeout: 10 };
  const at = stop.findIndex(ours);
  let wanted = stop.filter((h, i) => !ours(h) || i === at);
  if (!enabled) wanted = wanted.filter((h) => !ours(h));
  else if (at === -1) wanted.push(entry);
  else wanted = wanted.map((h) => (ours(h) ? entry : h));
  if (JSON.stringify(wanted) === JSON.stringify(stop)) return 'unchanged';

  if (wanted.length) hooks.stop = wanted;
  else delete hooks.stop;
  config.hooks = hooks;
  if (config.version === undefined) config.version = 1;
  const mode = fs.statSync(target, { throwIfNoEntry: false });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, mode ? { mode: mode.mode & 0o777 } : undefined);
    fs.renameSync(tmp, target);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return enabled ? 'written' : 'removed';
}

module.exports = { MARK, defaultHooksFile, signalFile, hookCommand, syncHook };
