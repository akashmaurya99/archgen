// profile-wiring.test.mjs — the PROFILE must reach the WRITTEN MCP entry.
//
// WHY THIS TEST EXISTS.
//
// The tool profile is a privilege control: in `lean` the admin tools are not
// published to the model. But the profile only takes effect if it reaches the
// MCP server the CLIENT launches — and it reaches it through the entry the
// installer writes.
//
// The OpenCode entry had no `envKey`, so the profile landed under `env`
// while OpenCode reads `environment`: `ARCHGEN_TOOL_PROFILE=full` was a
// silent no-op there. The operator believed the control plane was published
// and it was not — the exact class of silent privilege failure the profile
// exists to prevent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadAsset } from '../../src/context.mjs';
import { wireArchgenMcp } from '../../src/core/harness/mcp-server-manager.mjs';

const registry = loadAsset('harness-mcp.json');

/** A project that looks like an OpenCode one: `.opencode/` plus opencode.json. */
function opencodeProject() {
  const root = mkdtempSync(join(tmpdir(), 'ag-profile-wire-'));
  const home = mkdtempSync(join(tmpdir(), 'ag-profile-home-'));
  mkdirSync(join(root, '.opencode'), { recursive: true });
  return { root, home };
}

test('the tool profile reaches the OpenCode entry under the key OpenCode reads', () => {
  const { root, home } = opencodeProject();
  try {
    const res = wireArchgenMcp({
      projectRoot: root,
      registry,
      home,
      location: 'project',
      approved: true,
      env: { ARCHGEN_TOOL_PROFILE: 'full', PATH: '/usr/bin:/bin' },
    });
    const written = res.wired.filter((w) => w.status === 'written');
    assert.ok(written.length, 'the entry must be written');

    const config = JSON.parse(readFileSync(join(root, 'opencode.json'), 'utf8'));
    const entry = config.mcp?.servers?.archgen ?? config.mcpServers?.archgen;
    assert.ok(entry, 'the archgen entry must be in the OpenCode config');
    // OpenCode reads `environment`; `env` is ignored by the client.
    assert.equal(entry.environment?.ARCHGEN_TOOL_PROFILE, 'full', 'the profile must be where OpenCode reads it');
    assert.equal(entry.env, undefined, 'the profile must not also land under a key OpenCode ignores');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('the DEFAULT profile writes no environment at all', () => {
  const { root, home } = opencodeProject();
  try {
    const res = wireArchgenMcp({
      projectRoot: root,
      registry,
      home,
      location: 'project',
      approved: true,
      env: { PATH: '/usr/bin:/bin' },
    });
    const written = res.wired.filter((w) => w.status === 'written');
    assert.ok(written.length, 'the entry must be written');

    const config = JSON.parse(readFileSync(join(root, 'opencode.json'), 'utf8'));
    const entry = config.mcp?.servers?.archgen ?? config.mcpServers?.archgen;
    assert.ok(entry, 'the archgen entry must be in the OpenCode config');
    // The default is the server's own default, so the config says nothing and
    // cannot disagree with it.
    assert.equal(entry.environment?.ARCHGEN_TOOL_PROFILE, undefined);
    assert.equal(entry.env?.ARCHGEN_TOOL_PROFILE, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('the writer and the status resolve the SAME paths (the Copilot home)', () => {
  // The writer and the status must agree on where a config lives. The
  // writer used to run with process.env while the status ran with the
  // caller's env, so a caller that named $COPILOT_HOME saw the status
  // resolve one path and the write another — and VS Code was silently left
  // unwired.
  const { root, home } = opencodeProject();
  const copilotHome = mkdtempSync(join(tmpdir(), 'ag-copilot-home-'));
  try {
    mkdirSync(join(copilotHome, '.vscode'), { recursive: true });
    const env = { COPILOT_HOME: copilotHome, PATH: '/usr/bin:/bin' };
    const res = wireArchgenMcp({
      projectRoot: root,
      registry,
      home,
      location: 'global',
      approved: true,
      env,
    });
    const written = res.wired.filter((w) => w.status === 'written');
    const vscode = written.find((w) => w.harness === 'vscode');
    assert.ok(vscode, 'VS Code must be wired when its Copilot home exists');
    assert.equal(
      vscode.path,
      join(copilotHome, 'mcp-config.json'),
      'the writer must use the Copilot home the caller named',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
    rmSync(copilotHome, { recursive: true, force: true });
  }
});
