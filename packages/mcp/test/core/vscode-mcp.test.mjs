// vscode-mcp.test.mjs — where VS Code actually reads MCP servers.
//
// VS Code has TWO configuration formats, and the difference decides whether
// the agent sees the server at all:
//
//   the VS Code format     `.vscode/mcp.json` (workspace) and the user
//                          profile's `mcp.json` — a top-level `servers` object.
//   the PORTABLE format    `.mcp.json` (workspace root) and the Copilot
//                          user's `mcp-config.json` — `mcpServers`.
//
// "Copilot harness sessions read the portable format directly." And the
// Copilot user's file is `$COPILOT_HOME/mcp-config.json`, falling back to
// `~/.copilot/mcp-config.json` — and `COPILOT_HOME` REPLACES the default:
// "VS Code does not check both locations."
//
// So the global configuration belongs in the Copilot home, in the portable
// format: ONE file, read by VS Code stable, VS Code Insiders, the Copilot
// CLI, and every workspace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAsset } from '../../src/context.mjs';
import { copilotHome, configPathFor, detectHarnesses, wireServer } from '../../src/core/harness/harness-wiring.mjs';

const registry = loadAsset('harness-mcp.json');
const vscode = registry.harnesses.vscode;

test('the Copilot home is $COPILOT_HOME when it is set', () => {
  assert.equal(copilotHome({ COPILOT_HOME: '/tmp/copilot' }, '/home/u'), '/tmp/copilot');
});

test('the Copilot home is ~/.copilot otherwise', () => {
  assert.equal(copilotHome({}, '/home/u'), join('/home/u', '.copilot'));
  assert.equal(copilotHome({ COPILOT_HOME: '' }, '/home/u'), join('/home/u', '.copilot'));
});

test('the global VS Code config lives in the Copilot home, in the portable format', () => {
  const path = configPathFor(vscode.configs.global, {
    projectRoot: '/project',
    home: '/home/u',
    env: {},
  });
  assert.equal(path, join('/home/u', '.copilot', 'mcp-config.json'));
  assert.equal(vscode.configs.global.key, 'mcpServers');
});

test('$COPILOT_HOME moves the config — VS Code checks only one of them', () => {
  const path = configPathFor(vscode.configs.global, {
    projectRoot: '/project',
    home: '/home/u',
    env: { COPILOT_HOME: '/elsewhere/copilot' },
  });
  assert.equal(path, join('/elsewhere/copilot', 'mcp-config.json'));
});

test('VS Code is detected at home when the Copilot home exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'ag-vscode-'));
  const home = mkdtempSync(join(tmpdir(), 'ag-vscode-home-'));
  try {
    mkdirSync(join(home, '.copilot'), { recursive: true });
    const found = detectHarnesses(registry, root, home, {});
    const vs = found.find((d) => d.id === 'vscode');
    assert.ok(vs, 'VS Code was not detected');
    assert.equal(vs.atHome, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('VS Code is detected when only $COPILOT_HOME exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'ag-vscode-'));
  const home = mkdtempSync(join(tmpdir(), 'ag-vscode-home-'));
  const copilot = mkdtempSync(join(tmpdir(), 'ag-copilot-'));
  try {
    const found = detectHarnesses(registry, root, home, { COPILOT_HOME: copilot });
    const vs = found.find((d) => d.id === 'vscode');
    assert.ok(vs, 'VS Code was not detected through $COPILOT_HOME');
    assert.equal(vs.atHome, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(copilot, { recursive: true, force: true });
  }
});

test('wiring writes the portable global file AND the workspace VS Code file', () => {
  const root = mkdtempSync(join(tmpdir(), 'ag-vscode-'));
  const home = mkdtempSync(join(tmpdir(), 'ag-vscode-home-'));
  try {
    mkdirSync(join(home, '.copilot'), { recursive: true });
    // The workspace scope needs its marker: archgen does not litter every
    // project with a .vscode/mcp.json.
    mkdirSync(join(root, '.vscode'), { recursive: true });
    const result = wireServer({
      serverId: 'archgen',
      registry,
      entries: registry.archgenEntries,
      npxEntries: registry.archgenNpxEntries,
      projectRoot: root,
      home,
      location: 'both',
      approved: true,
      binPath: '/usr/local/bin/archgen-mcp',
      fallbackCommand: 'archgen-mcp',
      env: {},
    });

    const global = result.wired.find((w) => w.harness === 'vscode' && w.location === 'global');
    assert.ok(global, 'the global VS Code config was not written');
    assert.equal(global.path, join(home, '.copilot', 'mcp-config.json'));
    assert.equal(global.key, 'mcpServers');
    const portable = JSON.parse(readFileSync(global.path, 'utf8'));
    assert.ok(portable.mcpServers.archgen, 'the entry is not where the portable format reads it');
    assert.equal(portable.mcpServers.archgen.command, '/usr/local/bin/archgen-mcp');

    const project = result.wired.find((w) => w.harness === 'vscode' && w.location === 'project');
    assert.ok(project, 'the workspace VS Code config was not written');
    assert.equal(project.path, join(root, '.vscode', 'mcp.json'));
    assert.equal(project.key, 'servers');
    const vsFormat = JSON.parse(readFileSync(project.path, 'utf8'));
    assert.ok(vsFormat.servers.archgen, 'the entry is not where the VS Code format reads it');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('wiring with $COPILOT_HOME writes THERE, and not to the ignored default', () => {
  const root = mkdtempSync(join(tmpdir(), 'ag-vscode-'));
  const home = mkdtempSync(join(tmpdir(), 'ag-vscode-home-'));
  const copilot = mkdtempSync(join(tmpdir(), 'ag-copilot-'));
  try {
    const result = wireServer({
      serverId: 'archgen',
      registry,
      entries: registry.archgenEntries,
      npxEntries: registry.archgenNpxEntries,
      projectRoot: root,
      home,
      location: 'global',
      approved: true,
      binPath: '/usr/local/bin/archgen-mcp',
      fallbackCommand: 'archgen-mcp',
      env: { COPILOT_HOME: copilot },
    });
    const global = result.wired.find((w) => w.harness === 'vscode');
    assert.ok(global);
    assert.equal(global.path, join(copilot, 'mcp-config.json'));
    assert.ok(existsSync(join(copilot, 'mcp-config.json')));
    // The default location is the one VS Code IGNORES when COPILOT_HOME is
    // set — writing there would be the very bug this fixes.
    assert.equal(existsSync(join(home, '.copilot', 'mcp-config.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(copilot, { recursive: true, force: true });
  }
});
