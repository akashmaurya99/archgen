// mcp-client.ts — the extension's client for the archgen MCP server.
//
// The extension used to run the skill's scripts/next-tasks.mjs to resolve the
// next wave. Those scripts no longer exist: ALL deterministic capability lives
// in the archgen MCP server, so the extension calls THAT.
//
// WHY A SUBPROCESS AND NOT AN MCP CLIENT LIBRARY: the extension only needs
// ONE operation (resolve the next wave) and already had the process-spawning
// machinery. `archgen-mcp exec <tool> '<json>'` reaches the same handler the
// agent's tools reach — one implementation, two ways in — without adding an
// MCP client dependency to the .vsix.
//
// Spawned (not imported) so untrusted plan tooling never loads into the
// extension host process.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { errorText } from './error-text';

export const MCP_PACKAGE = 'archgen-mcp';

/** Resolved archgen-mcp binary, or the npx fallback. */
export interface McpBinary {
  /** Absolute path, or null when the npx fallback is used. */
  bin: string | null;
  /** How it was found. */
  source: 'override' | 'local' | 'path' | 'npx';
  /** The executable to spawn. */
  command: string;
  /** Arguments that precede the subcommand. */
  args: string[];
}

/**
 * Locate an executable on PATH (cross-platform, no shell).
 *
 * `platform` is injectable so the Windows path rules can be exercised on any
 * runner — CI runs Linux, and a Windows-only branch that is never executed is
 * a branch that is never verified.
 */
export function whichOnPath(
  bin: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const exts = platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  const dirs = (env.PATH ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const d of dirs) {
    for (const ext of exts) {
      const p = join(d, bin + ext);
      try {
        if (existsSync(p)) return p;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/**
 * True when the command must be run through a shell.
 *
 * On Windows the npx shim is a `.cmd`/`.bat` file, which the OS cannot
 * execute directly — `spawn` needs `shell: true` for it. Everywhere else
 * spawning a shell would be a needless (and injectable) risk, so it stays off.
 */
export function shouldUseShell(
  command: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === 'win32' && /\.(cmd|bat)$/i.test(command);
}

/**
 * Resolve the archgen-mcp binary.
 *
 * Order: $ARCHGEN_MCP_BIN -> <project>/node_modules/.bin -> PATH -> npx.
 */
export function resolveMcpBinary(
  wsRoot: string | null,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): McpBinary {
  const override = env.ARCHGEN_MCP_BIN;
  if (override && existsSync(override)) {
    return { bin: override, source: 'override', command: override, args: [] };
  }
  if (wsRoot) {
    const local = join(
      resolve(wsRoot),
      'node_modules',
      '.bin',
      platform === 'win32' ? 'archgen-mcp.cmd' : 'archgen-mcp',
    );
    if (existsSync(local)) return { bin: local, source: 'local', command: local, args: [] };
  }
  const onPath = whichOnPath('archgen-mcp', env, platform);
  if (onPath) return { bin: onPath, source: 'path', command: onPath, args: [] };
  return { bin: null, source: 'npx', command: 'npx', args: ['-y', MCP_PACKAGE] };
}

/** The envelope every archgen MCP tool returns. */
interface Envelope {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

/** Shape of archgen_tasks{action:'next'} data: { waves: [[{id,…}]] }. */
interface WavesData {
  waves: Array<Array<{ id: string }>>;
}

/**
 * Run one archgen MCP tool and return its envelope.
 *
 * @param tool the tool name
 * @param args the tool arguments
 * @param opts.projectRoot the project root (also the containment root)
 * @param opts.binary the resolved binary
 */
export function callMcpTool(
  tool: string,
  args: Record<string, unknown>,
  opts: { projectRoot: string; binary: McpBinary },
): Promise<Envelope> {
  const { projectRoot, binary } = opts;
  return new Promise((resolvePromise, reject) => {
    const child = spawn(
      binary.command,
      [...binary.args, 'exec', tool, JSON.stringify(args), '--project', projectRoot],
      {
        cwd: projectRoot,
        shell: false,
        // On Windows the npx shim is a .cmd file, which needs a shell.
        ...(shouldUseShell(binary.command) ? { shell: true } : {}),
      },
    );
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    // 'close', NOT 'exit'.
    //
    // 'exit' fires when the process is gone, but its stdout pipe may still
    // have bytes in flight: the parent has not necessarily received the last
    // chunk yet. Reading the buffer on 'exit' therefore loses the tail of the
    // response — and for a response that arrives in more than one chunk, it
    // can lose ALL of it. The client then reports "produced no JSON" for a
    // server that answered perfectly well, which is exactly what happened on
    // CI: a fast Linux runner delivered the data event AFTER 'exit', and the
    // extension rejected a valid envelope.
    //
    // 'close' fires only after the process has exited AND its stdio streams
    // have been closed, so the buffer is complete when it runs.
    child.on('close', (code) => {
      let envelope: Envelope | null = null;
      let parseError = '';
      try {
        envelope = JSON.parse(stdout) as Envelope;
      } catch (e) {
        parseError = errorText(e);
        envelope = null;
      }
      if (!envelope) {
        const why = [parseError, stderr.trim()].filter(Boolean).join(': ');
        reject(new Error(`archgen-mcp exec ${tool} produced no JSON (exit ${code})${why ? `: ${why}` : ''}`));
        return;
      }
      if (!envelope.ok) {
        reject(new Error(`archgen-mcp ${tool} failed: ${envelope.error?.message ?? 'unknown error'}`));
        return;
      }
      resolvePromise(envelope);
    });
  });
}

/**
 * Resolve the next wave of executable tasks.
 *
 * @param projectRoot the workspace root
 * @param tasksYamlPath the absolute path to tasks.yaml
 * @param binary the resolved archgen-mcp binary
 */
export async function loadWaves(
  projectRoot: string,
  tasksYamlPath: string,
  binary: McpBinary,
): Promise<string[][]> {
  if (!tasksYamlPath) throw new Error('loadWaves: tasks.yaml path is required');
  const envelope = await callMcpTool(
    'archgen_tasks',
    { action: 'next', tasksYaml: tasksYamlPath },
    { projectRoot, binary },
  );
  const data = envelope.data as WavesData | undefined;
  if (!data || !Array.isArray(data.waves)) {
    throw new Error('archgen_tasks{next} returned no waves array');
  }
  return data.waves.map((wave, i) => {
    if (!Array.isArray(wave)) throw new TypeError(`waves[${i}] is not an array`);
    return wave.map((t, j) => {
      if (typeof t?.id !== 'string') throw new TypeError(`waves[${i}][${j}] has no string id`);
      return t.id;
    });
  });
}
