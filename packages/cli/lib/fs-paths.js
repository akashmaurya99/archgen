// fs-paths.js — the path primitives the installer files all need.
//
// WHY THIS FILE EXISTS.
//
// `lstatSafe` and `relJoin` were copy-pasted into five and three files
// respectively, byte for byte. Two copies of one rule is how rules start
// disagreeing: the day someone hardens `lstatSafe` — to survive a symlink,
// to handle a permission error, to log the path it refused — they harden
// ONE copy and the other four keep the old behaviour. The bug then reads as
// "the installer works on my machine" rather than as "two implementations of
// one rule".
//
// So they live here, once, with the reason they exist written down.
//
// WHY `lstatSafe` IS NOT `existsSync`. `existsSync` follows symlinks and
// answers "can I reach a file through this path". A symlink to somewhere
// outside the project still answers TRUE — which is exactly the case the
// installer must refuse rather than write through. `lstatSafe` asks about
// the PATH ITSELF (is it a link? is it a directory?) and never follows it,
// so the caller can make the decision before it touches anything.
//
// WHY `relJoin` SPLITS ON '/'. The store and adapter paths are stored as
// POSIX-style relative paths ('.agents/skills/archgen') because they are
// written into manifests and compared as strings across platforms. They
// must become NATIVE paths before they reach the filesystem, and `join`
// does that — but only if it receives the segments, not one string with a
// separator in it. On Windows, `join('.agents/skills/archgen')` treats the
// whole thing as ONE segment and produces a file literally named
// ".agents/skills/archgen".

import { lstatSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `lstat` that cannot throw.
 *
 * `lstatSync` throws when the path does not exist, when a parent is not
 * searchable, or when the path is too long. Every caller here is asking
 * "what IS at this path", and "nothing" is a perfectly good answer to that
 * question — so the failure is folded into the answer instead of thrown.
 *
 * The result is NOT followed: a symlink reports as a symlink, so the caller
 * can refuse to write through it.
 *
 * @param {string} p the path to inspect
 * @returns {import('node:fs').Stats|null} the stat, or null when the path
 *   does not exist or cannot be inspected
 */
export function lstatSafe(p) {
  try { return lstatSync(p); } catch { return null; }
}

/**
 * Join a POSIX-style relative path into a native path.
 *
 * The relative paths the installer stores ('.agents/skills/archgen') are
 * POSIX-style on purpose: they are written into a manifest, compared as
 * strings, and read on every platform. This turns one into a path the
 * local filesystem understands.
 *
 * @param {string} rel a POSIX-style relative path
 * @returns {string} the native path
 */
export function relJoin(rel) {
  return join(...rel.split('/'));
}
