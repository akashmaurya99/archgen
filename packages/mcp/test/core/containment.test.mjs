// containment.test.mjs — the boundary the server works inside.
//
// THE THREAT MODEL. The MCP server takes paths from a model. A model can be
// talked into reading a private key, or into naming a different project root
// to move the boundary. The containment checks are therefore the difference
// between a tool and an open door.
//
// THE ANCHOR. The server owns an anchor root — the directory it was started
// in. A tool's `projectRoot` argument SELECTS a directory inside the anchor;
// it cannot redefine the boundary. That is what these tests pin.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '../../src/context.mjs';
import { assertWithinRoot } from '../../src/core/fs-safety.mjs';
import { docIndex } from '../../src/core/doc-navigator.mjs';
import { resolveSlugInput } from '../../src/core/scope.mjs';

let root;
let outside;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ag-anchor-'));
  outside = mkdtempSync(join(tmpdir(), 'ag-outside-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

test('a project root inside the anchor is accepted', () => {
  const ctx = new Context({ projectRoot: root });
  const sub = join(root, 'packages', 'api');
  mkdirSync(sub, { recursive: true });
  const scoped = ctx.withProjectRoot(sub);
  assert.equal(scoped.projectRoot, sub);
});

test('a relative project root is resolved against the anchor', () => {
  const ctx = new Context({ projectRoot: root });
  mkdirSync(join(root, 'pkg'), { recursive: true });
  assert.equal(ctx.withProjectRoot('pkg').projectRoot, join(root, 'pkg'));
});

test('a project root OUTSIDE the anchor is refused', () => {
  const ctx = new Context({ projectRoot: root });
  assert.throws(
    () => ctx.withProjectRoot(outside),
    (e) => e.code === 'PERMISSION_DENIED',
  );
});

test('a project root that TRAVERSES out of the anchor is refused', () => {
  const ctx = new Context({ projectRoot: root });
  assert.throws(
    () => ctx.withProjectRoot(join(root, '..', 'elsewhere')),
    (e) => e.code === 'PERMISSION_DENIED',
  );
});

test('an absolute path outside the anchor is refused', () => {
  const ctx = new Context({ projectRoot: root });
  assert.throws(() => ctx.withProjectRoot('/etc'), (e) => e.code === 'PERMISSION_DENIED');
});

test('a scoped context keeps the SAME anchor', () => {
  const ctx = new Context({ projectRoot: root });
  const sub = join(root, 'pkg');
  mkdirSync(sub, { recursive: true });
  const scoped = ctx.withProjectRoot(sub);
  assert.equal(scoped.anchorRoot, ctx.anchorRoot);
  // The scoped context cannot be widened either.
  assert.throws(() => scoped.withProjectRoot(outside), (e) => e.code === 'PERMISSION_DENIED');
});

test('assertWithinRoot refuses a path outside the root', () => {
  assert.throws(() => assertWithinRoot(root, outside), (e) => e.code === 'PERMISSION_DENIED');
});

test('assertWithinRoot refuses a path that traverses out of the root', () => {
  assert.throws(() => assertWithinRoot(root, join(root, '..', 'x')), (e) => e.code === 'PERMISSION_DENIED');
});

test('assertWithinRoot catches a symlinked PARENT that redirects outside', () => {
  const link = join(root, 'escape');
  symlinkSync(outside, link);
  assert.throws(() => assertWithinRoot(root, join(link, 'file.txt')), (e) => e.code === 'PERMISSION_DENIED');
});

test('the doc navigator does not read through a symlink out of the artifact space', () => {
  const secret = join(outside, 'secret.md');
  writeFileSync(secret, 'PRIVATE KEY MATERIAL\n');
  const slugDir = join(root, '.archgen', 'demo');
  mkdirSync(join(slugDir, 'docs'), { recursive: true });
  symlinkSync(secret, join(slugDir, 'docs', 'leak.md'));

  const index = docIndex(slugDir, { mode: 'overview' });
  const text = JSON.stringify(index.data ?? index);
  assert.doesNotMatch(text, /PRIVATE KEY MATERIAL/);
});

test('the scope gate refuses an artifact space outside the project root', () => {
  // A `.archgen` directory anywhere on the machine is not this project's
  // artifact space.
  const foreign = join(outside, '.archgen', 'demo');
  mkdirSync(foreign, { recursive: true });
  assert.throws(() => resolveSlugInput(foreign, root), (e) => e.name === 'ScopeError');
  // Without a root the gate accepts it — the root is what makes it specific.
  assert.equal(resolveSlugInput(foreign).slug, 'demo');
});

test('the scope gate accepts an artifact space inside the project root', () => {
  const mine = join(root, '.archgen', 'demo');
  mkdirSync(mine, { recursive: true });
  assert.equal(resolveSlugInput(mine, root).slug, 'demo');
});
