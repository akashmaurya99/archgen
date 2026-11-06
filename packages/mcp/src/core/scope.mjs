// scope.mjs — the single entry gate for plan-graph.mjs and doc-index.mjs.
//
// WHY THIS EXISTS: these indexers read whatever tree they are pointed at. An
// agent following injected instructions in a README, a prompt, or a hostile
// tasks.yaml could otherwise aim them at arbitrary project source, dotfiles,
// or home-directory content and have the tooling enumerate it. Pinning every
// input to `.archgen/<slug>/` guarantees both tools only ever read archgen's
// own artifact space — nothing else, no escape hatch.
//
// resolveSlugInput(rawInput) -> { kind: 'dir'|'tasks', root: <absolute slug dir>, slug: <dirname> }
//   Rules:
//   - fs.realpathSync the input first: symlinks are resolved to their target,
//     so `ln -s ~/secrets .archgen/x` style escapes are defeated (the real
//     path outside .archgen fails the segment check).
//   - The REAL path must contain a path segment exactly `.archgen` (segment
//     equality — `.archgenx/` does not count) such that the target is either
//     (a) a directory immediately under that `.archgen` segment (the slug
//     dir), or (b) a file named `tasks.yaml` directly inside such a slug dir.
//   - Everything else throws ScopeError. Missing/unreadable inputs surface as
//     the underlying realpath/stat error so callers keep their own messages.
import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, sep } from 'node:path';

export class ScopeError extends Error {
  constructor(input) {
    super(`'${input}' is outside .archgen scope — plan-graph/doc-index index only .archgen/<slug>/ plans`);
    this.name = 'ScopeError';
  }
}

/** Split an absolute real path into segments, separator-aware on all platforms
 * (win32 accepts both `\` and `/`; posix treats `\` as a normal filename char). */
function segmentsOf(abs) {
  return process.platform === 'win32' ? abs.split(/[\\/]+/).filter(Boolean) : abs.split(sep).filter(Boolean);
}

export function resolveSlugInput(rawInput) {
  let real;
  try {
    real = realpathSync(rawInput); // follows symlinks: judge the TARGET, not the link
  } catch (e) {
    e.input = rawInput;
    throw e; // missing/unreadable: caller renders its own "cannot read" message
  }
  const st = statSync(real);
  const parts = segmentsOf(real);

  // Scan EVERY `.archgen` segment; accept when any of them makes the target an
  // immediate slug dir (a) or its direct tasks.yaml (b). Last-wins is fine in
  // practice but any-match is the honest reading of the rule for nested oddities.
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] !== '.archgen') continue;
    const depthFromArchgen = parts.length - 1 - i; // segments after this `.archgen`
    if (st.isDirectory() && depthFromArchgen === 1) {
      // (a) `<...>/.archgen/<slug>` — the slug dir itself
      return { kind: 'dir', root: real, slug: parts[i + 1] };
    }
    if (st.isFile() && basename(real) === 'tasks.yaml' && depthFromArchgen === 2) {
      // (b) `<...>/.archgen/<slug>/tasks.yaml` — direct tasks.yaml mode
      const root = dirname(real);
      return { kind: 'tasks', root, slug: basename(root) };
    }
  }
  throw new ScopeError(rawInput);
}
