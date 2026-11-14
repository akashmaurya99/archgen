// io.mjs — output that does not LOSE BYTES.
//
// WHY THIS FILE EXISTS.
//
// `process.stdout.write` to a PIPE is ASYNCHRONOUS on Node 20: the bytes
// are queued, and a process that writes a large payload and exits can lose
// the tail. The budget gate read a TRUNCATED catalog on Node 20 and
// reported `the MCP catalog is not valid JSON` — so the largest always-on
// term SILENTLY dropped out of the measurement on a supported Node version,
// and the gate passed on a number that was thousands of tokens short.
//
// Node 22 made pipe writes synchronous, which hides the bug there and
// leaves Node 20 (the supported floor) broken. `fs.writeSync` is
// synchronous on EVERY version: the bytes are in the pipe before the
// process can exit.
//
// So every large stdout payload goes through here. The cost is one syscall
// per write instead of a buffered stream — which is the right trade for
// tools whose output is a report, a catalog, or a JSON document.

import { writeSync } from 'node:fs';

/**
 * Write EVERY byte to a file descriptor, or fail loudly.
 *
 * A non-blocking pipe can refuse a write with EAGAIN while the reader is
 * busy; the write is retried rather than dropped. EPIPE means the reader
 * is gone (`| head`), and there is nothing left to do.
 *
 * @param {number} fd the file descriptor (1 = stdout, 2 = stderr)
 * @param {string} text the bytes to write
 */
export function writeAll(fd, text) {
  const buf = Buffer.from(String(text), 'utf8');
  let offset = 0;
  while (offset < buf.length) {
    try {
      offset += writeSync(fd, buf, offset);
    } catch (e) {
      if (e?.code === 'EAGAIN') continue;
      if (e?.code === 'EPIPE') return;
      throw e;
    }
  }
}

/**
 * Print a line to stdout — synchronously, so it cannot be truncated.
 *
 * @param {string} text
 */
export function writeOut(text) {
  writeAll(1, `${text}\n`);
}

/**
 * Print a line to stderr — synchronously, for the same reason.
 *
 * @param {string} text
 */
export function writeErr(text) {
  writeAll(2, `${text}\n`);
}
