// admin-commands.test.mjs — the CONTROL PLANE commands.
//
// WHY THIS TEST EXISTS.
//
// `archgen-skill mcp …` and `archgen-skill codegraph …` are the commands
// that replace the model-facing admin tools. The CHANGELOG advertises them
// and the README documents them — and NOTHING tested them: not the plan-only
// behaviour, not the `--yes` gate, not an unknown action.
//
// These tests drive the REAL binary against a temp HOME, so they also prove
// the commands never touch the developer's real harness configs.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'archgen.mjs');
const MCP_BIN = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'mcp', 'bin', 'archgen-mcp.mjs');

let home, project;

/** Run the CLI against the temp HOME and the repo's own MCP server. */
function cli(args) {
  const r = spawnSync(process.execPath, [CLI_BIN, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      ARCHGEN_MCP_BIN: MCP_BIN,
      ARCHGEN_CODEGRAPH: '0',
    },
    cwd: project,
  });
  return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'ag-admin-home-'));
  project = mkdtempSync(join(tmpdir(), 'ag-admin-proj-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(project, { recursive: true, force: true });
});

test('mcp list is READ-ONLY: it reports the harnesses and writes nothing', () => {
  const r = cli(['mcp', 'list', '--project', project]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /archgen mcp list/);
  assert.ok(!existsSync(join(home, '.claude.json')), 'a read must not create a config');
});

test('mcp add without --yes is a PLAN and writes nothing', () => {
  const r = cli(['mcp', 'add', '--project', project]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /PLAN only/);
  assert.ok(!existsSync(join(home, '.claude.json')), 'an unapproved add must not write');
});

test('mcp remove without --yes REFUSES', () => {
  const r = cli(['mcp', 'remove', '--project', project]);
  assert.notEqual(r.code, 0, 'removing without --yes must fail');
  assert.match(r.err + r.out, /--yes/);
});

test('mcp add --yes writes the entry, and mcp remove --yes takes it away', () => {
  // `--no-codegraph` keeps the test OFFLINE and side-effect free: without
  // it the bootstrap would ensure CodeGraph, and on a machine without
  // CodeGraph that is a real global install. A test must never install
  // anything.
  const added = cli(['mcp', 'add', '--project', project, '--yes', '--no-codegraph']);
  assert.equal(added.code, 0, added.err);
  const config = join(home, '.claude.json');
  assert.ok(existsSync(config), 'the approved add must write the config');
  const written = JSON.parse(readFileSync(config, 'utf8'));
  assert.ok(written.mcpServers?.archgen, 'the archgen entry must be in the config');

  const removed = cli(['mcp', 'remove', '--project', project, '--yes']);
  assert.equal(removed.code, 0, removed.err);
  const after = JSON.parse(readFileSync(config, 'utf8'));
  assert.equal(after.mcpServers?.archgen, undefined, 'the approved remove must take the entry away');
});

test('codegraph status is READ-ONLY', () => {
  const r = cli(['codegraph', 'status', '--project', project]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /archgen codegraph status/);
  assert.match(r.out, /tools:/, 'the status must name the tool surface');
});

test('codegraph ensure without --yes is a PLAN and writes nothing', () => {
  const r = cli(['codegraph', 'ensure', '--project', project]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /PLAN only/);
  assert.ok(!existsSync(join(home, '.claude.json')), 'an unapproved ensure must not write');
});

test('an unknown action is refused with the valid ones', () => {
  const r = cli(['codegraph', 'teleport', '--project', project]);
  assert.notEqual(r.code, 0, 'an unknown action must fail');
  assert.match(r.err + r.out, /status \| ensure \| wire/);
});
