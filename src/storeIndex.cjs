'use strict';

// An index of the message blobs in Cursor's store, by what they name: the tool call ids in their parts,
// and the digests of their assistant texts. A replaced tool result and an interrupted reply are stored
// outside the prompt, and nothing in the chat's state names them, so each is looked for in the store.
// Looking for each one reads the store again; the index reads every row once instead. It advances in
// steps of rows (by rowid), each within a time budget, so the work is spread over ticks. Lookups are
// queries of the index, and the index is kept in <history dir>/.store-index.sqlite. It only ever gains
// entries: a store whose rows were renumbered (VACUUM), or whose last blob read was removed, is read again.

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
  // The last blob read ({ rowid, key }), or none.
  const setAnchor = (blob) => {
    if (blob) { set('anchor', blob.key || `agentKv:blob:${blob.hash}`); set('anchorRowid', blob.rowid); }
    else { db.exec("DELETE FROM state WHERE k = 'anchor'"); set('anchorRowid', 0); }
  };
  const insertCall = db.prepare('INSERT OR IGNORE INTO calls (id, hash) VALUES (?, ?)');
  const insertText = db.prepare('INSERT OR IGNORE INTO texts (digest, hash) VALUES (?, ?)');
  const callsOf = db.prepare('SELECT hash FROM calls WHERE id = ?');
  const textsOf = db.prepare('SELECT hash FROM texts WHERE digest = ?');
  const index = {
    dir,
    // Rows read so far by this process (for tests and measurements).
    stats: { rowsRead: 0 },
    watermark: () => Number(get('watermark') || 0),
    // True once every row was read, even if the rows are being read again since.
    complete: () => get('complete') === '1',
    // The blobs naming the tool call `id` (in a part of their content).
    callHashes: (id) => callsOf.all(id).map((r) => r.hash),
    // The blobs whose assistant text is `text` (compared trimmed).
    textHashes: (text) => textsOf.all(digest(text)).map((r) => r.hash),
    // Reads the store's rows after the watermark, up to its last row, within `budgetMs` (at least one
    // step). Returns { watermark, caughtUp }: caughtUp once the rows the store had are all read.
    advance(cursorDb, { budgetMs = Infinity, clock = Date.now, chunkRows = CHUNK_ROWS } = {}) {
      const max = store.maxRowid(cursorDb);
      let watermark = index.watermark();
      // The anchor is the last blob read (anchorRowid 0: none yet). An index of an earlier version has an
      // anchor that is the key of any row, and no anchorRowid: the anchor is taken again from the store.
      if (get('anchorRowid') === undefined) {
        const last = watermark > 0 ? store.lastBlobAtOrBelow(cursorDb, watermark) : undefined;
        setAnchor(last);
      }
      let anchorRowid = Number(get('anchorRowid'));
      const anchor = get('anchor');
      if (anchor && store.rowidOf(cursorDb, anchor) !== anchorRowid) {
        // The rows were renumbered (VACUUM), or the blob was removed: the rows are read again (entries are
        // only added, so this adds nothing twice). Other rows removed and written again change nothing.
        watermark = 0;
        set('watermark', 0);
        setAnchor(undefined);
        anchorRowid = 0;
      } else if (watermark > max) {
        // The last rows were removed: none is left to read after the store's last row. The ones written next
        // may be given the same rowids; the check below finds them.
        watermark = max;
        set('watermark', watermark);
      }
      if (watermark > anchorRowid && store.lastBlobAtOrBelow(cursorDb, watermark, anchorRowid)) {
        // A blob under the watermark, after the last one read: the rowids of rows removed at the end were
        // given again. Those rows are read again.
        watermark = anchorRowid;
        set('watermark', watermark);
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
          if (blobs.length) setAnchor(blobs[blobs.length - 1]);
          if (to >= max) set('complete', 1);
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
