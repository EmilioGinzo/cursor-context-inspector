'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const stopHook = require('../src/stopHook.cjs');

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stop-hook-'));
}

const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

test('adds the stop hook and keeps the user hooks', () => {
  const dir = tmp();
  const hooksFile = path.join(dir, 'hooks.json');
  const own = { command: './hooks/mine.py', timeout: 5 };
  fs.writeFileSync(hooksFile, JSON.stringify({ version: 1, hooks: { stop: [own], postToolUse: [{ command: 'x' }] } }));

  assert.strictEqual(stopHook.syncHook({ historyDir: path.join(dir, 'h'), enabled: true, hooksFile }), 'written');
  const config = read(hooksFile);
  assert.deepStrictEqual(config.hooks.postToolUse, [{ command: 'x' }]);
  assert.deepStrictEqual(config.hooks.stop[0], own);
  assert.match(config.hooks.stop[1].command, new RegExp(stopHook.MARK));

  assert.strictEqual(stopHook.syncHook({ historyDir: path.join(dir, 'h'), enabled: true, hooksFile }), 'unchanged');
  // A new history folder replaces the entry instead of adding a second one.
  assert.strictEqual(stopHook.syncHook({ historyDir: path.join(dir, 'other'), enabled: true, hooksFile }), 'written');
  assert.strictEqual(read(hooksFile).hooks.stop.length, 2);

  assert.strictEqual(stopHook.syncHook({ historyDir: path.join(dir, 'h'), enabled: false, hooksFile }), 'removed');
  assert.deepStrictEqual(read(hooksFile).hooks.stop, [own]);
});

test('creates hooks.json when missing, and removes an emptied stop list', () => {
  const dir = tmp();
  const hooksFile = path.join(dir, 'cursor', 'hooks.json');
  assert.strictEqual(stopHook.syncHook({ historyDir: dir, enabled: false, hooksFile }), 'unchanged');
  assert.ok(!fs.existsSync(hooksFile));
  stopHook.syncHook({ historyDir: dir, enabled: true, hooksFile });
  assert.strictEqual(read(hooksFile).version, 1);
  stopHook.syncHook({ historyDir: dir, enabled: false, hooksFile });
  assert.deepStrictEqual(read(hooksFile), { version: 1, hooks: {} });
});

test('leaves a hooks.json it cannot parse alone', () => {
  const dir = tmp();
  const hooksFile = path.join(dir, 'hooks.json');
  fs.writeFileSync(hooksFile, '{ "version": 1, // comment\n}');
  assert.strictEqual(stopHook.syncHook({ historyDir: dir, enabled: true, hooksFile }), 'unreadable');
  assert.strictEqual(fs.readFileSync(hooksFile, 'utf8'), '{ "version": 1, // comment\n}');
});

test('the hook command writes the turn to the signal file', { skip: process.platform === 'win32' }, () => {
  const historyDir = path.join(tmp(), "it's new");
  const payload = '{"conversation_id":"abc","status":"completed"}';
  execFileSync('sh', ['-c', stopHook.hookCommand(historyDir)], { input: payload });
  assert.strictEqual(fs.readFileSync(stopHook.signalFile(historyDir), 'utf8'), payload);
});

test('a hooks.json of another shape is left alone', () => {
  const dir = tmp();
  const hooksFile = path.join(dir, 'hooks.json');
  for (const text of ['[]', '{"hooks": []}', '{"hooks": {"stop": {"command": "mine"}}}', '{"hooks": "x"}', '']) {
    fs.writeFileSync(hooksFile, text);
    assert.strictEqual(stopHook.syncHook({ historyDir: dir, enabled: true, hooksFile }), 'unreadable', text);
    assert.strictEqual(fs.readFileSync(hooksFile, 'utf8'), text);
  }
});

test('keeps the place of its entry, reads a BOM, writes through a symlink and keeps the mode', { skip: process.platform === 'win32' }, () => {
  const dir = tmp();
  const real = path.join(dir, 'dotfiles', 'hooks.json');
  fs.mkdirSync(path.dirname(real));
  const first = { command: 'first' };
  const last = { command: 'last' };
  const old = { command: `mkdir -p '/old' && cat > '/old/.${stopHook.MARK}.json'` };
  fs.writeFileSync(real, `\uFEFF${JSON.stringify({ version: 1, hooks: { stop: [first, old, last] } })}`, { mode: 0o600 });
  const hooksFile = path.join(dir, 'hooks.json');
  fs.symlinkSync(real, hooksFile);

  assert.strictEqual(stopHook.syncHook({ historyDir: path.join(dir, 'h'), enabled: true, hooksFile }), 'written');
  assert.ok(fs.lstatSync(hooksFile).isSymbolicLink());
  assert.strictEqual(fs.statSync(real).mode & 0o777, 0o600);
  const stop = read(real).hooks.stop;
  assert.deepStrictEqual([stop[0], stop[2]], [first, last]);
  assert.match(stop[1].command, new RegExp(path.join(dir, 'h')));
});

test('the Windows command is encoded, and found again to be replaced', () => {
  const dir = tmp();
  const hooksFile = path.join(dir, 'hooks.json');
  const command = stopHook.hookCommand("C:\\Users\\a$b 'c'\\h", 'win32');
  const script = Buffer.from(/-EncodedCommand (\S+)/.exec(command)[1], 'base64').toString('utf16le');
  assert.ok(script.includes("'C:\\Users\\a$b ''c''\\h"));
  assert.ok(!/["$']/.test(command));
  stopHook.syncHook({ historyDir: 'C:\\one', enabled: true, hooksFile, platform: 'win32' });
  stopHook.syncHook({ historyDir: 'C:\\two', enabled: true, hooksFile, platform: 'win32' });
  assert.strictEqual(read(hooksFile).hooks.stop.length, 1);
  assert.strictEqual(stopHook.syncHook({ historyDir: 'C:\\two', enabled: false, hooksFile, platform: 'win32' }), 'removed');
});

test('a write that fails throws, and leaves no temporary file', { skip: process.platform === 'win32' || process.getuid() === 0 }, () => {
  const dir = tmp();
  const hooksFile = path.join(dir, 'hooks.json');
  fs.writeFileSync(hooksFile, '{"version": 1, "hooks": {}}');
  fs.chmodSync(dir, 0o500);
  try {
    assert.throws(() => stopHook.syncHook({ historyDir: dir, enabled: true, hooksFile }));
  } finally {
    fs.chmodSync(dir, 0o700);
  }
  assert.deepStrictEqual(fs.readdirSync(dir), ['hooks.json']);
});
