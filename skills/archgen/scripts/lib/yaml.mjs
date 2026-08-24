// yaml.mjs — zero-dependency YAML subset parser/writer for archgen contracts.
// WHY hand-rolled: skill scripts must run on bare Node ≥18 with no npm install
// (portability across harness sandboxes); full YAML libs are overkill for our
// two documented shapes (tasks.yaml, architecture.yaml).
//
// Supported subset (anything else is REJECTED, never guessed):
//   - nested mappings (2-space indentation levels)
//   - sequences of scalars (block "- x" and flow "[a, b]")
//   - sequences of mappings (block "- key: value")
//   - scalars: plain, 'single-quoted', "double-quoted", numbers, booleans, null/~
//   - full-line AND end-of-line comments, preserved positionally
// Unsupported BY DESIGN (throws with file:line): block scalars (| >), anchors,
// tags, multi-document streams, flow mappings, tabs.
//
// Comment preservation contract (used by set-status.mjs so edits never destroy
// reviewer notes): parse() returns { data, comments }; stringify(data, comments)
// re-emits every comment verbatim, in original order, at its anchored position.

/**
 * @typedef {{path: Array<string|number>, inline: boolean, text: string}} YamlComment
 * `path` anchors the comment to the mapping key (or sequence item index) it
 * sits above; `inline:true` means it trailed a value on the same line.
 * `path:null` = dangling comment emitted at end of document.
 */

const INDENT_UNIT = 2;

/** Parse YAML-subset text into data plus its comment ledger.
 * @param {string} text
 * @param {{filename?: string}} [opts]
 * @returns {{data: any, comments: YamlComment[]}}
 */
export function parseYaml(text, opts = {}) {
  const filename = opts.filename ?? '<input>';
  const lines = text.split('\n');
  // Strip a single trailing newline artifact so the last real line is processed.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  /** @type {YamlComment[]} */
  const comments = [];
  /** Pending full-line comments waiting to anchor to the next key/item. */
  let pendingComments = [];

  const ctx = { filename, comments, pendingComments };

  // Pre-scan: tabs are illegal for indentation in our subset — fail fast with location.
  lines.forEach((raw, i) => {
    const m = raw.match(/^[\t ]*/)[0];
    if (m.includes('\t')) {
      throw new YamlError(`${filename}:${i + 1}: tab characters are not allowed in indentation`);
    }
  });

  // Drop blank/comment-only knowledge from the recursive descent input by
  // filtering here but recording positions first (keeps parser core simple).
  const pos = { i: 0 };
  const data = parseBlock(lines, pos, 0, ctx, /*root*/ true);
  // Guard: nothing structural may survive past the root block (e.g. a sequence
  // followed by a mapping at the same indent) — silent truncation would corrupt
  // contracts, so refuse loudly instead.
  for (let i = pos.i; i < lines.length; i++) {
    const c = classify(lines[i]);
    if (c.type === 'content') fail(ctx, i + 1, `unexpected content outside the document block: ${c.bare.slice(0, 30)}`);
  }

  // Any comments left pending anchor to end-of-document.
  for (const c of ctx.pendingComments) comments.push({ path: null, inline: false, text: c });
  return { data, comments };
}

class YamlError extends Error {}

function fail(ctx, lineNo, msg) {
  throw new YamlError(`${ctx.filename}:${lineNo}: ${msg}`);
}

/** Classification of one physical line. */
function classify(raw) {
  const trimmed = raw.trimStart();
  const indent = raw.length - trimmed.length;
  if (trimmed === '' ) return { type: 'blank', indent };
  if (trimmed.startsWith('#')) return { type: 'comment', indent, text: trimmed };
  // WHY `bare`: all structural checks (dash items, key regex) must see the
  // de-indented text; `indent` alone carries the column information.
  return { type: 'content', indent, text: trimmed, bare: trimmed };
}

/** Recursive block parser: consumes lines at >= indent belonging to this block. */
function parseBlock(lines, pos, indent, ctx, root = false) {
  // Decide map vs sequence by first content line at exactly this indent.
  const peek = peekContent(lines, pos, indent);
  if (!peek) return null;
  if (peek.line.bare.startsWith('- ') || peek.line.bare === '-') return parseSequence(lines, pos, indent, ctx);
  return parseMapping(lines, pos, indent, ctx);
}

function peekContent(lines, pos, indent) {
  let i = pos.i;
  while (i < lines.length) {
    const c = classify(lines[i]);
    if (c.type === 'blank') { i++; continue; }
    if (c.type === 'comment') { i++; continue; } // handled by caller via pendingComments
    if (c.indent < indent) return null;
    if (c.indent > indent) fail({ filename: 'internal' }, i + 1, `unexpected deeper indentation (got ${c.indent}, expected ${indent})`);
    return { idx: i, line: c };
  }
  return null;
}

function parseMapping(lines, pos, indent, ctx) {
  /** @type {Record<string, any>} */
  const out = {};
  while (pos.i < lines.length) {
    const c = classify(lines[pos.i]);
    if (c.type === 'blank') { pos.i++; continue; }
    if (c.type === 'comment') { ctx.pendingComments.push(c.text); pos.i++; continue; }
    if (c.indent < indent) break;
    if (c.indent > indent) fail(ctx, pos.i + 1, 'inconsistent indentation inside mapping');

    const key = consumePendingAndParseKey(ctx, c, pos.i + 1);
  assertKeyWellFormed(ctx, pos.i + 1, matchKey(c.text));
    pos.i++;

    // Value may be inline, a nested block, or a sequence at SAME indent (common YAML style).
    const inlineVal = splitKeyValue(c.text, ctx, pos.i);
    if (inlineVal.hasValue) {
      out[key.name] = parseScalarOrFlow(inlineVal.value, ctx, pos.i);
      key.inlineComment(out, key.name);
      continue;
    }
    // Look ahead: nested block (deeper indent) or sequence at same indent.
    const next = nextContent(lines, pos.i);
    if (!next || next.indent < indent) { out[key.name] = null; key.inlineComment(out, key.name); continue; }
    if (next.indent > indent) {
      out[key.name] = parseChild(lines, pos, next.indent, ctx);
      continue;
    }
    // Same indent: only legal child here is a sequence ("- ...").
    if (next.bare.startsWith('- ')) {
      out[key.name] = parseSequence(lines, pos, indent, ctx);
    } else {
      out[key.name] = null;
      key.inlineComment(out, key.name);
    }
  }
  return out;
}

function parseChild(lines, pos, childIndent, ctx) {
  // Skip blanks/comments so a leading comment block never masquerades as the
  // child's first structural line (classify() of a comment has no `bare`).
  let c = null;
  while (pos.i < lines.length) {
    const l = classify(lines[pos.i]);
    if (l.type === 'blank') { pos.i++; continue; }
    if (l.type === 'comment') {
      // Pre-item comments must survive: park them for the sequence to anchor.
      ctx.pendingComments.push(l.text); pos.i++; continue;
    }
    c = l; break;
  }
  if (!c) return null;
  if (c.bare.startsWith('- ') || c.bare === '-') return parseSequence(lines, pos, childIndent, ctx);
  return parseMapping(lines, pos, childIndent, ctx);
}

function parseSequence(lines, pos, indent, ctx) {
  /** @type {any[]} */
  const out = [];
  while (pos.i < lines.length) {
    const c = classify(lines[pos.i]);
    if (c.type === 'blank') { pos.i++; continue; }
    if (c.type === 'comment') { ctx.pendingComments.push(c.text); pos.i++; continue; }
    if (c.indent !== indent || !(c.bare.startsWith('- ') || c.bare === '-')) break;

    const itemText = c.bare.slice(2).trim();
    if (itemText === '-' || itemText.startsWith('- ')) {
      fail(ctx, pos.i + 1, 'nested sequence items are not supported by archgen\u0027s YAML subset');
    }
    const idx = out.length;
    flushPendingInto(ctx.comments, ctx.pendingComments, ['\u0000seq', idx], false);

    if (itemText === '') { // nested block under bare "-"
      pos.i++;
      const next = nextContent(lines, pos.i);
      if (!next || next.indent <= indent) { out.push(null); continue; }
      out.push(parseChild(lines, pos, next.indent, ctx));
      continue;
    }
    const isFlowMap = itemText.startsWith('{');
    const isMapItem = !isFlowMap && (/^[^:#]+:(\s|$)/.test(itemText) || /^[A-Za-z_][\w.-]*:\s/.test(itemText));
    if (isFlowMap) {
      // Compact flow-map item: parse whole item as a flat mapping value.
      const idx0 = out.length;
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
        const n = classify(lines[pos.i]);
        if (n.type === 'blank' || n.type === 'comment') { sub.push(lines[pos.i]); pos.i++; continue; }
        // Absorb ANY deeper line, dashes included: a '-' deeper than the item
        // base belongs to THIS item (nested list under one of its keys). Sibling
        // items sit exactly at `indent`, so the indent test alone is sufficient.
        if (n.indent > indent) { sub.push(lines[pos.i]); pos.i++; continue; }
        break;
      }
      const subCtx = { filename: ctx.filename, comments: ctx.comments, pendingComments: [] };
      const subPos = { i: 0 };
      const obj = parseMapping(sub, subPos, indent + INDENT_UNIT, subCtx);
      for (const pc of subCtx.pendingComments) ctx.comments.push({ path: null, inline: false, text: pc });
      // Re-anchor seq-item comments recorded during sub-parse onto this item.
      reanchorSeqComments(ctx.comments, out.length, idx);
      out.push(obj);
      continue;
    }
    // Plain scalar item (may include inline comment).
    const { value, inlineComment } = splitInlineComment(itemText);
    out.push(parseScalarOrFlow(value, ctx, pos.i + 1));
    if (inlineComment) ctx.comments.push({ path: ['\u0000seq', idx], inline: true, text: inlineComment });
    pos.i++;
  }
  return out;
}

/** Split "key: value # comment" honoring quotes; returns parts. */
function splitKeyValue(text, ctx, lineNo) {
  const m = matchKey(text);
  if (!m) fail(ctx, lineNo, `expected 'key:' mapping entry, got: ${text.slice(0, 40)}`);
  const rest = text.slice(m.end).trim();
  const { value, inlineComment } = splitInlineComment(rest);
  return { hasValue: value.length > 0, value, inlineComment, key: m.key };
}

const KEY_RE = /^("([^"\\]|\\.)*"|'([^'\\]|\\.)*'|[^:#]+?):(?:\s|$)/;
function matchKey(text) {
  const m = KEY_RE.exec(text);
  if (!m) return null;
  return { key: unquote(m[1]), raw: m[1], end: m[0].length };
}

/** Reject malformed keys early: unterminated quotes and brace/bracket starts are
 * typos that would otherwise silently become literal key names. */
function assertKeyWellFormed(ctx, lineNo, m) {
  const r = m.raw;
  if (r.startsWith('"') && !(r.length >= 2 && r.endsWith('"'))) fail(ctx, lineNo, `unterminated double-quoted key: ${r}`);
  if (r.startsWith("'") && !(r.length >= 2 && r.endsWith("'"))) fail(ctx, lineNo, `unterminated single-quoted key: ${r}`);
  if ('{['.includes(r[0])) fail(ctx, lineNo, `flow collections cannot be keys in archgen's YAML subset: ${r}`);
}

function splitInlineComment(s) {
  // Find '#' outside quotes.
  let inS = false, inD = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "'" && !inD) inS = !inS;
    else if (ch === '"' && !inS) inD = !inD;
    else if (ch === '#' && !inS && !inD && (i === 0 || s[i - 1] === ' ')) {
      return { value: s.slice(0, i).trim(), inlineComment: s.slice(i).trim() };
    }
  }
  return { value: s.trim(), inlineComment: null };
}

function parseScalarOrFlow(v, ctx, lineNo) {
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
    const obj = {};
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
  if (!/^["']/.test(v) && /:\s/.test(v)) {
    fail(ctx, lineNo, `plain values cannot contain ': ' (quote the value if intended): ${v.slice(0, 30)}`);
  }
  if (v.startsWith('|') || v.startsWith('>')) fail(ctx, lineNo, `block scalars are not supported by archgen's YAML subset (use quoted or single-line values): ${v[0]}`);
  if (v.startsWith('&') || v.startsWith('*') || v.startsWith('!')) fail(ctx, lineNo, `anchors/tags are not supported by archgen's YAML subset: ${v[0]}`);
  return parseScalar(v);
}

function splitFlow(inner) {
  const parts = []; let cur = ''; let inS = false, inD = false, depth = 0;
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

function parseScalar(v) {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return unquote(v);
  if (v === 'null' || v === '~' || v === '') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  return v; // plain string
}

function unquote(v) {
  if (v.startsWith('"')) return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  if (v.startsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

function quoteIfNeeded(v) {
  if (v === '') return '""';
  if (/^[#&*!|>%@`{}[\],]|^\s|\s$|: |\s#|^[-?:]\s|^".*"$/ .test(v) || /[:#]/.test(v) && !/^["']/.test(v)) {
    return JSON.stringify(v);
  }
  if (/^(true|false|null|~|-?\d+(\.\d+)?)$/.test(v)) return JSON.stringify(v);
  return v;
}

function nextContent(lines, from) {
  for (let i = from; i < lines.length; i++) {
    const c = classify(lines[i]);
    if (c.type === 'blank') continue;
    if (c.type === 'comment') continue;
    return { indent: c.indent, text: c.bare, bare: c.bare, idx: i };
  }
  return null;
}

/** Stable path of a key inside its mapping (best-effort: key name alone is ambiguous
 * across repeated names, but our schemas forbid duplicates — name is sufficient). */
function currentPath(_out, keyName) { return [keyName]; }

function consumePendingAndParseKey(ctx, line, lineNo) {
  const m = matchKey(line.text);
  if (!m) fail(ctx, lineNo, `expected 'key:' mapping entry, got: ${line.text.slice(0, 40)}`);
  assertKeyWellFormed(ctx, lineNo, m);
  // Full-line comments sitting directly above this key anchor to it NOW;
  // waiting longer would misattach them to a deeper child key.
  for (const t of ctx.pendingComments.splice(0)) {
    ctx.comments.push({ path: [m.key], inline: false, text: t });
  }
  const name = m.key;
  return {
    name,
    inlineComment(_obj, k) {
      const { inlineComment } = splitInlineComment(line.text.slice(line.text.indexOf(':') + 1).trim());
      if (inlineComment) ctx.comments.push({ path: [k], inline: true, text: inlineComment });
    },
  };
}

// NOTE: pre-comments for mapping keys are flushed by the caller right before the
// child block parses (flushPendingInto) using the child key path; top-level keys
// flush via the same mechanism inside parseMapping's lookahead branch. Inline and
// dangling comments are handled directly. This asymmetry is intentional: it keeps
// the hot path simple while guaranteeing every captured comment is emitted exactly once.

function flushPendingInto(comments, pending, path, _inline) {
  for (const t of pending.splice(0)) comments.push({ path, inline: false, text: t });
}

function reanchorSeqComments(comments, _len, idx) {
  // Comments captured while parsing this sequence item were anchored with a
  // placeholder first segment '\u0000seq'; retarget placeholder entries that
  // were pushed AFTER the flush for this item to point at this item index.
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i];
    if (c.path && c.path[0] === '\u0000seq' && c.path[1] === undefined) {
      c.path[1] = idx;
      break; // only the most recent unanchored seq comment belongs to this item
    }
  }
}

/**
 * Serialize data back to the YAML subset, re-emitting comments positionally.
 * @param {any} data
 * @param {YamlComment[]} [comments]
 */
export function stringifyYaml(data, comments = []) {
  const out = [];
  const used = new Set();
  emitValue(out, data, 0, comments, used, []);
  // Dangling comments (path null) land at EOF in original order.
  for (let i = 0; i < comments.length; i++) {
    if (!used.has(i) && comments[i].path === null) out.push(comments[i].text);
  }
  return out.join('\n') + '\n';
}

function preComments(out, comments, used, path) {
  comments.forEach((c, i) => {
    if (used.has(i) || c.inline || c.path === null) return;
    if (samePath(c.path, path)) { out.push(c.text); used.add(i); }
  });
}

function inlineCommentFor(out, comments, used, path) {
  comments.forEach((c, i) => {
    if (used.has(i) || !c.inline) return;
    if (samePath(c.path, path)) { out[out.length - 1] += ' ' + c.text; used.add(i); }
  });
}

function samePath(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (String(a[i]) !== String(b[i])) return false;
  return true;
}

function emitValue(out, v, indent, comments, used, path) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    if (v.length === 0) { out.push(pad + '[]'); return; }
    v.forEach((item, idx) => {
      const ipath = [...path, idx];
      preComments(out, comments, used, ['\u0000seq', idx]); // seq pre-comments (document-level seqs)
      if (item !== null && typeof item === 'object') {
        const entries = Object.entries(item);
        if (entries.length === 0) { out.push(pad + '- {}'); return; }
        const [k0, v0] = entries[0];
        preComments(out, comments, used, [k0]);
        out.push(pad + '- ' + k0 + ': ' + encodeScalar(v0));
        inlineCommentFor(out, comments, used, [k0]);
        emitEntries(out, entries.slice(1), indent + INDENT_UNIT, comments, used, ipath.concat(k0));
      } else {
        out.push(pad + '- ' + encodeScalar(item));
        inlineCommentFor(out, comments, used, ['\u0000seq', idx]);
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

function emitEntries(out, entries, indent, comments, used, basePath) {
  const pad = ' '.repeat(indent);
  for (const [k, val] of entries) {
    const kpath = [...basePath, k];
    preComments(out, comments, used, [k]);
    if (val !== null && typeof val === 'object') {
      if (Object.keys(val).length === 0 && !Array.isArray(val)) { out.push(pad + k + ': {}'); inlineCommentFor(out, comments, used, [k]); continue; }
      if (Array.isArray(val) && val.length === 0) { out.push(pad + k + ': []'); inlineCommentFor(out, comments, used, [k]); continue; }
      out.push(pad + k + ':');
      inlineCommentFor(out, comments, used, [k]);
      emitValue(out, val, indent + INDENT_UNIT, comments, used, kpath);
    } else {
      out.push(pad + k + ': ' + encodeScalar(val));
      inlineCommentFor(out, comments, used, [k]);
    }
  }
}

function encodeScalar(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  return quoteIfNeeded(String(v));
}
