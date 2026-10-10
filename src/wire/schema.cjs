'use strict';

// Extracts Cursor's protobuf schema (messages, enums, RPC services) from the
// protobuf-es code generated into its JS bundles, so captured gRPC/Connect
// traffic can be decoded field by field.
//
// Patterns handled (all minified; names like `C`, `Jce`, `s.a` vary per bundle):
//   X=C.makeMessageType("pkg.Msg",()=>[{no:1,name:"text",kind:"scalar",T:9},...])
//   X=C.makeEnum("pkg.Enum",[{no:0,name:"ENUM_UNSPECIFIED",localName:"UNSPECIFIED"},...])
//   C.util.setEnumType(X,"pkg.Enum",[{no:0,name:"..."},...])
//   X=class Y extends M{...},X.typeName="pkg.Msg",X.fields=C.util.newFieldList(()=>[...])
//   class X extends M{static typeName="pkg.Msg";static fields=C.util.newFieldList(()=>[...])}
//   Cursor's compact classes (agent extensions, webpack):
//     class B extends H{static get runtime(){...}static $p(){return"agent.v1."}}
//     class X extends B{...static $(){return["Msg|1 args #0|2 out 9?|3 a #1 result|4 m 9,#2",s.a,l,c]}}
//     where a type is a ScalarType number or #<index into the refs>, a trailing
//     ? means opt, * repeated, a 4th word is the oneof, and K,V is a map.
//     X=(0,s.QT)(n.proto3,"agent.v1.","Enum",[[0,"UNSPECIFIED"],...],1)
//   {typeName:"pkg.Svc",methods:{run:{name:"Run",I:x,O:y,kind:K.BiDiStreaming}}}
//
// Field types (T) are minified variables. They are resolved in the scope that
// defines them: the webpack module (following r(<id>) imports and r.d exports
// across the files of one dist/ folder), else the whole file. A reference
// that matches no definition, or several different ones, is reported in
// `unresolved` instead of being guessed; its field keeps T: null (and, for
// compact classes, kind: null, since only the target tells message from enum).
// When bundles disagree, the copy with fewer unresolved refs wins, then the
// one with more fields (on Cursor 3.22 every resolved copy agrees).
//
// Enum value names are kept as the bundle registers them with protobuf-es:
// the full proto names (LINT_SEVERITY_ERROR), not the stripped localName.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_APP_DIR = '/usr/share/cursor/resources/app';
const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.cursor-wire', 'schema');

const METHOD_KINDS = {
  Unary: 'unary', ServerStreaming: 'server_streaming',
  ClientStreaming: 'client_streaming', BiDiStreaming: 'bidi_streaming',
};
const METHOD_KIND_NUMBERS = ['unary', 'server_streaming', 'client_streaming', 'bidi_streaming'];

// Cheap test for files worth parsing.
const MARKERS = ['makeMessageType(', 'newFieldList(', 'makeEnum(', 'setEnumType(', '$p(){', 'methods:{'];

// ---------------------------------------------------------------------------
// Minimal JS literal reader: enough for the object/array literals protobuf-es
// code generators emit. Anything else becomes { expr: "<source text>" }.

const IDENT = /[\w$]/;

// Skips whitespace and comments.
function skipWs(src, i) {
  for (;;) {
    while (i < src.length && /\s/.test(src[i])) i++;
    if (src[i] !== '/') return i;
    if (src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
    } else if (src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      i = end === -1 ? src.length : end + 1;
    } else return i;
  }
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim();
}

function skipString(src, i) {
  const q = src[i];
  for (i++; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') i++;
    else if (c === q) return i + 1;
    else if (q === '`' && c === '$' && src[i + 1] === '{') i = skipBalanced(src, i + 1) - 1;
  }
  return src.length;
}

// i at an opening bracket; returns the index just past its match.
function skipBalanced(src, i) {
  let depth = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i); continue; }
    if (c === '/' && (src[i + 1] === '*' || src[i + 1] === '/')) { i = skipWs(src, i); continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return src.length;
}

function unquote(s) {
  let out = '';
  for (let i = 1; i < s.length - 1; i++) {
    const c = s[i];
    if (c !== '\\') { out += c; continue; }
    const n = s[++i];
    if (n === 'n') out += '\n';
    else if (n === 't') out += '\t';
    else if (n === 'r') out += '\r';
    else if (n === '0') out += '\0';
    else if (n === 'x') { out += String.fromCharCode(parseInt(s.slice(i + 1, i + 3), 16)); i += 2; }
    else if (n === 'u' && s[i + 1] === '{') {
      const end = s.indexOf('}', i);
      out += String.fromCodePoint(parseInt(s.slice(i + 2, end), 16));
      i = end;
    } else if (n === 'u') { out += String.fromCharCode(parseInt(s.slice(i + 1, i + 5), 16)); i += 4; }
    else out += n;
  }
  return out;
}

const NUMBER = /-?(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/y;
const WORD = /(true|false|undefined|null)(?![\w$.])/y;
const WORDS = { true: true, false: false, undefined: undefined, null: null };

function parseValue(src, i) {
  i = skipWs(src, i);
  const c = src[i];
  if (c === '{') return parseObject(src, i);
  if (c === '[') return parseArray(src, i);
  if (c === '"' || c === "'") {
    const end = skipString(src, i);
    return { value: unquote(src.slice(i, end)), end };
  }
  if (c === '!' && (src[i + 1] === '0' || src[i + 1] === '1') && !IDENT.test(src[i + 2] || '')) {
    return { value: src[i + 1] === '0', end: i + 2 };
  }
  WORD.lastIndex = i;
  const w = WORD.exec(src);
  if (w) return { value: WORDS[w[1]], end: i + w[1].length };
  NUMBER.lastIndex = i;
  const m = NUMBER.exec(src);
  if (m && !/[\w$.]/.test(src[i + m[0].length] || '')) return { value: Number(m[0]), end: i + m[0].length };
  // Any other expression: up to the next , } ] at depth 0.
  let j = i;
  while (j < src.length) {
    const d = src[j];
    if (d === ',' || d === '}' || d === ']') break;
    if (d === '"' || d === "'" || d === '`') { j = skipString(src, j); continue; }
    if (d === '/' && (src[j + 1] === '*' || src[j + 1] === '/')) { j = skipWs(src, j); continue; }
    if (d === '(' || d === '[' || d === '{') { j = skipBalanced(src, j); continue; }
    if (d === ')') break;
    j++;
  }
  const text = stripComments(src.slice(i, j));
  return { value: text === 'void 0' ? undefined : { expr: text }, end: j };
}

function parseObject(src, i) {
  const obj = {};
  i++;
  for (;;) {
    i = skipWs(src, i);
    if (src[i] === '}') return { value: obj, end: i + 1 };
    let key;
    if (src[i] === '"' || src[i] === "'") {
      const end = skipString(src, i);
      key = unquote(src.slice(i, end));
      i = end;
    } else {
      const start = i;
      while (i < src.length && IDENT.test(src[i])) i++;
      key = src.slice(start, i);
      if (!key) throw new SyntaxError(`unexpected ${JSON.stringify(src[i])} at ${i}`);
    }
    i = skipWs(src, i);
    if (src[i] === '(') { // method shorthand: key(){...}
      i = skipBalanced(src, skipWs(src, skipBalanced(src, i)));
      obj[key] = { expr: 'function' };
    } else if (src[i] === ',' || src[i] === '}') { // shorthand: {T} when the variable is named T
      obj[key] = { expr: key };
    } else {
      if (src[i] !== ':') throw new SyntaxError(`expected : at ${i}`);
      const v = parseValue(src, i + 1);
      obj[key] = v.value;
      i = v.end;
    }
    i = skipWs(src, i);
    if (src[i] === ',') i++;
    else if (src[i] !== '}') throw new SyntaxError(`expected , or } at ${i}`);
  }
}

function parseArray(src, i) {
  const arr = [];
  i++;
  for (;;) {
    i = skipWs(src, i);
    if (src[i] === ']') return { value: arr, end: i + 1 };
    const v = parseValue(src, i);
    arr.push(v.value);
    i = skipWs(src, v.end);
    if (src[i] === ',') i++;
    else if (src[i] !== ']') throw new SyntaxError(`expected , or ] at ${i}`);
  }
}

// At the start of a field list argument: `()=>[`, `function(){return[` or `[`.
function parseFieldListArg(src, i) {
  i = skipWs(src, i);
  if (src[i] !== '[') {
    const open = src.indexOf('[', i);
    if (open === -1 || open - i > 40) throw new SyntaxError(`no field list at ${i}`);
    i = open;
  }
  return parseArray(src, i).value;
}

// ---------------------------------------------------------------------------
// Reference expressions: Jce, s.a, (0,s.a), C.getEnumType(kr), ()=>l

function parseRef(expr) {
  let e = stripComments(expr).replace(/\s+/g, '');
  let m;
  if ((m = /^(?:\(\)=>|function\(\)\{return)(.*?)\}?$/.exec(e))) e = m[1];
  while ((m = /^\((.*)\)$/.exec(e))) e = m[1];
  if ((m = /^[\w$.]*getEnumType\((.*)\)$/.exec(e))) e = m[1];
  if ((m = /^\(?0,(.*?)\)?$/.exec(e))) e = m[1];
  if (/^[\w$]+$/.test(e)) return { ident: e };
  if ((m = /^([\w$]+)\.([\w$]+)$/.exec(e))) return { object: m[1], prop: m[2], ident: e };
  return null;
}

// ---------------------------------------------------------------------------
// Per-file scanning

function moduleHeaders(src) {
  // webpack: ,12345:(e,t,r)=>{  ,12345:function(e,t,r){  or, unminified,
  //   /***/ 59:
  //   /***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {
  const re = /(?:^|[{,])[ \t]*(?:\/\*+\/[ \t]*)?(\d+):\s*(?:\/\*+\/\s*)?\(?(?:\(([\w$,\s]*)\)\s*=>|function\s*\(([\w$,\s]*)\)|([\w$]+)\s*=>)\s*\{/gm;
  // or, in array form, with the id only in a comment:
  //   /* 59 */
  //   /***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {
  const arrayRe = /^\/\* (\d+) \*\/\n\/\*\*\*\/ \(\(?(?:\(([\w$,\s]*)\)\s*=>|function\s*\(([\w$,\s]*)\)|([\w$]+)\s*=>)\s*\{/gm;
  const out = [];
  for (const r of [re, arrayRe]) {
    for (let m; (m = r.exec(src));) {
      const params = (m[2] ?? m[3] ?? m[4] ?? '').split(',').map((p) => p.trim());
      out.push({ pos: m.index + 1, id: m[1], exportsParam: params[1], requireParam: params[2] });
    }
  }
  out.sort((a, b) => a.pos - b.pos);
  return out;
}

function scanFile(file, src) {
  const rec = { file, src, headers: moduleHeaders(src), defs: new Map(), messages: [], enums: [], services: [], prefixClasses: [], errors: 0 };
  const addDef = (ident, def) => {
    def.ident = ident;
    def.pos ??= 0;
    if (!rec.defs.has(ident)) rec.defs.set(ident, []);
    rec.defs.get(ident).push(def);
  };
  const lhsBefore = (at) => {
    const m = /([\w$]+(?:\.[\w$]+)?)\s*=\s*(?:\/\*[^*]*\*\/\s*)*$/.exec(src.slice(Math.max(0, at - 120), at));
    return m && m[1];
  };
  // A pattern match that turns out not to be generated code is skipped.
  const tryParse = (fn) => {
    try { fn(); } catch { rec.errors++; }
  };

  // makeMessageType / makeEnum
  for (const [needle, kind] of [['.makeMessageType(', 'message'], ['.makeEnum(', 'enum']]) {
    for (let at = src.indexOf(needle); at !== -1; at = src.indexOf(needle, at + 1)) {
      tryParse(() => {
        let i = skipWs(src, at + needle.length);
        if (src[i] !== '"' && src[i] !== "'") return;
        const end = skipString(src, i);
        const typeName = unquote(src.slice(i, end));
        i = skipWs(src, end);
        if (src[i] !== ',') return;
        let calleeStart = at;
        while (calleeStart > 0 && /[\w$.]/.test(src[calleeStart - 1])) calleeStart--;
        const ident = lhsBefore(calleeStart);
        if (kind === 'message') {
          const def = { kind, typeName, pos: at, file, fields: parseFieldListArg(src, i + 1), style: 'makeMessageType' };
          rec.messages.push(def);
          if (ident) addDef(ident, def);
        } else {
          const def = { kind, typeName, pos: at, file, values: enumValues(parseArray(src, skipWs(src, i + 1)).value) };
          rec.enums.push(def);
          if (ident) addDef(ident, def);
        }
      });
    }
  }

  // setEnumType(X,"pkg.Enum",[...]) with literal arguments
  const setEnum = /\.setEnumType\(\s*([\w$]+),\s*("[\w.]+"|'[\w.]+'),\s*\[/g;
  for (let m; (m = setEnum.exec(src));) {
    tryParse(() => {
      const def = { kind: 'enum', typeName: unquote(m[2]), pos: m.index, file, values: enumValues(parseArray(src, m.index + m[0].length - 1).value) };
      rec.enums.push(def);
      addDef(m[1], def);
    });
  }

  // X.typeName="pkg.Msg" ... X.fields=...newFieldList(...)
  const classTn = /([\w$]+)\.typeName\s*=\s*("[\w.]+"|'[\w.]+')/g;
  for (let m; (m = classTn.exec(src));) {
    tryParse(() => {
      const fieldsAt = src.indexOf(`${m[1]}.fields`, m.index);
      if (fieldsAt === -1 || fieldsAt - m.index > 400) return;
      const nl = src.indexOf('newFieldList(', fieldsAt);
      if (nl === -1 || nl - fieldsAt > 80) return;
      const def = { kind: 'message', typeName: unquote(m[2]), pos: m.index, file, fields: parseFieldListArg(src, nl + 'newFieldList('.length), style: 'class' };
      rec.messages.push(def);
      addDef(m[1], def);
    });
  }

  // class X extends M{static typeName="pkg.Msg";static fields=...newFieldList(...)}
  const staticTn = /static typeName\s*=\s*("[\w.]+"|'[\w.]+')/g;
  for (let m; (m = staticTn.exec(src));) {
    tryParse(() => {
      const ident = enclosingClassName(src, m.index);
      const fieldsAt = src.indexOf('static fields', m.index);
      if (!ident || fieldsAt === -1 || fieldsAt - m.index > 400) return;
      const nl = src.indexOf('newFieldList(', fieldsAt);
      const def = { kind: 'message', typeName: unquote(m[1]), pos: m.index, file, fields: parseFieldListArg(src, nl + 'newFieldList('.length), style: 'class' };
      rec.messages.push(def);
      addDef(ident, def);
    });
  }

  // Compact classes: base classes carry the package ($p), leaves the fields ($).
  const prefixRe = /static \$p\(\)\{return([^}]+)\}/g;
  for (let m; (m = prefixRe.exec(src));) {
    const ident = enclosingClassName(src, m.index);
    if (ident) rec.prefixClasses.push({ ident, pos: m.index, expr: m[1].trim() });
  }
  const compactRe = /static \$\(\)\{return\[/g;
  for (let m; (m = compactRe.exec(src));) {
    tryParse(() => {
      const cls = enclosingClass(src, m.index);
      if (!cls) return;
      const arr = parseArray(src, m.index + m[0].length - 1).value;
      if (typeof arr[0] !== 'string') return;
      const def = { kind: 'message', pos: m.index, file, compact: arr[0], refs: arr.slice(1), base: cls.base, style: 'compact' };
      rec.messages.push(def);
      addDef(cls.name, def);
    });
  }
  // The callee may be (0,s.QT), (0,r(8592).QT) or QT, and the assignment a
  // comma expression: rn=(n.proto3,n.proto3,(0,o.QT)(...)).
  const compactEnumRe = /([\w$]+)=(?:\((?:[\w$.]+,)+)?(?:\(0,(?:[\w$]+\(\d+\)\.)?[\w$.]+\)|[\w$]+)\([\w$.]+,([\w$]+|"[\w.]*"),"([\w.]+)",\[\[(?=-?\d)/g;
  for (let m; (m = compactEnumRe.exec(src));) {
    tryParse(() => {
      const open = m.index + m[0].length - 2;
      const pairs = parseArray(src, open);
      let i = skipWs(src, pairs.end);
      let mode;
      if (src[i] === ',') mode = parseValue(src, i + 1).value;
      const def = { kind: 'enum', pos: m.index, file, prefixExpr: m[2], name: m[3], pairs: pairs.value, mode, style: 'compact' };
      rec.enums.push(def);
      addDef(m[1], def);
    });
  }

  // Services
  const svcRe = /typeName:\s*("[\w.]+"|'[\w.]+'),\s*methods:\s*\{/g;
  for (let m; (m = svcRe.exec(src));) {
    tryParse(() => {
      const methods = parseObject(src, m.index + m[0].length - 1).value;
      rec.services.push({ typeName: unquote(m[1]), pos: m.index, file, methods });
    });
  }
  return rec;
}

function enclosingClass(src, at) {
  const from = Math.max(0, at - 4000);
  const window = src.slice(from, at);
  const re = /(?:([\w$]+)\s*=\s*)?class(?:\s+([\w$]+))?\s+extends\s+([\w$.()]+?)\s*\{/g;
  let last = null;
  for (let m; (m = re.exec(window));) last = m;
  if (!last) return null;
  const name = last[2] || last[1];
  return name ? { name, base: last[3].replace(/^\(0,(.*)\)$/, '$1') } : null;
}

function enclosingClassName(src, at) {
  const c = enclosingClass(src, at);
  return c && c.name;
}

function enumValues(list) {
  const values = {};
  for (const v of list) {
    if (v && typeof v.no === 'number' && typeof v.name === 'string' && !(v.no in values)) values[v.no] = v.name;
  }
  return values;
}

// ---------------------------------------------------------------------------
// Resolution

class Resolver {
  constructor(files) {
    this.files = files;
    this.units = new Map(); // unit key -> Map(module id -> { rec, index })
    for (const rec of files) {
      rec.unit = unitOf(rec.file);
      if (!this.units.has(rec.unit)) this.units.set(rec.unit, new Map());
      const mods = this.units.get(rec.unit);
      rec.headers.forEach((h, index) => { if (!mods.has(h.id)) mods.set(h.id, { rec, index }); });
      rec.moduleCache = new Map();
    }
  }

  moduleIndex(rec, pos) {
    const h = rec.headers;
    let lo = 0, hi = h.length - 1, found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (h[mid].pos <= pos) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return found;
  }

  moduleInfo(rec, index) {
    if (rec.moduleCache.has(index)) return rec.moduleCache.get(index);
    const h = rec.headers[index];
    const end = index + 1 < rec.headers.length ? rec.headers[index + 1].pos : rec.src.length;
    const text = rec.src.slice(h.pos, end);
    const info = { imports: new Map(), exports: new Map(), reexports: new Map(), consts: new Map() };
    const esc = (s) => s.replace(/\$/g, '\\$');
    if (h.requireParam) {
      const imp = new RegExp(`([\\w$]+)\\s*=\\s*${esc(h.requireParam)}\\((\\d+)\\)`, 'g');
      for (let m; (m = imp.exec(text));) info.imports.set(m[1], m[2]);
      const d = new RegExp(`${esc(h.requireParam)}\\.d\\(${esc(h.exportsParam || 't')},\\s*\\{`, 'g');
      for (let m; (m = d.exec(text));) {
        try {
          const obj = parseObject(text, m.index + m[0].length - 1).value;
          for (const [k, v] of Object.entries(obj)) {
            const ref = v && v.expr && parseRef(v.expr);
            if (ref) info.exports.set(k, ref.ident);
          }
        } catch { /* not an export map */ }
      }
    }
    if (h.exportsParam) {
      const ex = new RegExp(`[^\\w$.]${esc(h.exportsParam)}\\.([\\w$]+)=([\\w$]+)(?=[,;)}])`, 'g');
      for (let m; (m = ex.exec(text));) if (!info.exports.has(m[1])) info.exports.set(m[1], m[2]);
      const re = new RegExp(`defineProperty\\(${esc(h.exportsParam)},"([\\w$]+)",\\{enumerable:!0,get:function\\(\\)\\{return ([\\w$]+\\.[\\w$]+)\\}`, 'g');
      for (let m; (m = re.exec(text));) info.reexports.set(m[1], m[2]);
    }
    const c = /(?:^|[^\w$.])([\w$]+)\s*=\s*"([\w.]*)"(?=\s*[,;])/g;
    for (let m; (m = c.exec(text));) if (!info.consts.has(m[1])) info.consts.set(m[1], m[2]);
    rec.moduleCache.set(index, info);
    return info;
  }

  // -> { def } | { ambiguous: [typeNames] } | null
  lookupIdent(rec, ident, pos, depth = 0) {
    const cands = rec.defs.get(ident) || [];
    if (rec.headers.length) {
      const mod = this.moduleIndex(rec, pos);
      const same = cands.filter((d) => this.moduleIndex(rec, d.pos) === mod);
      const r = pick(same);
      if (r) return r;
      if (mod !== -1) {
        // CJS export of this module: t.Foo=makeMessageType(...)
        const info = this.moduleInfo(rec, mod);
        const viaExport = [...info.exports].find(([, local]) => local === ident);
        if (viaExport && depth < 8) {
          const r2 = this.lookupIdent(rec, `${rec.headers[mod].exportsParam}.${viaExport[0]}`, pos, depth + 1);
          if (r2) return r2;
        }
        return null;
      }
    }
    const r = pick(cands);
    if (r) return r;
    return this.lookupAlias(rec, ident, pos, depth);
  }

  // Aliases like `CLc=fpn` in single-scope bundles.
  lookupAlias(rec, ident, pos, depth) {
    if (depth > 4) return null;
    if (!rec.aliases) {
      rec.aliases = new Map();
      const re = /(?:^|[,;{(\s])([\w$]+)=([\w$]+)(?=[,;)}])/g;
      for (let m; (m = re.exec(rec.src));) {
        if (!rec.defs.has(m[2])) continue;
        if (!rec.aliases.has(m[1])) rec.aliases.set(m[1], new Set());
        rec.aliases.get(m[1]).add(m[2]);
      }
    }
    const targets = rec.aliases.get(ident);
    if (!targets) return null;
    const found = [...targets].map((t) => this.lookupIdent(rec, t, pos, depth + 1)).filter(Boolean);
    return pick(found.flatMap((r) => (r.def ? [r.def] : [])), found.some((r) => r.ambiguous));
  }

  lookupMember(rec, object, prop, pos, depth = 0) {
    if (depth > 8) return null;
    const mod = this.moduleIndex(rec, pos);
    if (mod === -1) return null;
    const info = this.moduleInfo(rec, mod);
    const target = info.imports.get(object);
    if (target === undefined) return null;
    const entry = this.units.get(rec.unit).get(target);
    if (!entry) return null;
    return this.lookupExport(entry.rec, entry.index, prop, depth + 1);
  }

  lookupExport(rec, index, name, depth) {
    const info = this.moduleInfo(rec, index);
    const h = rec.headers[index];
    const local = info.exports.get(name);
    if (local) {
      const r = this.lookupIdent(rec, local, h.pos, depth);
      if (r) return r;
    }
    const direct = this.lookupIdent(rec, `${h.exportsParam}.${name}`, h.pos, depth);
    if (direct) return direct;
    const re = info.reexports.get(name);
    if (re) {
      const [o, p] = re.split('.');
      return this.lookupMember(rec, o, p, h.pos, depth + 1);
    }
    return null;
  }

  resolveRef(rec, expr, pos) {
    const ref = typeof expr === 'object' && expr && expr.expr !== undefined ? parseRef(expr.expr) : null;
    if (!ref) return { ref: exprText(expr) };
    const r = ref.object
      ? this.lookupMember(rec, ref.object, ref.prop, pos)
      : this.lookupIdent(rec, ref.ident, pos);
    if (r && r.def) return { def: r.def, ref: ref.ident };
    // An import of @bufbuild/protobuf itself (an external module, not in the bundle).
    if (!r && ref.object && WELL_KNOWN[ref.prop]) {
      return { def: { kind: WELL_KNOWN[ref.prop], typeName: `google.protobuf.${ref.prop}` }, ref: ref.ident };
    }
    return { ref: ref.ident };
  }

  prefixFor(rec, def) {
    // The base class (same module, or imported) whose $p() names the package.
    const lookup = (r, ident, pos, depth) => {
      if (depth > 6) return null;
      const mod = this.moduleIndex(r, pos);
      const classes = r.prefixClasses.filter((c) => c.ident === ident && this.moduleIndex(r, c.pos) === mod);
      return classes.length === 1 ? this.constValue(r, classes[0].expr, classes[0].pos) : null;
    };
    if (/^[\w$]+$/.test(def.base)) {
      const p = lookup(rec, def.base, def.pos, 0);
      if (p !== null) return p;
    } else {
      const [o, prop] = def.base.split('.');
      const mod = this.moduleIndex(rec, def.pos);
      if (mod !== -1) {
        const target = this.moduleInfo(rec, mod).imports.get(o);
        const entry = target && this.units.get(rec.unit).get(target);
        if (entry) {
          const local = this.moduleInfo(entry.rec, entry.index).exports.get(prop);
          if (local) {
            const p = lookup(entry.rec, local, entry.rec.headers[entry.index].pos, 0);
            if (p !== null) return p;
          }
        }
      }
    }
    return null;
  }

  constValue(rec, expr, pos) {
    if (/^["']/.test(expr)) return unquote(expr);
    const mod = this.moduleIndex(rec, pos);
    if (mod !== -1) {
      const v = this.moduleInfo(rec, mod).consts.get(expr);
      if (v !== undefined) return v;
    }
    return null;
  }
}

function pick(defs, ambiguous = false) {
  if (!defs.length) return ambiguous ? { ambiguous: true } : null;
  const names = new Set(defs.map((d) => `${d.kind}:${d.typeName ?? d.ident}`));
  if (names.size === 1 && !ambiguous) return { def: defs[0] };
  return { ambiguous: [...names] };
}

function exprText(v) {
  if (v && typeof v === 'object' && 'expr' in v) return v.expr;
  return JSON.stringify(v);
}

// Exported by @bufbuild/protobuf under their own names.
const WELL_KNOWN = {
  Any: 'message', Duration: 'message', Empty: 'message', FieldMask: 'message', Struct: 'message',
  Value: 'message', ListValue: 'message', NullValue: 'enum', Timestamp: 'message',
  DoubleValue: 'message', FloatValue: 'message', Int64Value: 'message', UInt64Value: 'message',
  Int32Value: 'message', UInt32Value: 'message', BoolValue: 'message', StringValue: 'message',
  BytesValue: 'message',
};

function unitOf(file) {
  // Webpack module ids are shared by the files of one dist/ folder.
  const parts = file.split(/[\\/]/);
  const i = parts.lastIndexOf('dist');
  return i === -1 ? file : parts.slice(0, i + 1).join('/');
}

function shouty(name) {
  return (name.charAt(0) + name.slice(1).replace(/[A-Z]/g, (c) => `_${c}`)).toUpperCase() + '_';
}

// ---------------------------------------------------------------------------
// Building the schema

function resolveCompactTypeNames(resolver, files) {
  for (const rec of files) {
    for (const def of rec.messages) {
      if (def.style !== 'compact') continue;
      const prefix = resolver.prefixFor(rec, def);
      const head = def.compact.split('|')[0];
      def.typeName = prefix === null ? null : prefix + head;
      def.localName = head;
    }
    for (const def of rec.enums) {
      if (def.style !== 'compact') continue;
      const prefix = resolver.constValue(rec, def.prefixExpr, def.pos);
      def.typeName = prefix === null ? null : prefix + def.name;
      const short = def.name.slice(def.name.lastIndexOf('.') + 1);
      def.values = {};
      def.pairs.forEach(([no, name]) => {
        if (no in def.values) return;
        // Mode 1: names are given without the ENUM_NAME_ prefix (the helper adds it).
        def.values[no] = def.mode === 1 ? shouty(short) + name : name;
      });
    }
  }
}

function buildFields(resolver, rec, def, unresolved) {
  const fail = (field, r) => unresolved.push({ file: rec.file, type: def.typeName, field, ref: r.ref });
  const typeRef = (field, expr, kind) => {
    const r = resolver.resolveRef(rec, expr, def.pos);
    if (r.def && r.def.typeName && (!kind || r.def.kind === kind)) return r.def;
    fail(field, r);
    return null;
  };

  if (def.style === 'compact') {
    const out = [];
    for (const part of def.compact.split('|').slice(1)) {
      const [noText, name, typeText, extra] = part.split(' ');
      let type = typeText, suffix = extra;
      const last = type.charAt(type.length - 1);
      if (last === '?' || last === '*') { suffix = last; type = type.slice(0, -1); }
      const field = { no: Number(noText), name, kind: null, T: null, repeated: suffix === '*', oneof: suffix && suffix !== '?' && suffix !== '*' ? suffix : null, opt: suffix === '?' };
      const one = (t) => {
        if (t.charAt(0) !== '#') return { kind: 'scalar', T: Number(t) };
        const target = typeRef(name, def.refs[Number(t.slice(1))]);
        return target ? { kind: target.kind, T: target.typeName } : { kind: null, T: null };
      };
      const comma = type.indexOf(',');
      if (comma !== -1) {
        out.push({ no: field.no, name, kind: 'map', K: Number(type.slice(0, comma)), V: one(type.slice(comma + 1)), repeated: false, oneof: null, opt: false });
      } else {
        Object.assign(field, one(type));
        out.push(field);
      }
    }
    return out;
  }

  return def.fields.map((f) => {
    const base = { no: f.no, name: f.name, kind: f.kind };
    if (f.kind === 'map') {
      const v = f.V || {};
      let V;
      if (v.kind === 'scalar') V = { kind: 'scalar', T: v.T };
      else {
        const target = typeRef(f.name, v.T, v.kind);
        V = { kind: v.kind, T: target ? target.typeName : null };
      }
      return { ...base, K: f.K, V, repeated: false, oneof: f.oneof ?? null, opt: !!f.opt };
    }
    let T = f.T;
    if (f.kind === 'message' || f.kind === 'enum') {
      const target = typeRef(f.name, f.T, f.kind);
      T = target ? target.typeName : null;
    }
    return { ...base, T, repeated: !!f.repeated, oneof: f.oneof ?? null, opt: !!f.opt };
  });
}

function buildMethods(resolver, rec, svc, unresolved) {
  const methods = {};
  for (const m of Object.values(svc.methods)) {
    if (!m || typeof m.name !== 'string') continue;
    const io = {};
    for (const key of ['I', 'O']) {
      const r = resolver.resolveRef(rec, m[key], svc.pos);
      if (r.def && r.def.kind === 'message' && r.def.typeName) io[key] = r.def.typeName;
      else {
        io[key] = null;
        unresolved.push({ file: rec.file, type: svc.typeName, field: `${m.name}.${key}`, ref: r.ref });
      }
    }
    let kind = null;
    if (typeof m.kind === 'number') kind = METHOD_KIND_NUMBERS[m.kind] ?? null;
    else if (m.kind && m.kind.expr) kind = METHOD_KINDS[m.kind.expr.split('.').pop()] ?? null;
    methods[m.name] = { I: io.I, O: io.O, kind };
  }
  return methods;
}

function listJsFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue; // no Cursor protos in there (3.x)
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) listJsFiles(p, out);
    else if (entry.isFile() && /\.(c|m)?js$/.test(entry.name)) out.push(p);
  }
  return out;
}

function readProduct(appDir) {
  try {
    const p = JSON.parse(fs.readFileSync(path.join(appDir, 'product.json'), 'utf8'));
    return { version: p.version ?? null, commit: p.commit ?? null };
  } catch {
    return { version: null, commit: null };
  }
}

// Candidates for one name, from different bundles: prefer the fully resolved
// one, then the one with more fields (bundles can lag behind each other).
function better(a, b) {
  if (a.unresolved.length !== b.unresolved.length) return a.unresolved.length < b.unresolved.length;
  return a.size > b.size;
}

function extractSchema(appDir = DEFAULT_APP_DIR) {
  const files = [];
  for (const abs of listJsFiles(appDir).sort()) {
    const src = fs.readFileSync(abs, 'utf8');
    if (!MARKERS.some((m) => src.includes(m))) continue;
    files.push(scanFile(path.relative(appDir, abs), src));
  }
  const resolver = new Resolver(files);
  resolveCompactTypeNames(resolver, files);

  const pickedMessages = new Map();
  const pickedEnums = new Map();
  const pickedServices = new Map();
  const unresolvedTop = [];
  const offer = (map, name, cand) => {
    const cur = map.get(name);
    if (!cur || better(cand, cur)) map.set(name, cand);
  };

  for (const rec of files) {
    for (const def of rec.messages) {
      if (!def.typeName) {
        unresolvedTop.push({ file: rec.file, type: def.localName ?? null, field: null, ref: def.base });
        continue;
      }
      const unresolved = [];
      const fields = buildFields(resolver, rec, def, unresolved);
      offer(pickedMessages, def.typeName, { value: { fields }, unresolved, size: fields.length });
    }
    for (const def of rec.enums) {
      if (!def.typeName) {
        unresolvedTop.push({ file: rec.file, type: def.name ?? null, field: null, ref: def.prefixExpr });
        continue;
      }
      offer(pickedEnums, def.typeName, { value: def.values, unresolved: [], size: Object.keys(def.values).length });
    }
    for (const svc of rec.services) {
      const unresolved = [];
      const methods = buildMethods(resolver, rec, svc, unresolved);
      offer(pickedServices, svc.typeName, { value: { methods }, unresolved, size: Object.keys(methods).length });
    }
  }

  const sorted = (map) => Object.fromEntries([...map.keys()].sort().map((k) => [k, map.get(k).value]));
  const unresolved = [...pickedMessages.values(), ...pickedServices.values()].flatMap((c) => c.unresolved);
  // Definitions whose package could not be found (type is the bare name).
  for (const u of unresolvedTop) unresolved.push(u);

  return {
    cursor: { ...readProduct(appDir), appDir },
    messages: sorted(pickedMessages),
    enums: sorted(pickedEnums),
    services: sorted(pickedServices),
    unresolved,
  };
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function cacheFile(appDir, cacheDir) {
  const { version, commit } = readProduct(appDir);
  if (!version || !commit) return null;
  return path.join(cacheDir, `${version}-${commit}.json`);
}

function loadSchema({ appDir = DEFAULT_APP_DIR, cacheDir = DEFAULT_CACHE_DIR } = {}) {
  const file = cacheFile(appDir, cacheDir);
  if (file) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { /* not cached yet */ }
  }
  const schema = extractSchema(appDir);
  if (file) writeAtomic(file, JSON.stringify(schema));
  return schema;
}

module.exports = {
  DEFAULT_APP_DIR, DEFAULT_CACHE_DIR,
  extractSchema, loadSchema, cacheFile,
  // for tests
  parseValue, scanFile,
};
