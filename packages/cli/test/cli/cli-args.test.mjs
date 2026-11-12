// cli-args.test.mjs — the CLI's argument handling.
//
// A command-line flag is never a directory name. This suite pins that rule,
// because getting it wrong is silent: `init --project .` used to create a
// directory literally named "--project" in the user's cwd and install the
// skill there, with no error at all.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = join(CLI, 'bin', 'archgen.mjs');
const REPO = join(CLI, '..', '..');
// The local MCP server, so `doctor` does not reach out to the npm registry
// (the CLI falls back to `npx -y archgen-mcp`, which would make these tests
// slow and network-dependent).
const MCP_BIN = join(REPO, 'packages', 'mcp', 'bin', 'archgen-mcp.mjs');

let proj;

beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'ag-args-'));
});
afterEach(() => {
  rmSync(proj, { recursive: true, force: true });
});

/** Run the CLI in a scratch cwd; never touches the real project. */
function run(args, cwd = proj) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      ARCHGEN_CODEGRAPH: '0',
      ARCHGEN_MCP_BIN: MCP_BIN,
      HOME: join(proj, 'home'),
    },
  });
}

test('init takes a positional directory', () => {
  const target = join(proj, 'myproj');
  const r = run(['init', target, '--no-mcp', '--no-codegraph']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(join(target, '.agents', 'skills', 'archgen', 'SKILL.md')));
});

test('init takes --project <dir> — the same directory, not a flag-named dir', () => {
  const target = join(proj, 'myproj');
  const r = run(['init', '--project', target, '--no-mcp', '--no-codegraph']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(join(target, '.agents', 'skills', 'archgen', 'SKILL.md')));
  // The whole point: no directory named "--project" was created anywhere.
  assert.equal(
    readdirSync(proj).some((e) => e.startsWith('--')),
    false,
    'a directory named after a flag was created: ' + readdirSync(proj).join(', '),
  );
});

test('init takes --project=<dir>', () => {
  const target = join(proj, 'myproj');
  const r = run([`init`, `--project=${target}`, '--no-mcp', '--no-codegraph']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(join(target, '.agents', 'skills', 'archgen', 'SKILL.md')));
});

test('init refuses an unknown flag instead of treating it as a directory', () => {
  const r = run(['init', '--no-mcpx', '--no-mcp', '--no-codegraph']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /unknown option: --no-mcpx/);
  // Nothing was installed, and no flag-named directory appeared.
  assert.equal(readdirSync(proj).length, 0, 'the project directory was touched: ' + readdirSync(proj).join(', '));
});

test('init refuses a flag-shaped positional argument', () => {
  const r = run(['init', '--bogus', '--no-mcp', '--no-codegraph']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /unknown option: --bogus/);
  assert.equal(readdirSync(proj).length, 0);
});

test('init refuses the directory given twice, in two different ways', () => {
  const a = join(proj, 'a');
  const b = join(proj, 'b');
  const r = run(['init', a, '--project', b, '--no-mcp', '--no-codegraph']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /give the project directory once/);
});

test('init accepts the directory given twice, in the SAME way', () => {
  const a = join(proj, 'a');
  const r = run(['init', a, `--project=${a}`, '--no-mcp', '--no-codegraph']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(existsSync(join(a, '.agents', 'skills', 'archgen', 'SKILL.md')));
});

test('doctor takes --project <dir>', () => {
  const target = join(proj, 'myproj');
  assert.equal(run(['init', target, '--no-mcp', '--no-codegraph']).status, 0);
  const r = run(['doctor', '--project', target, '--check']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /archgen doctor/);
  assert.equal(
    readdirSync(proj).some((e) => e.startsWith('--')),
    false,
    'a directory named after a flag was created',
  );
});

test('doctor refuses an unknown flag', () => {
  const r = run(['doctor', '--checkk']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr + r.stdout, /unknown option: --checkk/);
});

test('uninstall --project <dir> removes that project, not a flag-named dir', () => {
  const target = join(proj, 'myproj');
  assert.equal(run(['init', target, '--no-mcp', '--no-codegraph']).status, 0);
  const r = run(['uninstall', '--project', target]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /project uninstall/);
  assert.equal(existsSync(join(target, '.agents', 'skills', 'archgen')), false);
  assert.equal(readdirSync(proj).some((e) => e.startsWith('--')), false);
});
