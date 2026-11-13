// codegraph-policy.test.mjs — CodeGraph is wired the way the policy says.
//
// WHY THIS TEST EXISTS.
//
// The CodeGraph MCP server publishes ONE tool by default
// (`codegraph_explore`): seven more exist and stay unlisted, because each
// listed tool costs permanent context and steers the agent toward a
// narrower call. The allowlist is the server's `CODEGRAPH_MCP_TOOLS`
// environment variable — so an MCP entry WITHOUT it exposes the default one
// tool, and the curated surface never reaches the agent.
//
// Four facts have to hold, and none of them is visible in the result:
//   1. the entry carries the allowlist (and the per-process telemetry switch);
//   2. the INSTALL happens once, when the CLI is missing — an existing
//      install is never fetched, upgraded or rewritten;
//   3. the npx FALLBACK is pinned — an unpinned `npx -y pkg` executes
//      whatever `latest` becomes;
//   4. the environment key is the one the CLIENT reads (`env` for most
//      clients, `environment` for OpenCode).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  codegraphPolicy,
  codegraphEntries,
  codegraphSpec,
  codegraphInstallSpec,
} from '../../src/core/harness/codegraph-manager.mjs';

const REGISTRY = {
  entries: {
    stdio: { type: 'stdio', command: 'codegraph', args: ['serve', '--mcp'] },
    opencodeLocal: {
      type: 'local',
      command: ['codegraph', 'serve', '--mcp'],
      disabled: false,
      envKey: 'environment',
      codemode: false,
    },
  },
  npxEntries: {
    stdio: { type: 'stdio', command: 'npx', args: ['-y', '@colbymchenry/codegraph', 'serve', '--mcp'] },
  },
};

/** Every tool CodeGraph v1.6.2 defines. */
const ALL_TOOLS = ['explore', 'node', 'search', 'callers', 'callees', 'impact', 'files', 'status'];

test('the policy names the package, the install, the wire spec and the telemetry posture', () => {
  const policy = codegraphPolicy({});
  assert.equal(policy.package, '@colbymchenry/codegraph');
  assert.ok(policy.install, 'the policy must say what a first-time install fetches');
  assert.ok(policy.wire, 'the policy must pin the npx fallback');
  assert.match(policy.wire, /^\d+\.\d+\.\d+$/, 'the wire spec must be a plain semver — npm refuses a leading v');
  assert.equal(policy.telemetry, 'off');
});

test('EVERY CodeGraph tool is exposed, so the agent can use the whole surface', () => {
  // The allowlist REPLACES the default and silently drops unknown names, so
  // a typo would remove a tool without saying so — and a missing name would
  // leave the agent without a capability it is told it has.
  const policy = codegraphPolicy({});
  for (const tool of ALL_TOOLS) {
    assert.ok(policy.tools.includes(tool), `the policy does not expose ${tool}`);
  }
  assert.equal(policy.tools.length, ALL_TOOLS.length, 'the policy names a tool CodeGraph does not have');
});

test('the wired entry carries the allowlist and the telemetry switch', () => {
  const policy = codegraphPolicy({});
  const { entries, npxEntries } = codegraphEntries(REGISTRY, policy);

  assert.equal(entries.stdio.env.CODEGRAPH_MCP_TOOLS, policy.tools.join(','));
  assert.equal(entries.stdio.env.CODEGRAPH_TELEMETRY, '0', 'the server process must not phone home');
  assert.equal(npxEntries.stdio.env.CODEGRAPH_MCP_TOOLS, policy.tools.join(','));
});

test('the npx FALLBACK is pinned', () => {
  const policy = codegraphPolicy({});
  const { npxEntries } = codegraphEntries(REGISTRY, policy);
  const pkg = npxEntries.stdio.args.find((a) => a.includes('@colbymchenry/codegraph'));
  assert.equal(pkg, `@colbymchenry/codegraph@${policy.wire}`);
  assert.equal(codegraphSpec(policy), `@colbymchenry/codegraph@${policy.wire}`);
});

test('the FIRST-TIME install fetches the latest release; an existing install is never touched', () => {
  const policy = codegraphPolicy({});
  // The install spec is the package with NO version: the newest published
  // release, exactly like CodeGraph's official installer.
  assert.equal(policy.install, 'latest');
  assert.equal(codegraphInstallSpec(policy), '@colbymchenry/codegraph');

  // A machine that must pin says so, and the pin is a plain semver.
  const pinned = codegraphPolicy({ ARCHGEN_CODEGRAPH_INSTALL: '1.6.2' });
  assert.equal(codegraphInstallSpec(pinned), '@colbymchenry/codegraph@1.6.2');
  // A leading `v` is not a valid npm spec — it is stripped, never passed on.
  const vPrefixed = codegraphPolicy({ ARCHGEN_CODEGRAPH_INSTALL: 'v1.6.2' });
  assert.equal(codegraphInstallSpec(vPrefixed), '@colbymchenry/codegraph@1.6.2');
});

test('the environment goes under the key the client reads', () => {
  const policy = codegraphPolicy({});
  const { entries } = codegraphEntries(REGISTRY, policy);
  // OpenCode reads `environment`; everyone else reads `env`.
  assert.equal(entries.opencodeLocal.environment.CODEGRAPH_MCP_TOOLS, policy.tools.join(','));
  assert.equal(entries.opencodeLocal.env, undefined);
  assert.equal(entries.stdio.env.CODEGRAPH_MCP_TOOLS, policy.tools.join(','));
  // The registry's own bookkeeping key never reaches the config.
  assert.equal(entries.opencodeLocal.envKey, undefined);
});

test('the environment overrides the policy', () => {
  const overridden = codegraphPolicy({
    ARCHGEN_CODEGRAPH_VERSION: '1.2.3',
    ARCHGEN_CODEGRAPH_TOOLS: 'explore',
    ARCHGEN_CODEGRAPH_TELEMETRY: 'on',
  });
  assert.equal(overridden.wire, '1.2.3');
  assert.deepEqual(overridden.tools, ['explore']);
  assert.equal(overridden.telemetry, 'on');

  // `latest` is the explicit way to say "do not pin".
  const unpinned = codegraphPolicy({ ARCHGEN_CODEGRAPH_VERSION: 'latest' });
  assert.equal(unpinned.wire, null);
  assert.equal(codegraphSpec(unpinned), '@colbymchenry/codegraph');
});
