// doc-access.ts — guarded access to the documents under .archgen/.
//
// A repository is a supply-chain surface: `.archgen/leak.md` can be a SYMLINK
// to ~/.aws/credentials. A lexical prefix check cannot see that — the file
// name looks perfectly innocent — so the REAL path of both the target and the
// .archgen root is compared before the file is read.
//
// Reads are also SEQUENCED: two doc requests in flight can finish out of
// order, which would leave the DOCS tab showing the first document while the
// sidebar highlights the second. Only the newest request may publish.
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { errorText } from './error-text';
import { archgenDir, isInside } from './path-policy';

export type DocPathResult =
  | { ok: true; path: string }
  | { ok: false; reason: string };

/**
 * Resolve one document path to a REAL file inside the REAL .archgen dir.
 *
 * Both sides are resolved through realpath, so a symlink pointing outside the
 * workspace is refused instead of being read.
 */
export async function resolveDocPath(wsRoot: string, rel: string): Promise<DocPathResult> {
  const base = archgenDir(wsRoot);
  const abs = resolve(base, rel);
  if (abs === base || !isInside(base, abs)) {
    return { ok: false, reason: `Refusing to open ${rel} outside .archgen/.` };
  }
  let realBase: string;
  try {
    realBase = await realpath(base);
  } catch (e) {
    return { ok: false, reason: `Cannot read ${rel}: ${errorText(e)}` };
  }
  let realTarget: string;
  try {
    realTarget = await realpath(abs);
  } catch (e) {
    return { ok: false, reason: `Cannot read ${rel}: ${errorText(e)}` };
  }
  if (!isInside(realBase, realTarget)) {
    return { ok: false, reason: `Refusing to open ${rel} outside .archgen/.` };
  }
  return { ok: true, path: realTarget };
}

/** Outcome of one reveal request. */
export type DocRevealOutcome =
  | { kind: 'doc'; path: string; content: string }
  | { kind: 'error'; message: string }
  /** A newer request superseded this one — its result must not be published. */
  | { kind: 'stale' };

export interface DocRevealerOptions {
  /** Current workspace root (null when no folder is open). */
  wsRoot: () => string | null;
  /** Read a resolved absolute path. */
  read: (absPath: string) => Promise<string>;
}

/**
 * Last-request-wins reader for workspace documents.
 *
 * The token check happens AFTER every await: a slow first read that finishes
 * after a fast second read is reported as stale and never published.
 */
export class DocRevealer {
  private seq = 0;

  constructor(private readonly opts: DocRevealerOptions) {}

  /** Read one document; only the newest request may publish its result. */
  async reveal(rel: string): Promise<DocRevealOutcome> {
    this.seq += 1;
    const token = this.seq;
    const wsRoot = this.opts.wsRoot();
    if (!wsRoot) return { kind: 'stale' };
    const resolved = await resolveDocPath(wsRoot, rel);
    if (!resolved.ok) {
      return token === this.seq ? { kind: 'error', message: resolved.reason } : { kind: 'stale' };
    }
    let content: string;
    try {
      content = await this.opts.read(resolved.path);
    } catch (e) {
      const message = `Cannot read ${rel}: ${errorText(e)}`;
      return token === this.seq ? { kind: 'error', message } : { kind: 'stale' };
    }
    if (token !== this.seq) return { kind: 'stale' };
    return { kind: 'doc', path: rel, content };
  }
}
