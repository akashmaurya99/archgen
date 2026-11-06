// MCP-server invocation fixes.
//
// M17: on Windows the MCP server was spawned with `shell: true` and UNQUOTED
//      arguments — including the user-supplied project path. A path with
//      spaces was split and a path with `&`/`|` was interpreted by cmd.exe.
//      The shim's JS entry point is now run with the current node binary (no
//      shell at all); when that is impossible, every argument is quoted for
//      cmd.exe.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mcpInvocation, quoteWindowsArg } from '../lib/mcp-server.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..');

let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ag-mcp-fix-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test('M17: a Windows argument is quoted so cmd.exe cannot split or execute it', () => {
  assert.equal(quoteWindowsArg('bootstrap'), '"bootstrap"');
  assert.equal(quoteWindowsArg('C:\\my project'), '"C:\\my project"');
  assert.equal(quoteWindowsArg('a&b'), '"a&b"');
  assert.equal(quoteWindowsArg('a|b'), '"a|b"');
  assert.equal(quoteWindowsArg(''), '""');
});

test('M17: an argument cmd.exe would still rewrite is refused', () => {
  // `%` is expanded by cmd.exe even inside quotes.
  assert.throws(() => quoteWindowsArg('C:\\100%'), /unsafe character/);
});

test('M17: the Windows shell path quotes every argument', () => {
  const inv = mcpInvocation(
    'C:\\Program Files\\nodejs\\archgen-mcp.cmd',
    ['bootstrap', '--project', 'C:\\my project'],
    'win32',
  );
  assert.equal(inv.shell, true, 'the shell fallback is used when no JS entry exists');
  assert.deepEqual(inv.args, ['"bootstrap"', '"--project"', '"C:\\my project"']);
  assert.match(inv.command, /^"/, 'the command itself is quoted');
});

test('M17: a .cmd shim with a known package is run through node, without a shell', () => {
  const pkgDir = join(dir, 'node_modules', 'archgen-mcp');
  mkdirSync(join(pkgDir, 'bin'), { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: 'archgen-mcp', version: '0.0.7', bin: { 'archgen-mcp': 'bin/archgen-mcp.mjs' } }),
  );
  const entry = join(pkgDir, 'bin', 'archgen-mcp.mjs');
  writeFileSync(entry, '// stub\n');
  const shim = join(dir, 'node_modules', '.bin', 'archgen-mcp.cmd');
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(shim, '@echo off\n');

  const inv = mcpInvocation(shim, ['doctor', '--project', 'C:\\my project'], 'win32');
  assert.equal(inv.shell, false, 'no shell is involved');
  assert.equal(inv.command, process.execPath);
  assert.deepEqual(inv.args, [entry, 'doctor', '--project', 'C:\\my project']);
});

test('M17: a non-Windows invocation never uses a shell', () => {
  const inv = mcpInvocation('npx', ['-y', 'archgen-mcp', 'doctor'], 'linux');
  assert.equal(inv.shell, false);
  assert.deepEqual(inv.args, ['-y', 'archgen-mcp', 'doctor']);
  assert.equal(inv.command, 'npx');
});

test('M17: the project path is never handed to a shell unquoted', () => {
  const inv = mcpInvocation(
    'C:\\tools\\archgen-mcp.cmd',
    ['bootstrap', '--project', 'C:\\a&b|c'],
    'win32',
  );
  for (const a of inv.args) assert.ok(a.startsWith('"') && a.endsWith('"'), `unquoted argument: ${a}`);
});
