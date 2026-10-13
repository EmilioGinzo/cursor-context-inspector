'use strict';

// Run by VS Code / Cursor (vscode:uninstall) once the extension is uninstalled: removes its stop hook
// from ~/.cursor/hooks.json, keeping every other hook.
const stopHook = require('../src/stopHook.cjs');

try {
  stopHook.syncHook({ historyDir: '.', enabled: false });
} catch (err) {
  console.error('[context-inspector] could not remove the stop hook:', err);
}
