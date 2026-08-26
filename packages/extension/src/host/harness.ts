// harness.ts — build-button dispatch (todo 9).
//
// SAFETY CONTRACT: this module NEVER mutates repository files. It only
// child_process.spawn()s an external agent harness with cwd = workspace root;
// the spawned agent itself is responsible for any status writes via
// set-status.mjs. Everything here is vscode-free so vitest (node env) can
// exercise it directly; extension.ts owns OutputChannel + toast wiring.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

export type HarnessId = 'claude' | 'opencode' | 'codex' | 'gemini' | 'custom';

/** Built-in invocation templates (bg_ae660a02 matrix). {{prompt}}/{{task}}/{{outfile}}. */
export const DEFAULT_TEMPLATES: Record<HarnessId, string> = {
  claude: 'claude -p "{{prompt}}" --output-format json --permission-mode acceptEdits',
  opencode: 'opencode run "{{prompt}}" --auto --format json',
  codex: 'codex exec --sandbox workspace-write --json -o "{{outfile}}" "{{prompt}}"',
  gemini: 'gemini --output-format json "{{prompt}}"',
  custom: '',
};

/** Typed error when no archgen scripts dir can be probed — surfaced to the UI banner. */
export class ScriptsNotFoundError extends Error {
  readonly kind = 'scripts-not-found';
  constructor(readonly probed: string[]) {
    super(
      `ArchGen scripts not found. Probed:\n${probed.map((p) => `  - ${p}`).join('\n')}\n` +
        `Set "archgen.scriptsPath" or install the archgen skill.`,
    );
    this.name = 'ScriptsNotFoundError';
  }
}

/** Typed error when the configured harness has no usable template. */
export class TemplateNotFoundError extends Error {
  readonly kind = 'template-not-found';
  constructor(readonly harness: HarnessId) {
    super(`No command template configured for harness "${harness}". Set archgen.harness.templates.${harness}.`);
    this.name = 'TemplateNotFoundError';
  }
}

/**
 * Resolve the harness transcript outfile for one task id, hardened against
 * path traversal. Task ids come from repository-controlled tasks.yaml (a
 * supply-chain surface), so every character outside [a-zA-Z0-9_-] is
 * replaced with `_` (an id that sanitizes to nothing falls back to "task"),
 * and the result is pinned inside os.tmpdir() — a hostile id like
 * `../../etc/cron` can never escape the temp directory. The containment
 * assert is defense-in-depth: after sanitization the id cannot contain a
 * separator, so the join alone is already safe.
 */
export function outfileForTask(taskId: string): string {
  const safeId = taskId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'task';
  const outfile = join(tmpdir(), `archgen-${safeId}.json`);
  if (!resolve(outfile).startsWith(resolve(tmpdir()) + sep)) {
    throw new Error(`Refusing to write harness outfile outside the temp directory for task "${taskId}".`);
  }
  return outfile;
}

/**
 * Replace {{var}} placeholders; unknown placeholders are a config error.
 * Substituted values are escaped for the double-quoted regions templates wrap
 * around {{prompt}}/{{task}}/{{outfile}}: backslash first (`\` → `\\`), then
 * double quote (`"` → `\"`). splitCommand decodes those escapes inside double
 * quotes, so a hostile task title round-trips as ONE verbatim argv element
 * instead of corrupting argv or smuggling instructions into the agent prompt.
 */
export function interpolateTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-zA-Z_]\w*)\s*\}\}/g, (_m, key: string) => {
    const value = vars[key];
    if (value === undefined) throw new Error(`Missing template value for placeholder {{${key}}}`);
    // Order matters: escaping backslashes first keeps the `\"` added below intact.
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  });
}

/**
 * Split a command line into argv, honoring double/single quotes. No shell involved.
 *
 * Inside double quotes `\"` and `\\` decode to literal `"` and `\`
 * (POSIX-double-quote-ish), so values escaped by interpolateTemplate reappear
 * verbatim as ONE argv element. Everywhere else characters are taken
 * literally, exactly as before this escape decoding existed.
 */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd.charAt(i);
    if (quote) {
      if (quote === '"' && ch === '\\') {
        const next = cmd.charAt(i + 1);
        if (next === '"' || next === '\\') {
          cur += next;
          i++;
          continue;
        }
      }
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) out.push(cur);
      cur = '';
      started = false;
    } else {
      cur += ch;
      started = true;
    }
  }
  if (started) out.push(cur);
  return out;
}

/**
 * Probe order for the archgen scripts directory:
 *   1. explicit archgen.scriptsPath setting (when non-empty)
 *   2. <workspace>/.agents/skills/archgen/scripts  (canonical layout)
 *   3. <workspace>/.claude/skills/archgen/scripts  (symlinked installs follow)
 *   4. <workspace>/skills/archgen/scripts          (legacy bare layout)
 *   5. ~/.agents/skills/archgen/scripts
 *   6. ~/.claude/skills/archgen/scripts
 * Throws ScriptsNotFoundError listing every probe when all are absent.
 */
export function probeScriptsPath(wsRoot: string | null, home: string, configured?: string): string {
  const candidates: string[] = [];
  if (configured && configured.trim() !== '') candidates.push(configured.trim());
  if (wsRoot) {
    candidates.push(join(wsRoot, '.agents', 'skills', 'archgen', 'scripts'));
    candidates.push(join(wsRoot, '.claude', 'skills', 'archgen', 'scripts'));
    candidates.push(join(wsRoot, 'skills', 'archgen', 'scripts'));
  }
  candidates.push(join(home, '.agents', 'skills', 'archgen', 'scripts'));
  candidates.push(join(home, '.claude', 'skills', 'archgen', 'scripts'));
  for (const c of candidates) if (existsSync(c)) return c;
  throw new ScriptsNotFoundError(candidates);
}

/** Shape of next-tasks.mjs output: { waves: [[taskId, ...], ...] }. */
export interface WavesFile {
  waves: string[][];
}

/** Validate parsed next-tasks JSON; throws TypeError on malformed shapes. */
export function parseWaves(text: string): string[][] {
  const raw: unknown = JSON.parse(text);
  const waves = (raw as { waves?: unknown })?.waves;
  if (!Array.isArray(waves)) throw new TypeError('next-tasks output missing "waves" array');
  return waves.map((wave, i) => {
    if (!Array.isArray(wave)) throw new TypeError(`waves[${i}] is not an array`);
    return wave.map((id, j) => {
      if (typeof id !== 'string') throw new TypeError(`waves[${i}][${j}] is not a string`);
      return id;
    });
  });
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Run `<node> next-tasks.mjs <tasksYaml>` inside scriptsPath and parse its
 * stdout as a WavesFile. Spawned (not imported) so untrusted plan tooling never
 * loads into the extension host process. The tasks.yaml path is REQUIRED — the
 * real script exits 4 (usage) without it.
 */
export function loadWaves(scriptsPath: string, tasksYamlPath: string, node = process.execPath): Promise<string[][]> {
  if (!tasksYamlPath) {
    return Promise.reject(new Error('loadWaves: tasks.yaml path is required'));
  }
  return new Promise((resolve, reject) => {
    const child = spawn(node, ['next-tasks.mjs', tasksYamlPath], { cwd: scriptsPath });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error(`next-tasks.mjs exited ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
        return;
      }
      try {
        resolve(parseWaves(stdout));
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  });
}

export interface LaunchOptions {
  /** Fully interpolated command line ("bin arg1 arg2"). */
  command: string;
  cwd: string;
  /** Live sink for stdout/stderr lines (host passes its OutputChannel). */
  log: (line: string) => void;
  /** Rolling tail kept in memory for the exit summary. */
  tailLines?: number;
}

/**
 * Spawn the harness WITHOUT a shell (argv array), streaming output lines to
 * `log`. Read-only with respect to the repo: we only start a process.
 */
export function launchHarness(opts: LaunchOptions): ChildProcess {
  const [bin, ...args] = splitCommand(opts.command);
  if (!bin) throw new Error('Empty harness command');
  const max = opts.tailLines ?? 40;
  const tail: string[] = [];
  const push = (line: string): void => {
    if (line === '') return;
    tail.push(line);
    if (tail.length > max) tail.shift();
    opts.log(line);
  };
  const child = spawn(bin, args, { cwd: opts.cwd });
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => chunk.split(/\r?\n/).forEach(push));
  child.stderr?.on('data', (chunk: string) => chunk.split(/\r?\n/).forEach(push));
  child.on('exit', (code, signal) => {
    opts.log(`[harness] tail (${tail.length} line${tail.length === 1 ? '' : 's'} kept):`);
    for (const l of tail.slice(-max)) opts.log(`  ${l}`);
    opts.log(`[harness] exited code=${code ?? 'null'} signal=${signal ?? 'none'}`);
  });
  return child;
}

/** Map an exit outcome to the toast the host should show. */
export function describeExit(
  taskId: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): { kind: 'info' | 'error'; message: string } {
  if (code === 0) return { kind: 'info', message: `ArchGen: task '${taskId}' finished successfully.` };
  if (signal) return { kind: 'error', message: `ArchGen: task '${taskId}' harness was killed by signal ${signal}.` };
  return { kind: 'error', message: `ArchGen: task '${taskId}' harness exited with code ${code ?? 'unknown'}.` };
}
