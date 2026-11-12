// skill-version.test.mjs — ONE version, read from the skill itself.
//
// WHY THIS FILE EXISTS.
//
// The installed skill's version was read from the `.archgen-version` stamp
// alone, and the reader accepted ANY text: a store stamped "dev" reported
// {"version":"dev"} while the CLI's reader — which requires plain semver —
// reported "missing". Two readers, two answers for the same file.
//
// The version also lives in the SKILL's own frontmatter, which is present in
// every install mode (a copied store, a symlink to the packaged skill, a git
// checkout) and cannot disagree with the skill it describes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { readSkillVersion, resolveSkill } from '../../src/context.mjs';

const SKILL_MD = `---
name: archgen
description: A test skill.
metadata:
  version: 1.2.3
  requires:
    archgen_mcp: ">=1.0.0"
---

# archgen
`;

/**
 * A skill directory.
 *
 * @param {{stamp?: string|null, frontmatter?: string}} opts
 * @returns {string} the skill directory
 */
function skill(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'archgen-skillver-'));
  writeFileSync(join(dir, 'SKILL.md'), opts.frontmatter ?? SKILL_MD, 'utf8');
  if (opts.stamp !== null && opts.stamp !== undefined) {
    writeFileSync(join(dir, '.archgen-version'), opts.stamp, 'utf8');
  }
  return dir;
}

test('the version comes from the skill frontmatter', () => {
  const dir = skill();
  try {
    assert.equal(readSkillVersion(dir), '1.2.3');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a corrupt stamp does not become the version', () => {
  // The stamp used to be trusted verbatim: "dev" was reported as a version,
  // while the CLI's reader rejected the very same file.
  const dir = skill({ stamp: 'dev\n' });
  try {
    assert.equal(readSkillVersion(dir), '1.2.3', 'the frontmatter wins');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a legacy store with only a valid stamp still reports its version', () => {
  const dir = skill({ stamp: '0.9.1\n', frontmatter: '---\nname: archgen\n---\n' });
  try {
    assert.equal(readSkillVersion(dir), '0.9.1');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a legacy store with a non-semver stamp reports no version', () => {
  const dir = skill({ stamp: 'dev\n', frontmatter: '---\nname: archgen\n---\n' });
  try {
    assert.equal(readSkillVersion(dir), null, 'an unusable stamp is unknown, not a version');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a skill with neither source reports no version', () => {
  const dir = skill({ stamp: null, frontmatter: '---\nname: archgen\n---\n' });
  try {
    assert.equal(readSkillVersion(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the resolved skill carries the frontmatter version', () => {
  const root = mkdtempSync(join(tmpdir(), 'archgen-skillver-root-'));
  try {
    const dir = join(root, '.agents', 'skills', 'archgen');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), SKILL_MD, 'utf8');
    const found = resolveSkill(root, root, {});
    assert.ok(found, 'the skill was resolved');
    assert.equal(found.version, '1.2.3');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
