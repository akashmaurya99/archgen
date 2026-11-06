// late-writer.mjs — a stub whose stdout is written AFTER it exits.
//
// The stub spawns a grandchild that inherits its stdout pipe and writes the
// answer 250ms later, then exits immediately. The pipe therefore stays open
// after the stub's own process is gone:
//
//   * on 'exit'  the parent sees an EMPTY stdout -> "produced no JSON"
//   * on 'close' the parent waits for the pipe to end and reads the answer
//
// That is the whole bug, made deterministic instead of timing-dependent.
import { spawn } from 'node:child_process';

const payload = JSON.stringify({ ok: true, data: { late: true, note: 'written after the parent exited' } });

const grandchild = spawn(
  process.execPath,
  ['-e', `setTimeout(() => process.stdout.write(${JSON.stringify(payload)}), 250)`],
  { stdio: ['ignore', 'inherit', 'inherit'] },
);
grandchild.unref();

// Exit NOW. The grandchild still holds the stdout pipe open.
process.exit(0);
