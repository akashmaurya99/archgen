// skill-install-engine.test.mjs — the capability installer's Node requirement.
//
// WHY THIS FILE EXISTS.
//
// The capability skills are installed by a THIRD-PARTY package (`skills`)
// that declares its own Node requirement — newer than the server's. The
// server never checked it, so on an older Node the install died inside npx
// with a message about the installer and nothing about what to do.
//
// The requirement lives in the registry, so the check lives where the
// registry is read: before anything is spawned.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installSkill } from '../../src/core/skill/skill-manager.mjs';

const REGISTRY = {
  version: '1',
  skills: [
    {
      id: 'ui-baseline',
      slug: 'ui-baseline',
      family: 'ui',
      repo: 'example/ui-baseline',
      purpose: 'baseline UI rules',
      policy: 'required',
      matches: ['ui', 'component'],
    },
  ],
  installer: {
    package: 'skills',
    version: '^1.7.6',
    nodeEngine: '>=22.20.0',
    addCommand: 'npx -y skills add',
    listCommand: 'npx -y skills list --json',
  },
};

test('an install that the running Node cannot satisfy is REFUSED, with the requirement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'archgen-engine-'));
  try {
    // A requirement no Node satisfies — the same code path a Node 20 machine
    // takes with the registry's real `>=22.20.0`.
    await assert.rejects(
      installSkill({
        registry: {
          ...REGISTRY,
          installer: { ...REGISTRY.installer, nodeEngine: '>=999.0.0' },
        },
        entry: REGISTRY.skills[0],
        projectRoot: root,
        approved: true,
        home: root,
      }),
      (e) => {
        assert.equal(e.code, 'INVALID_INPUT');
        assert.match(e.message, /needs Node >=999\.0\.0/, 'the requirement is named');
        assert.match(e.message, /this server runs on Node/, 'the running version is named');
        assert.match(e.message, /every other capability works on this Node/, 'the scope is bounded');
        assert.equal(e.details.required, '>=999.0.0');
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a satisfiable requirement does NOT block the install path', async () => {
  const root = mkdtempSync(join(tmpdir(), 'archgen-engine-'));
  try {
    // The PLAN (no approval) is returned before anything is spawned — the
    // engine check must not stand in the way of an answer the caller needs.
    const plan = await installSkill({
      registry: { ...REGISTRY, installer: { ...REGISTRY.installer, nodeEngine: '>=999.0.0' } },
      entry: REGISTRY.skills[0],
      projectRoot: root,
      approved: false,
      home: root,
    });
    assert.equal(plan.planned, true, 'the plan is returned');
    assert.equal(plan.installed, false, 'nothing was installed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
