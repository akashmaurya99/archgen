// jsonc-config.mjs — lossless JSONC support for the harness config writer.
//
// WHY THIS EXISTS: two harnesses keep their MCP config as JSONC, not strict
// JSON — opencode (~/.config/opencode/opencode.json) and Zed
// (~/.config/zed/settings.json). JSON.parse rejects both, so the writer used
// to refuse them and leave them permanently unwired.
//
// WHY NOT JUST PARSE AND REWRITE: rewriting a JSONC file as plain JSON would
// delete the user's comments, their key order and their formatting. That is
// as destructive as never wiring the file at all, so a JSONC config is edited
// TEXTUALLY: only the bytes of the target entry are spliced and everything
// else survives verbatim.

/** Raised for any JSONC text this module cannot handle safely. */
class JsoncError extends Error {}

/**
 * Parse strict JSON or JSONC.
 *
 * Comments and trailing commas are removed for the parse only — the input
 * text is never modified, because the writer edits the raw bytes.
 *
 * @param {string} text
 * @returns {{data: any, error: string|null}}
 */
export function parseJsonc(text) {
  try {
    const scan = maskJsonc(text);
    return { data: JSON.parse(stripTrailingCommas(scan)), error: null };
  } catch (e) {
    return { data: null, error: e.message };
  }
}

/**
 * Merge a server entry into a JSON/JSONC MCP config.
 *
 * Strict JSON is merged and re-serialized as a whole (the historic
 * behaviour). JSONC is spliced textually so every unrelated byte survives.
 *
 * @param {string} text the current file contents
 * @param {string} key the top-level key ('mcpServers' | 'mcp' | 'context_servers')
 * @param {string} serverId the entry name inside the bucket
 * @param {any} entry the server entry
 * @returns {{text: string, changed: boolean, reason?: string}}
 *   `changed:false` with no reason means "already up to date"; with a reason
 *   it means "refused, the text is untouched".
 */
export function mergeEntry(text, key, serverId, entry) {
  const strict = parseStrict(text);
  if (strict.ok) return mergeStrict(text, strict.data, key, serverId, entry);

  const parsed = parseJsonc(text);
  if (parsed.error) {
    return { text, changed: false, reason: `not valid JSON or JSONC (${parsed.error})` };
  }
  const installed = bucketOf(parsed.data, key)?.[serverId];
  if (installed && JSON.stringify(installed) === JSON.stringify(entry)) {
    return { text, changed: false };
  }

  let root;
  try {
    root = scanDocument(text);
  } catch (e) {
    return { text, changed: false, reason: `cannot locate the target safely (${e.message})` };
  }
  const style = detectStyle(text, root);
  const parts = key.split('.');
  const resolved = walkKeyPath(root, parts);
  if (resolved.ambiguous) {
    // A duplicated key makes the target ambiguous: JSON.parse would read the
    // last one, so splicing the first would have no effect.
    return { text, changed: false, reason: `the key '${key}' appears more than once` };
  }
  if (resolved.blocked) {
    return { text, changed: false, reason: `'${resolved.blocked}' is not an object` };
  }

  if (!resolved.member) {
    // The path does not exist yet. Build the missing chain and insert it.
    const value = buildChain(parts, serverId, entry, resolved.missingIndex ?? parts.length - 1);
    const out = insertMember(text, resolved.parent, JSON.stringify(resolved.missing), value, style, false);
    return { text: out, changed: out !== text };
  }
  if (resolved.member.kind !== 'object') {
    return { text, changed: false, reason: `the key '${key}' is not an object` };
  }

  const bucket = resolved.member.object;
  const existing = bucket.members.filter((m) => m.key === serverId);
  if (existing.length > 1) {
    return { text, changed: false, reason: `the entry '${serverId}' appears more than once under '${key}'` };
  }
  const current = existing[0];
  if (!current) {
    const out = insertMember(text, bucket, JSON.stringify(serverId), entry, style, isMultiline(text, root));
    return { text: out, changed: out !== text };
  }
  // A replaced value keeps the shape it had: a value written over several
  // lines stays over several lines.
  const multiline = text.slice(current.valueStart, current.valueEnd).includes('\n');
  const replacement = renderValue(entry, style, multiline, memberIndent(text, bucket, style));
  const out = text.slice(0, current.valueStart) + replacement + text.slice(current.valueEnd);
  return { text: out, changed: out !== text };
}

/**
 * Walk a dotted key path through the scanned tree.
 *
 * WHY IT IS NOT CALLED `resolvePath`: another module had a `resolvePath`
 * that resolved a FILESYSTEM path — a different operation under the same
 * name. Two names for two operations in one codebase is how a reader picks
 * the wrong one. This one walks a tree of members, so it is named for that.
 *
 * @param {object} root the scanned top-level object
 * @param {string[]} parts the path segments
 * @returns {{member: object|null, parent: object|null, missing: string|null,
 *   missingIndex: number, ambiguous: boolean, blocked: string|null}}
 */
function walkKeyPath(root, parts) {
  let container = root;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const hits = container.members.filter((m) => m.key === part);
    if (hits.length > 1) return { member: null, parent: null, missing: null, missingIndex: 0, ambiguous: true, blocked: null };
    if (hits.length === 0) {
      return { member: null, parent: container, missing: part, missingIndex: i, ambiguous: false, blocked: null };
    }
    const member = hits[0];
    if (i === parts.length - 1) {
      return { member, parent: container, missing: null, missingIndex: 0, ambiguous: false, blocked: null };
    }
    if (member.kind !== 'object') {
      return { member: null, parent: null, missing: null, missingIndex: 0, ambiguous: false, blocked: part };
    }
    container = member.object;
  }
  return { member: null, parent: null, missing: null, missingIndex: 0, ambiguous: false, blocked: null };
}

/**
 * The value for the missing segment of a key path.
 *
 * `parts` is the full path and `fromIndex` the index of its first missing
 * segment. The value is what goes UNDER that segment: the chain from the
 * segment below it down to the entry. The segment itself is the member's
 * name, so it is not repeated here.
 *
 * `fromIndex` defaults to -1 — the WHOLE chain — which is what a brand-new
 * config file needs. A merge into an existing document passes the index of
 * the segment that already exists, so only the part below it is built.
 *
 * @param {string[]} parts the key path, split on '.'
 * @param {string} serverId the entry's member name
 * @param {unknown} entry the entry itself
 * @param {number} [fromIndex] the index of the first MISSING segment
 * @returns {object}
 */
export function buildChain(parts, serverId, entry, fromIndex = -1) {
  let value = { [serverId]: entry };
  for (let i = parts.length - 1; i > fromIndex; i--) {
    value = { [parts[i]]: value };
  }
  return value;
}

/**
 * Remove one server entry from a JSON/JSONC MCP config.
 *
 * The JSONC branch exists because the writer can now install into a JSONC
 * file: uninstalling by re-serializing the parsed document would silently
 * delete the user's comments.
 *
 * @param {string} text
 * @param {string} key
 * @param {string} serverId
 * @returns {{text: string, changed: boolean, reason?: string}}
 */
export function removeEntry(text, key, serverId) {
  const strict = parseStrict(text);
  if (strict.ok) {
    const obj = strict.data && typeof strict.data === 'object' && !Array.isArray(strict.data) ? strict.data : null;
    const bucket = obj ? bucketOf(obj, key) : null;
    if (!bucket || !(serverId in bucket)) {
      return { text, changed: false, reason: `no '${serverId}' entry under '${key}'` };
    }
    delete bucket[serverId];
    const out = JSON.stringify(obj, null, 2) + '\n';
    return { text: out, changed: out !== text };
  }

  const parsed = parseJsonc(text);
  if (parsed.error) {
    return { text, changed: false, reason: `not valid JSON or JSONC (${parsed.error})` };
  }
  let root;
  try {
    root = scanDocument(text);
  } catch (e) {
    return { text, changed: false, reason: `cannot locate the target safely (${e.message})` };
  }
  const resolved = walkKeyPath(root, key.split('.'));
  if (resolved.ambiguous) {
    return { text, changed: false, reason: `the key '${key}' appears more than once` };
  }
  const target = resolved.member;
  if (!target || target.kind !== 'object') {
    return { text, changed: false, reason: `no '${key}' object found` };
  }
  const member = target.object.members.find((m) => m.key === serverId);
  if (!member) {
    return { text, changed: false, reason: `no '${serverId}' entry under '${key}'` };
  }
  const out = removeMemberText(text, target.object, member);
  return { text: out, changed: out !== text };
}

// ── parsing helpers ──────────────────────────────────────────────────────────

/** Strict JSON, or a failed attempt. */
function parseStrict(text) {
  try {
    return { ok: true, data: JSON.parse(text) };
  } catch {
    return { ok: false, data: null };
  }
}

/**
 * Merge into a strict JSON document and re-serialize the whole file.
 *
 * Strict JSON carries no formatting worth preserving, so the historic
 * behaviour (parse, merge, re-serialize) is kept.
 *
 * The key may be a DOTTED PATH: opencode keeps its servers at
 * `mcp.servers.<id>`, not `mcp.<id>`. A single top-level key cannot express
 * that, and writing to `mcp.<id>` put the entry where opencode never looks —
 * the server was installed and invisible.
 */
function mergeStrict(text, data, key, serverId, entry) {
  const obj = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const parts = key.split('.');
  let container = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!container[part] || typeof container[part] !== 'object' || Array.isArray(container[part])) {
      container[part] = {};
    }
    container = container[part];
  }
  const leaf = parts[parts.length - 1];
  const bucket =
    container[leaf] && typeof container[leaf] === 'object' && !Array.isArray(container[leaf])
      ? container[leaf]
      : {};
  const existing = bucket[serverId];
  if (existing && JSON.stringify(existing) === JSON.stringify(entry)) {
    return { text, changed: false };
  }
  bucket[serverId] = entry;
  container[leaf] = bucket;
  const out = JSON.stringify(obj, null, 2) + '\n';
  return { text: out, changed: out !== text };
}

/**
 * The bucket object for a key path, or null when it is missing or not an
 * object. A dotted path names a nested bucket (`mcp.servers`).
 */
function bucketOf(data, key) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const parts = key.split('.');
  let value = data;
  for (const part of parts) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    value = value[part];
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

/**
 * Blank out comments so JSON.parse can read the document.
 *
 * The masked text keeps the original length and every newline, so a parse
 * error still points at the right offset in the ORIGINAL file.
 */
function maskJsonc(text) {
  let masked = '';
  const commas = [];
  let i = 0;
  const n = text.length;
  let inString = false;
  while (i < n) {
    const c = text[i];
    if (inString) {
      if (c === '\\') {
        masked += c;
        if (i + 1 < n) {
          masked += text[i + 1];
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }
      masked += c;
      if (c === '"') inString = false;
      i += 1;
      continue;
    }
    if (c === '"') {
      inString = true;
      masked += c;
      i += 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      // A line comment runs to the end of the line; the newline itself stays
      // so every following offset is unchanged.
      while (i < n && text[i] !== '\n') {
        masked += ' ';
        i += 1;
      }
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      if (end === -1) throw new JsoncError('unterminated block comment');
      masked += text.slice(i, end + 2).replace(/[^\n]/g, ' ');
      i = end + 2;
      continue;
    }
    if (c === ',') commas.push(masked.length);
    masked += c;
    i += 1;
  }
  if (inString) throw new JsoncError('unterminated string');
  // A leading BOM is not JSON whitespace; blank it so the document parses
  // without moving any other byte.
  if (masked.charCodeAt(0) === 0xfeff) masked = ' ' + masked.slice(1);
  return { masked, commas };
}

/**
 * Turn trailing commas into whitespace.
 *
 * Only commas that are really outside a string are considered — a comma in
 * "a, }" is part of the string and must survive.
 */
function stripTrailingCommas(scan) {
  const chars = scan.masked.split('');
  for (const idx of scan.commas) {
    let j = idx + 1;
    while (j < chars.length && /\s/.test(chars[j])) j += 1;
    if (chars[j] === '}' || chars[j] === ']') chars[idx] = ' ';
  }
  return chars.join('');
}

// ── structural scanning ──────────────────────────────────────────────────────

/**
 * A scanner over the RAW text.
 *
 * It finds the byte ranges of the members of an object, so a target can be
 * spliced without re-serializing anything around it.
 */
class RawScanner {
  constructor(text) {
    this.text = text;
    this.i = 0;
  }

  peek() {
    return this.text[this.i];
  }

  /** Skip whitespace and comments. */
  skipTrivia() {
    const t = this.text;
    for (;;) {
      const c = t[this.i];
      if (c === undefined) return;
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        this.i += 1;
        continue;
      }
      if (c === '/' && t[this.i + 1] === '/') {
        while (this.i < t.length && t[this.i] !== '\n') this.i += 1;
        continue;
      }
      if (c === '/' && t[this.i + 1] === '*') {
        const end = t.indexOf('*/', this.i + 2);
        if (end === -1) throw new JsoncError('unterminated block comment');
        this.i = end + 2;
        continue;
      }
      return;
    }
  }

  /** Read a quoted string; the opening quote must be at the cursor. */
  readString() {
    const start = this.i;
    this.i += 1;
    while (this.i < this.text.length) {
      const c = this.text[this.i];
      if (c === '\\') {
        this.i += 2;
        continue;
      }
      if (c === '"') {
        this.i += 1;
        const raw = this.text.slice(start, this.i);
        try {
          return { start, end: this.i, value: JSON.parse(raw) };
        } catch {
          throw new JsoncError(`invalid string literal at offset ${start}`);
        }
      }
      this.i += 1;
    }
    throw new JsoncError(`unterminated string at offset ${start}`);
  }

  /** Scan an object; `level` is the nesting level of the members inside it. */
  scanObject(level) {
    const open = this.i;
    this.i += 1;
    const members = [];
    for (;;) {
      this.skipTrivia();
      const c = this.peek();
      if (c === undefined) throw new JsoncError('unterminated object');
      if (c === '}') {
        this.i += 1;
        return { open, close: this.i, members, level };
      }
      if (c === ',') {
        this.i += 1;
        continue; // a trailing comma before the closing brace
      }
      if (c !== '"') throw new JsoncError(`expected a property name at offset ${this.i}`);
      const key = this.readString();
      this.skipTrivia();
      if (this.peek() !== ':') throw new JsoncError(`expected ':' at offset ${this.i}`);
      this.i += 1;
      this.skipTrivia();
      const value = this.scanValue(level);
      members.push({
        key: key.value,
        keyStart: key.start,
        keyEnd: key.end,
        valueStart: value.start,
        valueEnd: value.end,
        kind: value.kind,
        object: value.object,
        level,
      });
      this.skipTrivia();
      const d = this.peek();
      if (d === ',') {
        this.i += 1;
        continue;
      }
      if (d === '}') {
        this.i += 1;
        return { open, close: this.i, members, level };
      }
      throw new JsoncError(`expected ',' or '}' at offset ${this.i}`);
    }
  }

  scanArray(level) {
    const open = this.i;
    this.i += 1;
    for (;;) {
      this.skipTrivia();
      const c = this.peek();
      if (c === undefined) throw new JsoncError('unterminated array');
      if (c === ']') {
        this.i += 1;
        return { open, close: this.i };
      }
      if (c === ',') {
        this.i += 1;
        continue;
      }
      this.scanValue(level);
      this.skipTrivia();
      const d = this.peek();
      if (d === ',') {
        this.i += 1;
        continue;
      }
      if (d === ']') {
        this.i += 1;
        return { open, close: this.i };
      }
      throw new JsoncError(`expected ',' or ']' at offset ${this.i}`);
    }
  }

  scanValue(level) {
    const c = this.peek();
    if (c === '{') {
      const obj = this.scanObject(level + 1);
      return { kind: 'object', start: obj.open, end: obj.close, object: obj };
    }
    if (c === '[') {
      const arr = this.scanArray(level + 1);
      return { kind: 'array', start: arr.open, end: arr.close };
    }
    if (c === '"') {
      const s = this.readString();
      return { kind: 'string', start: s.start, end: s.end };
    }
    const start = this.i;
    while (this.i < this.text.length && !/[\s,}\]\/]/.test(this.text[this.i])) this.i += 1;
    const raw = this.text.slice(start, this.i);
    if (!/^(true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.test(raw)) {
      throw new JsoncError(`unexpected token at offset ${start}`);
    }
    return { kind: 'literal', start, end: this.i };
  }
}

/**
 * Scan the whole document.
 *
 * The root must be an object and must be the only thing in the file —
 * anything else is refused rather than guessed at.
 */
function scanDocument(text) {
  const s = new RawScanner(text);
  s.skipTrivia();
  if (s.peek() !== '{') {
    throw new JsoncError(s.peek() === undefined ? 'the document is empty' : 'the top-level value is not an object');
  }
  const root = s.scanObject(1);
  s.skipTrivia();
  if (s.peek() !== undefined) throw new JsoncError('unexpected content after the top-level object');
  return root;
}

// ── style, splicing and rendering ───────────────────────────────────────────

/** The offset of the first character on the line that contains `pos`. */
function lineStart(text, pos) {
  return text.lastIndexOf('\n', pos - 1) + 1;
}

/** The leading whitespace of the line that contains `pos`. */
function lineIndent(text, pos) {
  const start = lineStart(text, pos);
  let end = start;
  while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end += 1;
  return text.slice(start, end);
}

function isSameLine(text, a, b) {
  return lineStart(text, a) === lineStart(text, b);
}

/** The indentation one level deeper than `parent`. */
function indentDiff(parent, child) {
  if (child.startsWith(parent)) return child.slice(parent.length);
  return child.length > parent.length ? child : null;
}

/**
 * The file's own formatting: its line ending and its indentation unit.
 *
 * The unit is measured from the root object, so an inserted member lines up
 * with the members that are already there.
 */
function detectStyle(text, root) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const rootIndent = lineIndent(text, root.open);
  let unit = null;
  for (const m of root.members) {
    if (isSameLine(text, m.keyStart, root.open)) continue;
    const diff = indentDiff(rootIndent, lineIndent(text, m.keyStart));
    if (diff && (unit === null || diff.length < unit.length)) unit = diff;
  }
  return { eol, unit: unit ?? '  ' };
}

/** The indentation of the members of an object. */
function memberIndent(text, obj, style) {
  const first = obj.members[0];
  if (first && !isSameLine(text, first.keyStart, obj.open)) return lineIndent(text, first.keyStart);
  return lineIndent(text, obj.open) + style.unit;
}

function isMultiline(text, obj) {
  return !isSameLine(text, obj.open, obj.close - 1);
}

/**
 * Render a value the way the file already writes values.
 *
 * A multiline object gets multiline values, a single-line object gets
 * single-line values: the edit must not restyle the file around it.
 */
function renderValue(value, style, multiline, indent) {
  if (!multiline) return JSON.stringify(value);
  return stringifyPretty(value, indent + style.unit, indent, style.unit, style.eol);
}

/** Pretty-print a value at a given indentation. */
function stringifyPretty(value, memberPad, closePad, unit, eol) {
  if (Array.isArray(value)) {
    if (!value.length) return '[]';
    const parts = value.map((v) => memberPad + stringifyPretty(v, memberPad + unit, memberPad, unit, eol));
    return '[' + eol + parts.join(',' + eol) + eol + closePad + ']';
  }
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (!keys.length) return '{}';
    const parts = keys.map(
      (k) => memberPad + JSON.stringify(k) + ': ' + stringifyPretty(value[k], memberPad + unit, memberPad, unit, eol),
    );
    return '{' + eol + parts.join(',' + eol) + eol + closePad + '}';
  }
  return JSON.stringify(value);
}

/** The index of the next comma between `from` and `to`, or -1. */
function findCommaAfter(text, from, to) {
  const s = new RawScanner(text);
  s.i = from;
  s.skipTrivia();
  if (s.i < to && text[s.i] === ',') return s.i;
  return -1;
}

/** The index of the previous comma between `from` and `to`, or -1. */
function findCommaBefore(text, from, to) {
  let i = to - 1;
  while (i >= from) {
    const c = text[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i -= 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      i = text.lastIndexOf('\n', i - 1);
      continue;
    }
    if (c === '/' && text[i - 1] === '*') {
      i = text.lastIndexOf('/*', i - 1) - 1;
      continue;
    }
    return c === ',' ? i : -1;
  }
  return -1;
}

/**
 * Insert `keyText: value` as the last member of an object.
 *
 * Only the bytes around the insertion point move; every other byte of the
 * file is left exactly as it was.
 */
function insertMember(text, obj, keyText, value, style, parentMultiline) {
  const closeIdx = obj.close - 1;
  const indent = memberIndent(text, obj, style);
  // An object with no members yet has no style of its own to copy, so it
  // follows the object it lives in.
  const multiline = isMultiline(text, obj) || (!obj.members.length && parentMultiline);
  const memberText = keyText + ': ' + renderValue(value, style, multiline, indent);

  if (!obj.members.length) {
    // The object holds nothing yet, so its braces are the only thing to
    // replace.
    const inner = text.slice(obj.open + 1, closeIdx);
    if (!multiline) return text.slice(0, obj.open + 1) + memberText + text.slice(closeIdx);
    const nl = inner.lastIndexOf('\n');
    const head = nl >= 0 ? inner.slice(0, nl + 1) : style.eol;
    const closePad = lineIndent(text, obj.open);
    const pad = closePad + style.unit;
    return text.slice(0, obj.open + 1) + head + pad + memberText + style.eol + closePad + text.slice(closeIdx);
  }

  const last = obj.members[obj.members.length - 1];
  const comma = findCommaAfter(text, last.valueEnd, closeIdx);
  if (!multiline) {
    if (comma >= 0) {
      return text.slice(0, comma + 1) + ' ' + memberText + text.slice(comma + 1, closeIdx) + text.slice(closeIdx);
    }
    return text.slice(0, last.valueEnd) + ', ' + memberText + text.slice(closeIdx);
  }

  const before = comma >= 0 ? text.slice(0, comma + 1) : text.slice(0, last.valueEnd) + ',';
  const after = comma >= 0 ? text.slice(comma + 1, closeIdx) : text.slice(last.valueEnd, closeIdx);
  // The first newline after the comma separates the new member from what was
  // there; anything after it (a note, the closing indent) keeps its place.
  const nl = after.indexOf('\n');
  const sep = nl >= 0 ? after.slice(0, nl + 1) : '';
  const rest = nl >= 0 ? after.slice(nl + 1) : after;
  return before + sep + indent + memberText + style.eol + rest + text.slice(closeIdx);
}

/** Remove one member from an object, taking its comma with it. */
function removeMemberText(text, obj, member) {
  const closeIdx = obj.close - 1;
  const commaAfter = findCommaAfter(text, member.valueEnd, closeIdx);
  if (commaAfter >= 0) {
    let start = member.keyStart;
    const ls = lineStart(text, member.keyStart);
    if (/^[ \t]*$/.test(text.slice(ls, member.keyStart))) {
      start = ls > 0 && text[ls - 1] === '\n' ? ls - 1 : ls;
    }
    return text.slice(0, start) + text.slice(commaAfter + 1);
  }
  const commaBefore = findCommaBefore(text, obj.open + 1, member.keyStart);
  if (commaBefore >= 0) return text.slice(0, commaBefore) + text.slice(member.valueEnd);
  return text.slice(0, member.keyStart) + text.slice(member.valueEnd);
}
