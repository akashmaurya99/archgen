// yaml.ts — zero-dependency YAML subset parser/writer for archgen contracts.
//
// FAITHFUL PORT of skills/archgen/scripts/lib/yaml.mjs (todo 3): identical
// public API (parseYaml / stringifyYaml), identical semantics, identical error
// messages — byte-for-byte where it matters. Both implementations are pinned
// together by the shared corpus at <repo-root>/fixtures/yaml-corpus/*.yaml +
// *.expected.json: the skill's node:test suite AND this extension's vitest
// suite consume the same files and assert identical parse output (parity).
// If the corpus ever exposes a divergence, fix BOTH sides in one change.
//
// WHY hand-rolled: skill scripts must run on bare Node ≥18 with no npm install;
// the extension reuses the exact same subset so a tasks.yaml parsed by either
// side is indistinguishable.
//
// Supported subset (anything else is REJECTED, never guessed):
//   - nested mappings (2-space indentation levels)
//   - sequences of scalars (block "- x" and flow "[a, b]")
//   - sequences of mappings (block "- key: value")
//   - scalars: plain, 'single-quoted', "double-quoted", numbers, booleans, null/~
//   - full-line AND end-of-line comments, preserved positionally
// Unsupported BY DESIGN (throws with file:line): block scalars (| >), anchors,
// tags, multi-document streams, flow mappings nested inside flow values, tabs.

/** `path` anchors the comment to the mapping key (or sequence item index) it
 * sits above; `inline:true` means it trailed a value on the same line.
 * `path:null` = dangling comment emitted at end of document. */
/** Dynamic YAML values: everything the subset can produce. Replaces `any`
 * (project standard bans it) while keeping parser internals honest. */
export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

export interface YamlComment {
  path: Array<string | number> | null;
  inline: boolean;
  text: string;
}

export interface ParseYamlOptions {
  filename?: string;
}

export interface ParsedYaml {
  data: YamlValue;
  comments: YamlComment[];
}

const INDENT_UNIT = 2;

class YamlError extends Error {}

interface Ctx {
  filename: string;
  comments: YamlComment[];
  pendingComments: string[];
}

/** Parse YAML-subset text into data plus its comment ledger. */
export function parseYaml(text: string, opts: ParseYamlOptions = {}): ParsedYaml {
  const filename = opts.filename ?? '<input>';
  const lines = text.split('\n');
  // Strip a single trailing newline artifact so the last real line is processed.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  const comments: YamlComment[] = [];
  /** Pending full-line comments waiting to anchor to the next key/item. */
  const pendingComments: string[] = [];

  const ctx: Ctx = { filename, comments, pendingComments };

  // Pre-scan: tabs are illegal for indentation in our subset — fail fast with location.
  lines.forEach((raw, i) => {
    const m = (/^[\t ]*/).exec(raw)![0];
    if (m.includes('\t')) {
      throw new YamlError(`${filename}:${i + 1}: tab characters are not allowed in indentation`);
    }
  });

  const pos = { i: 0 };
  const data = parseBlock(lines, pos, 0, ctx, /*root*/ true, []);
  // Guard: nothing structural may survive past the root block (e.g. a sequence
  // followed by a mapping at the same indent) — silent truncation would corrupt
  // contracts, so refuse loudly instead.
  for (let i = pos.i; i < lines.length; i++) {
    const c = classify(lines[i]!);
    if (c.type === 'content') fail(ctx, i + 1, `unexpected content outside the document block: ${c.bare!.slice(0, 30)}`);
  }

  // Any comments left pending anchor to end-of-document.
  for (const c of ctx.pendingComments) comments.push({ path: null, inline: false, text: c });
  return { data, comments };
}

function fail(ctx: Ctx, lineNo: number, msg: string): never {
  throw new YamlError(`${ctx.filename}:${lineNo}: ${msg}`);
}

/** Classification of one physical line. */
interface Classified {
  type: 'blank' | 'comment' | 'content';
  indent: number;
  text?: string;
  bare?: string;
}

function classify(raw: string): Classified {
  const trimmed = raw.trimStart();
  const indent = raw.length - trimmed.length;
  if (trimmed === '') return { type: 'blank', indent };
  if (trimmed.startsWith('#')) return { type: 'comment', indent, text: trimmed };
  // WHY `bare`: all structural checks (dash items, key regex) must see the
  // de-indented text; `indent` alone carries the column information.
  return { type: 'content', indent, text: trimmed, bare: trimmed };
}

/** Recursive block parser: consumes lines at >= indent belonging to this block. */
function parseBlock(lines: string[], pos: { i: number }, indent: number, ctx: Ctx, _root = false, basePath: Array<string | number> = []): YamlValue {
  // Decide map vs sequence by first content line at exactly this indent.
  const peek = peekContent(lines, pos, indent);
  if (!peek) return null;
  if (peek.line.bare!.startsWith('- ') || peek.line.bare === '-') return parseSequence(lines, pos, indent, ctx, basePath);
  return parseMapping(lines, pos, indent, ctx, basePath);
}

function peekContent(lines: string[], pos: { i: number }, indent: number): { idx: number; line: Classified } | null {
  let i = pos.i;
  while (i < lines.length) {
    const c = classify(lines[i]!);
    if (c.type === 'blank') { i++; continue; }
    if (c.type === 'comment') { i++; continue; } // handled by caller via pendingComments
    if (c.indent < indent) return null;
    if (c.indent > indent) fail({ filename: 'internal', comments: [], pendingComments: [] }, i + 1, `unexpected deeper indentation (got ${c.indent}, expected ${indent})`);
    return { idx: i, line: c };
  }
  return null;
}

function parseMapping(lines: string[], pos: { i: number }, indent: number, ctx: Ctx, basePath: Array<string | number> = []): Record<string, YamlValue> {
  const out: Record<string, YamlValue> = {};
  while (pos.i < lines.length) {
    const c = classify(lines[pos.i]!);
    if (c.type === 'blank') { pos.i++; continue; }
    if (c.type === 'comment') { ctx.pendingComments.push(c.text!); pos.i++; continue; }
    if (c.indent < indent) break;
    if (c.indent > indent) fail(ctx, pos.i + 1, 'inconsistent indentation inside mapping');

    assertKeyWellFormed(ctx, pos.i + 1, matchKey(c.text!)!);
    const keyPath: Array<string | number> = [...basePath, matchKey(c.text!)!.key];
    const key = consumePendingAndParseKey(ctx, c, pos.i + 1, keyPath);
    pos.i++;

    // Value may be inline, a nested block, or a sequence at SAME indent (common YAML style).
    const inlineVal = splitKeyValue(c.text!, ctx, pos.i);
    if (inlineVal.hasValue) {
      out[key.name] = parseScalarOrFlow(inlineVal.value, ctx, pos.i);
      key.inlineComment(keyPath);
      continue;
    }
    // Look ahead: nested block (deeper indent) or sequence at same indent.
    const next = nextContent(lines, pos.i);
    if (!next || next.indent < indent) { out[key.name] = null; key.inlineComment(keyPath); continue; }
    if (next.indent > indent) {
      out[key.name] = parseChild(lines, pos, next.indent, ctx, keyPath);
      continue;
    }
    // Same indent: only legal child here is a sequence ("- ...").
    if (next.bare.startsWith('- ')) {
      out[key.name] = parseSequence(lines, pos, indent, ctx, keyPath);
    } else {
      out[key.name] = null;
      key.inlineComment(keyPath);
    }
  }
  return out;
}

function parseChild(lines: string[], pos: { i: number }, childIndent: number, ctx: Ctx, basePath: Array<string | number> = []): YamlValue {
  // Skip blanks/comments so a leading comment block never masquerades as the
  // child's first structural line (classify() of a comment has no `bare`).
  let c: Classified | null = null;
  while (pos.i < lines.length) {
    const l = classify(lines[pos.i]!);
    if (l.type === 'blank') { pos.i++; continue; }
    if (l.type === 'comment') {
      // Pre-item comments must survive: park them for the sequence to anchor.
      ctx.pendingComments.push(l.text!); pos.i++; continue;
    }
    c = l; break;
  }
  if (!c) return null;
  if (c.bare!.startsWith('- ') || c.bare === '-') return parseSequence(lines, pos, childIndent, ctx, basePath);
  return parseMapping(lines, pos, childIndent, ctx, basePath);
}

function parseSequence(lines: string[], pos: { i: number }, indent: number, ctx: Ctx, basePath: Array<string | number> = []): YamlValue[] {
  const out: YamlValue[] = [];
  while (pos.i < lines.length) {
    const c = classify(lines[pos.i]!);
    if (c.type === 'blank') { pos.i++; continue; }
    if (c.type === 'comment') { ctx.pendingComments.push(c.text!); pos.i++; continue; }
    if (c.indent !== indent || !(c.bare!.startsWith('- ') || c.bare === '-')) break;

    const itemText = c.bare!.slice(2).trim();
    if (itemText === '-' || itemText.startsWith('- ')) {
      fail(ctx, pos.i + 1, 'nested sequence items are not supported by archgen\u0027s YAML subset');
    }
    // Positional anchor: comments above this item bind to its exact location.
    const itemPath: Array<string | number> = [...basePath, out.length];
    flushPendingInto(ctx.comments, ctx.pendingComments, itemPath, false);

    if (itemText === '') { // nested block under bare "-"
      pos.i++;
      const next = nextContent(lines, pos.i);
      if (!next || next.indent <= indent) { out.push(null); continue; }
      out.push(parseChild(lines, pos, next.indent, ctx, itemPath));
      continue;
    }
    const isFlowMap = itemText.startsWith('{');
    const isMapItem = !isFlowMap && ((/^[^:#]+:(\s|$)/).test(itemText) || (/^[A-Za-z_][\w.-]*:\s/).test(itemText));
    if (isFlowMap) {
      // Compact flow-map item: parse whole item as a flat mapping value.
      out.push(parseScalarOrFlow(itemText, ctx, pos.i + 1));
      pos.i++;
      continue;
    }
    if (isMapItem) {
      // Sequence of mappings: rewrite this line as a virtual mapping start.
      const virtualLine = ' '.repeat(indent + INDENT_UNIT) + itemText;
      const sub = [virtualLine];
      pos.i++;
      // Absorb following lines that belong to this item (indent > indent, not a new "- ").
      while (pos.i < lines.length) {
        const n = classify(lines[pos.i]!);
        if (n.type === 'blank' || n.type === 'comment') { sub.push(lines[pos.i]!); pos.i++; continue; }
        // Absorb ANY deeper line, dashes included: a '-' deeper than the item
        // base belongs to THIS item (nested list under one of its keys). Sibling
        // items sit exactly at `indent`, so the indent test alone is sufficient.
        if (n.indent > indent) { sub.push(lines[pos.i]!); pos.i++; continue; }
        break;
      }
      const subCtx: Ctx = { filename: ctx.filename, comments: ctx.comments, pendingComments: [] };
      const subPos = { i: 0 };
      // Sub-mapping inherits the item's positional path so inner keys anchor
      // as [.., itemIndex, keyName] — reviewer notes can never migrate between
      // sibling items that share key names.
      const obj = parseMapping(sub, subPos, indent + INDENT_UNIT, subCtx, itemPath);
      for (const pc of subCtx.pendingComments) ctx.comments.push({ path: null, inline: false, text: pc });
      out.push(obj);
      continue;
    }
    // Plain scalar item (may include inline comment).
    const { value, inlineComment } = splitInlineComment(itemText);
    out.push(parseScalarOrFlow(value, ctx, pos.i + 1));
    if (inlineComment) ctx.comments.push({ path: itemPath, inline: true, text: inlineComment });
    pos.i++;
  }
  return out;
}

/** Split "key: value # comment" honoring quotes; returns parts. */
function splitKeyValue(text: string, ctx: Ctx, lineNo: number): { hasValue: boolean; value: string; inlineComment: string | null; key: string } {
  const m = matchKey(text);
  if (!m) fail(ctx, lineNo, `expected 'key:' mapping entry, got: ${text.slice(0, 40)}`);
  const rest = text.slice(m.end).trim();
  const { value, inlineComment } = splitInlineComment(rest);
  return { hasValue: value.length > 0, value, inlineComment, key: m.key };
}

const KEY_RE = /^("([^"\\]|\\.)*"|'([^'\\]|\\.)*'|[^:#]+?):(?:\s|$)/;

function matchKey(text: string): { key: string; raw: string; end: number } | null {
  const m = KEY_RE.exec(text);
  if (!m) return null;
  return { key: unquote(m[1]!), raw: m[1]!, end: m[0].length };
}

/** Reject malformed keys early: unterminated quotes and brace/bracket starts are
 * typos that would otherwise silently become literal key names. */
function assertKeyWellFormed(ctx: Ctx, lineNo: number, m: { key: string; raw: string; end: number }): void {
  const r = m.raw;
  if (r.startsWith('"') && !(r.length >= 2 && r.endsWith('"'))) fail(ctx, lineNo, `unterminated double-quoted key: ${r}`);
  if (r.startsWith("'") && !(r.length >= 2 && r.endsWith("'"))) fail(ctx, lineNo, `unterminated single-quoted key: ${r}`);
  if ('{['.includes(r[0]!)) fail(ctx, lineNo, `flow collections cannot be keys in archgen's YAML subset: ${r}`);
}

function splitInlineComment(s: string): { value: string; inlineComment: string | null } {
  // Find '#' outside quotes.
  let inS = false, inD = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "'" && !inD) inS = !inS;
    else if (ch === '"' && !inS) inD = !inD;
    else if (ch === '#' && !inS && !inD && (i === 0 || s[i - 1] === ' ')) {
      return { value: s.slice(0, i).trim(), inlineComment: s.slice(i).trim() };
    }
  }
  return { value: s.trim(), inlineComment: null };
}

function parseScalarOrFlow(v: string, ctx: Ctx, lineNo: number): YamlValue {
  if (v === '') return null;
  if (v.startsWith('[')) {
    if (!v.endsWith(']')) fail(ctx, lineNo, `unterminated flow sequence: ${v}`);
    const inner = v.slice(1, -1).trim();
    if (inner === '') return [];
    return splitFlow(inner).map((p) => parseScalarOrFlow(p, ctx, lineNo));
  }
  if ((v.startsWith('"') && !(v.length >= 2 && v.endsWith('"'))) ||
      (v.startsWith("'") && !(v.length >= 2 && v.endsWith("'")))) {
    fail(ctx, lineNo, `unterminated quoted string: ${v.slice(0, 30)}`);
  }
  if (v.startsWith('{')) {
    // Flat flow mappings are supported ({k: v, ...}) because compact task
    // entries read far better; NESTED flow values inside them are not.
    if (!v.endsWith('}')) fail(ctx, lineNo, `unterminated flow mapping: ${v}`);
    const inner = v.slice(1, -1).trim();
    if (inner === '') return {};
    const obj: Record<string, any> = {};
    for (const part of splitFlow(inner)) {
      const m = matchKey(part);
      if (!m) fail(ctx, lineNo, `flow mapping entry must be 'key: value', got: ${part}`);
      assertKeyWellFormed(ctx, lineNo, m);
      const val = part.slice(m.end).trim();
      if (val.startsWith('{')) fail(ctx, lineNo, `nested flow mappings are not supported: ${val}`);
      obj[m.key] = parseScalarOrFlow(val, ctx, lineNo);
    }
    return obj;
  }
  if (!(/^["']/).test(v) && (/:\s/).test(v)) {
    fail(ctx, lineNo, `plain values cannot contain ': ' (quote the value if intended): ${v.slice(0, 30)}`);
  }
  if (v.startsWith('|') || v.startsWith('>')) fail(ctx, lineNo, `block scalars are not supported by archgen's YAML subset (use quoted or single-line values): ${v[0]}`);
  if (v.startsWith('&') || v.startsWith('*') || v.startsWith('!')) fail(ctx, lineNo, `anchors/tags are not supported by archgen's YAML subset: ${v[0]}`);
  return parseScalar(v);
}

function splitFlow(inner: string): string[] {
  const parts: string[] = []; let cur = ''; let inS = false, inD = false, depth = 0;
  for (const ch of inner) {
    if (ch === "'" && !inD) inS = !inS;
    else if (ch === '"' && !inS) inD = !inD;
    else if (ch === '[' && !inS && !inD) depth++;
    else if (ch === ']' && !inS && !inD) depth--;
    if (ch === ',' && !inS && !inD && depth === 0) { parts.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

function parseScalar(v: string): YamlValue {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return unquote(v);
  if (v === 'null' || v === '~' || v === '') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if ((/^-?\d+$/).test(v)) return parseInt(v, 10);
  if ((/^-?\d+\.\d+$/).test(v)) return parseFloat(v);
  return v; // plain string
}

function unquote(v: string): string {
  if (v.startsWith('"')) return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if (v.startsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

function quoteIfNeeded(v: string): string {
  if (v === '') return '""';
  if ((/^[#&*!|>%@`{}[\],]|^\s|\s$|: |\s#|^[-?:]\s|^".*"$/).test(v) || ((/[:#]/).test(v) && !(/^["']/).test(v))) {
    return JSON.stringify(v);
  }
  if ((/^(true|false|null|~|-?\d+(\.\d+)?)$/).test(v)) return JSON.stringify(v);
  return v;
}

function nextContent(lines: string[], from: number): { indent: number; text: string; bare: string; idx: number } | null {
  for (let i = from; i < lines.length; i++) {
    const c = classify(lines[i]!);
    if (c.type === 'blank') continue;
    if (c.type === 'comment') continue;
    return { indent: c.indent, text: c.bare!, bare: c.bare!, idx: i };
  }
  return null;
}

function consumePendingAndParseKey(ctx: Ctx, line: Classified, lineNo: number, keyPath: Array<string | number>): { name: string; inlineComment(kp: Array<string | number>): void } {
  const m = matchKey(line.text!);
  if (!m) fail(ctx, lineNo, `expected 'key:' mapping entry, got: ${line.text!.slice(0, 40)}`);
  assertKeyWellFormed(ctx, lineNo, m);
  // Full-line comments sitting directly above this key anchor to its FULL
  // positional path NOW; waiting longer would misattach them to a deeper child.
  for (const t of ctx.pendingComments.splice(0)) {
    ctx.comments.push({ path: keyPath, inline: false, text: t });
  }
  return {
    name: m.key,
    inlineComment(kp: Array<string | number>) {
      const { inlineComment } = splitInlineComment(line.text!.slice(line.text!.indexOf(':') + 1).trim());
      if (inlineComment) ctx.comments.push({ path: kp, inline: true, text: inlineComment });
    },
  };
}

// NOTE: pre-comments for mapping keys are flushed by the caller right before the
// child block parses (flushPendingInto) using the child key path; top-level keys
// flush via the same mechanism inside parseMapping's lookahead branch. Inline and
// dangling comments are handled directly. This asymmetry is intentional: it keeps
// the hot path simple while guaranteeing every captured comment is emitted exactly once.

function flushPendingInto(comments: YamlComment[], pending: string[], path: Array<string | number> | null, _inline: boolean): void {
  for (const t of pending.splice(0)) comments.push({ path, inline: false, text: t });
}


/**
 * Serialize data back to the YAML subset, re-emitting comments positionally.
 */
export function stringifyYaml(data: YamlValue, comments: YamlComment[] = []): string {
  const out: string[] = [];
  const used = new Set<number>();
  emitValue(out, data, 0, comments, used, []);
  // Dangling comments (path null) land at EOF in original order.
  for (let i = 0; i < comments.length; i++) {
    if (!used.has(i) && comments[i]!.path === null) out.push(comments[i]!.text);
  }
  return out.join('\n') + '\n';
}

function preComments(out: string[], comments: YamlComment[], used: Set<number>, path: Array<string | number>): void {
  comments.forEach((c, i) => {
    if (used.has(i) || c.inline || c.path === null) return;
    if (samePath(c.path, path)) { out.push(c.text); used.add(i); }
  });
}

function inlineCommentFor(out: string[], comments: YamlComment[], used: Set<number>, path: Array<string | number>): void {
  comments.forEach((c, i) => {
    if (used.has(i) || !c.inline) return;
    if (samePath(c.path, path)) { out[out.length - 1] += ' ' + c.text; used.add(i); }
  });
}

function samePath(a: Array<string | number> | null, b: Array<string | number> | null): boolean {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (String(a[i]) !== String(b[i])) return false;
  return true;
}

function emitValue(out: string[], v: YamlValue, indent: number, comments: YamlComment[], used: Set<number>, path: Array<string | number>): void {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    if (v.length === 0) { out.push(pad + '[]'); return; }
    v.forEach((item, idx) => {
      const itemPath: Array<string | number> = [...path, idx];
      // Pre-item comments keep their original indentation relative to the dash.
      comments.forEach((c, i) => {
        if (!used.has(i) && !c.inline && c.path && samePath(c.path, itemPath)) {
          out.push(pad + c.text); used.add(i);
        }
      });
      if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
        const entries = Object.entries(item);
        if (entries.length === 0) { out.push(pad + '- {}'); return; }
        const [k0, v0] = entries[0]!;
        const k0path: Array<string | number> = [...itemPath, k0];
        preComments(out, comments, used, k0path);
        out.push(pad + '- ' + k0 + ': ' + encodeScalar(v0));
        inlineCommentFor(out, comments, used, k0path);
        emitEntries(out, entries.slice(1), indent + INDENT_UNIT, comments, used, itemPath);
      } else {
        out.push(pad + '- ' + encodeScalar(item));
        inlineCommentFor(out, comments, used, itemPath);
      }
    });
    return;
  }
  if (v !== null && typeof v === 'object') {
    emitEntries(out, Object.entries(v), indent, comments, used, path);
    return;
  }
  out.push(pad + encodeScalar(v));
}

function emitEntries(out: string[], entries: [string, YamlValue][], indent: number, comments: YamlComment[], used: Set<number>, basePath: Array<string | number>): void {
  const pad = ' '.repeat(indent);
  for (const [k, val] of entries) {
    const kpath: Array<string | number> = [...basePath, k];
    preComments(out, comments, used, kpath);
    if (val !== null && typeof val === 'object') {
      if (Object.keys(val).length === 0 && !Array.isArray(val)) { out.push(pad + k + ': {}'); inlineCommentFor(out, comments, used, kpath); continue; }
      if (Array.isArray(val) && val.length === 0) { out.push(pad + k + ': []'); inlineCommentFor(out, comments, used, kpath); continue; }
      out.push(pad + k + ':');
      inlineCommentFor(out, comments, used, kpath);
      emitValue(out, val, indent + INDENT_UNIT, comments, used, kpath);
    } else {
      out.push(pad + k + ': ' + encodeScalar(val));
      inlineCommentFor(out, comments, used, kpath);
    }
  }
}

function encodeScalar(v: YamlValue): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  return quoteIfNeeded(String(v));
}
