// io.js — the CLI's output must not lose bytes.
//
// WHY THIS FILE EXISTS.
//
// `process.stdout.write` to a PIPE is ASYNCHRONOUS on Node 20, and a
// process that writes a large payload and exits can lose the tail: the
// budget gate read a TRUNCATED 17KB catalog as 8KB of invalid JSON on Node
// 20, and silently dropped the largest always-on term from the measurement.
//
// Node 22 made pipe writes synchronous, so the bug hides there and breaks
// on Node 20 — the supported floor. `fs.writeSync` is synchronous on every
// version: the bytes are in the pipe before the process can exit.
//
// The CLI's output is usually a handful of lines, but "usually" is not a
// guarantee, and a truncated message is a broken message.
import { writeSync } from 'node:fs';

/**
 * Write EVERY byte to a file descriptor, or fail loudly.
 *
 * A non-blocking pipe can refuse a write with EAGAIN while the reader is
 * busy; the write is retried rather than dropped. EPIPE means the reader is
 * gone (`| head`), and there is nothing left to do.
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
