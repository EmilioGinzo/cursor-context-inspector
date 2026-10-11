'use strict';

// An index of the message blobs in Cursor's store, by what they name: the tool call ids in their parts,
// and the digests of their assistant texts. A replaced tool result and an interrupted reply are stored
// outside the prompt, and nothing in the chat's state names them, so each is looked for in the store.
// Looking for each one reads the store again; the index reads every row once instead. It advances in
// steps of rows (by rowid), each within a time budget, so the work is spread over ticks. Lookups are
// queries of the index, and the index is kept in <history dir>/.store-index.sqlite. It only ever gains
// entries: a store whose rows were renumbered (VACUUM) or removed under the watermark is read again.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const store = require('./cursorStore.cjs');

const FILE = '.store-index.sqlite';
const CHUNK_ROWS = 256;
const TOOL_ID = Buffer.from('toolCallId');
const ASSISTANT = Buffer.from('"assistant"');
const indexes = new Map();

// The text as a reply is compared: trimmed, then digested.
const digest = (text) => crypto.createHash('sha1').update(String(text).trim()).digest('hex');

// The index of the history directory `dir` (one per process and directory).
function open(dir) {
  const file = path.join(dir, FILE);
  if (indexes.has(file)) return indexes.get(file);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS state (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS calls (id TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (id, hash)) WITHOUT ROWID;
    CREATE TABLE IF NOT EXISTS texts (digest TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (digest, hash)) WITHOUT ROWID;`);
  const get = (k) => { const r = db.prepare('SELECT v FROM state WHERE k = ?').get(k); return r ? r.v : undefined; };
  const set = (k, v) => db.prepare('INSERT OR REPLACE INTO state (k, v) VALUES (?, ?)').run(k, String(v));
  const insertCall = db.prepare('INSERT OR IGNORE INTO calls (id, hash) VALUES (?, ?)');
  const insertText = db.prepare('INSERT OR IGNORE INTO texts (digest, hash) VALUES (?, ?)');
  const callsOf = db.prepare('SELECT hash FROM calls WHERE id = ?');
  const textsOf = db.prepare('SELECT hash FROM texts WHERE digest = ?');
  const index = {
    dir,
    // Rows read so far by this process (for tests and measurements).
    stats: { rowsRead: 0 },
    watermark: () => Number(get('watermark') || 0),
    // The blobs naming the tool call `id` (in a part of their content).
    callHashes: (id) => callsOf.all(id).map((r) => r.hash),
    // The blobs whose assistant text is `text` (compared trimmed).
    textHashes: (text) => textsOf.all(digest(text)).map((r) => r.hash),
    // Reads the store's rows after the watermark, up to its last row, within `budgetMs` (at least one
    // step). Returns { watermark, caughtUp }: caughtUp once the rows the store had are all read.
    advance(cursorDb, { budgetMs = Infinity, clock = Date.now, chunkRows = CHUNK_ROWS } = {}) {
      const max = store.maxRowid(cursorDb);
      let watermark = index.watermark();
      if (watermark > 0 && (watermark > max || store.keyAtOrBelow(cursorDb, watermark) !== get('anchor'))) {
        // Renumbered or removed rows: the rows are read again (entries are only added, so this adds nothing twice).
        watermark = 0;
        set('watermark', 0);
      }
      const start = clock();
      let steps = 0;
      while (watermark < max) {
        if (steps > 0 && clock() - start >= budgetMs) break;
        const to = Math.min(max, watermark + chunkRows);
        const blobs = store.blobRows(cursorDb, watermark, to);
        db.exec('BEGIN');
        try {
          for (const { hash, value } of blobs) addBlob(hash, value);
          set('watermark', to);
          set('anchor', store.keyAtOrBelow(cursorDb, to) || '');
          db.exec('COMMIT');
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
        index.stats.rowsRead += to - watermark;
        watermark = to;
        steps++;
      }
      return { watermark, caughtUp: watermark >= max, steps };
    },
    close: () => { indexes.delete(file); db.close(); },
  };
  const addBlob = (hash, value) => {
    if (!value.includes(TOOL_ID) && !value.includes(ASSISTANT)) return;
    let message;
    try { message = JSON.parse(value.toString('utf8')); } catch { return; }
    if (!message || !Array.isArray(message.content)) return;
    for (const p of message.content) if (p && typeof p.toolCallId === 'string') insertCall.run(p.toolCallId, hash);
    if (message.role === 'assistant') {
      for (const p of message.content) if (p && p.type === 'text') insertText.run(digest(String(p.text)), hash);
    }
  };
  indexes.set(file, index);
  return index;
}

// Closes the index of `dir`, if it is open.
function close(dir) {
  const index = indexes.get(path.join(dir, FILE));
  if (index) index.close();
}

module.exports = { open, close, FILE, CHUNK_ROWS };
