// path-safety-parity.test.mjs — the two path guards must agree.
//
// WHY THIS FILE EXISTS. The CLI's installer and the MCP's server each guard
// the paths they write, and the guards are near-copies: the CLI package is
// published and must work when it is copied ALONE, with no server beside
// it, so they cannot be one implementation.
//
// Duplication invites drift, and the drift has already started — the two
// messages for the same refusal differ. The BEHAVIOUR is what matters, so
// this test holds the behaviour of one to the behaviour of the other, over
// the same corpus of paths: a symlink, a path outside the root, a path
// inside it, and a path whose parent does not exist yet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  assertNotSymlink as cliAssertNotSymlink,
  assertWithinRoot as cliAssertWithinRoot,
} from '../../packages/cli/lib/store.js';
import {
  assertNotSymlink as mcpAssertNotSymlink,
  assertWithinRoot as mcpAssertWithinRoot,
} from '../../packages/mcp/src/core/fs/fs-safety.mjs';

/** Whether a guard refuses the path. */
function refuses(guard, ...args) {
  try {
    guard(...args);
    return false;
  } catch {
    return true;
  }
}

test('the two symlink guards refuse the same paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'archgen-parity-'));
  try {
    const real = join(root, 'real');
    const link = join(root, 'link');
    mkdirSync(real);
    writeFileSync(join(real, 'file.txt'), 'x');
    symlinkSync(real, link);

    for (const path of [link, join(real, 'file.txt'), join(root, 'missing.txt')]) {
      assert.equal(
        refuses(cliAssertNotSymlink, path),
        refuses(mcpAssertNotSymlink, path),
        `the guards disagree about ${path}`,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the two containment guards refuse the same paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'archgen-parity-'));
  try {
    const inside = join(root, 'inside');
    mkdirSync(inside);
    const outside = mkdtempSync(join(tmpdir(), 'archgen-outside-'));
    try {
      const paths = [
        inside,
        join(inside, 'not-created-yet.txt'),
        join(root, '..', 'elsewhere.txt'),
        outside,
        resolve(root),
      ];
      for (const path of paths) {
        assert.equal(
          refuses(cliAssertWithinRoot, root, path),
          refuses(mcpAssertWithinRoot, root, path),
          `the guards disagree about ${path}`,
        );
      }
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
