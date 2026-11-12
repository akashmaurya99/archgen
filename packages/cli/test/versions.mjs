// versions.mjs — the ONE place the CLI test suite gets its versions from.
//
// WHY A HELPER: a release version written into a test is a release chore.
// It is wrong at the next release, and nobody notices until the suite fails
// for a reason that has nothing to do with what it is testing. Three
// versions recur across the suite — "the current release", "an older one",
// "a newer one" — and each was written out separately, in several files.
//
// So:
//
//   RELEASE      the version under test, READ from the package. Never a
//                literal. It cannot go stale, and it cannot disagree with
//                what the code actually ships.
//
//   OLDER_STAMP  a stamp unambiguously older than ANY release. It is not a
//                version of this project — it is the "before" side of a
//                before/after comparison, so it must never be mistaken for
//                a release that happened.
//
//   NEWER_STAMP  the mirror image: unambiguously newer than any release.
//
// The two synthetic values are deliberately outside every plausible release
// range, so "is this stamp older than the current one?" is true forever.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The version under test — read from the package, never written down. */
export const RELEASE = JSON.parse(readFileSync(join(CLI_ROOT, 'package.json'), 'utf8')).version;

/** A stamp older than any release. */
export const OLDER_STAMP = '0.0.1';

/** A stamp newer than any release. */
export const NEWER_STAMP = '99.0.0';

/** Escape a version for use inside a RegExp. */
export const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
