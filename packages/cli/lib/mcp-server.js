// mcp-server.js — locate and drive the `archgen-mcp` server from the CLI.
//
// WHY THE CLI DELEGATES: archgen's deterministic capability now lives in ONE
// place — the MCP server. The CLI used to shell out to the skill's
// scripts/codegraph.mjs; it now shells out to `archgen-mcp bootstrap`, which
// runs the same code the agent's tools run. There is no second implementation
// of harness wiring, CodeGraph bootstrap, or doctor logic.
//
// NEVER FATAL: no npm, no network, a read-only config, or a missing MCP
// server must still leave a working skill install. Failures are REPORTED,
// never thrown — the same posture bootstrapCodegraph has always had.
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { whichOnPath } from './spawn-npm.js';
import { installedServerVersion } from './global-server.js';
import { compareSemver } from './version.js';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MCP_PACKAGE = 'archgen-mcp';

/** This CLI package's root — the version it ships with. */
const CLI_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The CLI's own version.
 *
 * It is the SERVER version the CLI expects: the two packages are released
 * together and the skill declares the minimum server it needs. The npx
 * fallback asks for EXACTLY this version instead of `latest`, so an install
 * is reproducible and a newer server cannot change behaviour under a CLI
 * that was never tested against it.
 *
 * @returns {string|null}
 */
export function cliPackageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(CLI_PACKAGE_ROOT, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

/**
 * Locate the archgen-mcp binary.
 *
 * Resolution order (first hit wins):
 *   1. $ARCHGEN_MCP_BIN            — explicit override
 *   2. <project>/node_modules/.bin/archgen-mcp
 *   3. `archgen-mcp` on PATH       — a global npm install
 *   4. `npx -y archgen-mcp@<this CLI's version>` — network fallback (npx
 *      caches it). The fallback is PINNED to the version this CLI ships
 *      with: `latest` would let a newer server change behaviour under a CLI
 *      that was never tested against it.
 *
 * A server on PATH that is OLDER than this CLI is SKIPPED, not used. The CLI
 * and the server are released together and the skill declares the minimum
 * server it needs, so driving an old server would answer with an old tool
 * surface — and the failure looks like "the command does not exist" rather
 * than "the installed server is too old". The pinned npx fallback is used
 * instead.
 *
 * @param {{projectRoot?: string, home?: string, env?: Record<string, string|undefined>}} opts
 * @returns {{bin: string|null, source: 'override'|'local'|'path'|'npx', command: string, args: string[], stale?: string|null}}
 */
export function resolveMcpBinary(opts = {}) {
  const { projectRoot = process.cwd(), home = homedir(), env = process.env } = opts;

  const override = env.ARCHGEN_MCP_BIN;
  if (override && existsSync(override)) {
    return { bin: override, source: 'override', command: override, args: [] };
  }

  const local = join(
    resolve(projectRoot),
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'archgen-mcp.cmd' : 'archgen-mcp',
  );
  if (existsSync(local)) return { bin: local, source: 'local', command: local, args: [] };

  const onPath = whichOnPath('archgen-mcp', env);
  const version = cliPackageVersion();
  if (onPath) {
    const installed = installedServerVersion(onPath);
    const cmp = version && installed ? compareSemver(installed, version) : null;
    if (cmp === null || cmp >= 0) {
      // Same version, newer, or an unreadable version (the caller's call).
      return { bin: onPath, source: 'path', command: onPath, args: [] };
    }
    // TOO OLD: fall through to the pinned fallback, and say why.
    const stale = `the archgen-mcp on PATH is ${installed}; this CLI needs ${version}`;
    return {
      bin: null,
      source: 'npx',
      command: 'npx',
      args: ['-y', version ? `${MCP_PACKAGE}@${version}` : MCP_PACKAGE],
      stale,
    };
  }

  return {
    bin: null,
    source: 'npx',
    command: 'npx',
    args: ['-y', version ? `${MCP_PACKAGE}@${version}` : MCP_PACKAGE],
  };
}

/**
 * Quote one argument for cmd.exe.
 *
 * cmd.exe parses `&`, `|`, `<`, `>`, `^` and whitespace as syntax even in an
 * unquoted argument — an unquoted project path is split on spaces and its
 * `&`/`|` are executed. Double quotes neutralize all of them. `%` is the one
 * character cmd expands even inside quotes, so an argument carrying one is
 * refused rather than silently rewritten.
 *
 * @param {string} arg
 * @returns {string} the quoted argument
 */
export function quoteWindowsArg(arg) {
  const s = String(arg);
  if (s === '') return '""';
  if (/["%]/.test(s)) {
    throw new Error(`refusing to pass an unsafe character through the Windows shell: ${JSON.stringify(s)}`);
  }
  return '"' + s + '"';
}

/**
 * Find the JS entry point a Windows npm shim launches.
 *
 * npm writes `<name>.cmd` beside the package it points at, and the package's
 * package.json names the real script. Resolving it lets the script run with
 * the current node binary — no shell, no quoting, nothing to inject.
 *
 * @param {string} cmdPath path of the .cmd/.bat shim
 * @returns {string|null} absolute path of the JS entry point
 */
function resolveShimEntry(cmdPath) {
  const name = basename(cmdPath).replace(/\.(cmd|bat)$/i, '');
  const dir = dirname(cmdPath);
  const candidates = [
    join(dir, 'node_modules', MCP_PACKAGE), // global npm prefix
    join(dir, '..', MCP_PACKAGE), // node_modules/.bin -> node_modules/<pkg>
    join(dir, '..', 'node_modules', MCP_PACKAGE), // prefix/lib layout
  ];
  for (const pkgDir of candidates) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
    } catch {
      continue; // not this layout
    }
    const bin = pkg && pkg.bin;
    const rel = typeof bin === 'string' ? bin : bin && typeof bin === 'object' ? bin[name] : null;
    if (!rel) continue;
    const js = resolve(pkgDir, rel);
    if (existsSync(js)) return js;
  }
  return null;
}

/**
 * Build the spawn invocation for the MCP server.
 *
 * On Windows an npm-installed binary is a `.cmd` shim that only cmd.exe can
 * run — and cmd.exe parses unquoted arguments as shell syntax. The shim's JS
 * entry point is preferred (run with the current node binary, no shell at
 * all); when it cannot be resolved, every argument is quoted for cmd.exe.
 *
 * @param {string} command executable to run
 * @param {string[]} args arguments
 * @param {string} [platform] process.platform (injectable for tests)
 * @param {Record<string, string|undefined>} [env] environment used for lookups
 * @returns {{command: string, args: string[], shell: boolean}}
 */
export function mcpInvocation(command, args, platform = process.platform, env = process.env) {
  if (platform !== 'win32') return { command, args, shell: false };
  let cmd = command;
  if (!/\.(cmd|bat)$/i.test(cmd) && !/[\\/]/.test(cmd)) {
    // A bare name (e.g. 'npx') resolves to a .cmd shim on Windows.
    const shim = whichOnPath(cmd + '.cmd', env);
    if (shim) cmd = shim;
  }
  if (!/\.(cmd|bat)$/i.test(cmd)) return { command, args, shell: false };
  const js = resolveShimEntry(cmd);
  if (js) return { command: process.execPath, args: [js, ...args], shell: false };
  return { command: quoteWindowsArg(cmd), args: args.map(quoteWindowsArg), shell: true };
}

/**
 * The project root an MCP call is made against.
 *
 * It MUST be an ABSOLUTE path.
 *
 * The child process resolves a relative root against ITS OWN working
 * directory, so a root that was missing — or a property-name mismatch
 * between the caller and the callee — did not fail. It silently wrote the
 * harness configs, the CodeGraph index and the managed blocks into a
 * directory named "undefined", next to the real project.
 *
 * The guard turns that class of mistake into an immediate, named failure.
 *
 * @param {unknown} projectRoot
 * @param {string} fn the caller's name, for the message
 * @returns {string} the absolute project root
 */
export function requireProjectRoot(projectRoot, fn) {
  if (typeof projectRoot !== 'string' || projectRoot.trim() === '') {
    throw new Error(`${fn}: projectRoot is required and must be an absolute path`);
  }
  if (!isAbsolute(projectRoot)) {
    throw new Error(`${fn}: projectRoot must be an absolute path (got '${projectRoot}')`);
  }
  return resolve(projectRoot);
}

/**
 * Run one `archgen-mcp` subcommand and return its JSON output.
 *
 * @param {string[]} args the subcommand + flags
 * @param {{projectRoot?: string, timeout?: number, env?: Record<string, string|undefined>, noCodegraph?: boolean, noMcp?: boolean}} opts
 * @returns {{ok: boolean, code: number|null, data: any, stdout: string, stderr: string, detail?: string}}
 */
function runMcp(args, opts = {}) {
  const { timeout = 600000, env = process.env, noCodegraph = false, noMcp = false } = opts;
  const projectRoot = requireProjectRoot(opts.projectRoot ?? process.cwd(), 'runMcp');
  const resolved = resolveMcpBinary({ projectRoot, env });
  // The scope flags are forwarded to the server's bootstrap: the operator (or
  // a test) can wire ONLY the MCP server, without the bootstrap also
  // ENSURING CodeGraph — which on a machine without CodeGraph is a real
  // global install.
  const flags = [
    ...(noCodegraph ? ['--no-codegraph'] : []),
    ...(noMcp ? ['--no-mcp'] : []),
  ];
  const inv = mcpInvocation(resolved.command, [...resolved.args, ...args, ...flags], process.platform, env);
  let r;
  try {
    r = spawnSync(inv.command, inv.args, {
      encoding: 'utf8',
      timeout,
      env,
      cwd: projectRoot,
      shell: inv.shell,
    });
  } catch (e) {
    return { ok: false, code: null, data: null, stdout: '', stderr: '', detail: String(e?.message ?? e) };
  }
  if (r.error) {
    return { ok: false, code: null, data: null, stdout: '', stderr: '', detail: String(r.error.message ?? r.error) };
  }
  const stdout = r.stdout ?? '';
  let data = null;
  try {
    data = JSON.parse(stdout);
  } catch {
    /* not JSON — the caller renders the raw output */
  }
  return {
    ok: r.status === 0,
    code: r.status ?? null,
    data,
    stdout,
    stderr: r.stderr ?? '',
    // WHY the server was chosen (or skipped). A version-skew note belongs in
    // the doctor's output, not buried in a failed command.
    stale: resolved.stale ?? null,
  };
}

/**
 * The arguments for the server's bootstrap call.
 *
 * Exported so the project root in them can be asserted directly: the bug
 * this guards against was a property-name mismatch that put the literal
 * string "undefined" in this exact position.
 *
 * @param {string} projectRoot
 * @param {{location?: 'project'|'global'|'both', approved?: boolean}} [opts]
 * @returns {string[]}
 */
export function bootstrapArgs(projectRoot, opts = {}) {
  const { location = 'both', approved = true } = opts;
  const root = requireProjectRoot(projectRoot, 'bootstrapArgs');
  const args = ['bootstrap', '--project', root, '--location', location, '--json'];
  if (approved) args.push('--yes');
  return args;
}

/**
 * Wire the archgen MCP server into the detected harnesses and ensure CodeGraph.
 *
 * @param {{projectRoot: string, location?: 'project'|'global'|'both', approved?: boolean, profile?: string, noCodegraph?: boolean, noMcp?: boolean, env?: Record<string, string|undefined>}} opts
 * @returns {{ok: boolean, skipped?: string, detail?: string, report?: any}}
 */
export function bootstrapMcp(opts) {
  const { location = 'both', approved = true, profile = null, noCodegraph = false, noMcp = false, env = process.env } = opts;
  const args = bootstrapArgs(opts.projectRoot, { location, approved });

  // The TOOL PROFILE is declared in the WIRING when it is not the default, so
  // the project's MCP config says which surface it runs with — instead of one
  // developer's shell deciding it.
  const childEnv = profile ? { ...env, ARCHGEN_TOOL_PROFILE: profile } : env;
  const r = runMcp(args, { projectRoot: opts.projectRoot, env: childEnv, noCodegraph, noMcp });
  if (r.detail) {
    return { ok: false, detail: `cannot run ${MCP_PACKAGE}: ${r.detail}` };
  }
  if (r.data === null) {
    const firstLine = (r.stderr || r.stdout || '').trim().split('\n')[0];
    return { ok: false, detail: firstLine || `${MCP_PACKAGE} bootstrap produced no output` };
  }
  return { ok: r.ok, report: r.data, detail: r.ok ? undefined : r.stderr.trim().split('\n')[0] };
}

/**
 * Health-check the archgen MCP install.
 * @param {{projectRoot: string, env?: Record<string, string|undefined>}} opts
 */
export function mcpDoctor(opts) {
  const { env = process.env } = opts;
  const projectRoot = requireProjectRoot(opts.projectRoot, 'mcpDoctor');
  const r = runMcp(['doctor', '--project', projectRoot, '--json'], { projectRoot, env, timeout: 60000 });
  return { ok: r.ok, report: r.data, detail: r.detail, stale: r.stale ?? null };
}

/**
 * Remove the archgen MCP entries.
 * @param {{projectRoot: string, env?: Record<string, string|undefined>}} opts
 */
export function uninstallMcp(opts) {
  const { env = process.env } = opts;
  const projectRoot = requireProjectRoot(opts.projectRoot, 'uninstallMcp');
  // The scope is explicit: 'project' removes THIS project's wiring and
  // leaves the global wiring every other project shares alone.
  const location = opts.location ?? 'both';
  const r = runMcp(
    ['uninstall-mcp', '--project', projectRoot, '--location', location, '--yes', '--json'],
    { projectRoot, env, timeout: 60000 },
  );
  return { ok: r.ok, report: r.data, detail: r.detail };
}

/**
 * The runtime facts about this harness — the same answer `archgen_platform`
 * gives the model, reachable from a terminal.
 *
 * @param {{projectRoot: string, env?: Record<string, string|undefined>}} opts
 */
export function platformFacts(opts) {
  const { env = process.env } = opts;
  const projectRoot = requireProjectRoot(opts.projectRoot, 'platformFacts');
  const r = runMcp(['platform', '--project', projectRoot, '--json'], { projectRoot, env, timeout: 60000 });
  return { ok: r.ok, report: r.data, detail: r.detail };
}

/**
 * The detected harnesses and their MCP config paths.
 *
 * @param {{projectRoot: string, location?: 'project'|'global'|'both', env?: Record<string, string|undefined>}} opts
 */
export function mcpList(opts) {
  const { env = process.env } = opts;
  const projectRoot = requireProjectRoot(opts.projectRoot, 'mcpList');
  const location = opts.location ?? 'both';
  const r = runMcp(['mcp-list', '--project', projectRoot, '--location', location, '--json'], { projectRoot, env, timeout: 60000 });
  return { ok: r.ok, report: r.data, detail: r.detail };
}

/**
 * Drive the CodeGraph admin surface: `status`, `ensure` or `wire`.
 *
 * `ensure` and `wire` WRITE — they install the CLI and rewrite harness
 * configuration — so they carry the approval flag the server expects.
 *
 * @param {{projectRoot: string, action: 'status'|'ensure'|'wire', location?: 'project'|'global'|'both', approved?: boolean, env?: Record<string, string|undefined>}} opts
 */
export function codegraphAdmin(opts) {
  const { env = process.env } = opts;
  const projectRoot = requireProjectRoot(opts.projectRoot, 'codegraphAdmin');
  const location = opts.location ?? 'both';
  const args = ['codegraph', opts.action, '--project', projectRoot, '--location', location, '--json'];
  if (opts.approved) args.push('--yes');
  const r = runMcp(args, { projectRoot, env, timeout: 600000 });
  return { ok: r.ok, report: r.data, detail: r.detail };
}
