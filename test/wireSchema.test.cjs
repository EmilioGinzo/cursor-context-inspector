'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { extractSchema, loadSchema, parseValue } = require('../src/wire/schema.cjs');

// Small hand-written imitations of each pattern Cursor's bundles use.

// esbuild bundle (workbench, extension host): one scope per file.
const ESBUILD = [
  'var C={},M=class{},re={};var Msg,Kind,Other,Ts,TsAlias,T,Lvl,Svc,U;',
  'Kind=C.makeEnum("pkg.v1.Kind",[{no:0,name:"KIND_UNSPECIFIED",localName:"UNSPECIFIED"},{no:1,name:"KIND_A",localName:"A"}]),',
  'Msg=C.makeMessageType("pkg.v1.Msg",()=>[{no:1,name:"text",kind:"scalar",T:9},',
  '{no:2,name:"kind",kind:"enum",T:C.getEnumType(Kind)},{no:3,name:"others",kind:"message",T:Other,repeated:!0},',
  '{no:4,name:"a",kind:"message",T:Other,oneof:"pick"},{no:10,name:"b",kind:"scalar",T:9,oneof:"pick"},',
  '{no:5,name:"n",kind:"scalar",T:3,opt:!0,default:C.protoInt64.parse("7")},',
  '{no:6,name:"m",kind:"map",K:9,V:{kind:"message",T:Other}},{no:7,name:"e",kind:"map",K:5,V:{kind:"enum",T:C.getEnumType(Kind)}},',
  '{no:8,name:"ts",kind:"message",T:TsAlias},{no:9,name:"tee",kind:"message",T}]),',
  'Other=C.makeMessageType("pkg.v1.Other",()=>[{no:1,name:"b",kind:"scalar",T:12,default:new Uint8Array([1,2])},{no:2,name:"s",kind:"scalar",T:9,label:"a,b}"}],{localName:"Other"}),',
  'T=C.makeMessageType("pkg.v1.Tee",()=>[]);',
  '(e=>(e[e.X=0]="X",e))(Lvl||{}),C.util.setEnumType(Lvl,"pkg.v1.Level",[{no:0,name:"LEVEL_X"},{no:0,name:"LEVEL_ALIAS"}]);',
  'Ts=class Q extends M{constructor(t){super()}static fromBinary(t,n){return new Q().fromBinary(t,n)}},Ts.runtime=C,',
  'Ts.typeName="google.protobuf.Timestamp",Ts.fields=C.util.newFieldList(()=>[{no:1,name:"seconds",kind:"scalar",T:3},{no:2,name:"nanos",kind:"scalar",T:5}]),TsAlias=Ts;',
  'class Sx extends M{static typeName="pkg.v1.Static";static fields=C.util.newFieldList(()=>[{no:1,name:"s",kind:"scalar",T:8}])}',
  // The same minified name bound to two types in different scopes: ambiguous.
  'function f1(){var D=C.makeMessageType("pkg.v1.D1",()=>[])}function f2(){var D=C.makeMessageType("pkg.v1.D2",()=>[])}',
  'U=C.makeMessageType("pkg.v1.UsesD",()=>[{no:1,name:"d",kind:"message",T:D},{no:2,name:"g",kind:"message",T:Ghost}]);',
  'Svc={typeName:"pkg.v1.Svc",methods:{run:{name:"Run",I:Msg,O:Other,kind:re.BiDiStreaming},get:{name:"Get",I:Msg,O:Other,kind:re.Unary},',
  'up:{name:"Up",I:Msg,O:Other,kind:2},watch:{name:"Watch",I:Msg,O:Other,kind:re.ServerStreaming,idempotency:1}}};',
].join('');

// Minified webpack bundle with Cursor's compact classes, split over a chunk.
const WEBPACK_MAIN = [
  '(()=>{var e={10:(e,t,r)=>{"use strict";r.d(t,{HL:()=>i,QT:()=>a});class i extends M{}function a(){}},',
  '20:(e,t,r)=>{"use strict";r.d(t,{a:()=>l,K:()=>u});var n=r(99),s=r(10);const o="agent.v1.";',
  'class i extends s.HL{static get runtime(){return(0,s.kU)(this,"runtime",n.proto3)}static $p(){return o}}',
  'var u=(0,s.QT)(n.proto3,o,"ShellKind",[[0,"UNSPECIFIED"],[1,"LOCAL"]],1),c=(0,s.QT)(n.proto3,o,"Raw",[[0,"RAW_ZERO"],[1,"RAW_ONE"]]);',
  // Enums inside comma expressions, and with the helper required inline.
  'var w=(n.proto3,n.proto3,(0,s.QT)(n.proto3,o,"Mode",[[0,"UNSPECIFIED"],[1,"FAST"]],1)),x=(0,r(10).QT)(n.proto3,"agent.v1.","Inline",[[0,"INLINE_A"]]);',
  'class l extends i{constructor(e){super(),n.proto3.util.initPartial(e,this)}static equals(e,t){return n.proto3.util.equals(l,e,t)}',
  'static $(){return["ShellArgs|1 command 9|2 kind #0|3 env 9,9|4 raw #1?|5 kinds 9,#0",u,c]}}},',
  '30:(e,t,r)=>{"use strict";r.d(t,{S:()=>p});var n=r(99),s=r(10),a=r(20),q=r(50);',
  'class d extends s.HL{static $p(){return"agent.v1."}}',
  'class p extends d{static $(){return["ShellCall|1 args #0|2 list #0*|3 by_name 9,#0|4 text 9 result|5 ok 8 result|6 ts #1",a.a,q.Timestamp]}}',
  'const v={typeName:"agent.v1.AgentService",methods:{run:{name:"Run",I:a.a,O:p,kind:n.MethodKind.BiDiStreaming}}}}',
  '};})();',
].join('');
const WEBPACK_CHUNK = [
  'exports.id=1;exports.modules={40:(e,t,r)=>{"use strict";r.d(t,{Z:()=>z});var s=r(10),a=r(30);',
  'class b extends s.HL{static $p(){return"x.v1."}}class z extends b{static $(){return["UsesChunk|1 call #0|2 gone #1",a.S,a.nope]}}}};',
].join('');

// Unminified webpack bundle: array modules, comments, whitespace.
const WEBPACK_DEV = `/******/ (() => { // webpackBootstrap
/******/ 	var __webpack_modules__ = ([
/* 0 */,
/* 1 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

__webpack_require__.r(__webpack_exports__);
/* harmony export */ __webpack_require__.d(__webpack_exports__, {
/* harmony export */   Entry: () => (/* binding */ Entry)
/* harmony export */ });
/* harmony import */ var _external_bufbuild_protobuf_js__WEBPACK_IMPORTED_MODULE_0__ = __webpack_require__(9);
/**
 * @generated from message dev.v1.Entry
 */
const Entry = /*@__PURE__*/ _external_bufbuild_protobuf_js__WEBPACK_IMPORTED_MODULE_0__.proto3.makeMessageType(
  "dev.v1.Entry",
  () => [
    { no: 1, name: "name", kind: "scalar", T: 9 /* ScalarType.STRING */ },
    { no: 2, name: "flag", kind: "scalar", T: 8 /* ScalarType.BOOL */, opt: true },
    { no: 3, name: "empty", kind: "message", T: _external_bufbuild_protobuf_js__WEBPACK_IMPORTED_MODULE_0__.Empty },
  ],
);

/***/ }),
/* 2 */
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

/* harmony import */ var _entry_pb_js__WEBPACK_IMPORTED_MODULE_1__ = __webpack_require__(1);
const List = /*@__PURE__*/ _x.proto3.makeMessageType(
  "dev.v1.List",
  () => [
    { no: 1, name: "entries", kind: "message", T: _entry_pb_js__WEBPACK_IMPORTED_MODULE_1__.Entry, repeated: true },
  ],
);

/***/ })
/******/ 	]);
`;

function makeApp(files, product = { version: '9.9.9', commit: 'abc123' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-schema-'));
  fs.writeFileSync(path.join(dir, 'product.json'), JSON.stringify(product));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

const field = (schema, type, name) => schema.messages[type].fields.find((f) => f.name === name);

test('reads esbuild bundles: makeMessageType, makeEnum, setEnumType, classes, services', () => {
  const app = makeApp({ 'out/w.js': ESBUILD });
  const s = extractSchema(app);
  assert.deepStrictEqual(s.cursor, { version: '9.9.9', commit: 'abc123', appDir: app });

  assert.deepStrictEqual(field(s, 'pkg.v1.Msg', 'text'), { no: 1, name: 'text', kind: 'scalar', T: 9, repeated: false, oneof: null, opt: false });
  assert.deepStrictEqual(field(s, 'pkg.v1.Msg', 'kind'), { no: 2, name: 'kind', kind: 'enum', T: 'pkg.v1.Kind', repeated: false, oneof: null, opt: false });
  assert.deepStrictEqual(field(s, 'pkg.v1.Msg', 'others'), { no: 3, name: 'others', kind: 'message', T: 'pkg.v1.Other', repeated: true, oneof: null, opt: false });
  assert.strictEqual(field(s, 'pkg.v1.Msg', 'a').oneof, 'pick');
  assert.strictEqual(field(s, 'pkg.v1.Msg', 'b').oneof, 'pick');
  assert.strictEqual(field(s, 'pkg.v1.Msg', 'n').opt, true);
  assert.deepStrictEqual(field(s, 'pkg.v1.Msg', 'm'), { no: 6, name: 'm', kind: 'map', K: 9, V: { kind: 'message', T: 'pkg.v1.Other' }, repeated: false, oneof: null, opt: false });
  assert.deepStrictEqual(field(s, 'pkg.v1.Msg', 'e').V, { kind: 'enum', T: 'pkg.v1.Kind' });
  assert.strictEqual(field(s, 'pkg.v1.Msg', 'ts').T, 'google.protobuf.Timestamp', 'through the alias TsAlias=Ts');
  assert.strictEqual(field(s, 'pkg.v1.Msg', 'tee').T, 'pkg.v1.Tee', 'shorthand {T}');
  assert.deepStrictEqual(s.messages['pkg.v1.Other'].fields.map((f) => [f.name, f.T]), [['b', 12], ['s', 9]]);
  assert.deepStrictEqual(s.messages['google.protobuf.Timestamp'].fields.map((f) => [f.no, f.name, f.T]), [[1, 'seconds', 3], [2, 'nanos', 5]]);
  assert.deepStrictEqual(s.messages['pkg.v1.Static'].fields.map((f) => [f.name, f.T]), [['s', 8]]);

  assert.deepStrictEqual(s.enums['pkg.v1.Kind'], { 0: 'KIND_UNSPECIFIED', 1: 'KIND_A' });
  assert.deepStrictEqual(s.enums['pkg.v1.Level'], { 0: 'LEVEL_X' });

  assert.deepStrictEqual(s.services['pkg.v1.Svc'].methods, {
    Run: { I: 'pkg.v1.Msg', O: 'pkg.v1.Other', kind: 'bidi_streaming' },
    Get: { I: 'pkg.v1.Msg', O: 'pkg.v1.Other', kind: 'unary' },
    Up: { I: 'pkg.v1.Msg', O: 'pkg.v1.Other', kind: 'client_streaming' },
    Watch: { I: 'pkg.v1.Msg', O: 'pkg.v1.Other', kind: 'server_streaming' },
  });
});

test('reports ambiguous and missing references instead of guessing', () => {
  const s = extractSchema(makeApp({ 'out/w.js': ESBUILD }));
  assert.strictEqual(field(s, 'pkg.v1.UsesD', 'd').T, null);
  assert.strictEqual(field(s, 'pkg.v1.UsesD', 'g').T, null);
  assert.deepStrictEqual(s.unresolved, [
    { file: 'out/w.js', type: 'pkg.v1.UsesD', field: 'd', ref: 'D' },
    { file: 'out/w.js', type: 'pkg.v1.UsesD', field: 'g', ref: 'Ghost' },
  ]);
});

test('reads compact classes across webpack modules and chunks', () => {
  const s = extractSchema(makeApp({
    'extensions/x/dist/main.js': WEBPACK_MAIN,
    'extensions/x/dist/1.js': WEBPACK_CHUNK,
  }));
  assert.deepStrictEqual(s.messages['agent.v1.ShellArgs'].fields, [
    { no: 1, name: 'command', kind: 'scalar', T: 9, repeated: false, oneof: null, opt: false },
    { no: 2, name: 'kind', kind: 'enum', T: 'agent.v1.ShellKind', repeated: false, oneof: null, opt: false },
    { no: 3, name: 'env', kind: 'map', K: 9, V: { kind: 'scalar', T: 9 }, repeated: false, oneof: null, opt: false },
    { no: 4, name: 'raw', kind: 'enum', T: 'agent.v1.Raw', repeated: false, oneof: null, opt: true },
    { no: 5, name: 'kinds', kind: 'map', K: 9, V: { kind: 'enum', T: 'agent.v1.ShellKind' }, repeated: false, oneof: null, opt: false },
  ]);
  const call = s.messages['agent.v1.ShellCall'].fields;
  assert.deepStrictEqual(call.map((f) => [f.name, f.kind, f.T, f.repeated, f.oneof]), [
    ['args', 'message', 'agent.v1.ShellArgs', false, null],
    ['list', 'message', 'agent.v1.ShellArgs', true, null],
    ['by_name', 'map', undefined, false, null],
    ['text', 'scalar', 9, false, 'result'],
    ['ok', 'scalar', 8, false, 'result'],
    ['ts', 'message', 'google.protobuf.Timestamp', false, null],
  ]);
  assert.deepStrictEqual(call[2].V, { kind: 'message', T: 'agent.v1.ShellArgs' });

  // Mode 1 enums list names without the ENUM_NAME_ prefix; others in full.
  assert.deepStrictEqual(s.enums['agent.v1.ShellKind'], { 0: 'SHELL_KIND_UNSPECIFIED', 1: 'SHELL_KIND_LOCAL' });
  assert.deepStrictEqual(s.enums['agent.v1.Raw'], { 0: 'RAW_ZERO', 1: 'RAW_ONE' });
  assert.deepStrictEqual(s.enums['agent.v1.Mode'], { 0: 'MODE_UNSPECIFIED', 1: 'MODE_FAST' });
  assert.deepStrictEqual(s.enums['agent.v1.Inline'], { 0: 'INLINE_A' });

  assert.deepStrictEqual(s.services['agent.v1.AgentService'].methods.Run,
    { I: 'agent.v1.ShellArgs', O: 'agent.v1.ShellCall', kind: 'bidi_streaming' });

  // The chunk imports module 30 from main.js; a.nope is exported by nobody.
  assert.deepStrictEqual(s.messages['x.v1.UsesChunk'].fields, [
    { no: 1, name: 'call', kind: 'message', T: 'agent.v1.ShellCall', repeated: false, oneof: null, opt: false },
    { no: 2, name: 'gone', kind: null, T: null, repeated: false, oneof: null, opt: false },
  ]);
  assert.deepStrictEqual(s.unresolved, [{ file: 'extensions/x/dist/1.js', type: 'x.v1.UsesChunk', field: 'gone', ref: 'a.nope' }]);
});

test('reads unminified webpack bundles with comments', () => {
  const s = extractSchema(makeApp({ 'extensions/y/dist/browser/main.js': WEBPACK_DEV }));
  assert.deepStrictEqual(s.messages['dev.v1.Entry'].fields.map((f) => [f.name, f.kind, f.T, f.opt]), [
    ['name', 'scalar', 9, false],
    ['flag', 'scalar', 8, true],
    ['empty', 'message', 'google.protobuf.Empty', false],
  ]);
  assert.deepStrictEqual(field(s, 'dev.v1.List', 'entries'),
    { no: 1, name: 'entries', kind: 'message', T: 'dev.v1.Entry', repeated: true, oneof: null, opt: false });
  assert.deepStrictEqual(s.unresolved, []);
});

test('merges bundles, preferring the copy that resolves', () => {
  const broken = 'var C={};A=C.makeMessageType("pkg.v1.Msg",()=>[{no:1,name:"o",kind:"message",T:Nope}]);';
  const good = 'var C={};B=C.makeMessageType("pkg.v1.O",()=>[]),A=C.makeMessageType("pkg.v1.Msg",()=>[{no:1,name:"o",kind:"message",T:B}]);';
  const s = extractSchema(makeApp({ 'out/a.js': broken, 'out/b.js': good }));
  assert.strictEqual(field(s, 'pkg.v1.Msg', 'o').T, 'pkg.v1.O');
  assert.deepStrictEqual(s.unresolved, []);
});

test('skips node_modules and files without protobuf code', () => {
  const s = extractSchema(makeApp({
    'node_modules/dep/index.js': 'X=C.makeMessageType("dep.Msg",()=>[]);',
    'out/plain.js': 'console.log("hi")',
  }));
  assert.deepStrictEqual([s.messages, s.enums, s.services], [{}, {}, {}]);
});

test('loadSchema caches per Cursor version and commit', () => {
  const app = makeApp({ 'out/w.js': 'var C={};A=C.makeMessageType("pkg.v1.First",()=>[]);' });
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wire-schema-cache-'));
  const first = loadSchema({ appDir: app, cacheDir });
  assert.ok(fs.existsSync(path.join(cacheDir, '9.9.9-abc123.json')));
  fs.writeFileSync(path.join(app, 'out/w.js'), 'var C={};A=C.makeMessageType("pkg.v1.Second",()=>[]);');
  assert.deepStrictEqual(loadSchema({ appDir: app, cacheDir }), first);
  assert.deepStrictEqual(Object.keys(first.messages), ['pkg.v1.First']);
  assert.deepStrictEqual(fs.readdirSync(cacheDir), ['9.9.9-abc123.json'], 'no temp files left');
});

test('parseValue reads the literals generated code uses', () => {
  const v = parseValue('{a:1e3,b:-2,c:0x1F,d:"q\\"\\u0041\\x42",e:\'s\',f:!0,g:!1,h:void 0,i:x.y(1,[2]),j:[1,{k:true}]}', 0).value;
  assert.deepStrictEqual(v, { a: 1000, b: -2, c: 31, d: 'q"AB', e: 's', f: true, g: false, h: undefined, i: { expr: 'x.y(1,[2])' }, j: [1, { k: true }] });
});
