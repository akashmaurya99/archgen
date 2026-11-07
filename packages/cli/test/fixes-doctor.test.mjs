// Doctor fixes.
//
// M1: a FAIL row is a broken state a human must fix — it now fails the run.
// M2: an unreadable managed file produced a raw exception that aborted the
//     whole doctor pass; it now produces a FAIL row.
// M3: a manifest without an `entries` array crashed the doctor.
// M7: the prune wrote THROUGH a symlinked store.
// M8: the claude link was recreated through a symlinked `.claude` parent.
// L4: the CLAUDE.md managed block was never version-upgraded.
// L9: a manifest entry of `../../etc/passwd` counted as "resolved".
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from '../lib/init.js';
import { doctorProject } from '../lib/doctor.js';
import { OLDER_STAMP } from './helpers/versions.mjs';
import { END, START, detectBlockVersion } from '../lib/block.js';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(CLI, 'package.json'), 'utf8')).version;
const STORE = (p) => join(p, '.agents', 'skills', 'archgen');
const NO_BOOTSTRAP = { env: { ARCHGEN_CODEGRAPH: '0' } };

let proj, outside;

beforeEach(() => {
  proj = mkdtempSync(join(tmpdir(), 'ag-doctor-fix-'));
  outside = mkdtempSync(join(tmpdir(), 'ag-doctor-outside-'));
  // A local stub keeps the MCP health-check hermetic and instant.
  const stub = join(outside, 'mcp-stub.mjs');
  writeFileSync(stub, 'process.exit(0);\n', { mode: 0o755 });
  process.env.ARCHGEN_MCP_BIN = stub;
});
afterEach(() => {
  delete process.env.ARCHGEN_MCP_BIN;
  rmSync(proj, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test('M1: a FAIL row is counted and fails the run', () => {
  initProject(proj, CLI, NO_BOOTSTRAP);
  // Two managed blocks in AGENTS.md: a broken state only a human can fix.
  writeFileSync(
    join(proj, 'AGENTS.md'),
    'x\n' + START + '\na\n' + END + '\n' + START + '\nb\n' + END + '\n',
  );
  const d = doctorProject(proj, CLI);
  assert.ok(d.tally.FAIL >= 1, 'a FAIL row was produced');
  assert.equal(d.failures, d.tally.FAIL, 'every FAIL row counts as a failure');
  assert.ok(d.failures > 0, 'failures drives the exit code');
});

test('M1: a failed link repair is a FAIL row and fails the run', () => {
  initProject(proj, CLI, NO_BOOTSTRAP);
  // A read-only .claude/skills parent makes the repair impossible.
  const skillsDir = join(proj, '.claude', 'skills');
  rmSync(join(proj, '.claude'), { recursive: true, force: true });
  mkdirSync(skillsDir, { recursive: true });
  chmodSync(skillsDir, 0o500);
  try {
    const d = doctorProject(proj, CLI);
    const fail = d.checks.find((c) => c.status === 'FAIL' && /claude link/.test(c.msg));
    assert.ok(fail, `expected a claude-link FAIL row, got: ${JSON.stringify(d.checks)}`);
    assert.ok(d.failures > 0, 'the failure is counted');
  } finally {
    chmodSync(skillsDir, 0o700);
  }
});

test('M2: an unreadable AGENTS.md is a FAIL row, not a crash', () => {
  initProject(proj, CLI, NO_BOOTSTRAP);
  const file = join(proj, 'AGENTS.md');
  chmodSync(file, 0o000);
  try {
    try {
      readFileSync(file, 'utf8');
      return; // readable (e.g. running as root) — the case cannot be exercised
    } catch { /* unreadable as intended */ }
    const d = doctorProject(proj, CLI);
    assert.ok(
      d.checks.some((c) => c.status === 'FAIL' && /AGENTS\.md/.test(c.msg)),
      `expected an AGENTS.md FAIL row, got: ${JSON.stringify(d.checks)}`,
    );
    // The pass continued: the CLAUDE.md check still ran.
    assert.ok(d.checks.some((c) => /CLAUDE\.md/.test(c.msg)), 'the doctor pass completed');
  } finally {
    chmodSync(file, 0o600);
  }
});

test('M2: an unreadable CLAUDE.md is a FAIL row, not a crash', () => {
  initProject(proj, CLI, NO_BOOTSTRAP);
  const file = join(proj, 'CLAUDE.md');
  chmodSync(file, 0o000);
  try {
    try {
      readFileSync(file, 'utf8');
      return;
    } catch { /* unreadable as intended */ }
    const d = doctorProject(proj, CLI);
    assert.ok(
      d.checks.some((c) => c.status === 'FAIL' && /CLAUDE\.md/.test(c.msg)),
      `expected a CLAUDE.md FAIL row, got: ${JSON.stringify(d.checks)}`,
    );
  } finally {
    chmodSync(file, 0o600);
  }
});

test('M3: a manifest without an entries array is reported, not crashed on', () => {
  initProject(proj, CLI, NO_BOOTSTRAP);
  const mPath = join(proj, '.archgen', '.install-manifest.json');
  writeFileSync(mPath, JSON.stringify({ version: 1, createdAt: new Date().toISOString() }, null, 2));
  const d = doctorProject(proj, CLI);
  assert.ok(
    d.checks.some((c) => c.status === 'FAIL' && /entries/.test(c.msg)),
    `expected a manifest FAIL row, got: ${JSON.stringify(d.checks)}`,
  );
});

test('M7: doctor refuses to prune through a symlinked store', () => {
  // The store is a symlink to a tree OUTSIDE the project.
  mkdirSync(join(outside, 'scripts', 'lib'), { recursive: true });
  writeFileSync(join(outside, 'scripts', 'lib', 'yaml.mjs'), 'export const x = 1;\n');
  writeFileSync(join(outside, 'SKILL.md'), '# outside\n');
  mkdirSync(join(proj, '.agents', 'skills'), { recursive: true });
  symlinkSync(outside, join(proj, '.agents', 'skills', 'archgen'));

  const d = doctorProject(proj, CLI);
  assert.ok(existsSync(join(outside, 'scripts', 'lib', 'yaml.mjs')), 'nothing was pruned through the link');
  assert.ok(
    d.checks.some((c) => c.status === 'FAIL' && /symlink/i.test(c.msg)),
    `expected a symlink-refusal FAIL row, got: ${JSON.stringify(d.checks)}`,
  );
});

test('M8: doctor refuses to recreate the claude link through a symlinked .claude parent', () => {
  initProject(proj, CLI, NO_BOOTSTRAP);
  rmSync(join(proj, '.claude'), { recursive: true, force: true });
  symlinkSync(outside, join(proj, '.claude'));

  const d = doctorProject(proj, CLI);
  assert.ok(
    d.checks.some((c) => c.status === 'FAIL' && /claude link/.test(c.msg)),
    `expected a claude-link FAIL row, got: ${JSON.stringify(d.checks)}`,
  );
  assert.ok(!existsSync(join(outside, 'skills', 'archgen')), 'no link was created through the escape');
});

test('L4: init refreshes the CLAUDE.md managed block version', () => {
  const stale = [START, `<!-- archgen:block v${OLDER_STAMP} -->`, '@AGENTS.md', END].join('\n') + '\n';
  writeFileSync(join(proj, 'CLAUDE.md'), stale);

  initProject(proj, CLI, NO_BOOTSTRAP);

  const raw = readFileSync(join(proj, 'CLAUDE.md'), 'utf8');
  assert.deepEqual(
    detectBlockVersion(raw),
    { present: true, version: VERSION },
    'the CLAUDE.md block carries the current provenance stamp',
  );
  assert.ok(raw.includes('@AGENTS.md'), 'the bridge itself survived');
});

test('L4: doctor upgrades a stale CLAUDE.md managed block', () => {
  initProject(proj, CLI, NO_BOOTSTRAP);
  const stale = [START, `<!-- archgen:block v${OLDER_STAMP} -->`, '@AGENTS.md', END].join('\n') + '\n';
  writeFileSync(join(proj, 'CLAUDE.md'), stale);

  const d = doctorProject(proj, CLI);
  assert.ok(
    d.checks.some((c) => /UPGRADED: CLAUDE\.md block v0\.0\.1/.test(c.msg)),
    `expected a CLAUDE.md upgrade row, got: ${JSON.stringify(d.checks)}`,
  );
  assert.deepEqual(
    detectBlockVersion(readFileSync(join(proj, 'CLAUDE.md'), 'utf8')),
    { present: true, version: VERSION },
  );
});

test('L9: a manifest entry pointing outside the project does not count as resolved', () => {
  initProject(proj, CLI, NO_BOOTSTRAP);
  const mPath = join(proj, '.archgen', '.install-manifest.json');
  const m = JSON.parse(readFileSync(mPath, 'utf8'));
  m.entries.push({ kind: 'dir', path: '../../etc/passwd', createdAt: new Date().toISOString() });
  writeFileSync(mPath, JSON.stringify(m, null, 2));

  const d = doctorProject(proj, CLI);
  assert.ok(
    !d.checks.some((c) => c.status === 'OK' && /entries resolve/.test(c.msg)),
    'the escaping entry was counted as resolved',
  );
  const after = JSON.parse(readFileSync(mPath, 'utf8')).entries;
  assert.ok(!after.some((e) => e.path === '../../etc/passwd'), 'the escaping entry was pruned');
});
