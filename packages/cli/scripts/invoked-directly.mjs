// invoked-directly.mjs — did this script get RUN, or was it imported?
//
// WHY THIS FILE EXISTS.
//
// A script that does its work at import time must not do it when it is
// IMPORTED. Node gives no signal for "was this run as the entry point", so
// every such script grows its own guard — and two guards that answer the
// same question are two guards that can disagree.
//
// The subtlety this guard handles: Node realpath-resolves `import.meta.url`,
// but `process.argv[1]` keeps its as-typed form. Where the script is
// launched through a symlinked path (macOS /tmp and /var/folders ->
// /private/...), a plain equality NEVER matches, and main() would silently
// never run. The script would exit 0, having done nothing — the worst
// possible outcome for a release gate.
//
// So argv[1] is resolved the same way before it is compared.
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * Whether a module was the process entry point.
 *
 * The module's own URL is a PARAMETER, not a default: a default would be
 * evaluated in THIS module's context, so every caller would be compared
 * against this file's URL and every caller would answer false. The caller
 * passes its own `import.meta.url`.
 *
 * @param {string} entry the URL of the calling module
 * @returns {boolean} true when the script was run directly
 */
export function invokedDirectly(entry) {
  if (!process.argv[1]) return false;
  try {
    return entry === pathToFileURL(realpathSync(resolve(process.argv[1]))).href;
  } catch {
    return false;
  }
}
