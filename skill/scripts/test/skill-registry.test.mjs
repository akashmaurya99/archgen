// Drift guard for assets/skill-registry.json — the FETCH-SKILL gate's whole
// purpose is mandatory, precise capability loading. A malformed registry or a
// raw-substring matcher turns the gate into either a no-op or a firehose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTRY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'skill-registry.json');

test('skill-registry: every entry is well-formed JSON with an explicit whole-word matcher', () => {
  const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  assert.ok(reg.version >= 1);
  assert.ok(Array.isArray(reg.skills) && reg.skills.length > 0, 'registry must not be empty');
  for (const s of reg.skills) {
    assert.ok(s.name, 'entry needs a name');
    assert.ok(s.repo, `entry ${s.name} needs repo`);
    assert.ok(s.install, `entry ${s.name} needs an install command`);
    assert.ok(Array.isArray(s.matches) && s.matches.length > 0, `entry ${s.name} needs matches`);
    assert.equal(s.match_mode ?? 'whole-word', 'whole-word',
      `entry ${s.name}: match_mode must be 'whole-word' — raw substring matching mis-fires on every task`);
    for (const m of s.matches) {
      assert.equal(m, m.trim(), `entry ${s.name}: matcher '${m}' has stray whitespace`);
      assert.ok(m.length >= 2, `entry ${s.name}: matcher '${m}' too short to be precise`);
    }
    assert.ok(['required', 'on-demand'].includes(s.policy), `entry ${s.name}: policy must be required|on-demand`);
  }
});

test('skill-registry: the required gate reaches UI/design work via whole words', () => {
  const reg = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  const ui = reg.skills.find((s) => s.name === 'ui-skills');
  assert.ok(ui, 'ui-skills must remain the required capability for design work');
  assert.equal(ui.policy, 'required');
  // positive signal: the design domains that MUST fire the gate
  for (const m of ['frontend', 'design', 'component', 'landing page']) {
    assert.ok(ui.matches.includes(m), `ui-skills must match '${m}'`);
  }
});
