// path-policy.test.ts — the ONE containment policy for workspace paths.
//
// A relative path is anchored at <wsRoot>/.archgen (the base the DOCS list
// publishes); an absolute path is accepted only inside the workspace.
import { describe, expect, it } from 'vitest';
import { archgenDir, isInside, resolveOpenFileTarget } from '../src/host/path-policy';

describe('isInside', () => {
  it('accepts the directory itself and its descendants', () => {
    expect(isInside('/ws', '/ws')).toBe(true);
    expect(isInside('/ws', '/ws/src/a.ts')).toBe(true);
  });

  it('rejects siblings and parents', () => {
    expect(isInside('/ws', '/ws-other/a.ts')).toBe(false);
    expect(isInside('/ws', '/etc/passwd')).toBe(false);
    expect(isInside('/ws', '/ws/../etc/passwd')).toBe(false);
  });
});

describe('archgenDir', () => {
  it('is the workspace-relative .archgen folder', () => {
    expect(archgenDir('/ws')).toBe('/ws/.archgen');
  });
});

describe('resolveOpenFileTarget', () => {
  it('anchors a relative path at <wsRoot>/.archgen — the base the DOCS list uses', () => {
    expect(resolveOpenFileTarget('plans/demo.md', '/ws')).toBe('/ws/.archgen/plans/demo.md');
    expect(resolveOpenFileTarget('demo.md', '/ws')).toBe('/ws/.archgen/demo.md');
  });

  it('refuses a relative path that escapes .archgen', () => {
    expect(resolveOpenFileTarget('../../etc/passwd', '/ws')).toBeNull();
    expect(resolveOpenFileTarget('../outside.md', '/ws')).toBeNull();
  });

  it('accepts an absolute path inside the workspace', () => {
    expect(resolveOpenFileTarget('/ws/.archgen/a.md', '/ws')).toBe('/ws/.archgen/a.md');
    expect(resolveOpenFileTarget('/ws/src/a.ts', '/ws')).toBe('/ws/src/a.ts');
  });

  it('refuses an absolute path outside the workspace', () => {
    expect(resolveOpenFileTarget('/etc/passwd', '/ws')).toBeNull();
    expect(resolveOpenFileTarget('/ws-other/a.md', '/ws')).toBeNull();
  });

  it('refuses everything when no workspace is open', () => {
    expect(resolveOpenFileTarget('a.md', null)).toBeNull();
    expect(resolveOpenFileTarget('/ws/a.md', null)).toBeNull();
  });

  it('refuses an empty path', () => {
    expect(resolveOpenFileTarget('', '/ws')).toBeNull();
    expect(resolveOpenFileTarget('   ', '/ws')).toBeNull();
  });
});
