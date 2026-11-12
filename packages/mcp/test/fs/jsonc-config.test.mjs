// jsonc-config.test.mjs — the lossless JSONC path of the config writer.
//
// WHY THESE TESTS EXIST: a JSONC config used to be refused outright, and the
// obvious "fix" — parse it and write it back as plain JSON — would delete
// the user's comments. These tests pin the contract that the edit is
// TEXTUAL: everything the user wrote survives byte-for-byte.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseJsonc, mergeEntry, removeEntry } from '../../src/core/fs/jsonc-config.mjs';
import { readJsonConfig, writeJsonConfig } from '../../src/core/harness/harness-wiring.mjs';

const ENTRY = { type: 'local', command: ['archgen-mcp'], enabled: true };

/**
 * True when `after` is `before` with characters INSERTED.
 *
 * This is the property that proves the edit added to the file instead of
 * rewriting it: every original byte is still there, in order.
 */
function isInsertionOf(before, after) {
  let i = 0;
  for (const ch of after) {
    if (i < before.length && before[i] === ch) i += 1;
  }
  return i === before.length;
}

function sandbox() {
  return mkdtempSync(join(tmpdir(), 'archgen-jsonc-'));
}

// ── parsing ──────────────────────────────────────────────────────────────────

test('a line comment is not a comment when it is inside a string', () => {
  const { data, error } = parseJsonc('{ "url": "https://example.com//path", "note": "a // b" }');
  assert.equal(error, null);
  assert.equal(data.url, 'https://example.com//path');
  assert.equal(data.note, 'a // b');
});

test('a block comment marker inside a string is left alone', () => {
  const { data, error } = parseJsonc('{ "note": "a /* b */ c" }');
  assert.equal(error, null);
  assert.equal(data.note, 'a /* b */ c');
});

test('a comma inside a string is not a trailing comma', () => {
  const { data, error } = parseJsonc('{ "a": "x, }" }');
  assert.equal(error, null);
  assert.equal(data.a, 'x, }');
});

test('strict JSON still parses', () => {
  const { data, error } = parseJsonc('{"a":1,"b":[1,2]}');
  assert.equal(error, null);
  assert.deepEqual(data, { a: 1, b: [1, 2] });
});

test('a broken document reports an error instead of throwing', () => {
  const { data, error } = parseJsonc('{ "a": ');
  assert.equal(data, null);
  assert.ok(error);
});

// ── merging into JSONC ───────────────────────────────────────────────────────

test('a JSONC file with line comments gains the entry and keeps every comment', () => {
  const source = [
    '{',
    '  // opencode reads this file as JSONC, comments included',
    '  "$schema": "https://opencode.ai/config.json",',
    '  "model": "opencode/space-bunny-free",',
    '  "mcp": {',
    '    "servers": {',
    '      "codegraph": {',
    '        "type": "local",',
    '        "command": ["codegraph", "serve", "--mcp"]',
    '      }',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');

  const result = mergeEntry(source, 'mcp', 'archgen', ENTRY);
  assert.equal(result.changed, true);
  assert.ok(isInsertionOf(source, result.text), 'the edit must only add bytes');
  assert.ok(result.text.includes('  // opencode reads this file as JSONC, comments included'));

  const after = parseJsonc(result.text);
  assert.equal(after.error, null);
  assert.deepEqual(after.data.mcp.archgen, ENTRY);
  assert.deepEqual(after.data.mcp.servers.codegraph, { type: 'local', command: ['codegraph', 'serve', '--mcp'] });
  assert.equal(after.data.model, 'opencode/space-bunny-free');
});

test('a JSONC file with block comments gains the entry and keeps every comment', () => {
  const source = [
    '{',
    '  /* Zed settings */',
    '  "theme": {',
    '    "mode": "dark" /* the only mode */',
    '  },',
    '  "context_servers": {',
    '    "other": { "command": "keep" }',
    '  }',
    '}',
    '',
  ].join('\n');

  const result = mergeEntry(source, 'context_servers', 'archgen', ENTRY);
  assert.equal(result.changed, true);
  assert.ok(isInsertionOf(source, result.text), 'the edit must only add bytes');
  assert.ok(result.text.includes('  /* Zed settings */'));
  assert.ok(result.text.includes('    "mode": "dark" /* the only mode */'));

  const after = parseJsonc(result.text);
  assert.equal(after.error, null);
  assert.deepEqual(after.data.context_servers.archgen, ENTRY);
  assert.deepEqual(after.data.context_servers.other, { command: 'keep' });
  assert.deepEqual(after.data.theme, { mode: 'dark' });
});

test('an empty bucket is filled in without losing the comments around it', () => {
  const source = ['{', '  // an empty bucket', '  "context_servers": {}', '}', ''].join('\n');

  const result = mergeEntry(source, 'context_servers', 'archgen', ENTRY);
  assert.equal(result.changed, true);
  assert.ok(result.text.includes('  // an empty bucket'));

  const after = parseJsonc(result.text);
  assert.equal(after.error, null);
  assert.deepEqual(after.data.context_servers.archgen, ENTRY);
});

test('a JSONC file with trailing commas gains the entry and keeps them', () => {
  const source = [
    '{',
    '  "mcp": {',
    '    "servers": {',
    '      "codegraph": {',
    '        "type": "local",',
    '      },',
    '    },',
    '  },',
    '}',
    '',
  ].join('\n');

  const result = mergeEntry(source, 'mcp', 'archgen', ENTRY);
  assert.equal(result.changed, true);
  assert.ok(isInsertionOf(source, result.text), 'the edit must only add bytes');

  const after = parseJsonc(result.text);
  assert.equal(after.error, null);
  assert.deepEqual(after.data.mcp.archgen, ENTRY);
  assert.ok(result.text.includes('      },'), 'the trailing commas must survive');
});

test('an absent target key is inserted, and the file still parses', () => {
  const source = ['// Zed settings', '{', '  "theme": "dark",', '  "font_size": 14,', '}', ''].join('\n');

  const result = mergeEntry(source, 'context_servers', 'archgen', ENTRY);
  assert.equal(result.changed, true);
  assert.ok(isInsertionOf(source, result.text), 'the edit must only add bytes');
  assert.ok(result.text.includes('// Zed settings'));

  const after = parseJsonc(result.text);
  assert.equal(after.error, null);
  assert.deepEqual(after.data.context_servers.archgen, ENTRY);
  assert.equal(after.data.theme, 'dark');
  assert.equal(after.data.font_size, 14);
});

test('an existing server entry is replaced in place, and everything else survives', () => {
  const source = [
    '{',
    '  // the bucket the writer fills',
    '  "mcp": {',
    '    "archgen": {',
    '      "type": "local",',
    '      "command": ["old-binary"],',
    '      "enabled": false',
    '    },',
    '    "other": { "keep": "me" }',
    '  }',
    '}',
    '',
  ].join('\n');

  const result = mergeEntry(source, 'mcp', 'archgen', ENTRY);
  assert.equal(result.changed, true);
  assert.ok(result.text.includes('  // the bucket the writer fills'));
  assert.ok(result.text.includes('"other": { "keep": "me" }'));
  assert.ok(!result.text.includes('old-binary'));

  const after = parseJsonc(result.text);
  assert.equal(after.error, null);
  assert.deepEqual(after.data.mcp.archgen, ENTRY);
  assert.deepEqual(after.data.mcp.other, { keep: 'me' });
});

// ── refusals ─────────────────────────────────────────────────────────────────

test('a target key holding a string is refused, and the file is untouched', () => {
  const source = '{\n  // Zed settings\n  "mcp": "not-an-object"\n}\n';
  const result = mergeEntry(source, 'mcp', 'archgen', ENTRY);
  assert.equal(result.changed, false);
  assert.ok(result.reason, 'a refusal must say why');
  assert.equal(result.text, source);
});

test('a target key holding an array is refused, and the file is untouched', () => {
  const source = '{\n  // Zed settings\n  "mcp": [\n    "one"\n  ]\n}\n';
  const result = mergeEntry(source, 'mcp', 'archgen', ENTRY);
  assert.equal(result.changed, false);
  assert.ok(result.reason, 'a refusal must say why');
  assert.equal(result.text, source);
});

test('a broken file is refused, and the file is untouched', () => {
  const source = '{\n  "mcp": {\n    "servers": {\n';
  const result = mergeEntry(source, 'mcp', 'archgen', ENTRY);
  assert.equal(result.changed, false);
  assert.ok(result.reason, 'a refusal must say why');
  assert.equal(result.text, source);
});

test('an unterminated string is refused, and the file is untouched', () => {
  const source = '{\n  "mcp": { "servers": { "a": "oops }\n}\n';
  const result = mergeEntry(source, 'mcp', 'archgen', ENTRY);
  assert.equal(result.changed, false);
  assert.ok(result.reason, 'a refusal must say why');
  assert.equal(result.text, source);
});

test('a document whose root is not an object is refused', () => {
  const source = '// a comment\n[\n  1,\n  2\n]\n';
  const result = mergeEntry(source, 'mcp', 'archgen', ENTRY);
  assert.equal(result.changed, false);
  assert.ok(result.reason, 'a refusal must say why');
  assert.equal(result.text, source);
});

test('a strict JSON document with an array root keeps the old replace-it behaviour', () => {
  const source = '[\n  1,\n  2\n]\n';
  const result = mergeEntry(source, 'mcp', 'archgen', ENTRY);
  assert.equal(result.changed, true);
  assert.deepEqual(JSON.parse(result.text).mcp.archgen, ENTRY);
});

// ── strict JSON keeps its old behaviour ──────────────────────────────────────

test('strict JSON is merged and re-serialized exactly as before', () => {
  const source = JSON.stringify({ mcpServers: { other: { command: 'x' } } }, null, 2);
  const result = mergeEntry(source, 'mcpServers', 'archgen', ENTRY);
  assert.equal(result.changed, true);
  assert.equal(
    result.text,
    JSON.stringify({ mcpServers: { other: { command: 'x' }, archgen: ENTRY } }, null, 2) + '\n',
  );
});

test('an identical strict JSON entry is reported unchanged', () => {
  const source = JSON.stringify({ mcpServers: { archgen: ENTRY } }, null, 2);
  const result = mergeEntry(source, 'mcpServers', 'archgen', ENTRY);
  assert.equal(result.changed, false);
  assert.equal(result.reason, undefined);
  assert.equal(result.text, source);
});

// ── round trip ───────────────────────────────────────────────────────────────

test('the merged file parses back to exactly what was merged', () => {
  const source = ['{', '  // a note', '  "mcp": {}', '}', ''].join('\n');
  const result = mergeEntry(source, 'mcp', 'archgen', ENTRY);
  const after = parseJsonc(result.text);
  assert.equal(after.error, null);
  assert.deepEqual(after.data.mcp.archgen, ENTRY);
  assert.deepEqual(after.data, { mcp: { archgen: ENTRY } });
});

// ── the writer uses it ───────────────────────────────────────────────────────

test('the writer wires a JSONC config and leaves the comments in place', () => {
  const dir = sandbox();
  const target = join(dir, 'settings.json');
  const source = ['// Zed settings', '{', '  "theme": "dark"', '}', ''].join('\n');
  writeFileSync(target, source, 'utf8');

  const res = writeJsonConfig(target, 'context_servers', 'archgen', ENTRY, { approved: true });
  assert.equal(res.status, 'written');
  const out = readFileSync(target, 'utf8');
  assert.ok(out.includes('// Zed settings'));
  const after = parseJsonc(out);
  assert.equal(after.error, null);
  assert.deepEqual(after.data.context_servers.archgen, ENTRY);
});

test('the writer reports a JSONC config it cannot merge, and writes nothing', () => {
  const dir = sandbox();
  const target = join(dir, 'settings.json');
  const source = '{\n  // Zed settings\n  "context_servers": "not-an-object"\n}\n';
  writeFileSync(target, source, 'utf8');

  const res = writeJsonConfig(target, 'context_servers', 'archgen', ENTRY, { approved: true });
  assert.equal(res.status, 'skipped');
  assert.ok(res.detail, 'the report must say why');
  assert.equal(readFileSync(target, 'utf8'), source, 'the file must be left untouched');
});

test('the writer reports a broken config, and writes nothing', () => {
  const dir = sandbox();
  const target = join(dir, 'settings.json');
  const source = '{ this is not json';
  writeFileSync(target, source, 'utf8');

  const res = writeJsonConfig(target, 'context_servers', 'archgen', ENTRY, { approved: true });
  assert.equal(res.status, 'skipped');
  assert.ok(res.detail, 'the report must say why');
  assert.equal(readFileSync(target, 'utf8'), source, 'the file must be left untouched');
});

test('the reader sees a JSONC config', () => {
  const dir = sandbox();
  const target = join(dir, 'settings.json');
  writeFileSync(target, '// Zed settings\n{ "theme": "dark" }\n', 'utf8');

  const read = readJsonConfig(target);
  assert.equal(read.error, undefined);
  assert.deepEqual(read.data, { theme: 'dark' });
});

// ── uninstall stays lossless ─────────────────────────────────────────────────

test('removing an entry keeps the comments around it', () => {
  const source = [
    '{',
    '  // Zed settings',
    '  "context_servers": {',
    '    "archgen": { "command": "archgen-mcp" },',
    '    "other": { "command": "keep" }',
    '  }',
    '}',
    '',
  ].join('\n');

  const result = removeEntry(source, 'context_servers', 'archgen');
  assert.equal(result.changed, true);
  assert.ok(result.text.includes('// Zed settings'));
  const after = parseJsonc(result.text);
  assert.equal(after.error, null);
  assert.deepEqual(after.data.context_servers.other, { command: 'keep' });
  assert.equal(after.data.context_servers.archgen, undefined);
});

// ── nested key paths ─────────────────────────────────────────────────────────
// opencode keeps its servers at `mcp.servers.<id>`, not `mcp.<id>`. A single
// top-level key cannot express that, and writing to `mcp.<id>` put the entry
// where opencode never looks — the server was installed and invisible.

test('a dotted key path merges into the NESTED bucket', () => {
  const text = '{\n  "mcp": {\n    "servers": {\n      "codegraph": { "type": "local", "command": ["codegraph"] }\n    }\n  }\n}\n';
  const entry = { type: 'local', command: ['archgen-mcp'], disabled: false };
  const r = mergeEntry(text, 'mcp.servers', 'archgen', entry);
  assert.equal(r.changed, true);
  const data = parseJsonc(r.text).data;
  assert.deepEqual(data.mcp.servers.archgen, entry);
  // The sibling entry is untouched.
  assert.deepEqual(data.mcp.servers.codegraph, { type: 'local', command: ['codegraph'] });
});

test('a dotted key path CREATES the missing chain', () => {
  const text = '{\n  "model": "x"\n}\n';
  const entry = { type: 'local', command: ['archgen-mcp'] };
  const r = mergeEntry(text, 'mcp.servers', 'archgen', entry);
  assert.equal(r.changed, true);
  const data = parseJsonc(r.text).data;
  assert.deepEqual(data.mcp.servers.archgen, entry);
  assert.equal(data.model, 'x');
});

test('a dotted key path preserves the comments around it', () => {
  const text = '{\n  // the servers live here\n  "mcp": {\n    // and the bucket\n    "servers": {}\n  }\n}\n';
  const r = mergeEntry(text, 'mcp.servers', 'archgen', { type: 'local' });
  assert.equal(r.changed, true);
  assert.match(r.text, /\/\/ the servers live here/);
  assert.match(r.text, /\/\/ and the bucket/);
  assert.equal(parseJsonc(r.text).data.mcp.servers.archgen.type, 'local');
});

test('a dotted key path in STRICT json works too', () => {
  const text = '{"mcp":{"servers":{}}}\n';
  const r = mergeEntry(text, 'mcp.servers', 'archgen', { type: 'local' });
  assert.equal(r.changed, true);
  assert.deepEqual(JSON.parse(r.text).mcp.servers.archgen, { type: 'local' });
});

test('a dotted key path removes the entry again', () => {
  const text = '{\n  "mcp": {\n    "servers": {\n      "archgen": { "type": "local" }\n    }\n  }\n}\n';
  const r = removeEntry(text, 'mcp.servers', 'archgen');
  assert.equal(r.changed, true);
  assert.equal(parseJsonc(r.text).data.mcp.servers.archgen, undefined);
});
