// path-policy.ts — ONE containment policy for every workspace path the
// extension opens. vscode-free so vitest can exercise it directly.
//
// The DOCS list publishes document paths RELATIVE TO <wsRoot>/.archgen (see
// features.ts), so every relative path the webview sends back is anchored at
// that same base. Absolute paths are accepted only when they stay inside the
// workspace root — an open request must never reach outside the repo.
import { isAbsolute, relative, resolve } from 'node:path';

/** The workspace-relative folder that holds plans, docs and runtime state. */
export const ARCHGEN_DIR = '.archgen';

/** True when `child` is `parent` itself or lives below it (lexical check). */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** Absolute path of the workspace's .archgen directory. */
export function archgenDir(wsRoot: string): string {
  return resolve(wsRoot, ARCHGEN_DIR);
}

/**
 * Resolve a path the webview asked to open.
 *
 * Relative paths are anchored at <wsRoot>/.archgen (the base the producers
 * use); absolute paths must stay inside the workspace root. Returns null when
 * the path is refused — the caller reports it instead of opening the file.
 */
export function resolveOpenFileTarget(path: string, wsRoot: string | null): string | null {
  if (typeof path !== 'string' || path.trim() === '') return null;
  if (!wsRoot) return null;
  if (isAbsolute(path)) {
    return isInside(wsRoot, path) ? resolve(path) : null;
  }
  const base = archgenDir(wsRoot);
  const abs = resolve(base, path);
  return isInside(base, abs) ? abs : null;
}
