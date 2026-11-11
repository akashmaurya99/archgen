// yaml.mjs — zero-dependency YAML subset parser/writer for archgen contracts.
// WHY hand-rolled: skill scripts must run on bare Node ≥18 with no npm install
// (portability across harness sandboxes); full YAML libs are overkill for our
// two documented shapes (tasks.yaml, architecture.yaml).
//
// Supported subset (anything else is REJECTED, never guessed):
//   - nested mappings (2-space indentation levels)
//   - sequences of scalars (block "- x" and flow "[a, b]")
//   - sequences of mappings (block "- key: value")
//   - flat flow mappings ({k: v, ...}) and nested flow sequences
//   - scalars: plain, 'single-quoted', "double-quoted", numbers, booleans, null/~
//   - full-line AND end-of-line comments, preserved positionally
// Unsupported BY DESIGN (throws with file:line): block scalars (| >), anchors,
// tags, multi-document streams, nested flow mappings, tabs.
//
// A plain scalar may contain ": ". In block style a nested mapping cannot
// start on the key's own line, so the remainder of a mapping value is
// unambiguously the scalar — refusing it rejected ordinary titles like
// "Refactor: the auth module" and killed every check on the file.
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

/**
 * @typedef {Map<string, number>} Provenance
 * Structural path ("tasks[0].title") to the 1-based source line it was read
 * from. Every finding the validator reports can name the line it came from,
 * so an agent fixes the plan without counting lines.
 */

const INDENT_UNIT = 2;

/** Parse YAML-subset text into data plus its comment ledger.
 * @param {string} text
 * @param {{filename?: string}} [opts]
 * @returns {{data: any, comments: YamlComment[], provenance: Provenance}}
 */
export function parseYaml(text, opts = {}) {
  const filename = opts.filename ?? '<input>';
  // Normalize CRLF: split on '\n' leaves a stray '\r' at the end of every line
  // in Windows-authored files; stripping it here keeps scalar values and
  // comment texts free of carriage returns so stringify can never double them
  // up when re-emitting with the file's dominant EOL (see stringifyYaml eol).
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  // Strip a single trailing newline artifact so the last real line is processed.
  if (lines.length && lines[lines.length - 1] === '') lines.pop();

  /** @type {YamlComment[]} */
  const comments = [];
  /** Pending full-line comments waiting to anchor to the next key/item. */
  let pendingComments = [];
  /** @type {Provenance} */
  const provenance = new Map();

  const ctx = { filename, comments, pendingComments, provenance, lineOf: (i) => i + 1 };

  // Pre-scan: tabs are illegal for indentation in our subset — fail fast with location.
  lines.forEach((raw, i) => {
    const m = raw.match(/^[\t ]*/)[0];
    if (m.includes('\t')) {
      throw new YamlError(`${filename}:${i + 1}: tab characters are not allowed in indentation`, {
        line: i + 1,
        path: null,
      });
    }
  });

  // Drop blank/comment-only knowledge from the recursive descent input by
  // filtering here but recording positions first (keeps parser core simple).
  const pos = { i: 0 };
  const data = parseBlock(lines, pos, 0, ctx, /*root*/ true, []);
  // Guard: nothing structural may survive past the root block (e.g. a sequence
  // followed by a mapping at the same indent) — silent truncation would corrupt
  // contracts, so refuse loudly instead.
  for (let i = pos.i; i < lines.length; i++) {
    const c = classify(lines[i]);
    if (c.type === 'content') fail(ctx, i + 1, `unexpected content outside the document block: ${c.bare.slice(0, 30)}`);
  }

  // Any comments left pending anchor to end-of-document.
  for (const c of ctx.pendingComments) comments.push({ path: null, inline: false, text: c });
  return { data, comments, provenance };
}

class YamlError extends Error {
  /**
   * @param {string} message
   * @param {{line?: number|null, path?: string|null, code?: string}} [detail]
   */
  constructor(message, detail = {}) {
    super(message);
    this.name = 'YamlError';
    this.line = detail.line ?? null;
    this.path = detail.path ?? null;
    this.code = detail.code ?? 'YAML_SYNTAX';
  }
}

/**
 * Fail the parse at a known location.
 *
 * The path travels in the message AND as a structured field. The line number
 * says WHERE; the path says WHICH field — an agent fixing a twelve-task plan
 * should not have to count lines to find the title that broke it.
 */
function fail(ctx, lineNo, msg, path) {
  const hasPath = Array.isArray(path) && path.length > 0;
  const where = hasPath ? ` (at ${formatPath(path)})` : '';
  throw new YamlError(`${ctx.filename}:${lineNo}: ${msg}${where}`, {
    line: lineNo,
    path: hasPath ? formatPath(path) : null,
  });
}

/** Format a structural path: tasks[0].acceptance[1]. */
function formatPath(path) {
  let out = '';
  for (const part of path) {
    if (typeof part === 'number') out += `[${part}]`;
    else out += out ? `.${part}` : String(part);
  }
  return out;
}

/** Extend a path with one more segment. */
function extendPath(path, part) {
  return Array.isArray(path) ? [...path, part] : [part];
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
function parseBlock(lines, pos, indent, ctx, root = false, basePath = []) {
  // Decide map vs sequence by first content line at exactly this indent.
  const peek = peekContent(lines, pos, indent);
  if (!peek) return null;
  if (peek.line.bare.startsWith('- ') || peek.line.bare === '-') return parseSequence(lines, pos, indent, ctx, basePath);
  return parseMapping(lines, pos, indent, ctx, basePath);
}

function peekContent(lines, pos, indent) {
  let i = pos.i;
  while (i < lines.length) {
    const c = classify(lines[i]);
    if (c.type === 'blank') { i++; continue; }
    if (c.type === 'comment') { i++; continue; } // handled by caller via pendingComments
    if (c.indent < indent) return null;
    if (c.indent > indent) fail(ctx, ctx.lineOf(i), `unexpected deeper indentation (got ${c.indent}, expected ${indent})`);
    return { idx: i, line: c };
  }
  return null;
}

function parseMapping(lines, pos, indent, ctx, basePath = []) {
  /** @type {Record<string, any>} */
  const out = {};
  while (pos.i < lines.length) {
    const c = classify(lines[pos.i]);
    if (c.type === 'blank') { pos.i++; continue; }
    if (c.type === 'comment') { ctx.pendingComments.push(c.text); pos.i++; continue; }
    if (c.indent < indent) break;
    if (c.indent > indent) fail(ctx, ctx.lineOf(pos.i), 'inconsistent indentation inside mapping');

    const m = matchKey(c.text);
    if (!m) fail(ctx, ctx.lineOf(pos.i), `expected 'key:' mapping entry, got: ${c.bare.slice(0, 40)}`, basePath);
    const keyPath = [...basePath, m.key];
    ctx.provenance.set(formatPath(keyPath), ctx.lineOf(pos.i));
    assertKeyWellFormed(ctx, ctx.lineOf(pos.i), m, keyPath);
    // Duplicate keys are a corruption class (real YAML parsers reject them):
    // silent last-wins hides data from every downstream check.
    if (Object.prototype.hasOwnProperty.call(out, m.key)) {
      fail(ctx, ctx.lineOf(pos.i), `duplicate key '${m.key}' in mapping`, keyPath);
    }
    const key = consumePendingAndParseKey(ctx, c, ctx.lineOf(pos.i), keyPath);
    pos.i++;

    // Value may be inline, a nested block, or a sequence at SAME indent (common YAML style).
    const inlineVal = splitKeyValue(c.text, ctx, pos.i, keyPath);
    if (inlineVal.hasValue) {
      out[key.name] = parseScalarOrFlow(inlineVal.value, ctx, pos.i, keyPath);
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

function parseChild(lines, pos, childIndent, ctx, basePath = []) {
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
  if (c.bare.startsWith('- ') || c.bare === '-') return parseSequence(lines, pos, childIndent, ctx, basePath);
  return parseMapping(lines, pos, childIndent, ctx, basePath);
}

function parseSequence(lines, pos, indent, ctx, basePath = []) {
  /** @type {any[]} */
  const out = [];
  while (pos.i < lines.length) {
    const c = classify(lines[pos.i]);
    if (c.type === 'blank') { pos.i++; continue; }
    if (c.type === 'comment') { ctx.pendingComments.push(c.text); pos.i++; continue; }
    if (c.indent !== indent || !(c.bare.startsWith('- ') || c.bare === '-')) break;

    const itemText = c.bare.slice(2).trim();
    if (itemText === '-' || itemText.startsWith('- ')) {
      fail(ctx, ctx.lineOf(pos.i), 'nested sequence items are not supported by archgen\'s YAML subset', basePath);
    }
    // Positional anchor: comments above this item bind to its exact location.
    const itemPath = [...basePath, out.length];
    ctx.provenance.set(formatPath(itemPath), ctx.lineOf(pos.i));
    flushPendingInto(ctx.comments, ctx.pendingComments, itemPath, false);

    if (itemText === '') { // nested block under bare "-"
      pos.i++;
      const next = nextContent(lines, pos.i);
      if (!next || next.indent <= indent) { out.push(null); continue; }
      out.push(parseChild(lines, pos, next.indent, ctx, itemPath));
      continue;
    }
    const isFlowMap = itemText.startsWith('{');
    // A fully quoted item is a SCALAR, never a mapping. The key-shaped tests
    // below match INSIDE the quotes, so `- "Test: returns 200"` used to be
    // rewritten as a mapping and died on an unterminated quoted key — the
    // spelling an agent reaches for first, refused for the wrong reason. A
    // quoted KEY (`- "odd: key": 1`) stays a mapping: it is not one quoted
    // scalar, so the pattern below does not match it.
    const isQuotedScalar = QUOTED_SCALAR_RE.test(itemText);
    const isMapItem = !isFlowMap && !isQuotedScalar &&
      (/^[^:#]+:(\s|$)/.test(itemText) || /^[A-Za-z_][\w.-]*:\s/.test(itemText));
    if (isFlowMap) {
      // Compact flow-map item: parse whole item as a flat mapping value.
      const { value, inlineComment } = splitInlineComment(itemText);
      out.push(parseScalarOrFlow(value, ctx, ctx.lineOf(pos.i), itemPath));
      if (inlineComment) ctx.comments.push({ path: itemPath, inline: true, text: inlineComment });
      pos.i++;
      continue;
    }
    if (isMapItem) {
      // Sequence of mappings: rewrite this line as a virtual mapping start.
      // The sub-parser sees a renumbered array, so every absorbed line keeps
      // its ORIGINAL number — a finding inside a task names the line in the
      // file the author will open, not the line in this scratch array.
      const virtualLine = ' '.repeat(indent + INDENT_UNIT) + itemText;
      const sub = [virtualLine];
      const origin = [ctx.lineOf(pos.i)];
      pos.i++;
      // Absorb following lines that belong to this item (indent > indent, not a new "- ").
      while (pos.i < lines.length) {
        const n = classify(lines[pos.i]);
        if (n.type === 'blank' || n.type === 'comment') { sub.push(lines[pos.i]); origin.push(ctx.lineOf(pos.i)); pos.i++; continue; }
        // Absorb ANY deeper line, dashes included: a '-' deeper than the item
        // base belongs to THIS item (nested list under one of its keys). Sibling
        // items sit exactly at `indent`, so the indent test alone is sufficient.
        if (n.indent > indent) { sub.push(lines[pos.i]); origin.push(ctx.lineOf(pos.i)); pos.i++; continue; }
        break;
      }
      const subCtx = {
        filename: ctx.filename,
        comments: ctx.comments,
        pendingComments: [],
        provenance: ctx.provenance,
        lineOf: (i) => origin[i] ?? origin[0],
      };
      const subPos = { i: 0 };
      // Sub-mapping inherits the item's positional path so inner keys anchor
      // as [.., itemIndex, keyName] — reviewer notes can never migrate between
      // sibling items that share key names (the set-status corruption class).
      const obj = parseMapping(sub, subPos, indent + INDENT_UNIT, subCtx, itemPath);
      // Every absorbed line must have been READ. A line whose indent does
      // not match the item's mapping ends the mapping early — and the
      // sequence has already consumed the line, so it would vanish from the
      // document AND from the next write. Refuse instead: a mis-indented key
      // is a typo, not a deletion.
      if (subPos.i < sub.length) {
        fail(
          ctx,
          origin[subPos.i] ?? ctx.lineOf(pos.i),
          'inconsistent indentation inside a sequence item — this line does not belong to the item',
          itemPath,
        );
      }
      for (const pc of subCtx.pendingComments) ctx.comments.push({ path: null, inline: false, text: pc });
      out.push(obj);
      continue;
    }
    // Plain scalar item (may include inline comment).
    const { value, inlineComment } = splitInlineComment(itemText);
    out.push(parseScalarOrFlow(value, ctx, ctx.lineOf(pos.i), itemPath));
    if (inlineComment) ctx.comments.push({ path: itemPath, inline: true, text: inlineComment });
    pos.i++;
  }
  return out;
}

/** Split "key: value # comment" honoring quotes; returns parts. */
function splitKeyValue(text, ctx, lineNo, path) {
  const m = matchKey(text);
  if (!m) fail(ctx, lineNo, `expected 'key:' mapping entry, got: ${text.slice(0, 40)}`, path);
  const rest = text.slice(m.end).trim();
  const { value, inlineComment } = splitInlineComment(rest);
  return { hasValue: value.length > 0, value, inlineComment, key: m.key };
}

const KEY_RE = /^("([^"\\]|\\.)*"|'([^'\\]|\\.)*'|[^:#]+?):(?:\s|$)/;

// A sequence item that is ONE quoted scalar, optionally followed by a comment.
// A quoted key (`- "odd: key": 1`) is a mapping and must not match this.
const QUOTED_SCALAR_RE = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*(?:#.*)?$/;
function matchKey(text) {
  const m = KEY_RE.exec(text);
  if (!m) return null;
  return { key: unquote(m[1]), raw: m[1], end: m[0].length };
}

/** Reject malformed keys early: unterminated quotes and brace/bracket starts are
 * typos that would otherwise silently become literal key names. */
function assertKeyWellFormed(ctx, lineNo, m, path) {
  const r = m.raw;
  if (r.startsWith('"') && !(r.length >= 2 && r.endsWith('"'))) fail(ctx, lineNo, `unterminated double-quoted key: ${r}`, path);
  if (r.startsWith("'") && !(r.length >= 2 && r.endsWith("'"))) fail(ctx, lineNo, `unterminated single-quoted key: ${r}`, path);
  if ('{['.includes(r[0])) fail(ctx, lineNo, `flow collections cannot be keys in archgen's YAML subset: ${r}`, path);
}

function splitInlineComment(s) {
  // Find '#' outside quotes.
  let inS = false, inD = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    // An escaped character cannot close a double-quoted string. Without
    // this, the value `a"b #c` — written as "a\"b #c" — closed its quote at
    // the ESCAPED quote, and the " #" after it was read as a comment.
    if (inD && ch === '\\') { i++; continue; }
    if (ch === "'" && !inD) inS = !inS;
    else if (ch === '"' && !inS) inD = !inD;
    else if (ch === '#' && !inS && !inD && (i === 0 || s[i - 1] === ' ')) {
      return { value: s.slice(0, i).trim(), inlineComment: s.slice(i).trim() };
    }
  }
  return { value: s.trim(), inlineComment: null };
}

function parseScalarOrFlow(v, ctx, lineNo, path) {
  if (v === '') return null;
  if (v.startsWith('[')) {
    if (!v.endsWith(']')) fail(ctx, lineNo, `unterminated flow sequence: ${v}`, path);
    const inner = v.slice(1, -1).trim();
    if (inner === '') return [];
    return splitFlow(inner).map((p, i) => parseScalarOrFlow(p, ctx, lineNo, extendPath(path, i)));
  }
  if ((v.startsWith('"') && !(v.length >= 2 && v.endsWith('"'))) ||
      (v.startsWith("'") && !(v.length >= 2 && v.endsWith("'")))) {
    fail(ctx, lineNo, `unterminated quoted string: ${v.slice(0, 30)}`, path);
  }
  if (v.startsWith('{')) {
    // Flat flow mappings are supported ({k: v, ...}) because compact task
    // entries read far better; NESTED flow values inside them are not.
    if (!v.endsWith('}')) fail(ctx, lineNo, `unterminated flow mapping: ${v}`, path);
    const inner = v.slice(1, -1).trim();
    if (inner === '') return {};
    const obj = {};
    for (const part of splitFlow(inner)) {
      const m = matchKey(part);
      if (!m) fail(ctx, lineNo, `flow mapping entry must be 'key: value', got: ${part}`, path);
      assertKeyWellFormed(ctx, lineNo, m, path);
      if (Object.prototype.hasOwnProperty.call(obj, m.key)) {
        fail(ctx, lineNo, `duplicate key '${m.key}' in flow mapping`, path);
      }
      const val = part.slice(m.end).trim();
      if (val.startsWith('{')) fail(ctx, lineNo, `nested flow mappings are not supported: ${val}`, path);
      obj[m.key] = parseScalarOrFlow(val, ctx, lineNo, extendPath(path, m.key));
    }
    return obj;
  }
  if (v.startsWith('|') || v.startsWith('>')) fail(ctx, lineNo, `block scalars are not supported by archgen's YAML subset (use quoted or single-line values): ${v[0]}`, path);
  if (v.startsWith('&') || v.startsWith('*') || v.startsWith('!')) fail(ctx, lineNo, `anchors/tags are not supported by archgen's YAML subset: ${v[0]}`, path);
  return parseScalar(v);
}

function splitFlow(inner) {
  const parts = []; let cur = ''; let inS = false, inD = false, depth = 0;
  for (const ch of inner) {
    if (ch === "'" && !inD) inS = !inS;
    else if (ch === '"' && !inS) inD = !inD;
    else if (!inS && !inD && (ch === '[' || ch === '{')) depth++;
    else if (!inS && !inD && (ch === ']' || ch === '}')) depth--;
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
  // Exponent notation too: `String(1e21)` is "1e+21", and a number the
  // writer emits must read back as the SAME number.
  if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(v)) return parseFloat(v);
  return v; // plain string
}

/**
 * The escapes a double-quoted scalar may carry.
 *
 * The emitter writes double-quoted values with JSON.stringify, so these are
 * exactly the escapes it can produce. The YAML-only names are accepted too: a
 * hand-written file uses them, and refusing them would reject legitimate
 * input for no gain.
 */
const DOUBLE_QUOTE_ESCAPES = {
  '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t',
  '0': '\0', a: '\x07', v: '\x0b', e: '\x1b', N: '\u0085', _: '\u00a0',
  L: '\u2028', P: '\u2029',
};

/** Decode the body of a double-quoted scalar. */
function decodeDoubleQuoted(body) {
  let out = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch !== '\\') { out += ch; continue; }
    const esc = body[++i];
    if (esc === undefined) { out += '\\'; break; }
    if (esc === 'x' || esc === 'u' || esc === 'U') {
      const width = esc === 'x' ? 2 : esc === 'u' ? 4 : 8;
      const hex = body.slice(i + 1, i + 1 + width);
      if (hex.length === width && /^[0-9a-fA-F]+$/.test(hex)) {
        out += String.fromCodePoint(parseInt(hex, 16));
        i += width;
        continue;
      }
      out += esc;
      continue;
    }
    out += Object.hasOwn(DOUBLE_QUOTE_ESCAPES, esc) ? DOUBLE_QUOTE_ESCAPES[esc] : esc;
  }
  return out;
}

function unquote(v) {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) return decodeDoubleQuoted(v.slice(1, -1));
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

/**
 * Whether a value may be emitted as a plain scalar.
 *
 * A plain scalar is the shortest form, but only while the reader cannot
 * mistake it for structure. The tests below are the inverse of the parser's
 * own scalar rules: anything the parser would read back differently, and any
 * character that carries meaning, forces the quoted form. Emitting a value
 * the parser cannot read back is the corruption class this guards.
 */
function isPlainSafe(v) {
  if (v === '' || v !== v.trim()) return false;
  if (!/^[A-Za-z0-9_/]/.test(v)) return false;
  if (/["'#,[\]{}]/.test(v)) return false;
  if (/:\s/.test(v) || /\s#/.test(v)) return false;
  if (v.endsWith(':')) return false;
  if (/[\n\r\t]/.test(v)) return false;
  if (/^(true|false|null|~)$/i.test(v)) return false;
  if (/^(yes|no|on|off)$/i.test(v)) return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return false;
  return true;
}

function quoteIfNeeded(v) {
  return isPlainSafe(v) ? v : JSON.stringify(v);
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

function consumePendingAndParseKey(ctx, line, lineNo, keyPath) {
  const m = matchKey(line.text);
  if (!m) fail(ctx, lineNo, `expected 'key:' mapping entry, got: ${line.text.slice(0, 40)}`, keyPath);
  assertKeyWellFormed(ctx, lineNo, m, keyPath);
  // Full-line comments sitting directly above this key anchor to its FULL
  // positional path NOW; waiting longer would misattach them to a deeper child.
  for (const t of ctx.pendingComments.splice(0)) {
    ctx.comments.push({ path: keyPath, inline: false, text: t });
  }
  return {
    name: m.key,
    inlineComment(kp) {
      const { inlineComment } = splitInlineComment(line.text.slice(line.text.indexOf(':') + 1).trim());
      if (inlineComment) ctx.comments.push({ path: kp, inline: true, text: inlineComment });
    },
  };
}

function flushPendingInto(comments, pending, path, _inline) {
  for (const t of pending.splice(0)) comments.push({ path, inline: false, text: t });
}

/**
 * Serialize data back to the YAML subset, re-emitting comments positionally.
 * @param {any} data
 * @param {YamlComment[]} [comments]
 * @param {{eol?: string}} [opts] `eol` joins lines with the given line ending
 *   (default '\n'); callers that detected a CRLF source pass '\r\n' so the
 *   rewrite preserves the file's dominant convention byte-for-byte.
 */
export function stringifyYaml(data, comments = [], opts = {}) {
  // The reader refuses a scalar document — a plan is always a mapping — so
  // the writer must not produce one. Emitting it would write a file the
  // server cannot read back.
  if (data === null || typeof data !== 'object') {
    throw new TypeError('stringifyYaml writes a mapping or a sequence; a scalar is not a plan');
  }
  const eol = opts.eol ?? '\n';
  const out = [];
  const used = new Set();
  emitValue(out, data, 0, comments, used, []);
  // Dangling comments (path null) land at EOF in original order.
  for (let i = 0; i < comments.length; i++) {
    if (!used.has(i) && comments[i].path === null) out.push(comments[i].text);
  }
  return out.join(eol) + eol;
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

/**
 * Encode a mapping key.
 *
 * Keys are written the way VALUES are written: quoted whenever a plain key
 * would be misread. A key containing ": ", starting with a YAML indicator,
 * or looking like a number or a keyword is quoted, so the file the emitter
 * writes always parses back to the key it was given.
 *
 * Without this, a key like `odd: key` was emitted verbatim and produced a
 * file that no longer parsed — and a single `set_status` could destroy the
 * plan it was updating.
 */
function encodeKey(k) {
  const s = String(k);
  if (s === '') return '""';
  if (
    /^[A-Za-z_][A-Za-z0-9_-]*$/.test(s) &&
    !/^(true|false|null|yes|no|on|off)$/i.test(s) &&
    !/^-?\d+(\.\d+)?$/.test(s)
  ) {
    return s;
  }
  return JSON.stringify(s);
}

/**
 * Emit one mapping entry.
 *
 * `prefix` is the text the key follows ("  " on its own line, "  - " on a
 * sequence item's first line); `keyIndent` is the column the key's own block
 * starts at. A collection value is emitted STRUCTURALLY — as a nested block,
 * never as a string — so a list can never be flattened into "a,b" or
 * "[object Object]" by the writer.
 */
function emitEntry(out, prefix, keyIndent, key, value, comments, used, kpath) {
  preComments(out, comments, used, kpath);
  const encoded = encodeKey(key);
  if (value !== null && typeof value === 'object') {
    const isArray = Array.isArray(value);
    const empty = isArray ? value.length === 0 : Object.keys(value).length === 0;
    if (empty) {
      out.push(prefix + encoded + (isArray ? ': []' : ': {}'));
      inlineCommentFor(out, comments, used, kpath);
      return;
    }
    out.push(prefix + encoded + ':');
    inlineCommentFor(out, comments, used, kpath);
    emitValue(out, value, keyIndent + INDENT_UNIT, comments, used, kpath);
    return;
  }
  out.push(prefix + encoded + ': ' + encodeScalar(value));
  inlineCommentFor(out, comments, used, kpath);
}

function emitValue(out, v, indent, comments, used, path) {
  const pad = ' '.repeat(indent);
  if (Array.isArray(v)) {
    if (v.length === 0) { out.push(pad + '[]'); return; }
    v.forEach((item, idx) => {
      const itemPath = [...path, idx];
      // Pre-item comments keep their original indentation relative to the dash.
      comments.forEach((c, i) => {
        if (!used.has(i) && !c.inline && c.path && samePath(c.path, itemPath)) {
          out.push(pad + c.text); used.add(i);
        }
      });
      if (item !== null && typeof item === 'object') {
        const entries = Object.entries(item);
        if (entries.length === 0) { out.push(pad + '- {}'); return; }
        const [k0, v0] = entries[0];
        // The first key shares the dash's line, so its block starts one level
        // deeper than the key's own column.
        emitEntry(out, pad + '- ', indent + INDENT_UNIT, k0, v0, comments, used, [...itemPath, k0]);
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

function emitEntries(out, entries, indent, comments, used, basePath) {
  const pad = ' '.repeat(indent);
  for (const [k, val] of entries) {
    emitEntry(out, pad, indent, k, val, comments, used, [...basePath, k]);
  }
}

function encodeScalar(v) {
  if (v === null) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (typeof v === 'string') return quoteIfNeeded(v);
  // Collections are emitted structurally; one reaching this branch is an
  // emitter bug, and writing "[object Object]" would corrupt the plan quietly.
  throw new TypeError(`cannot emit ${Array.isArray(v) ? 'an array' : 'an object'} as a scalar`);
}
