'use strict';

// Which MCP servers Cursor had connected at a time, from Cursor's own logs (~/.config/Cursor/logs,
// one folder per launch: <YYYYMMDDTHHMMSS>/). The request carries a server's tools and instructions
// only while it is connected: a server that is not is still listed, with no tools and no
// instructions. Captured: chat 59ad4195 sent two servers with 0 tools while their folders had 21
// and 13 (their connection attempts had failed: see below).
//
// Evidence, per server, in time order (the log lines are in local time, as the machine's clock):
//   "createClient completed for server: <id>, connected=true|false" in the workbench logs
//     (window*/workbench.mcp.files.log, window*/mcp-server-<id>.workbench.log): the outcome of an attempt;
//   "Transient error connecting to streamableHttp server" in <launch>/mcp-server-<id>.log: a failed attempt.
// The last of that evidence before the time decides. A server with none before it is taken as
// connected: Cursor's built-in servers log nothing here, and they are the usual case.

const fs = require('node:fs');
const path = require('node:path');

const LAUNCH = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/;
const LINE_TIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3}) /;
const OUTCOME = /createClient completed for server: ([^,\s]+), connected=(true|false)/;
const TRANSIENT = /Transient error connecting to streamableHttp server/;
// Launches to read: the latest ones that started before the time (an event before it is in one of them).
const LAUNCHES = 4;

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
    if (/^mcp-server-.+\.log$/.test(n) && !n.endsWith('.workbench.log')) out.push(path.join(launch, n));
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
        if (outcome) events.push({ at: when, server: outcome[1], up: outcome[2] === 'true' });
        else if (own && TRANSIENT.test(line)) events.push({ at: when, server: own[1], up: false });
      }
    }
  }
  return events.sort((a, b) => a.at - b.at);
}

// { server id: connected (true | false) } at the time, from the evidence before it; undefined when
// no launch of Cursor is in the logs (nothing is known: every server is taken as connected).
function connectionsAt(logsDir, at) {
  if (!launchesBefore(logsDir, at).length) return undefined;
  const out = new Map();
  for (const e of evidence(logsDir, at)) out.set(e.server, e.up);
  return out;
}

// Whether a server was connected per a connectionsAt() result (none known: connected).
const isConnected = (connections, server) => !connections || connections.get(server) !== false;

module.exports = { connectionsAt, evidence, isConnected, launchesBefore };
