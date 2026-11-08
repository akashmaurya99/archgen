// codegraph-manager.mjs — install / wire / index CodeGraph, idempotently.
//
// Extracted from skill/scripts/codegraph.mjs (deleted in the MCP-first
// cutover). The manager still DRIVES the official CodeGraph CLI — it never
// reimplements it — but the config writing is now delegated to the shared
// harness-wiring module, so archgen's own MCP server and CodeGraph's MCP
// server are wired by the same code.
//
// Modes: ensure | init | wire | status
//   ensure: install CLI if missing -> wire every DETECTED harness -> index the
//           project. The MCP server's watcher keeps the index live afterwards.
//   init:   index only (no config writes)
//   wire:   wire only (no install, no index)
//   status: report what is installed / wired / indexed
//
// SAFETY: MCP configs are written only with approval (otherwise the plan is
// reported); non-JSON configs are reported, never rewritten.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { detectHarnesses, wireServer, recordWiring } from './harness-wiring.mjs';
import { invalidInput } from './errors.mjs';

export const CODEGRAPH_PACKAGE = '@colbymchenry/codegraph';

/** Run a command; never throws. Returns {ok, status, stdout, stderr}. */
export function run(cmd, args, opts = {}) {
  const { timeout = 120000, cwd, env, shell } = opts;
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout,
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    // The caller's `shell` wins; otherwise only a Windows .cmd/.bat shim needs
    // one. The option used to be dropped, so a caller asking for a shell did
    // not get one.
    shell: shell === true || (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)),
  });
  if (r.error) return { ok: false, status: -1, stdout: '', stderr: String(r.error.message ?? r.error) };
  return { ok: r.status === 0, status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Run a command asynchronously; never throws. Returns {ok, status, stdout, stderr}.
 *
 * The SYNCHRONOUS form blocks the event loop for the child's whole lifetime,
 * and the stdio MCP server cannot answer a single request while that
 * happens — a global install or a full index can take minutes, so every
 * other request simply queues behind it.
 *
 * 'close' (not 'exit') decides the outcome: 'exit' fires when the process is
 * gone, while its output may still be in flight, and the last chunk of a
 * long install log would be lost.
 */
export function runAsync(cmd, args, opts = {}) {
  const { timeout = 120000, cwd, env, shell } = opts;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        shell: shell === true,
      });
    } catch (e) {
      resolve({ ok: false, status: -1, stdout: '', stderr: String(e?.message ?? e) });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const timer =
      timeout > 0
        ? setTimeout(() => {
            try {
              child.kill('SIGKILL');
            } catch {
              /* already gone */
            }
          }, timeout)
        : null;
    child.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', (e) => {
      finish({ ok: false, status: -1, stdout, stderr: String(e?.message ?? e) });
    });
    child.on('close', (code) => {
      finish({ ok: code === 0, status: code ?? -1, stdout, stderr });
    });
  });
}

/** Locate an executable on PATH (cross-platform, no shell). */
export function which(bin, env = process.env) {
  const exts = process.platform === 'win32' ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  const dirs = (env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const d of dirs) {
    for (const ext of exts) {
      const p = join(d, bin + ext);
      try {
        if (statSync(p).isFile()) return p;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/**
 * npm via its JS entry point: an unshelled .cmd shim fails with EINVAL on
 * Windows since the CVE-2024-27980 hardening.
 */
export function npmInvocation(npmArgs, env = process.env) {
  const fromEnv = env.npm_execpath;
  if (typeof fromEnv === 'string' && fromEnv.endsWith('.js') && existsSync(fromEnv)) {
    return { command: process.execPath, args: [fromEnv, ...npmArgs], shell: false };
  }
  const isWin = process.platform === 'win32';
  return { command: isWin ? 'npm.cmd' : 'npm', args: npmArgs, shell: isWin };
}

/** Resolve the codegraph CLI: absolute path + version, or null. */
export function findCodegraph(env = process.env) {
  const bin = which('codegraph', env);
  if (!bin) return null;
  const v = run(bin, ['--version'], { timeout: 20000 });
  const version = (v.stdout || v.stderr).trim().split('\n')[0] || 'unknown';
  return { bin, version };
}

/** Current telemetry state: 'enabled' | 'disabled' | 'unknown'. */
export function telemetryState(bin) {
  if (!bin) return 'unknown';
  const r = run(bin, ['telemetry', 'status'], { timeout: 20000 });
  if (!r.ok) return 'unknown';
  const out = (r.stdout + r.stderr).toLowerCase();
  if (out.includes('enabled')) return 'enabled';
  if (out.includes('disabled')) return 'disabled';
  return 'unknown';
}

/**
 * Manage CodeGraph for one project.
 *
 * @param {{
 *   mode: 'ensure'|'init'|'wire'|'status',
 *   projectRoot: string,
 *   registry: any,
 *   location?: 'project'|'global'|'both',
 *   targets?: string[]|null,
 *   approved?: boolean,
 *   dryRun?: boolean,
 *   telemetry?: 'keep'|'off'|'on',
 *   noInstall?: boolean,
 *   home?: string,
 *   env?: Record<string, string|undefined>,
 * }} opts
 * @returns {Promise<Record<string, unknown>>} the report
 */
export async function manageCodegraph(opts) {
  const {
    mode,
    projectRoot,
    registry,
    location = 'both',
    targets = null,
    approved = false,
    dryRun = false,
    telemetry = 'keep',
    noInstall = false,
    home = homedir(),
    env = process.env,
  } = opts;

  const report = {
    mode,
    projectRoot,
    cli: { present: false, version: null, bin: null, latest: null, action: 'none' },
    telemetry: { state: 'unknown', action: 'none' },
    wiring: { native: [], manual: [], skipped: [] },
    index: { initialized: false, action: 'none', files: null, detail: null },
    realtime: {
      watcher: true,
      note: 'codegraph serve --mcp runs a file watcher: the index stays in sync automatically while the MCP server runs',
    },
    detected: [],
    ok: true,
  };

  /**
   * Resolve the CodeGraph CLI.
   *
   * THE RULE: install it when it is MISSING, and leave it alone when it is
   * ALREADY THERE.
   *
   * An installed CodeGraph is the user's to manage. Upgrading it behind
   * their back changes a program they may have pinned, and the upgrade ran
   * on every bootstrap — so a plain `npx archgen-skill init` could rewrite a
   * working installation. The version that is already on the machine is the
   * version the MCP config points at, and it works.
   *
   * `install` lets a caller ask for the RESOLUTION only — the binary's path
   * without touching the machine. That is what `wire` needs: wiring is a
   * configuration change; installing a program globally is not.
   */
  const ensureCli = async ({ install = true } = {}) => {
    let found = findCodegraph(env);
    if (!found) {
      if (noInstall || !install) {
        // Caller manages the CLI — fall back to the npx form in the MCP config.
        report.cli.action = 'absent';
        report.cli.detail = `not installed and installation was skipped — the MCP config will use "npx -y ${CODEGRAPH_PACKAGE} serve --mcp"`;
        return { bin: null, version: null };
      }
      if (dryRun) {
        report.cli.action = 'would-install';
        return { bin: null, version: null };
      }
      // NOT APPROVED — do not install.
      //
      // A global `npm install -g` is a write to the user's machine, exactly
      // like a config write, and the tool documents the opposite of what the
      // code used to do: "Without `approve: true` the tool prints its plan
      // and writes nothing." The code installed a global program anyway.
      // The gate now covers the install, so an unapproved call is a plan.
      if (!approved) {
        report.cli.action = 'would-install';
        report.cli.detail = `not installed — pass approve:true to install ${CODEGRAPH_PACKAGE} globally`;
        return { bin: null, version: null };
      }
      // Official install path; always the latest published release.
      const inv = npmInvocation(['install', '-g', CODEGRAPH_PACKAGE], env);
      const r = await runAsync(inv.command, inv.args, { timeout: 600000, shell: inv.shell, env });
      found = findCodegraph(env);
      if (!found) {
        report.cli.action = 'failed';
        report.cli.detail = `global install failed${r.stderr ? `: ${r.stderr.trim().split('\n')[0]}` : ''} — npx fallback will be used in the MCP config`;
        report.ok = false;
        return { bin: null, version: null };
      }
      report.cli.action = 'installed';
    } else {
      // Already installed: report it and stop. No upgrade, no version check.
      report.cli.action = 'present';
    }
    report.cli.present = true;
    report.cli.bin = found.bin;
    report.cli.version = found.version;
    return found;
  };

  /** Wire the MCP server into every detected harness (native + fallback). */
  const wireHarnesses = async (cli) => {
    const detected = detectHarnesses(registry, projectRoot, home, env);
    const wanted = targets ?? detected.map((d) => d.id);
    const selected = detected.filter((d) => wanted.includes(d.id));

    const nativeIds = [];
    for (const d of selected) {
      const target = d.spec.codegraphTarget;
      if (!target) continue;
      if (location === 'project') {
        if (d.atProject) nativeIds.push(target);
      } else if (location === 'global') {
        if (d.atHome) nativeIds.push(target);
      } else if (d.atHome || d.atProject) {
        nativeIds.push(target);
      }
    }

    const uniqueNative = [...new Set(nativeIds)];
    if (uniqueNative.length) {
      const locations = location === 'both' ? ['global', 'local'] : [location === 'project' ? 'local' : 'global'];
      for (const loc of locations) {
        if (dryRun || !approved) {
          report.wiring.native.push({ targets: uniqueNative.join(','), location: loc, status: 'planned' });
          continue;
        }
        const r = await runAsync(
          cli.bin ?? 'codegraph',
          ['install', `--target=${uniqueNative.join(',')}`, `--location=${loc}`, '--yes'],
          {
            timeout: 120000,
            // CRITICAL: the installer resolves local config paths from CWD — it
            // must run in the project root or it writes into the wrong project.
            cwd: loc === 'local' ? projectRoot : undefined,
            env,
          },
        );
        report.wiring.native.push({
          targets: uniqueNative.join(','),
          location: loc,
          status: r.ok ? 'wired' : 'failed',
          detail: r.ok ? undefined : (r.stderr || r.stdout || '').trim().split('\n')[0],
        });
        if (!r.ok) report.ok = false;
      }
    }

    // Harnesses codegraph does not target (windsurf, vscode, zed, trae) are
    // wired from the registry's per-platform key + shape.
    const manual = wireServer({
      serverId: 'codegraph',
      registry,
      entries: registry.entries,
      npxEntries: registry.npxEntries,
      projectRoot,
      home,
      location,
      approved,
      dryRun,
      binPath: cli.bin,
      fallbackCommand: 'codegraph',
      skipHarnesses: selected.filter((d) => d.spec.codegraphTarget).map((d) => d.id),
      targets: selected.map((d) => d.id),
    });
    for (const w of manual.wired) {
      report.wiring.manual.push({ harness: w.harness, path: w.path, key: w.key, ...w });
      if (w.status === 'error') report.ok = false;
    }
    report.wiring.skipped.push(...manual.skipped);

    // Fall back to our writer when the native install failed.
    const nativeFailed = report.wiring.native.some((n) => n.status === 'failed');
    if (nativeFailed && !dryRun) {
      const fallback = wireServer({
        serverId: 'codegraph',
        registry,
        entries: registry.entries,
        npxEntries: registry.npxEntries,
        projectRoot,
        home,
        location,
        approved,
        dryRun,
        binPath: cli.bin,
        fallbackCommand: 'codegraph',
        skipHarnesses: selected.filter((d) => !d.spec.codegraphTarget).map((d) => d.id),
      });
      for (const w of fallback.wired) {
        report.wiring.manual.push({ harness: w.harness, path: w.path, key: w.key, fallback: true, ...w });
      }
    }
    return selected;
  };

  /** Index the project: `codegraph init` builds `.codegraph/` + the first graph. */
  const initIndex = async (cli) => {
    const codegraphDir = join(projectRoot, '.codegraph');
    if (existsSync(codegraphDir)) {
      report.index.action = 'already-indexed';
      const st = run(cli.bin ?? 'codegraph', ['status', projectRoot, '--json'], { timeout: 60000, env });
      if (st.ok) {
        try {
          const parsed = JSON.parse(st.stdout);
          report.index.files = parsed.files ?? parsed.fileCount ?? parsed.totalFiles ?? null;
          report.index.detail = parsed.status ?? null;
        } catch {
          /* status shape is informational only */
        }
      }
      return;
    }
    if (dryRun) {
      report.index.action = 'would-index';
      return;
    }
    // Official indexing command: creates .codegraph/ AND builds the graph.
    const r = await runAsync(cli.bin ?? 'codegraph', ['init', projectRoot], { timeout: 900000, env });
    if (!r.ok) {
      report.index.action = 'failed';
      report.index.detail = (r.stderr || r.stdout || 'codegraph init failed').trim().split('\n')[0];
      report.ok = false;
      return;
    }
    report.index.action = 'indexed';
    report.index.initialized = true;
    const st = run(cli.bin ?? 'codegraph', ['status', projectRoot, '--json'], { timeout: 60000, env });
    if (st.ok) {
      try {
        const parsed = JSON.parse(st.stdout);
        report.index.files = parsed.files ?? parsed.fileCount ?? parsed.totalFiles ?? null;
        report.index.detail = parsed.status ?? null;
      } catch {
        /* informational */
      }
    }
  };

  const applyTelemetry = async (cli) => {
    const state = telemetryState(cli.bin);
    report.telemetry.state = state;
    if (telemetry === 'keep' || !cli.bin) return;
    if (telemetry === state) {
      report.telemetry.action = 'unchanged';
      return;
    }
    if (dryRun) {
      report.telemetry.action = 'would-set-' + telemetry;
      return;
    }
    const r = run(cli.bin, ['telemetry', telemetry], { timeout: 30000, env });
    report.telemetry.action = r.ok ? 'set-' + telemetry : 'failed';
    if (!r.ok) report.telemetry.detail = (r.stderr || '').trim().split('\n')[0];
  };

  if (mode === 'status') {
    const cli = findCodegraph(env);
    report.cli.present = Boolean(cli);
    report.cli.bin = cli?.bin ?? null;
    report.cli.version = cli?.version ?? null;
    // Official freshness check — reports what "latest" means today, no pin.
    if (cli) {
      const chk = await runAsync(cli.bin, ['upgrade', '--check'], { timeout: 120000, env });
      const m = /latest\s+v?([0-9][^\s]*)/i.exec((chk.stdout ?? '') + (chk.stderr ?? ''));
      report.cli.latest = m ? m[1] : null;
    }
    report.telemetry.state = telemetryState(cli?.bin ?? null);
    const detected = detectHarnesses(registry, projectRoot, home, env);
    report.detected = detected.map((d) => d.id);
    for (const d of detected) {
      for (const cfg of Object.values(d.spec.configs ?? {})) {
        if (cfg.format === 'toml') continue;
        const absPath = cfg.path.startsWith('~') ? join(home, cfg.path.slice(2)) : join(projectRoot, cfg.path);
        const { data, existed, error } = readConfig(absPath);
        if (!existed) continue;
        const bucket = data && typeof data === 'object' ? data[cfg.key] : null;
        const wired = bucket && typeof bucket === 'object' && Boolean(bucket.codegraph);
        report.wiring.manual.push({
          harness: d.id,
          path: absPath,
          key: cfg.key,
          status: error ? 'not-parseable' : wired ? 'wired' : 'present-no-codegraph',
          detail: error ? `left untouched: ${error}` : undefined,
        });
      }
    }
    report.index.action = existsSync(join(projectRoot, '.codegraph')) ? 'indexed' : 'not-indexed';
  } else if (mode === 'init') {
    const cli = await ensureCli();
    await applyTelemetry(cli);
    await initIndex(cli);
  } else if (mode === 'wire') {
    // WIRE ONLY. It resolves the binary (so the config can point at it) but
    // never installs, never upgrades and never writes a global setting: a
    // wiring request is a request to change the MCP CONFIGS.
    const cli = await ensureCli({ install: false });
    const detected = await wireHarnesses(cli);
    report.detected = detected.map((d) => d.id);
  } else {
    // ensure — install the CLI if it is MISSING (an installed one is left
    // exactly as it is), wire the configs, and index the project.
    const cli = await ensureCli();
    await applyTelemetry(cli);
    const detected = await wireHarnesses(cli);
    if (mode === 'ensure') {
      if (!approved && !dryRun) {
        // Without approval: print the plan, write no MCP config. The CLI
        // itself is still installed if it was missing (a program, not a user
        // config); an existing one is never touched.
        report.ok = true;
        report.planned = true;
        report.index.action = 'would-index';
      } else {
        await initIndex(cli);
      }
    }
    report.detected = detected.map((d) => d.id);
  }

  // Record what was written so uninstall can remove exactly those entries.
  const written = report.wiring.manual.filter((w) => w.status === 'written');
  if (written.length) {
    recordWiring(
      projectRoot,
      'codegraph',
      written.map((w) => ({ harness: w.harness, location: w.location ?? 'project', path: w.path, key: w.key })),
    );
  }

  return report;
}

/** Read + parse a JSON config; null when absent, {error} when unparseable. */
function readConfig(abs) {
  if (!existsSync(abs)) return { data: null, existed: false };
  try {
    return { data: JSON.parse(readFileSync(abs, 'utf8')), existed: true };
  } catch (e) {
    return { data: null, existed: true, error: e.message };
  }
}

/** Validate the location argument. */
export function assertLocation(location) {
  if (!['global', 'project', 'both'].includes(location)) {
    throw invalidInput(`location must be global|project|both`, { location });
  }
  return location;
}
