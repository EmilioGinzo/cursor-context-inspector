'use strict';

const test = require('node:test');
const assert = require('node:assert');
const pb = require('./protoEncode.cjs');
const { turnHashes, placeThinking } = require('../src/turnSteps.cjs');

const thinking = (hash, text) => ({ hash, kind: 'thinking', text });
const text = (hash, t) => ({ hash, kind: 'text', text: t });
// A tool call step: its bytes hold the call's id and arguments somewhere.
const tool = (hash, ...strings) => ({ hash, kind: 'tool-call', data: Buffer.concat(strings.map((s, i) => pb.len(i + 1, s))) });
const assistant = (hash, ...content) => ({ hash, message: { role: 'assistant', content } });
const R = { type: 'redacted-reasoning', data: 'AAAA' };
const where = (entries) => entries.map((e) => [e.step, e.message, e.part]);

test('turnHashes reads the turn blob ids (field 8) of the conversation state', () => {
  const a = Buffer.alloc(32, 1);
  const b = Buffer.alloc(32, 2);
  const state = Buffer.concat([pb.len(1, Buffer.alloc(32, 9)), pb.len(8, a), pb.v(17, 1), pb.len(8, b)]);
  assert.deepStrictEqual(turnHashes(`~${state.toString('base64')}`), [a.toString('hex'), b.toString('hex')]);
  assert.deepStrictEqual(turnHashes(undefined), []);
});

test('thinking goes to the message of the text or tool call after it, on its reasoning part', () => {
  const messages = [
    { hash: 'u', message: { role: 'user', content: 'hi' } },
    assistant('a1', R, { type: 'text', text: 'Looking.' }, { type: 'tool-call', toolCallId: 'call_1', toolName: 'Shell', args: { command: 'ls' } }),
    { hash: 't', message: { role: 'tool', content: [] } },
    // A response that thought again between its tool calls: both runs of thinking are on it.
    assistant('a2', R, { type: 'tool-call', toolCallId: 'call_2', toolName: 'Read', args: { path: '/x' } }, R, { type: 'tool-call', toolCallId: 'call_3', toolName: 'Shell', args: { command: 'make' } }),
    assistant('a3', R, { type: 'tool-call', toolCallId: 'call_4', toolName: 'Shell', args: { command: 'make' } }),
    // Thinking with nothing after it: the next message with a reasoning part.
    assistant('a4', { type: 'reasoning', text: 'shown' }),
  ];
  const turns = [{ turn: 'T', steps: [
    thinking('s1', 'plan'), text('s2', ' Looking. '), tool('s3', 'call_1', 'ls'),
    thinking('s4', 'read x'), tool('s5', 'call_2', '/x'),
    thinking('s6', 'build'), tool('s7', 'call_3', 'make'),
    thinking('s8', 'again'), thinking('s9', 'more'), tool('s10', 'call_4', 'make'),
    thinking('s11', 'last'),
  ] }];
  assert.deepStrictEqual(where(placeThinking(turns, messages)), [
    ['s1', 'a1', 0], ['s4', 'a2', 0], ['s6', 'a2', 2], ['s8', 'a3', 0], ['s9', 'a3', null], ['s11', 'a4', 0],
  ]);
});

test('a tool call is matched by its id only: a later call with the same arguments is another message', () => {
  // The record lacks the message of call_1; call_2 ran the same command later.
  const messages = [assistant('a2', R, { type: 'tool-call', toolCallId: 'call_2', toolName: 'Shell', args: { command: 'git status' } })];
  const turns = [{ turn: 'T', steps: [
    thinking('s1', 'check'), tool('s2', 'call_1', 'git status'),
    thinking('s3', 'check again'), tool('s4', 'call_2', 'git status'),
  ] }];
  assert.deepStrictEqual(where(placeThinking(turns, messages)), [['s1', null, null], ['s3', 'a2', 0]]);
});

test('thinking whose message the record lacks stays unplaced, and does not take another\'s', () => {
  const messages = [assistant('a1', R, { type: 'text', text: 'Second.' })];
  const turns = [
    { turn: 'T1', steps: [thinking('s1', 'gone'), text('s2', 'First.')] },
    { turn: 'T2', steps: [thinking('s3', 'kept'), text('s4', 'Second.')] },
  ];
  assert.deepStrictEqual(where(placeThinking(turns, messages)), [['s1', null, null], ['s3', 'a1', 0]]);
});
