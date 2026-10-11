'use strict';

// Which MCP servers Cursor had connected at a time, from Cursor's own logs (~/.config/Cursor/logs,
// one folder per launch: <YYYYMMDDTHHMMSS>/). The request carries a server's tools and instructions
// only while it is connected: a server that is not is still listed, with no tools and no
// instructions. Captured: chat 59ad4195 sent two servers with 0 tools while their folders had 21
// and 13 (their connection attempts had failed: see below).
//
// Evidence, per server, in time order (the log lines are in local time, as the machine's clock):
//   "createClient completed for server: <id>, connected=... | statusType=..., success=..." in the workbench
//     logs (window*/workbench.mcp.files.log, window*/mcp-server-<id>.workbench.log): the outcome of a client;
//   "Successfully connected to streamableHttp server" and "Transient error connecting to streamableHttp
//     server" in <launch>/mcp-server-<id>.log: a connection's outcome (the server's own log);
//   "stopped connection: <id>" (the MCP process logs): stopped, so not connected.
// The last of that evidence before the time decides, if it is recent: a server that failed while Cursor
// retried it (every few seconds to a few tens of seconds in the captured logs) is down until it
// connects again; but a server that recovered is not logged again, so a failure more than RECENT_MS
// before the time says nothing. A server with no recent evidence is taken as connected: Cursor's
// built-in servers log nothing here, and they are the usual case.

const fs = require('node:fs');
const path = require('node:path');

const LAUNCH = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/;
const LINE_TIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3}) /;
const OUTCOME = /createClient completed for server: ([^,\s]+), (?:connected=(true|false)|statusType=\w+, success=(true|false))/;
const CONNECTED = /Successfully connected to streamableHttp server/;
const TRANSIENT = /Transient error connecting to streamableHttp server/;
const STOPPED = /stopped connection: ([^\s,]+)/;
// Launches to read: the latest ones that started before the time (an event before it is in one of them).
const LAUNCHES = 4;
// A failure this long before the time still means the server is down (see the header).
const RECENT_MS = 3 * 60 * 1000;

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n');
  } catch {
    return [];
  }
}

// The launch folders that began at or before `at`, latest first.
function launchesBefore(logsDir, at) {
  let names = [];
  try {
    names = fs.readdirSync(logsDir);
  } catch {
    return [];
  }
  return names.map((name) => {
    const m = LAUNCH.exec(name);
    return m ? { dir: path.join(logsDir, name), start: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() } : undefined;
  }).filter((l) => l && l.start <= at).sort((a, b) => b.start - a.start).slice(0, LAUNCHES);
}

// The log files of a launch that say which servers connected: its own and its windows'.
function logFiles(launch) {
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(launch);
  } catch {
    return out;
  }
  for (const n of names) {
    if ((/^mcp-server-.+\.log$/.test(n) && !n.endsWith('.workbench.log')) || n === 'mcpprocess.log') out.push(path.join(launch, n));
    if (/^window\d+$/.test(n)) {
      try {
        for (const f of fs.readdirSync(path.join(launch, n))) {
          if (/^(workbench\.mcp\.[\w.]+|mcp-server-.+\.workbench)\.log$/.test(f)) out.push(path.join(launch, n, f));
        }
      } catch {
        /* no window folder */
      }
    }
  }
  return out;
}

// Every outcome in the launches before `at`: [{ at, server, up }], in time order.
function evidence(logsDir, at) {
  const events = [];
  for (const launch of launchesBefore(logsDir, at)) {
    for (const file of logFiles(launch.dir)) {
      const base = path.basename(file);
      // A server's own log (not a window's workbench one): its failed attempts.
      const own = !base.endsWith('.workbench.log') ? /^mcp-server-(.+)\.log$/.exec(base) : null;
      for (const line of readLines(file)) {
        const t = LINE_TIME.exec(line);
        if (!t) continue;
        const when = new Date(`${t[1]}T${t[2]}`).getTime();
        if (!Number.isFinite(when) || when > at) continue;
        const outcome = OUTCOME.exec(line);
        const stopped = STOPPED.exec(line);
        if (outcome) events.push({ at: when, server: outcome[1], up: (outcome[2] ?? outcome[3]) === 'true' });
        else if (own && CONNECTED.test(line)) events.push({ at: when, server: own[1], up: true });
        else if (own && TRANSIENT.test(line)) events.push({ at: when, server: own[1], up: false });
        else if (stopped) events.push({ at: when, server: stopped[1], up: false });
      }
    }
  }
  return events.sort((a, b) => a.at - b.at);
}

// { server id: false (not connected) or true (connected: its last outcome was a success) } at the
// time; a server with no recent evidence is left out. undefined when no launch of Cursor is in the
// logs (nothing is known: every server is taken as connected).
function connectionsAt(logsDir, at) {
  if (!launchesBefore(logsDir, at).length) return undefined;
  const last = new Map();
  for (const e of evidence(logsDir, at)) last.set(e.server, e);
  const out = new Map();
  for (const [server, e] of last) {
    if (e.up) out.set(server, true);
    else if (at - e.at <= RECENT_MS) out.set(server, false);
  }
  return out;
}

// Whether a server was connected per a connectionsAt() result (none known: connected).
const isConnected = (connections, server) => !connections || connections.get(server) !== false;

module.exports = { connectionsAt, evidence, isConnected, launchesBefore };
