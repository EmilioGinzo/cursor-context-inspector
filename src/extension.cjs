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
    vscode.commands.registerCommand('cursorContextInspector.open', () => Inspector.show(context)),
  );
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
    if (Inspector.current) {
      Inspector.current.panel.reveal();
      Inspector.current.reload();
      return;
    }
    Inspector.current = new Inspector(context);
  }

  constructor(context) {
    this.dbPath = databasePath(context);
    this.follow = true;
    this.chatId = undefined;
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
  }

  dispose() {
    fs.unwatchFile(this.walPath, this.onWal);
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

  followTick() {
    if (!this.follow || !this.panel.visible) return;
    try {
      const latest = store.listComposers(this.database(), 1)[0];
      if (latest && (latest.id !== this.chatId || latest.lastUpdatedAt !== this.loadedAt)) this.reload();
    } catch {
      // Cursor may be mid-write; the next tick retries.
    }
  }

  reload() {
    try {
      const db = this.database();
      const chats = store.listComposers(db, 60);
      if (this.follow || !this.chatId) this.chatId = chats[0] && chats[0].id;
      if (!this.chatId) return this.post({ type: 'error', message: 'No Cursor agent chats with context data were found.' });
      const ctx = store.loadContext(db, this.chatId);
      this.loadedAt = ctx.lastUpdatedAt;
      this.index(ctx);
      this.post({ type: 'context', chats, follow: this.follow, context: skeleton(ctx) });
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
