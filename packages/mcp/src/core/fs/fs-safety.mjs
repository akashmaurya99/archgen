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
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { conflict, permissionDenied } from '../protocol/errors.mjs';

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
 * The REAL path of a path, climbing to the nearest existing ancestor when
 * the leaf does not exist yet — so a symlinked PARENT is caught too.
 *
 * Returns null when the chain cannot be resolved at all (a broken symlink,
 * or a component that is not a directory).
 *
 * @param {string} abs
 * @returns {string|null}
 */
function realPathWithTail(abs) {
  const tail = [];
  let probe = resolve(abs);
  for (;;) {
    try {
      const real = realpathSync(probe);
      return tail.length ? join(real, ...tail) : real;
    } catch (e) {
      if (!e || e.code !== 'ENOENT') return null;
      const parent = dirname(probe);
      if (parent === probe) return null;
      tail.unshift(basename(probe));
      probe = parent;
    }
  }
}

/**
 * Realpath-escape guard: refuse anything that lands outside `rootAbs`.
 *
 * TWO COMPARISONS, AND THE PATH IS ALLOWED IF EITHER SAYS IT IS INSIDE.
 *
 *   1. LEXICAL — the caller's spelling against the root's spelling.
 *   2. REAL — where the path actually LANDS against where the root actually
 *      IS. This is the one that catches a symlinked PARENT redirecting a
 *      write elsewhere, and it is the only one that can answer the question
 *      when the two paths are spelled differently.
 *
 * They can disagree, and they DO whenever the root and the path are spelled
 * differently — which is the NORMAL case on macOS (`/tmp`, `/var`) and for
 * any symlinked project: `process.cwd()` is the REAL path while the caller
 * passes the LOGICAL one.
 *
 * The old guard compared the LEXICAL path against the REAL root and refused
 * on that mismatch, so a perfectly valid path inside the project was
 * reported as "outside the project" — and the two names the SAME place. The
 * real comparison is the one that can actually answer the question, and it
 * must be allowed to.
 *
 * The guard does NOT fail open: if the real comparison cannot be made, the
 * lexical one stands on its own, and a path outside the root by every
 * measure we could make is always refused.
 *
 * @param {string} rootAbs
 * @param {string} absPath
 */
export function assertWithinRoot(rootAbs, absPath) {
  const root = resolve(rootAbs);
  const abs = resolve(absPath);

  const rootReal = realPathWithTail(root);
  const pathReal = realPathWithTail(abs);

  const lexicalInside = abs === root || abs.startsWith(root + sep);
  const realInside =
    rootReal && pathReal ? pathReal === rootReal || pathReal.startsWith(rootReal + sep) : null;

  if (realInside === true || (realInside === null && lexicalInside)) return;

  if (lexicalInside) {
    // Lexically inside, but it lands somewhere else: a symlinked parent.
    throw permissionDenied(refuseSymlinkMessage(absPath), { path: absPath, root: rootAbs });
  }
  throw permissionDenied(
    `refusing a path outside the project: ${absPath} is not inside ${rootAbs}`,
    { path: absPath, root: rootAbs },
  );
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
      // A lock older than staleMs MIGHT belong to a holder that died — but a
      // slow holder is not a dead one, and stealing its lock put two writers
      // in the critical section at once. The PID in the lock says which: it
      // is taken only when that process is gone.
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > staleMs && !holderIsAlive(lockPath)) {
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
    // ONLY the lock this holder took is removed. A holder that ran longer
    // than staleMs had its lock stolen by the next writer; removing "the
    // lock file" then removed the NEXT holder's lock, and a third writer
    // entered the critical section beside it.
    try {
      if (readFileSync(lockPath, 'utf8').trim() === String(process.pid)) {
        unlinkSync(lockPath);
      }
    } catch {
      /* the lock is already gone */
    }
  }
}

/**
 * Whether the process holding a lock is still alive.
 *
 * The lock file carries the holder's PID. A stale lock is only broken when
 * that process is GONE: a lock older than the stale window may belong to a
 * writer that is merely slow, and taking its lock put two writers in the
 * critical section at once.
 *
 * @param {string} lockPath
 * @returns {boolean}
 */
function holderIsAlive(lockPath) {
  let holder;
  try {
    holder = readFileSync(lockPath, 'utf8').trim();
  } catch {
    return false; // the lock is gone — nobody holds it
  }
  const pid = Number(holder);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the process exists and belongs to another user.
    return e?.code === 'EPERM';
  }
}

/** Block the current thread for `ms` milliseconds. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}



