// errors.mjs — the single error taxonomy for every archgen capability.
//
// Tool failures are DATA, not protocol errors: the agent must be able to read
// a failure and act on it (fix the YAML, resolve the cycle, pass --force).
// Protocol-level errors are reserved for malformed calls the SDK rejects
// before a handler ever runs.
//
// The codes below are the stable contract. They map 1:1 onto the old script
// exit codes so nothing that used to be scriptable stops being scriptable:
//   2 -> CYCLE            (dependency cycle)
//   3 -> OWNERSHIP_CONFLICT
//   4 -> INVALID_INPUT    (usage / parse / IO)
// plus the enterprise additions that the scripts never needed:
//   NOT_FOUND · PERMISSION_DENIED · UNAVAILABLE · TIMEOUT · CONFLICT · INTERNAL

/** @typedef {'INVALID_INPUT'|'NOT_FOUND'|'CYCLE'|'OWNERSHIP_CONFLICT'|'CONFLICT'|'PERMISSION_DENIED'|'UNAVAILABLE'|'TIMEOUT'|'INTERNAL'} ErrorCode */

export class ArchgenError extends Error {
  /**
   * @param {ErrorCode} code
   * @param {string} message
   * @param {Record<string, unknown>} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ArchgenError';
    this.code = code;
    this.details = details;
  }

  /** @returns {{code: ErrorCode, message: string, details: Record<string, unknown>}} */
  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

/** Invalid usage, bad arguments, unparseable input. */
export const invalidInput = (message, details) => new ArchgenError('INVALID_INPUT', message, details);
/** A referenced path / task / document does not exist. */
export const notFound = (message, details) => new ArchgenError('NOT_FOUND', message, details);
/** The task graph contains a dependency cycle. */
export const cycle = (message, details) => new ArchgenError('CYCLE', message, details);
/** Two tasks in the same wave claim overlapping file ownership. */
export const ownershipConflict = (message, details) => new ArchgenError('OWNERSHIP_CONFLICT', message, details);
/** The action conflicts with current state (e.g. reopening a done task). */
export const conflict = (message, details) => new ArchgenError('CONFLICT', message, details);
/** A write was refused by a safety guard (symlink, outside-root, no approval). */
export const permissionDenied = (message, details) => new ArchgenError('PERMISSION_DENIED', message, details);
/** A required external actor is absent (extension not running, binary missing). */
export const unavailable = (message, details) => new ArchgenError('UNAVAILABLE', message, details);
/** An operation exceeded its deadline. */
export const timeout = (message, details) => new ArchgenError('TIMEOUT', message, details);

/**
 * Normalize ANY thrown value into an ArchgenError. Unknown throws become
 * INTERNAL but keep the original message — a stack trace never reaches the
 * agent, but the cause always does.
 * @param {unknown} e
 * @returns {ArchgenError}
 */
export function toArchgenError(e) {
  if (e instanceof ArchgenError) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new ArchgenError('INTERNAL', message);
}
