'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vscode = require('vscode');
const store = require('./cursorStore.cjs');
const history = require('./history.cjs');
const storeIndex = require('./storeIndex.cjs');
const sentContext = require('./sentContext.cjs');
const stopHook = require('./stopHook.cjs');
const requests = require('./requests.cjs');

const VIEW_TYPE = 'cursorContextInspector';
let focus;

function activate(context) {
  focus = new FocusTracker(context);
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = '$(layers) Context';
  status.tooltip = 'Inspect the text behind each part of the agent context';
  status.command = 'cursorContextInspector.open';
  if (vscode.workspace.getConfiguration('cursorContextInspector').get('showStatusBarItem')) status.show();

  context.subscriptions.push(
    status,
    vscode.commands.registerCommand('cursorContextInspector.open', () => Inspector.show(context)),
    vscode.commands.registerCommand('cursorContextInspector.openHistory', () => openHistoryFolder()),
    vscode.commands.registerCommand('cursorContextInspector.recordAllHistory', () => recordAll(context)),
    vscode.commands.registerCommand('cursorContextInspector.recordFocusedChat', () => recordFocused(context)),
  );
  // The recorder starts again when a setting it was started with changes.
  let recorder = startRecorder(context);
  context.subscriptions.push(
    { dispose: () => recorder.dispose() },
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!RECORDER_SETTINGS.some((k) => e.affectsConfiguration(`cursorContextInspector.${k}`))) return;
      recorder.dispose();
      recorder = startRecorder(context);
    }),
  );
}

const RECORDER_SETTINGS = ['recordHistory', 'historyDirectory', 'recordOnAgentStop', 'databasePath'];

function settings() {
  return vscode.workspace.getConfiguration('cursorContextInspector');
}

function historyDir() {
  return settings().get('historyDirectory') || history.defaultHistoryDir();
}

// A chat's entry in the history's index.json ({ composerId, path, subagents, ... }); undefined if not recorded.
function findEntry(composerId) {
  const find = (list) => {
    for (const c of list) {
      if (c.composerId === composerId) return c;
      const sub = find(c.subagents || []);
      if (sub) return sub;
    }
    return undefined;
  };
  try {
    return find(JSON.parse(fs.readFileSync(path.join(historyDir(), 'index.json'), 'utf8')));
  } catch {
    return undefined;
  }
}

// A chat's recorded meta.json; undefined if not recorded.
function readMeta(composerId) {
  try {
    const entry = findEntry(composerId);
    return entry && JSON.parse(fs.readFileSync(path.join(historyDir(), entry.path, 'meta.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

// Snapshot changed chats every 30 s, and as soon as an agent turn ends (Cursor's stop hook) or a chat is
// asked for (Record Focused Chat Now); one window records, the others skip. Older chats, the store's index,
// and changed chats a tick had no time for are caught up in small batches, every 5 s until done.
// Returns a disposable that stops it.
function startRecorder(context) {
  const enabled = settings().get('recordHistory');
  const onStop = enabled && settings().get('recordOnAgentStop');
  const dir = historyDir();
  try {
    const hook = stopHook.syncHook({ historyDir: dir, enabled: onStop });
    if (hook === 'unreadable') console.error(`[context-inspector] ${stopHook.defaultHooksFile()} is not JSON of the shape Cursor reads; the stop hook was not changed.`);
  } catch (err) {
    console.error('[context-inspector] could not update the stop hook:', err);
  }
  if (!enabled) return { dispose: () => {} };
  let db;
  let lastWrite;
  let busy = true;
  // Set while index.json misses a record: when its next write is due (ms).
  let indexDueIn;
  let timer;
  const run = () => {
    clearTimeout(timer);
    let waiting = [];
    try {
      waiting = requests.waiting(dir);
      // Cursor commits through the WAL; unchanged mtime means no chat changed.
      const dbPath = databasePath(context);
      const stat = fs.statSync(`${dbPath}-wal`, { throwIfNoEntry: false }) || fs.statSync(dbPath);
      if (stat.mtimeMs !== lastWrite || busy || waiting.length) {
        db = db || store.openDatabase(dbPath);
        const result = history.tick(db, dir, {
          backfillDays: settings().get('historyBackfillDays'),
          record: waiting,
          ...recordOptions(context),
        });
        // A store write another window was to record stays new here: if that window closes, this one records it.
        if (!result.skipped) lastWrite = stat.mtimeMs;
        requests.answer(dir, result.requested || [], result.failed || {});
        busy = !!(result.backfilling || result.indexing || result.behind);
        indexDueIn = result.indexDueIn;
        waiting = requests.waiting(dir);
      }
    } catch (err) {
      console.error('[context-inspector] history recording failed:', err);
    }
    const delay = busy || waiting.length ? 5000 : 30000;
    timer = setTimeout(run, indexDueIn === undefined ? delay : Math.min(delay, indexDueIn + 100));
  };
  timer = setTimeout(run, 5000);
  // A turn ended: Cursor may write its last messages to its store just after the hook runs, so look again
  // a little later. A chat asked for: at once.
  const later = (delays) => {
    let timers = [];
    return {
      start: () => { timers.forEach(clearTimeout); timers = delays.map((ms) => setTimeout(run, ms)); },
      stop: () => timers.forEach(clearTimeout),
    };
  };
  const afterStop = later([500, 3000, 10000]);
  const afterRequest = later([0]);
  const watch = (file, then) => {
    const listener = (now, before) => { if (now.mtimeMs !== before.mtimeMs) then.start(); };
    fs.watchFile(file, { interval: 500 }, listener);
    return () => fs.unwatchFile(file, listener);
  };
  const unwatch = [watch(requests.requestFile(dir), afterRequest)];
  if (onStop) unwatch.push(watch(stopHook.signalFile(dir), afterStop));
  return {
    dispose: () => {
      clearTimeout(timer);
      afterStop.stop();
      afterRequest.stop();
      unwatch.forEach((f) => f());
      if (db) db.close();
      storeIndex.close(dir);
      history.releaseLock(dir);
    },
  };
}

// What the recorder records, from the settings.
function recordOptions(context) {
  return {
    detail: settings().get('historyDetail'),
    // Rebuilt with Cursor's own ripgrep and gray-matter.
    sentContext: { enabled: true, appDir: vscode.env.appRoot, cursorLogsDir: cursorLogsDir(context) },
  };
}

// Records the chat focused in this window, and its subagents, now: asks the window that records (this one
// or another) and waits for its answer.
async function recordFocused(context) {
  if (!settings().get('recordHistory')) {
    vscode.window.showInformationMessage('Session history is off (cursorContextInspector.recordHistory).');
    return;
  }
  const db = store.openDatabase(databasePath(context));
  let id;
  try {
    id = await (Inspector.current ? Inspector.current.focus : focus).chatId(db);
  } finally {
    db.close();
  }
  if (!id) {
    vscode.window.showInformationMessage('No focused Cursor agent chat to record.');
    return;
  }
  const dir = historyDir();
  const asked = Date.now();
  requests.ask(dir, id, asked);
  const reply = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Recording the focused chat…' },
    async () => {
      for (let waited = 0; waited < 30000; waited += 250) {
        const got = requests.answerTo(dir, id, asked);
        if (got) return got;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return undefined;
    },
  );
  if (!reply) {
    vscode.window.showWarningMessage('The focused chat is not recorded yet: the recorder is still reading Cursor\'s store, or another window that has not been reloaded since an update is recording. It is recorded as soon as the recorder can.');
    return;
  }
  if (reply.error) {
    vscode.window.showErrorMessage(`Recording the focused chat failed: ${reply.error}`);
    return;
  }
  const entry = findEntry(id);
  const pick = await vscode.window.showInformationMessage('Recorded the focused chat.', ...(entry ? ['Open chat.md'] : []));
  if (pick) await vscode.window.showTextDocument(vscode.Uri.file(path.join(dir, entry.path, 'chat.md')));
}

// Cursor's logs folder (one folder per launch: <YYYYMMDDTHHMMSS>/), above this extension's own log
// folder (<launch>/window<n>/exthost/<extension>); on every platform. undefined: the default is used.
function cursorLogsDir(context) {
  let dir = context.logUri && context.logUri.fsPath;
  while (dir && path.dirname(dir) !== dir) {
    if (/^\d{8}T\d{6}$/.test(path.basename(dir))) return path.dirname(dir);
    dir = path.dirname(dir);
  }
  return undefined;
}

async function openHistoryFolder() {
  const dir = historyDir();
  if (!fs.existsSync(path.join(dir, 'chats'))) {
    vscode.window.showInformationMessage(`No session history recorded yet in ${dir}.`);
    return;
  }
  await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path.join(dir, 'index.json')));
}

async function recordAll(context) {
  const pick = await vscode.window.showWarningMessage(
    'Record the history of every Cursor chat on this machine? This copies all their prompt messages into the history folder.',
    { modal: true },
    'Record all',
  );
  if (pick !== 'Record all') return;
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Recording all chat history…' }, async () => {
    const db = store.openDatabase(databasePath(context));
    try {
      const { recorded } = history.recordUpdatedSince(db, historyDir(), 0, { detail: settings().get('historyDetail') });
      vscode.window.showInformationMessage(`Recorded ${recorded} chat snapshot(s) in ${historyDir()}.`);
    } finally {
      db.close();
    }
  });
}

// Tracks the chat focused in this window: one for each inspector panel, and one for Record Focused Chat Now
// while no panel is open.
class FocusTracker {
  constructor(context) {
    this.context = context;
    this.recentChatIds = []; // newest first, from live pane changes and stored focus
    this.panes = undefined;
    this.storedHead = undefined;
  }

  // The chat focused in this window. Cursor exposes only the open panes (in layout
  // order) live; a chat that just joined them is the one the user switched to.
  // The stored focus history fills in, but only after Cursor flushes it.
  // Chats without saved context (new, empty) are skipped.
  async chatId(db) {
    let panes = [];
    try {
      panes = (await vscode.commands.executeCommand('composer.getOrderedSelectedComposerIds')) || [];
    } catch {
      // Not Cursor, or the command changed; fall back to stored focus only.
    }
    const stored = lastFocusedChatIds(this.context);
    const bump = (id) => (this.recentChatIds = [id, ...this.recentChatIds.filter((r) => r !== id)]);
    if (this.panes) panes.filter((id) => !this.panes.includes(id)).forEach(bump);
    this.panes = panes;
    if (this.storedHead !== undefined && stored[0] && stored[0] !== this.storedHead) bump(stored[0]);
    this.storedHead = stored[0] || null;
    const open = (id) => !panes.length || panes.includes(id);
    const ordered = [...this.recentChatIds.filter(open), ...stored.filter(open), ...panes];
    return ordered.find((id) => store.hasContext(db, id));
  }
}

// This window's workspace storage (beside storageUri) records the chats focused in it.
// Cursor flushes it only about once a minute, so it lags behind live focus.
const focusCache = { mtimeMs: undefined, ids: [] };
function lastFocusedChatIds(context) {
  if (!context.storageUri) return [];
  const file = path.join(path.dirname(context.storageUri.fsPath), 'state.vscdb');
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat) return [];
  if (stat.mtimeMs === focusCache.mtimeMs) return focusCache.ids;
  focusCache.mtimeMs = stat.mtimeMs;
  focusCache.ids = readLastFocusedChatIds(file);
  return focusCache.ids;
}

function readLastFocusedChatIds(file) {
  let db;
  try {
    db = store.openDatabase(file);
    const row = db.prepare("SELECT value FROM ItemTable WHERE key = 'composer.composerData'").get();
    const data = row && JSON.parse(typeof row.value === 'string' ? row.value : Buffer.from(row.value).toString('utf8'));
    return (data && data.lastFocusedComposerIds) || [];
  } catch {
    return [];
  } finally {
    if (db) db.close();
  }
}

function databasePath(context) {
  const configured = vscode.workspace.getConfiguration('cursorContextInspector').get('databasePath');
  if (configured) return configured;
  // globalStorageUri = .../User/globalStorage/<publisher.name>; state.vscdb lives beside it.
  const beside = path.join(path.dirname(context.globalStorageUri.fsPath), 'state.vscdb');
  return fs.existsSync(beside) ? beside : store.defaultDatabasePath();
}

class Inspector {
  static current;

  static show(context) {
    if (!Inspector.current) Inspector.current = new Inspector(context);
    const inspector = Inspector.current;
    inspector.panel.reveal();
    if (inspector.ready) inspector.reload({ refocus: true });
  }

  constructor(context) {
    this.context = context;
    this.dbPath = databasePath(context);
    this.follow = true;
    this.chatId = undefined;
    this.ready = false;
    this.focus = new FocusTracker(context);
    this.itemIndex = new Map();
    this.panel = vscode.window.createWebviewPanel(VIEW_TYPE, 'Agent Context', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
    });
    this.panel.iconPath = new vscode.ThemeIcon('layers');
    this.panel.webview.html = html(this.panel.webview);
    this.panel.onDidDispose(() => this.dispose());
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));

    // Cursor writes chat state through SQLite's WAL; its mtime changes on every update.
    this.walPath = `${this.dbPath}-wal`;
    this.onWal = () => this.followTick();
    fs.watchFile(this.walPath, { interval: 2000 }, this.onWal);
    // Switching chats writes nothing to the global DB, so poll focus separately.
    this.focusTimer = setInterval(() => this.followTick(), 1000);
  }

  dispose() {
    fs.unwatchFile(this.walPath, this.onWal);
    clearInterval(this.focusTimer);
    if (this.db) this.db.close();
    Inspector.current = undefined;
  }

  database() {
    if (!this.db) this.db = store.openDatabase(this.dbPath);
    return this.db;
  }

  post(message) {
    this.panel.webview.postMessage(message);
  }

  onMessage(m) {
    try {
      switch (m.type) {
        case 'ready':
          this.ready = true;
          return this.reload();
        case 'refresh': // also jumps to the focused chat, even when not following
          return this.reload({ refocus: true });
        case 'selectChat':
        case 'openChat': // a subagent, or an ancestor from the breadcrumb
          this.chatId = m.chatId;
          this.follow = false;
          return this.reload();
        case 'follow':
          this.follow = m.value;
          return this.reload();
        case 'text':
          return this.post({ type: 'text', id: m.id, ...this.textFor(m.id) });
        case 'copy':
          return vscode.env.clipboard.writeText(this.textFor(m.id).text).then(() => vscode.window.setStatusBarMessage('Context text copied', 2000));
        case 'openEditor': {
          const t = this.textFor(m.id);
          return vscode.workspace
            .openTextDocument({ content: t.text, language: 'markdown' })
            .then((doc) => vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside }));
        }
      }
    } catch (err) {
      this.post({ type: 'error', message: String(err && err.message ? err.message : err) });
    }
  }

  async followTick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const db = this.database();
      // Track focus even when not following, so refresh can jump to it.
      const focused = await this.focusedChatId(db);
      if (!this.follow || !this.panel.visible) return;
      const target = focused || (store.listComposers(db, 1)[0] || {}).id;
      if (target && (target !== this.chatId || store.lastUpdatedAt(db, target) !== this.loadedAt)) await this.reload();
    } catch {
      // Cursor may be mid-write; the next tick retries.
    } finally {
      this.ticking = false;
    }
  }

  async focusedChatId(db) {
    return this.focus.chatId(db);
  }

  async reload({ refocus = false } = {}) {
    try {
      const db = this.database();
      const chats = store.listComposers(db, 60);
      if (this.follow || refocus || !this.chatId) {
        this.chatId = (await this.focusedChatId(db)) || (refocus && this.chatId) || (chats[0] && chats[0].id);
      }
      if (!this.chatId) return this.post({ type: 'error', message: 'No Cursor agent chats with context data were found.' });
      const ctx = store.loadContext(db, this.chatId, (id) => (readMeta(id) || {}).toolCallIds || []);
      const sent = sentContext.panelCategory(historyDir(), readMeta(this.chatId));
      if (sent) ctx.categories.push(sent);
      this.loadedAt = ctx.lastUpdatedAt;
      this.index(ctx);
      this.post({ type: 'context', chats, follow: this.follow, context: { ...skeleton(ctx), ancestors: store.ancestors(db, this.chatId) } });
    } catch (err) {
      this.post({ type: 'error', message: `${err.message}\n\nDatabase: ${this.dbPath}` });
    }
  }

  index(ctx) {
    this.itemIndex.clear();
    const add = (item) => {
      this.itemIndex.set(item.id, item);
      (item.children || []).forEach(add);
    };
    for (const c of ctx.categories) {
      this.itemIndex.set(`category:${c.id}`, { label: c.label, estimatedTokens: c.estimatedTokens, children: c.items, note: c.note });
      c.items.forEach(add);
    }
    this.itemIndex.set('category:raw', { label: 'All prompt messages', children: ctx.rawMessages });
    ctx.rawMessages.forEach(add);
  }

  textFor(id) {
    const item = this.itemIndex.get(id);
    if (!item) return { label: id, text: '(item no longer available — refresh)' };
    let text = item.text;
    if (text === undefined && item.children) {
      text = item.children
        .map((c) => `===== ${c.label} (~${c.estimatedTokens} tokens) =====\n${c.text ?? c.unavailable ?? leafText(c)}`)
        .join('\n\n');
    }
    if (!text) text = item.unavailable || item.note || '(empty)';
    return { label: item.label, kind: item.kind, estimatedTokens: item.estimatedTokens, text };
  }
}

function leafText(item) {
  return (item.children || []).map((c) => c.text ?? c.unavailable ?? leafText(c)).join('\n\n');
}

// The webview gets labels and counts only; text is fetched per click.
function skeleton(ctx) {
  const strip = (i) => ({
    id: i.id,
    label: i.label,
    kind: i.kind,
    estimatedTokens: i.estimatedTokens,
    characterCount: i.characterCount,
    unavailable: i.text === undefined && !i.children,
    untracked: i.untracked,
    subagents: i.subagents,
    children: i.children && i.children.map(strip),
  });
  return {
    composerId: ctx.composerId,
    name: ctx.name,
    model: ctx.model,
    hasTree: ctx.hasTree,
    totalUsedTokens: ctx.totalUsedTokens,
    maxTokens: ctx.maxTokens,
    categories: ctx.categories.map((c) => ({ ...c, items: c.items.map(strip) })),
    rawMessages: ctx.rawMessages.map(strip),
    subagents: ctx.subagents,
    parent: ctx.parent,
  };
}

function html(webview) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const media = fs.readFileSync(path.join(__dirname, '..', 'media', 'inspector.html'), 'utf8');
  return media.replaceAll('{{nonce}}', nonce).replaceAll('{{csp}}', webview.cspSource);
}

function deactivate() {}

module.exports = { activate, deactivate };
