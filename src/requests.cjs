'use strict';

// Record Focused Chat Now asks every window's recorder for a chat in requestFile ({ id: asked at }); the
// window that records it answers in answerFile ({ id: { at, error? } }). A request waits until answered,
// for at most REQUEST_MS (the store's first read can take minutes).

const fs = require('node:fs');
const path = require('node:path');

const REQUEST_MS = 30 * 60000;
const requestFile = (dir) => path.resolve(dir, '.context-inspector-record-requests.json');
const answerFile = (dir) => path.resolve(dir, '.context-inspector-record-answers.json');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

// The entries of the last REQUEST_MS; `at` gives an entry's time.
function recent(map, now, at = (v) => v) {
  const entries = map && typeof map === 'object' && !Array.isArray(map) ? Object.entries(map) : [];
  return Object.fromEntries(entries.filter(([, v]) => typeof at(v) === 'number' && now - at(v) < REQUEST_MS));
}

// Asks for chat `id`, at time `at`.
function ask(dir, id, at = Date.now()) {
  writeJson(requestFile(dir), { ...recent(readJson(requestFile(dir)), at), [id]: at });
}

// The ids asked for and not answered since.
function waiting(dir, now = Date.now()) {
  const answers = readJson(answerFile(dir)) || {};
  return Object.entries(recent(readJson(requestFile(dir)), now))
    .filter(([id, at]) => !(answers[id] && answers[id].at >= at))
    .map(([id]) => id);
}

// Answers the chats recorded (ids) and the ones that failed ({ id: error }).
function answer(dir, recorded, failed, now = Date.now()) {
  if (!recorded.length && !Object.keys(failed).length) return;
  const answers = recent(readJson(answerFile(dir)), now, (v) => v && v.at);
  for (const id of recorded) answers[id] = { at: now };
  for (const [id, error] of Object.entries(failed)) answers[id] = { at: now, error };
  writeJson(answerFile(dir), answers);
}

// The answer to a request for chat `id` made at `asked` ({ at, error? }), or undefined.
function answerTo(dir, id, asked) {
  const got = (readJson(answerFile(dir)) || {})[id];
  return got && got.at >= asked ? got : undefined;
}

module.exports = { REQUEST_MS, requestFile, answerFile, ask, waiting, answer, answerTo };
