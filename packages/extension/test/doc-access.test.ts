// doc-access.test.ts — guarded access to .archgen/ documents.
//
// A repo is a supply-chain surface: `.archgen/leak.md` may be a symlink to
// ~/.aws/credentials. The real path of the target AND of the .archgen root
// are compared before the file is read. Concurrent reads are sequenced so the
// LAST request always wins.
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocRevealer, resolveDocPath } from '../src/host/doc-access';

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'archgen-doc-'));
  dirs.push(dir);
  return dir;
}

/** Workspace with a .archgen folder holding one markdown file. */
function workspaceWithDoc(name = 'demo.md', body = '# demo'): string {
  const ws = scratch();
  mkdirSync(join(ws, '.archgen'), { recursive: true });
  writeFileSync(join(ws, '.archgen', name), body, 'utf8');
  return ws;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('resolveDocPath', () => {
  it('resolves a document that lives inside .archgen', async () => {
    const ws = workspaceWithDoc();
    const result = await resolveDocPath(ws, 'demo.md');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path.endsWith('/.archgen/demo.md')).toBe(true);
  });

  it('refuses a traversal path', async () => {
    const ws = workspaceWithDoc();
    const result = await resolveDocPath(ws, '../../etc/passwd');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/outside \.archgen/);
  });

  it('refuses an absolute path outside .archgen', async () => {
    const ws = workspaceWithDoc();
    const result = await resolveDocPath(ws, '/etc/passwd');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/outside \.archgen/);
  });

  it('refuses a SYMLINK that escapes .archgen — a lexical check would not', async () => {
    const ws = scratch();
    mkdirSync(join(ws, '.archgen'), { recursive: true });
    const secret = join(ws, 'secret.txt');
    writeFileSync(secret, 'AWS_SECRET=...', 'utf8');
    symlinkSync(secret, join(ws, '.archgen', 'leak.md'));
    const result = await resolveDocPath(ws, 'leak.md');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/outside \.archgen/);
  });

  it('accepts a symlink that stays inside .archgen', async () => {
    const ws = scratch();
    mkdirSync(join(ws, '.archgen', 'nested'), { recursive: true });
    writeFileSync(join(ws, '.archgen', 'nested', 'real.md'), '# real', 'utf8');
    symlinkSync(join(ws, '.archgen', 'nested', 'real.md'), join(ws, '.archgen', 'alias.md'));
    const result = await resolveDocPath(ws, 'alias.md');
    expect(result.ok).toBe(true);
  });

  it('reports a missing document as unreadable', async () => {
    const ws = workspaceWithDoc();
    const result = await resolveDocPath(ws, 'ghost.md');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Cannot read/);
  });

  it('reports a missing .archgen directory as unreadable', async () => {
    const ws = scratch();
    const result = await resolveDocPath(ws, 'demo.md');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/Cannot read/);
  });
});

describe('DocRevealer', () => {
  it('reads the document and reports its path + content', async () => {
    const ws = workspaceWithDoc('demo.md', '# hello');
    const revealer = new DocRevealer({
      wsRoot: () => ws,
      read: (abs) => import('node:fs/promises').then((fs) => fs.readFile(abs, 'utf8')),
    });
    const outcome = await revealer.reveal('demo.md');
    expect(outcome).toEqual({ kind: 'doc', path: 'demo.md', content: '# hello' });
  });

  it('lets the LAST request win when two reads finish out of order', async () => {
    const ws = workspaceWithDoc('first.md', 'FIRST');
    writeFileSync(join(ws, '.archgen', 'second.md'), 'SECOND', 'utf8');
    const gates: Array<() => void> = [];
    const revealer = new DocRevealer({
      wsRoot: () => ws,
      read: (abs) =>
        new Promise<string>((resolve) => {
          gates.push(() => resolve(abs.endsWith('first.md') ? 'FIRST' : 'SECOND'));
        }),
    });
    const first = revealer.reveal('first.md');
    const second = revealer.reveal('second.md');
    // Wait until both reads are actually in flight.
    while (gates.length < 2) await new Promise((r) => setTimeout(r, 1));
    // The SECOND read finishes first, the first one lands afterwards.
    gates[1]!();
    gates[0]!();
    expect(await second).toEqual({ kind: 'doc', path: 'second.md', content: 'SECOND' });
    // The late first read is stale — it must never be published.
    expect(await first).toEqual({ kind: 'stale' });
  });

  it('reports an error for a refused path', async () => {
    const ws = workspaceWithDoc();
    const revealer = new DocRevealer({
      wsRoot: () => ws,
      read: () => Promise.reject(new Error('should not be called')),
    });
    const outcome = await revealer.reveal('../escape.md');
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toMatch(/outside \.archgen/);
  });

  it('reports a failed read as an error (the original reason survives)', async () => {
    const ws = workspaceWithDoc();
    const revealer = new DocRevealer({
      wsRoot: () => ws,
      read: () => Promise.reject(new Error('EACCES')),
    });
    const outcome = await revealer.reveal('demo.md');
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toMatch(/Cannot read demo.md: EACCES/);
  });

  it('is a no-op without a workspace', async () => {
    const revealer = new DocRevealer({ wsRoot: () => null, read: () => Promise.reject(new Error('no')) });
    expect(await revealer.reveal('demo.md')).toEqual({ kind: 'stale' });
  });
});
