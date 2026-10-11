'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vscode = require('vscode');
const store = require('./cursorStore.cjs');
const history = require('./history.cjs');
const storeIndex = require('./storeIndex.cjs');
const sentContext = require('./sentContext.cjs');

const VIEW_TYPE = 'cursorContextInspector';

function activate(context) {
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
  );
  startRecorder(context);
}

function settings() {
  return vscode.workspace.getConfiguration('cursorContextInspector');
}

function historyDir() {
  return settings().get('historyDirectory') || history.defaultHistoryDir();
}

// A chat's recorded meta.json, found through the history's index; undefined if not recorded.
function readMeta(composerId) {
  try {
    const find = (list) => {
      for (const c of list) {
        if (c.composerId === composerId) return c;
        const sub = find(c.subagents || []);
        if (sub) return sub;
      }
      return undefined;
    };
    const entry = find(JSON.parse(fs.readFileSync(path.join(historyDir(), 'index.json'), 'utf8')));
    return entry && JSON.parse(fs.readFileSync(path.join(historyDir(), entry.path, 'meta.json'), 'utf8'));
  } catch {
    return undefined;
  }
}

// Snapshot changed chats every 30 s; one window records, the others skip.
// Older chats are caught up in small batches, every 5 s until done.
function startRecorder(context) {
  if (!settings().get('recordHistory')) return;
  let db;
  let lastWrite;
  let backfilling = true;
  let timer;
  const run = () => {
    try {
      // Cursor commits through the WAL; unchanged mtime means no chat changed.
      const dbPath = databasePath(context);
      const stat = fs.statSync(`${dbPath}-wal`, { throwIfNoEntry: false }) || fs.statSync(dbPath);
      if (stat.mtimeMs !== lastWrite || backfilling) {
        lastWrite = stat.mtimeMs;
        db = db || store.openDatabase(dbPath);
        backfilling = !!history.tick(db, historyDir(), {
          backfillDays: settings().get('historyBackfillDays'),
          // Rebuilt with Cursor's own ripgrep and gray-matter.
          sentContext: { enabled: true, appDir: vscode.env.appRoot },
        }).backfilling;
      }
    } catch (err) {
      console.error('[context-inspector] history recording failed:', err);
    }
    timer = setTimeout(run, backfilling ? 5000 : 30000);
  };
  timer = setTimeout(run, 5000);
  context.subscriptions.push({ dispose: () => { clearTimeout(timer); if (db) db.close(); storeIndex.close(historyDir()); } });
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
      const { recorded } = history.recordUpdatedSince(db, historyDir(), 0);
      vscode.window.showInformationMessage(`Recorded ${recorded} chat snapshot(s) in ${historyDir()}.`);
    } finally {
      db.close();
    }
  });
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
    this.itemIndex = new Map();
    this.recentChatIds = []; // newest first, from live pane changes and stored focus
    this.panes = undefined;
    this.storedHead = undefined;
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

  // The chat focused in this window. Cursor exposes only the open panes (in layout
  // order) live; a chat that just joined them is the one the user switched to.
  // The stored focus history fills in, but only after Cursor flushes it.
  // Chats without saved context (new, empty) are skipped.
  async focusedChatId(db) {
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
