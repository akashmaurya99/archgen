// profiles.test.mjs — the PROFILE is the privilege boundary.
//
// WHY THIS TEST EXISTS.
//
// The server used to publish EVERY tool to every client. Two of them
// (`archgen_setup`, `archgen_codegraph`) install software and write harness
// configuration, and their approval flag is an ARGUMENT the model supplies —
// so a model that could call them could be talked into using them by a
// repository it was reading.
//
// The split is now a profile:
//   lean (default) — the data plane; the admin tools are NOT published.
//   full           — the control plane too, for a trusted automation run.
//
// Three things must hold:
//   1. the lean profile publishes the data plane and NOT the admin tools;
//   2. the full profile publishes both;
//   3. the admin tools still WORK in the lean profile — the CLI reaches the
//      same handlers, and a profile decides what the MODEL sees, not what
//      the system can do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';

import { createServer, exposedToolNames, TOOL_NAMES } from '../../src/server.mjs';
import { getToolSpec, resetServerContext } from '../../src/tools/_register.mjs';
import { PROFILE_TOOLS, DEFAULT_PROFILE, resolveProfile } from '../../src/core/protocol/profiles.mjs';
import { Context } from '../../src/context.mjs';
import { guard } from '../../src/envelope.mjs';

/** Connect a client to a server built with a given profile. */
async function connect(profile) {
  resetServerContext();
  const server = createServer({ profile });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'archgen-profile-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test('the lean profile publishes the data plane and holds the admin tools back', async () => {
  const { client } = await connect('lean');
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [...PROFILE_TOOLS.lean].sort());
  assert.ok(!names.includes('archgen_setup'), 'the admin setup tool must not be published');
  assert.ok(!names.includes('archgen_codegraph'), 'the admin codegraph tool must not be published');
  await client.close();
});

test('the full profile publishes the control plane too', async () => {
  const { client } = await connect('full');
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [...PROFILE_TOOLS.full].sort());
  assert.ok(names.includes('archgen_setup'));
  assert.ok(names.includes('archgen_codegraph'));
  await client.close();
});

test('the admin tools still WORK in the lean profile — the CLI reaches them', async () => {
  // A profile decides what the MODEL sees, not what the system can do: the
  // handlers stay registered, so `archgen-mcp exec archgen_setup …` keeps
  // working.
  //
  // The context is HERMETIC — a temp project and a temp home, and a PATH
  // with nothing on it. The previous version ran against the developer's real
  // `$HOME`: it read their harness configs, and (because the action it
  // called no longer exists) it silently fell through to the bootstrap
  // branch — so the test passed while proving nothing.
  resetServerContext();
  createServer({ profile: 'lean' });
  const root = mkdtempSync(join(tmpdir(), 'ag-profile-'));
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  const ctx = new Context({
    projectRoot: root,
    anchorRoot: root,
    home,
    env: { PATH: '/nonexistent-archgen-test-path' },
  });
  try {
    const setup = getToolSpec('archgen_setup');
    const codegraph = getToolSpec('archgen_codegraph');
    assert.ok(setup, 'the setup spec must stay registered');
    assert.ok(codegraph, 'the codegraph spec must stay registered');

    // The REMOVED action is refused — by the schema, and by the handler.
    assert.equal(
      setup.inputSchema.safeParse({ action: 'harness_info' }).success,
      false,
      'harness_info was removed — the schema must reject it',
    );
    const removed = await guard(setup.handler, ctx, { action: 'harness_info' });
    assert.equal(removed.ok, false, 'harness_info must not resolve to another action');
    assert.equal(removed.error?.code, 'INVALID_INPUT');

    // The actions that remain are reachable.
    const harnesses = await guard(setup.handler, ctx, { action: 'harnesses' });
    assert.equal(harnesses.ok, true, harnesses.error?.message);
    const status = await guard(codegraph.handler, ctx, { action: 'status' });
    assert.equal(status.ok, true, status.error?.message);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unknown profile is refused, never silently defaulted', () => {
  assert.throws(() => resolveProfile('enterprise-plus', {}), /unknown tool profile/);
  assert.equal(resolveProfile(null, {}), DEFAULT_PROFILE);
  assert.equal(resolveProfile(null, { ARCHGEN_TOOL_PROFILE: 'full' }), 'full');
  assert.equal(resolveProfile('lean', { ARCHGEN_TOOL_PROFILE: 'full' }), 'lean');
});

test('every registered tool is in exactly one profile, and every profile is known', () => {
  for (const name of TOOL_NAMES) {
    const inProfiles = Object.entries(PROFILE_TOOLS).filter(([, names]) => names.includes(name));
    assert.ok(inProfiles.length >= 1, `${name} is in no profile`);
  }
  for (const [profile, names] of Object.entries(PROFILE_TOOLS)) {
    assert.ok(names.length > 0, `${profile} publishes nothing`);
    for (const name of names) {
      assert.ok(TOOL_NAMES.includes(name), `${profile} names an unknown tool: ${name}`);
    }
  }
  // The lean profile is a SUBSET of the full one: adding a profile must never
  // remove a tool from the data plane.
  for (const name of PROFILE_TOOLS.lean) {
    assert.ok(PROFILE_TOOLS.full.includes(name), `${name} is missing from the full profile`);
  }
});

test('the exposed names follow the active profile', () => {
  resetServerContext();
  createServer({ profile: 'lean' });
  assert.deepEqual(exposedToolNames(), [...PROFILE_TOOLS.lean]);
  resetServerContext();
  createServer({ profile: 'full' });
  assert.deepEqual(exposedToolNames(), [...PROFILE_TOOLS.full]);
});
