// Integration tests for codegraph.mjs — the CodeGraph bootstrap/wire/index
// command. Hermetic by construction: every case runs with --no-install and
// --no-upgrade so the suite never touches the network, never installs a
// global package, and never mutates the developer's real harness configs.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILL = join(SCRIPTS, '..');
const REGISTRY = join(SKILL, 'assets', 'harness-mcp.json');
let dir;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'codegraph-test-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function run(args) {
  return spawnSync(process.execPath, [join(SCRIPTS, 'codegraph.mjs'), ...args], { encoding: 'utf8', timeout: 120000 });
}

function makeProject(markers = ['.cursor', '.vscode']) {
  const root = join(dir, 'proj');
  mkdirSync(root, { recursive: true });
  for (const m of markers) mkdirSync(join(root, m), { recursive: true });
  writeFileSync(join(root, 'index.ts'), 'export const x = 1;\n');
  return root;
}

// --- usage / flag contract ---------------------------------------------------

test('codegraph: unknown mode is a usage error (exit 2, one stderr line)', () => {
  const r = run(['bogus']);
  assert.equal(r.status, 2);
  assert.equal(r.stderr.trim().split('\n').length, 1);
});

test('codegraph: unknown option is a usage error (exit 2)', () => {
  const r = run(['ensure', '--nope']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown option/);
});

test('codegraph: --location rejects anything but global|project|both', () => {
  const r = run(['ensure', '--location', 'elsewhere']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--location must be/);
});

test('codegraph: --telemetry rejects anything but keep|off|on', () => {
  const r = run(['ensure', '--telemetry', 'maybe']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--telemetry must be/);
});

test('codegraph: --target/--project require a value', () => {
  const r = run(['ensure', '--project']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /require a value/);
});

// --- registry integrity ------------------------------------------------------

test('registry: every harness config uses one of the four known top-level MCP keys', () => {
  const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  const known = new Set(['mcpServers', 'servers', 'mcp', 'context_servers']);
  for (const [id, h] of Object.entries(reg.harnesses)) {
    for (const [loc, cfg] of Object.entries(h.configs ?? {})) {
      if (cfg.format === 'toml') continue;
      assert.ok(known.has(cfg.key), `${id}.${loc} uses unknown MCP key '${cfg.key}'`);
    }
  }
});

test('registry: every referenced entry shape exists in entries AND npxEntries', () => {
  const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  for (const [id, h] of Object.entries(reg.harnesses)) {
    for (const cfg of Object.values(h.configs ?? {})) {
      if (cfg.format === 'toml') continue;
      assert.ok(reg.entries[cfg.entry], `${id} references unknown entry '${cfg.entry}'`);
      assert.ok(reg.npxEntries[cfg.entry], `${id} references unknown npx entry '${cfg.entry}'`);
    }
  }
});

test('registry: the server command is `serve --mcp` — never the non-existent `mcp` subcommand', () => {
  const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  // Two shapes exist: `args` (stdio servers) and a `command` ARRAY (OpenCode).
  const argvOf = (entry) => (Array.isArray(entry.command) ? entry.command : [entry.command, ...(entry.args ?? [])]).filter(Boolean);
  for (const [name, entry] of Object.entries(reg.entries)) {
    const argv = argvOf(entry);
    assert.ok(argv.includes('serve'), `${name} must start the MCP server via 'serve'`);
    assert.ok(argv.includes('--mcp'), `${name} must pass --mcp (stdio transport)`);
    assert.ok(!argv.includes('mcp'), `${name} must not use the bare 'mcp' subcommand (it does not exist)`);
  }
  for (const [name, entry] of Object.entries(reg.npxEntries)) {
    const argv = argvOf(entry);
    assert.ok(argv.includes('serve'), `npx ${name} must use 'serve'`);
    assert.ok(!argv.includes('mcp'), `npx ${name} must not use the bare 'mcp' subcommand`);
  }
});

test('registry: codegraphTarget values are names codegraph actually supports', () => {
  const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  // `codegraph install --print-config <id>` accepts exactly these agent ids.
  const supported = new Set(['claude', 'cursor', 'codex', 'opencode', 'hermes', 'gemini', 'antigravity', 'kiro']);
  for (const [id, h] of Object.entries(reg.harnesses)) {
    if (!h.codegraphTarget) continue;
    assert.ok(supported.has(h.codegraphTarget), `${id} targets unsupported codegraph agent '${h.codegraphTarget}'`);
  }
});

// --- behaviour ---------------------------------------------------------------

test('codegraph: without --yes nothing is written (approval gate) and the plan is reported', () => {
  const root = makeProject();
  const r = run(['ensure', '--project', root, '--location', 'project', '--no-install', '--no-upgrade', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.planned, true);
  assert.ok(!existsSync(join(root, '.vscode', 'mcp.json')), 'must not write .vscode/mcp.json without --yes');
  assert.ok(!existsSync(join(root, '.cursor', 'mcp.json')), 'must not write .cursor/mcp.json without --yes');
  const manual = out.wiring.manual.find((w) => w.harness === 'vscode');
  assert.equal(manual.status, 'planned');
});

test('codegraph: --yes writes the MCP entry into the platform-specific key', () => {
  const root = makeProject();
  const r = run(['ensure', '--project', root, '--location', 'project', '--no-install', '--no-upgrade', '--yes', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const vs = out.wiring.manual.find((w) => w.harness === 'vscode');
  assert.equal(vs.status, 'written');
  const cfg = JSON.parse(readFileSync(join(root, '.vscode', 'mcp.json'), 'utf8'));
  assert.ok(cfg.servers.codegraph, 'VS Code uses the "servers" key');
  assert.equal(cfg.servers.codegraph.type, 'stdio');
  assert.deepEqual(cfg.servers.codegraph.args.slice(-2), ['serve', '--mcp']);
});

test('codegraph: a malformed config file is never rewritten', () => {
  const root = makeProject(['.vscode']);
  const bad = join(root, '.vscode', 'mcp.json');
  writeFileSync(bad, '{ this is not json ');
  const r = run(['ensure', '--project', root, '--location', 'project', '--no-install', '--no-upgrade', '--yes', '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(bad, 'utf8'), '{ this is not json ', 'unparseable config must be left byte-identical');
  const out = JSON.parse(r.stdout);
  const vs = out.wiring.manual.find((w) => w.harness === 'vscode');
  assert.equal(vs.status, 'skipped');
});

test('codegraph: an existing identical entry is not rewritten (idempotency)', () => {
  const root = makeProject(['.vscode']);
  const r = run(['ensure', '--project', root, '--location', 'project', '--no-install', '--no-upgrade', '--yes', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const before = readFileSync(join(root, '.vscode', 'mcp.json'), 'utf8');
  const r2 = run(['ensure', '--project', root, '--location', 'project', '--no-install', '--no-upgrade', '--yes', '--json']);
  assert.equal(r2.status, 0, r2.stderr);
  assert.equal(readFileSync(join(root, '.vscode', 'mcp.json'), 'utf8'), before, 'second run must not change the file');
  const out = JSON.parse(r2.stdout);
  assert.equal(out.wiring.manual.find((w) => w.harness === 'vscode').status, 'unchanged');
});

test('codegraph: harnesses that are NOT installed are never configured', () => {
  const root = makeProject([]);
  const r = run(['ensure', '--project', root, '--location', 'project', '--no-install', '--no-upgrade', '--yes', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.wiring.manual, [], 'no harness detected → no config written');
  assert.ok(!existsSync(join(root, '.vscode')), 'must not create a harness directory');
});

test('codegraph: status --json reports the CLI, telemetry and index state', () => {
  const root = makeProject([]);
  const r = run(['status', root, '--json']);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok('cli' in out && 'telemetry' in out && 'index' in out && 'wiring' in out);
  assert.equal(out.index.action, 'not-indexed');
});

test('codegraph: the realtime watcher is always enabled (no --no-watch in any config)', () => {
  const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  for (const [name, entry] of Object.entries(reg.entries)) {
    assert.ok(!(entry.args ?? []).includes('--no-watch'), `${name} must keep the file watcher on (realtime auto-sync)`);
  }
});
