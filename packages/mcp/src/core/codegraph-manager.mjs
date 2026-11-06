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
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { detectHarnesses, wireServer, recordWiring } from './harness-wiring.mjs';
import { invalidInput } from './errors.mjs';

export const CODEGRAPH_PACKAGE = '@colbymchenry/codegraph';

/** Run a command; never throws. Returns {ok, status, stdout, stderr}. */
export function run(cmd, args, opts = {}) {
  const { timeout = 120000, cwd, env } = opts;
  const r = spawnSync(cmd, args, {
    encoding: 'utf8',
    timeout,
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    shell: false,
    // On Windows the npm/codegraph shims are .cmd files, which need a shell.
    ...(process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd) ? { shell: true } : {}),
  });
  if (r.error) return { ok: false, status: -1, stdout: '', stderr: String(r.error.message ?? r.error) };
  return { ok: r.status === 0, status: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
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
 *   noUpgrade?: boolean,
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
    noUpgrade = false,
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

  /** Install CodeGraph when missing; upgrade to the latest published version. */
  const ensureCli = () => {
    let found = findCodegraph(env);
    if (!found) {
      if (noInstall) {
        // Caller manages the CLI — fall back to the npx form in the MCP config.
        report.cli.action = 'absent';
        report.cli.detail = `not installed and installation was skipped — the MCP config will use "npx -y ${CODEGRAPH_PACKAGE} serve --mcp"`;
        return { bin: null, version: null };
      }
      if (dryRun) {
        report.cli.action = 'would-install';
        return { bin: null, version: null };
      }
      // Official install path; always the latest published release.
      const inv = npmInvocation(['install', '-g', CODEGRAPH_PACKAGE], env);
      const r = run(inv.command, inv.args, { timeout: 600000, shell: inv.shell, env });
      found = findCodegraph(env);
      if (!found) {
        report.cli.action = 'failed';
        report.cli.detail = `global install failed${r.stderr ? `: ${r.stderr.trim().split('\n')[0]}` : ''} — npx fallback will be used in the MCP config`;
        report.ok = false;
        return { bin: null, version: null };
      }
      report.cli.action = 'installed';
    } else {
      report.cli.action = 'present';
    }
    report.cli.present = true;
    report.cli.bin = found.bin;
    report.cli.version = found.version;

    if (noUpgrade) return found;

    // Freshness via the official updater (no-op when already current).
    const chk = run(found.bin, ['upgrade', '--check'], { timeout: 120000, env });
    const m = /latest\s+v?([0-9][^\s]*)/i.exec((chk.stdout ?? '') + (chk.stderr ?? ''));
    report.cli.latest = m ? m[1] : null; // informational only
    if (dryRun) {
      report.cli.action += '+upgrade';
      return found;
    }
    const up = run(found.bin, ['upgrade'], { timeout: 600000, env });
    const after = findCodegraph(env);
    if (after) {
      report.cli.version = after.version;
      report.cli.bin = after.bin;
      report.cli.action += /already up to date/i.test(up.stdout ?? '') ? '+current' : '+upgraded';
    } else {
      report.cli.action += '+upgrade-failed';
      report.ok = false;
    }
    return found;
  };

  /** Wire the MCP server into every detected harness (native + fallback). */
  const wireHarnesses = (cli) => {
    const detected = detectHarnesses(registry, projectRoot, home);
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
        const r = run(
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
  const initIndex = (cli) => {
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
    const r = run(cli.bin ?? 'codegraph', ['init', projectRoot], { timeout: 900000, env });
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

  const applyTelemetry = (cli) => {
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
      const chk = run(cli.bin, ['upgrade', '--check'], { timeout: 120000, env });
      const m = /latest\s+v?([0-9][^\s]*)/i.exec((chk.stdout ?? '') + (chk.stderr ?? ''));
      report.cli.latest = m ? m[1] : null;
    }
    report.telemetry.state = telemetryState(cli?.bin ?? null);
    const detected = detectHarnesses(registry, projectRoot, home);
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
    const cli = ensureCli();
    applyTelemetry(cli);
    initIndex(cli);
  } else {
    // ensure | wire
    const cli = ensureCli();
    applyTelemetry(cli);
    const detected = wireHarnesses(cli);
    if (mode === 'ensure') {
      if (!approved && !dryRun) {
        // Without approval: print the plan, write no MCP config. The CLI itself
        // is still installed/upgraded (a program, not a user config).
        report.ok = true;
        report.planned = true;
        report.index.action = 'would-index';
      } else {
        initIndex(cli);
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
