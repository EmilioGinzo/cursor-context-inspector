'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const requests = require('../src/requests.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'requests-'));

test('requests wait until answered, each chat on its own', () => {
  const dir = tmp();
  requests.ask(dir, 'x', 1000);
  requests.ask(dir, 'y', 1100);
  assert.deepStrictEqual(requests.waiting(dir, 1200), ['x', 'y']);
  // Both answered in one tick: neither answer hides the other.
  requests.answer(dir, ['x'], { y: 'truncated varint' }, 1300);
  assert.deepStrictEqual(requests.waiting(dir, 1400), []);
  assert.deepStrictEqual(requests.answerTo(dir, 'x', 1000), { at: 1300 });
  assert.deepStrictEqual(requests.answerTo(dir, 'y', 1100), { at: 1300, error: 'truncated varint' });
  // Asked again after its answer: waiting again, and the old answer is not its answer.
  requests.ask(dir, 'x', 1500);
  assert.deepStrictEqual(requests.waiting(dir, 1600), ['x']);
  assert.strictEqual(requests.answerTo(dir, 'x', 1500), undefined);
});

test('a request is dropped after REQUEST_MS, and unreadable files ask for nothing', () => {
  const dir = tmp();
  requests.ask(dir, 'x', 0);
  assert.deepStrictEqual(requests.waiting(dir, requests.REQUEST_MS - 1), ['x']);
  assert.deepStrictEqual(requests.waiting(dir, requests.REQUEST_MS), []);
  fs.writeFileSync(requests.requestFile(dir), '["x"]');
  assert.deepStrictEqual(requests.waiting(dir, 1), []);
  fs.writeFileSync(requests.requestFile(dir), '{"x": "soon"}');
  assert.deepStrictEqual(requests.waiting(dir, 1), []);
});
