// reference-resolution.test.mjs — how a reference resolves, and that the
// rule is DISCOVERABLE.
//
// WHY THIS FILE EXISTS.
//
// A real session hit 23 broken references it could not repair. The rule
// lived only in the implementation: a caller handed the broken list had no
// way to learn how a link resolves, and the rule it would have learned
// contradicted the skill — the skill mandates repo-root-relative paths, and
// the validator rejected every one of them.
//
// So two things are pinned here:
//
//   1. the RESOLUTION — a repo-root path resolves, a product path that does
//      not exist yet is an output declaration, and an artifact of the
//      artifact space must exist;
//   2. the DISCOVERY — the finding carries the rule, so the repair loop
//      needs no source reading.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { docIndex, REFERENCE_RULE } from '../../src/core/doc-navigator.mjs';

function fixture({ plan = '', artifacts = {}, product = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'archgen-refs-'));
  const slugDir = join(root, '.archgen', 'demo');
  mkdirSync(join(slugDir, 'plans'), { recursive: true });
  mkdirSync(join(slugDir, 'docs'), { recursive: true });
  writeFileSync(join(slugDir, 'plans', 'plan.md'), plan, 'utf8');
  // The validate mode cross-checks the task ids, so it needs the task file.
  writeFileSync(
    join(slugDir, 'tasks.yaml'),
    'tasks:\n  - id: T1\n    title: one\n    depends_on: []\n    file_ownership: ["src/a/**"]\n    acceptance:\n      - "it works"\n',
    'utf8',
  );
  for (const [rel, text] of Object.entries(artifacts)) {
    const abs = join(slugDir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text, 'utf8');
  }
  for (const [rel, text] of Object.entries(product)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, text, 'utf8');
  }
  return { root, slugDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const brokenOf = (f) => docIndex(f.slugDir, { mode: 'validate', projectRoot: f.root }).data.broken;

test('the profile\'s OWN artifact path resolves from a plan', () => {
  // The profile hands out `.archgen/<slug>/architecture.yaml`. A plan that
  // cites it verbatim used to be reported broken — in the very file the
  // profile told the agent to write the path in.
  const f = fixture({
    plan: '# Plan\n\nSee `.archgen/demo/architecture.yaml` for the contract.\n',
    artifacts: { 'architecture.yaml': 'toolchain: {}\n' },
  });
  try {
    const broken = brokenOf(f);
    assert.deepEqual(
      broken.filter((b) => b.kind === 'link'),
      [],
      `the profile's own path must resolve: ${JSON.stringify(broken)}`,
    );
  } finally {
    f.cleanup();
  }
});

test('a product path that does not exist yet is an OUTPUT, not a broken link', () => {
  // The skill mandates repo-root-relative paths for everything a worker
  // touches — including files the plan will create. Flagging them made the
  // mandated form unusable.
  const f = fixture({
    plan: '# Plan\n\nThe config lives at `configs/base.yaml` and `configs/stages/train.yaml`.\n',
  });
  try {
    const broken = brokenOf(f);
    assert.deepEqual(
      broken.filter((b) => b.kind === 'link'),
      [],
      `an output declaration must not be broken: ${JSON.stringify(broken)}`,
    );
  } finally {
    f.cleanup();
  }
});

test('a product path that EXISTS resolves', () => {
  const f = fixture({
    plan: '# Plan\n\nRead `configs/base.yaml`.\n',
    product: { 'configs/base.yaml': 'a: 1\n' },
  });
  try {
    assert.deepEqual(brokenOf(f).filter((b) => b.kind === 'link'), []);
  } finally {
    f.cleanup();
  }
});

test('a document-relative reference resolves inside the artifact space', () => {
  const f = fixture({
    plan: '# Plan\n\nThe contract is `../architecture.yaml`.\n',
    artifacts: { 'architecture.yaml': 'toolchain: {}\n' },
  });
  try {
    assert.deepEqual(brokenOf(f).filter((b) => b.kind === 'link'), []);
  } finally {
    f.cleanup();
  }
});

test('an artifact of the artifact space that does not exist IS broken', () => {
  const f = fixture({
    plan: '# Plan\n\nSee `.archgen/demo/docs/missing.md`.\n',
  });
  try {
    const broken = brokenOf(f).filter((b) => b.kind === 'link');
    assert.equal(broken.length, 1, 'a missing artifact is a broken link');
    assert.match(broken[0].detail ?? '', /does not exist/);
  } finally {
    f.cleanup();
  }
});

test('a document-relative reference that escapes the artifact space is broken', () => {
  const f = fixture({
    plan: '# Plan\n\nSee `../../../../etc/hosts.md`.\n',
  });
  try {
    const broken = brokenOf(f).filter((b) => b.kind === 'link');
    assert.equal(broken.length, 1, 'escaping the artifact space is broken');
    assert.match(broken[0].detail ?? '', /outside the artifact space/);
  } finally {
    f.cleanup();
  }
});

test('a broken finding carries the RULE — the repair loop needs no source reading', () => {
  const f = fixture({
    plan: '# Plan\n\nSee `.archgen/demo/docs/missing.md`.\n',
  });
  try {
    const broken = brokenOf(f).filter((b) => b.kind === 'link');
    assert.equal(broken.length, 1);
    assert.ok(broken[0].resolution, 'the finding must carry the resolution rule');
    assert.equal(broken[0].resolution, REFERENCE_RULE);
    assert.ok(broken[0].detail, 'the finding must say what it expected');
  } finally {
    f.cleanup();
  }
});

test('the rule is stated where an agent looks for it', () => {
  assert.match(REFERENCE_RULE, /project root/);
  assert.match(REFERENCE_RULE, /output declaration/);
});
