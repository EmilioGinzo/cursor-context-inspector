'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vscode = require('vscode');
const store = require('./cursorStore.cjs');

const VIEW_TYPE = 'cursorContextInspector';

function activate(context) {
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  status.text = '$(layers) Context';
  status.tooltip = 'Inspect the text behind each part of the agent context';
  status.command = 'cursorContextInspector.open';
  if (vscode.workspace.getConfiguration('cursorContextInspector').get('showStatusBarItem')) status.show();

  context.subscriptions.push(
    status,
    // Args (optional): a chat id string, or { composerId, categoryId } — the patched
    // Context Usage popover passes these when a row or "View Report" is clicked.
    vscode.commands.registerCommand('cursorContextInspector.open', (args) => Inspector.show(context, openTarget(args))),
  );
}

function openTarget(args) {
  if (typeof args === 'string') return { composerId: args };
  if (args && typeof args === 'object' && (args.composerId || args.categoryId)) {
    return { composerId: args.composerId, categoryId: args.categoryId };
  }
  return {};
}

// This window's workspace storage (beside storageUri) records the chats focused in it.
function lastFocusedChatIds(context) {
  if (!context.storageUri) return [];
  const file = path.join(path.dirname(context.storageUri.fsPath), 'state.vscdb');
  if (!fs.existsSync(file)) return [];
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

  static show(context, target = {}) {
    if (!Inspector.current) Inspector.current = new Inspector(context);
    const inspector = Inspector.current;
    if (target.composerId) {
      inspector.chatId = target.composerId;
      inspector.follow = false;
    }
    inspector.pendingCategory = target.categoryId;
    inspector.panel.reveal();
    if (inspector.ready) inspector.reload();
  }

  constructor(context) {
    this.context = context;
    this.dbPath = databasePath(context);
    this.follow = true;
    this.chatId = undefined;
    this.ready = false;
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
    this.focusTimer = setInterval(() => this.followTick(), 2500);
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
        case 'refresh':
          return this.reload();
        case 'selectChat':
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
    if (!this.follow || !this.panel.visible || this.ticking) return;
    this.ticking = true;
    try {
      const db = this.database();
      const target = (await this.focusedChatId(db)) || (store.listComposers(db, 1)[0] || {}).id;
      if (target && (target !== this.chatId || store.lastUpdatedAt(db, target) !== this.loadedAt)) await this.reload();
    } catch {
      // Cursor may be mid-write; the next tick retries.
    } finally {
      this.ticking = false;
    }
  }

  // The chat focused in this window: Cursor's live pane list, ordered by the
  // window's focus history. Chats without saved context (new, empty) are skipped.
  async focusedChatId(db) {
    let panes = [];
    try {
      panes = (await vscode.commands.executeCommand('composer.getOrderedSelectedComposerIds')) || [];
    } catch {
      // Not Cursor, or the command changed; fall back to stored focus only.
    }
    const focused = lastFocusedChatIds(this.context);
    const ordered = [...focused.filter((id) => !panes.length || panes.includes(id)), ...panes];
    return ordered.find((id) => store.hasContext(db, id));
  }

  async reload() {
    try {
      const db = this.database();
      const chats = store.listComposers(db, 60);
      if (this.follow || !this.chatId) this.chatId = (await this.focusedChatId(db)) || (chats[0] && chats[0].id);
      if (!this.chatId) return this.post({ type: 'error', message: 'No Cursor agent chats with context data were found.' });
      const ctx = store.loadContext(db, this.chatId);
      this.loadedAt = ctx.lastUpdatedAt;
      this.index(ctx);
      this.post({ type: 'context', chats, follow: this.follow, context: skeleton(ctx), focusCategory: this.pendingCategory });
      this.pendingCategory = undefined;
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
  };
}

function html(webview) {
  const nonce = crypto.randomBytes(16).toString('base64');
  const media = fs.readFileSync(path.join(__dirname, '..', 'media', 'inspector.html'), 'utf8');
  return media.replaceAll('{{nonce}}', nonce).replaceAll('{{csp}}', webview.cspSource);
}

function deactivate() {}

module.exports = { activate, deactivate };
