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
import { lstatSync, mkdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { conflict, permissionDenied } from './errors.mjs';

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
 * @param {{eol?: string, root?: string}} [opts] `root` adds a containment
 *   check for the whole parent chain, so a symlinked PARENT cannot redirect
 *   the write outside the tree.
 */
export function writeFileAtomic(file, content, opts = {}) {
  mkdirSync(dirname(file), { recursive: true });
  if (opts.root) assertWithinRoot(opts.root, file);
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

/**
 * Run `fn` while holding an exclusive lock on `file`.
 *
 * WHY. An atomic write stops a READER seeing a half-written file. It does
 * not stop two WRITERS losing each other's work: worker A reads tasks.yaml,
 * worker B reads the same bytes, A writes its status change, B writes its
 * own from the stale snapshot — and A's change is gone. The parallel
 * workers are separate processes by design, so the guard has to live on
 * disk, not in memory.
 *
 * The lock is a sibling `<file>.lock` created with O_EXCL. A lock older than
 * `staleMs` is a crashed holder's leftover and is broken. The lock is always
 * released, including when `fn` throws.
 *
 * @param {string} file the file being mutated
 * @param {() => any} fn
 * @param {{timeoutMs?: number, staleMs?: number, pollMs?: number}} [opts]
 * @returns {any} whatever `fn` returns
 */
export function withFileLock(file, fn, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const staleMs = opts.staleMs ?? 30_000;
  const pollMs = opts.pollMs ?? 50;
  const lockPath = `${file}.lock`;
  const deadline = Date.now() + timeoutMs;

  mkdirSync(dirname(lockPath), { recursive: true });
  for (;;) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
      break;
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e;
      // A lock older than staleMs belongs to a holder that died.
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > staleMs) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue; // the lock vanished between the EEXIST and the stat
      }
      if (Date.now() > deadline) {
        throw conflict(`timed out after ${timeoutMs}ms waiting for the lock on ${file}`, { file, lockPath });
      }
      sleepSync(pollMs);
    }
  }

  try {
    return fn();
  } finally {
    try {
      unlinkSync(lockPath);
    } catch {
      /* the lock is already gone */
    }
  }
}

/** Block the current thread for `ms` milliseconds. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}



