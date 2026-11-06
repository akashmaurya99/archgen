// fs-safety.mjs — filesystem primitives every write path must go through.
//
// WHY THIS EXISTS: the MCP server takes paths from a model. A model can be
// talked into reading ~/.ssh, or into writing through a symlink that a
// malicious clone shipped inside the repo. Every write therefore passes
// through the same three gates:
//
//   1. assertNotSymlink  — lstat (never stat) the TARGET. A symlink is
//      refused, never written through.
//   2. assertWithinRoot  — resolve the REAL path (climbing to the nearest
//      existing ancestor when the leaf does not exist yet, so a symlinked
//      PARENT is caught too) and refuse anything that lands outside root.
//   3. writeFileAtomic  — O_EXCL temp file + rename. Concurrent readers see
//      old-or-new, never a half-written file. A crash before the rename
//      leaves at worst an orphaned .tmp- sibling, never a corrupt original.
//
// These semantics are inherited verbatim from the CLI's store.js and from
// skill/scripts/set-status.mjs — the MCP server must not be weaker than the
// scripts it replaces.
import { lstatSync, mkdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { permissionDenied } from './errors.mjs';

/** Canonical refusal message — identical wording to the CLI's. */
export function refuseSymlinkMessage(absPath) {
  return `Refusing to write through symlink at ${absPath} — remove the link or point it at a real directory`;
}

/**
 * lstat (never stat — the LINK itself, not its target) a path before writing.
 * Absent paths pass (safe to create); a symlink at the target throws.
 * @param {string} absPath
 */
export function assertNotSymlink(absPath) {
  let st = null;
  try {
    st = lstatSync(absPath);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) throw permissionDenied(refuseSymlinkMessage(absPath), { path: absPath });
}

/**
 * Realpath-escape guard: resolve `absPath` (climbing to the nearest existing
 * ancestor when it does not exist yet, so a symlinked PARENT dir is caught
 * before anything is created beneath it) and refuse when the real location
 * lands outside `rootAbs`.
 * @param {string} rootAbs
 * @param {string} absPath
 */
export function assertWithinRoot(rootAbs, absPath) {
  let rootReal;
  try {
    rootReal = realpathSync(rootAbs);
  } catch {
    return; // the root itself does not exist yet — nothing can escape it
  }
  let probe = absPath;
  for (;;) {
    let exists = true;
    try {
      lstatSync(probe);
    } catch {
      exists = false;
    }
    if (exists) {
      let real;
      try {
        real = realpathSync(probe);
      } catch {
        return; // broken chain: nothing writable through it
      }
      if (real !== rootReal && !real.startsWith(rootReal + sep)) {
        throw permissionDenied(refuseSymlinkMessage(absPath), { path: absPath, root: rootAbs });
      }
      return;
    }
    const parent = dirname(probe);
    if (parent === probe) return;
    probe = parent;
  }
}

/**
 * Resolve `candidate` against `rootAbs` and prove it stays inside.
 * @param {string} rootAbs absolute root directory
 * @param {string} candidate absolute or relative path
 * @returns {string} the resolved absolute path
 */
export function containPath(rootAbs, candidate) {
  const root = resolve(rootAbs);
  const abs = resolve(root, candidate);
  assertWithinRoot(root, abs);
  return abs;
}

/**
 * Atomically write `content` to `file`.
 *
 * The temp name carries pid + timestamp + attempt so two concurrent writers
 * never collide, and O_EXCL ('wx') guarantees a stale leftover is never
 * silently truncated and overwritten. The original file stays byte-intact
 * until the rename lands.
 *
 * @param {string} file absolute target path
 * @param {string|Buffer} content
 * @param {{eol?: string}} [opts]
 */
export function writeFileAtomic(file, content, opts = {}) {
  mkdirSync(dirname(file), { recursive: true });
  assertNotSymlink(file);
  let tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(tmp, content, { flag: 'wx' });
      break;
    } catch (e) {
      if (e?.code === 'EEXIST' && attempt < 10) {
        tmp = `${file}.tmp-${process.pid}-${Date.now()}-${attempt + 1}`;
        continue;
      }
      throw e;
    }
  }
  try {
    renameSync(tmp, file); // atomic on POSIX: readers observe old-or-new, never partial
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* original intact; leftover tmp is harmless */
    }
    throw e;
  }
  return file;
}



