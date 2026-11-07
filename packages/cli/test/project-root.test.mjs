// project-root.test.mjs — the project root is never a guess.
//
// The MCP server is driven with `--project <root>`. If that value is missing
// or relative, the child process resolves it against its OWN working
// directory — and the harness configs, the CodeGraph index and the managed
// blocks all land in a directory named after whatever it got.
//
// It happened: a property-name mismatch between the caller (`projectDir`)
// and the callee (`projectRoot`) sent the literal string "undefined", and
// `archgen-skill init` created an `undefined/` directory in the user's
// project with a full set of harness configs inside it.
//
// The root is now REQUIRED, and it must be absolute.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapArgs, bootstrapMcp, mcpDoctor, requireProjectRoot, uninstallMcp } from '../lib/mcp-server.js';

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ag-root-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('requireProjectRoot accepts an absolute path', () => {
  assert.equal(requireProjectRoot(dir, 'test'), dir);
});

test('requireProjectRoot refuses a missing root', () => {
  assert.throws(() => requireProjectRoot(undefined, 'test'), /projectRoot is required/);
  assert.throws(() => requireProjectRoot(null, 'test'), /projectRoot is required/);
  assert.throws(() => requireProjectRoot('', 'test'), /projectRoot is required/);
  assert.throws(() => requireProjectRoot('   ', 'test'), /projectRoot is required/);
});

test('requireProjectRoot refuses a RELATIVE root', () => {
  // A relative root is resolved by the CHILD against its own cwd, which is
  // not the project. It must never be passed on.
  assert.throws(() => requireProjectRoot('undefined', 'test'), /must be an absolute path/);
  assert.throws(() => requireProjectRoot('sub/dir', 'test'), /must be an absolute path/);
});

test('the MCP calls refuse a missing project root', () => {
  assert.throws(() => bootstrapMcp({}), /projectRoot is required/);
  assert.throws(() => mcpDoctor({}), /projectRoot is required/);
  assert.throws(() => uninstallMcp({}), /projectRoot is required/);
});

test('the MCP calls refuse a relative project root', () => {
  assert.throws(() => bootstrapMcp({ projectRoot: 'undefined' }), /must be an absolute path/);
  assert.throws(() => mcpDoctor({ projectRoot: 'undefined' }), /must be an absolute path/);
  assert.throws(() => uninstallMcp({ projectRoot: 'undefined' }), /must be an absolute path/);
});

test('the bootstrap arguments carry the project root it was given', () => {
  // The regression: the caller named it `projectDir` and the callee read
  // `projectRoot`, so the value never arrived — and the child process got
  // the literal string "undefined".
  const args = bootstrapArgs(dir, { location: 'both' });
  assert.deepEqual(args, ['bootstrap', '--project', dir, '--location', 'both', '--json', '--yes']);
  assert.doesNotMatch(args.join(' '), /undefined/);
});

test('the bootstrap arguments refuse a missing or relative root', () => {
  assert.throws(() => bootstrapArgs(undefined), /projectRoot is required/);
  assert.throws(() => bootstrapArgs('undefined'), /must be an absolute path/);
});
