// harness-wiring.test.mjs — the ONE writer that installs MCP entries.
//
// This is the security-critical surface: it writes into users' harness
// config files. Every guard the original codegraph.mjs had must be here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { wireServer, writeJsonConfig, writeTomlConfig, detectHarnesses, removeWiring } from '../../src/core/harness/harness-wiring.mjs';
import { wireArchgenMcp } from '../../src/core/harness/mcp-server-manager.mjs';
import { loadAsset } from '../../src/context.mjs';

const registry = loadAsset('harness-mcp.json');

/** A minimal registry with one fake harness, so tests never touch a real one. */
function fakeRegistry() {
  return {
    harnesses: {
      fake: {
        label: 'Fake',
        detectHome: ['.fakehome'],
        detectProject: ['.fakeproj'],
        configs: {
          project: { path: '.fakeproj/mcp.json', key: 'mcpServers', entry: 'stdio' },
          global: { path: '~/.fakehome/mcp.json', key: 'mcpServers', entry: 'stdio' },
        },
      },
      fakeToml: {
        label: 'Fake TOML',
        detectHome: [],
        detectProject: ['.faketoml'],
        configs: {
          project: { path: '.faketoml/config.toml', key: 'mcp_servers.archgen', entry: 'stdio', format: 'toml' },
        },
      },
    },
    entries: { stdio: { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] } },
    npxEntries: { stdio: { type: 'stdio', command: 'npx', args: ['-y', '@colbymchenry/codegraph', 'serve', '--mcp'] } },
    archgenEntries: { stdio: { type: 'stdio', command: 'archgen-mcp', args: [] } },
    archgenNpxEntries: { stdio: { type: 'stdio', command: 'npx', args: ['-y', 'archgen-mcp'] } },
  };
}

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'archgen-wire-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return { root, home };
}

// ── the approval gate ───────────────────────────────────────────────────────

test('nothing is written without approval — the plan is reported instead', () => {
  const { root, home } = sandbox();
  mkdirSync(join(root, '.fakeproj'), { recursive: true });
  const target = join(root, '.fakeproj', 'mcp.json');

  const res = writeJsonConfig(target, 'mcpServers', 'archgen', { command: 'archgen-mcp' }, { approved: false });
  assert.equal(res.status, 'planned');
  assert.equal(existsSync(target), false, 'no config may be created without approval');
});

test('an approved write creates the config with the right key', () => {
  const { root } = sandbox();
  mkdirSync(join(root, '.fakeproj'), { recursive: true });
  const target = join(root, '.fakeproj', 'mcp.json');

  const res = writeJsonConfig(target, 'mcpServers', 'archgen', { command: 'archgen-mcp' }, { approved: true });
  assert.equal(res.status, 'written');
  const data = JSON.parse(readFileSync(target, 'utf8'));
  assert.deepEqual(data.mcpServers.archgen, { command: 'archgen-mcp' });
});

test('an identical existing entry is reported unchanged, not rewritten', () => {
  const { root } = sandbox();
  mkdirSync(join(root, '.fakeproj'), { recursive: true });
  const target = join(root, '.fakeproj', 'mcp.json');
  const entry = { command: 'archgen-mcp' };
  writeJsonConfig(target, 'mcpServers', 'archgen', entry, { approved: true });
  const before = readFileSync(target, 'utf8');

  const res = writeJsonConfig(target, 'mcpServers', 'archgen', entry, { approved: true });
  assert.equal(res.status, 'unchanged');
  assert.equal(readFileSync(target, 'utf8'), before);
});

test('a config that is not valid JSON is reported, never rewritten', () => {
  const { root } = sandbox();
  mkdirSync(join(root, '.fakeproj'), { recursive: true });
  const target = join(root, '.fakeproj', 'mcp.json');
  const original = '{ this is not json';
  writeFileSync(target, original, 'utf8');

  const res = writeJsonConfig(target, 'mcpServers', 'archgen', { command: 'archgen-mcp' }, { approved: true });
  assert.equal(res.status, 'skipped');
  assert.equal(readFileSync(target, 'utf8'), original, 'the file must be left untouched');
});

test('other servers in the same config survive a write', () => {
  const { root } = sandbox();
  mkdirSync(join(root, '.fakeproj'), { recursive: true });
  const target = join(root, '.fakeproj', 'mcp.json');
  writeFileSync(target, JSON.stringify({ mcpServers: { other: { command: 'x' } }, unrelated: 1 }), 'utf8');

  writeJsonConfig(target, 'mcpServers', 'archgen', { command: 'archgen-mcp' }, { approved: true });
  const data = JSON.parse(readFileSync(target, 'utf8'));
  assert.deepEqual(data.mcpServers.other, { command: 'x' });
  assert.equal(data.unrelated, 1);
});

// ── TOML (Codex CLI shape) ──────────────────────────────────────────────────

test('a TOML config gets its own section, and the rest of the file survives', () => {
  const { root } = sandbox();
  mkdirSync(join(root, '.faketoml'), { recursive: true });
  const target = join(root, '.faketoml', 'config.toml');
  const original = '# my config\nmodel = "gpt"\n\n[other]\nkey = "value"\n';
  writeFileSync(target, original, 'utf8');

  const res = writeTomlConfig(target, 'archgen', { command: '/abs/archgen-mcp' }, { approved: true });
  assert.equal(res.status, 'written');
  const out = readFileSync(target, 'utf8');
  assert.match(out, /# my config/);
  assert.match(out, /model = "gpt"/);
  assert.match(out, /\[other\]/);
  assert.match(out, /\[mcp_servers\.archgen\]/);
  assert.match(out, /command = "\/abs\/archgen-mcp"/);
});

test('an existing TOML section is replaced, not duplicated', () => {
  const { root } = sandbox();
  mkdirSync(join(root, '.faketoml'), { recursive: true });
  const target = join(root, '.faketoml', 'config.toml');
  writeFileSync(target, '[mcp_servers.archgen]\ncommand = "old"\n\n[other]\nkey = "value"\n', 'utf8');

  writeTomlConfig(target, 'archgen', { command: 'new' }, { approved: true });
  const out = readFileSync(target, 'utf8');
  assert.equal(out.match(/\[mcp_servers\.archgen\]/g).length, 1);
  assert.match(out, /command = "new"/);
  assert.ok(!out.includes('command = "old"'));
  assert.match(out, /\[other\]/);
});

// ── symlink refusal ─────────────────────────────────────────────────────────

test('a symlinked config is refused, never written through', () => {
  const { root } = sandbox();
  mkdirSync(join(root, '.fakeproj'), { recursive: true });
  const real = join(root, 'real.json');
  const link = join(root, '.fakeproj', 'mcp.json');
  writeFileSync(real, '{"mcpServers":{}}', 'utf8');
  symlinkSync(real, link);

  const res = writeJsonConfig(link, 'mcpServers', 'archgen', { command: 'archgen-mcp' }, { approved: true, root });
  assert.equal(res.status, 'error');
  assert.match(res.detail, /symlink/i);
  assert.equal(readFileSync(real, 'utf8'), '{"mcpServers":{}}', 'the link target must be untouched');
});

// ── detection ───────────────────────────────────────────────────────────────

test('only DETECTED harnesses are wired', () => {
  const { root, home } = sandbox();
  mkdirSync(join(root, '.fakeproj'), { recursive: true });
  mkdirSync(join(root, '.faketoml'), { recursive: true });
  mkdirSync(join(home, '.fakehome'), { recursive: true });

  const detected = detectHarnesses(fakeRegistry(), root, home).map((d) => d.id);
  assert.deepEqual(detected.sort(), ['fake', 'fakeToml']);

  const res = wireServer({
    serverId: 'archgen',
    registry: fakeRegistry(),
    entries: fakeRegistry().archgenEntries,
    npxEntries: fakeRegistry().archgenNpxEntries,
    projectRoot: root,
    home,
    location: 'both',
    approved: true,
    binPath: '/abs/archgen-mcp',
  });
  assert.deepEqual(res.detected.sort(), ['fake', 'fakeToml']);
  assert.ok(res.wired.some((w) => w.harness === 'fake' && w.status === 'written'));
  // fakeToml has no home marker, so only its project config is written.
  assert.ok(res.wired.filter((w) => w.harness === 'fakeToml').every((w) => w.location === 'project'));
});

test('the npx fallback is used when no binary was resolved', () => {
  const { root, home } = sandbox();
  mkdirSync(join(root, '.fakeproj'), { recursive: true });

  const res = wireServer({
    serverId: 'archgen',
    registry: fakeRegistry(),
    entries: fakeRegistry().archgenEntries,
    npxEntries: fakeRegistry().archgenNpxEntries,
    projectRoot: root,
    home,
    location: 'project',
    approved: true,
    binPath: null,
    fallbackCommand: 'npx',
  });
  const written = res.wired.find((w) => w.status === 'written');
  assert.ok(written);
  const data = JSON.parse(readFileSync(written.path, 'utf8'));
  assert.deepEqual(data.mcpServers.archgen, { type: 'stdio', command: 'npx', args: ['-y', 'archgen-mcp'] });
});

// ── uninstall ───────────────────────────────────────────────────────────────

test('removal takes out exactly the entry that was written', () => {
  const { root, home } = sandbox();
  mkdirSync(join(root, '.fakeproj'), { recursive: true });
  const target = join(root, '.fakeproj', 'mcp.json');
  writeFileSync(target, JSON.stringify({ mcpServers: { other: { command: 'keep-me' } } }), 'utf8');

  // wireArchgenMcp is the real entry point — it also records the wiring
  // manifest that makes a precise uninstall possible.
  const res = wireArchgenMcp({
    projectRoot: root,
    registry: fakeRegistry(),
    home,
    location: 'project',
    approved: true,
    binPath: '/abs/archgen-mcp',
  });
  assert.ok(res.wired.some((w) => w.status === 'written'));

  const removal = removeWiring(root, 'archgen', home);
  assert.equal(removal.removed.length, 1);
  const data = JSON.parse(readFileSync(target, 'utf8'));
  assert.equal(data.mcpServers.archgen, undefined, 'the archgen entry must be gone');
  assert.deepEqual(data.mcpServers.other, { command: 'keep-me' }, 'other entries must survive');
});
