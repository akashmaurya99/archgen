#!/usr/bin/env node
// codegraph.mjs — install/wire/index CodeGraph for archgen, idempotently.
//
//   node codegraph.mjs ensure [--project <dir>] [--location global|project|both]
//                             [--target <ids>] [--yes] [--dry-run] [--json]
//                             [--telemetry keep|off|on] [--no-upgrade] [--no-install]
//   node codegraph.mjs init|wire|status [dir] [--json]
//
// ensure: install CLI if missing → wire every DETECTED harness → index the
// project. The MCP server's watcher keeps the index live afterwards.
//
// SAFETY: MCP configs are written only with --yes (otherwise the plan is
// printed); non-JSON configs are reported, never rewritten.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = 'usage: codegraph.mjs <ensure|init|wire|status> [dir] [--project <dir>] [--location global|project|both] [--target <ids>] [--yes] [--dry-run] [--json] [--telemetry keep|off|on] [--no-upgrade]';
const PACKAGE = '@colbymchenry/codegraph';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

function die(msg, code = 2) { console.error(`codegraph: ${msg}`); process.exit(code); }

// --- arguments ---------------------------------------------------------------
const argv = process.argv.slice(2);
const mode = argv[0] ?? 'ensure';
if (!['ensure', 'init', 'wire', 'status'].includes(mode)) die(`${USAGE} — unknown mode '${mode}'`);
const opts = {
  dir: null,
  project: null,
  location: 'both',
  targets: null,
  yes: false,
  dryRun: false,
  json: false,
  telemetry: 'keep',
  noUpgrade: false,
  noInstall: false,
};
const positional = [];
for (let i = 1; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--project') opts.project = argv[++i];
  else if (a === '--location') opts.location = argv[++i];
  else if (a === '--target') opts.targets = argv[++i];
  else if (a === '--yes') opts.yes = true;
  else if (a === '--dry-run') opts.dryRun = true;
  else if (a === '--json') opts.json = true;
  else if (a === '--telemetry') opts.telemetry = argv[++i];
  else if (a === '--no-upgrade') opts.noUpgrade = true;
  else if (a === '--no-install') opts.noInstall = true;
  else if (a.startsWith('--')) die(`${USAGE} — unknown option '${a}'`);
  else positional.push(a);
}
if (opts.project === undefined || opts.location === undefined || opts.targets === undefined || opts.telemetry === undefined) {
  die(`${USAGE} — --project/--location/--target/--telemetry require a value`);
}
if (!['global', 'project', 'both'].includes(opts.location)) die(`${USAGE} — --location must be global|project|both`);
if (!['keep', 'off', 'on'].includes(opts.telemetry)) die(`${USAGE} — --telemetry must be keep|off|on`);
if (positional.length > 1) die(`${USAGE} — unexpected extra argument '${positional[1]}'`);
if (positional[0]) opts.dir = resolve(positional[0]);

const projectRoot = resolve(opts.project ?? opts.dir ?? process.cwd());

// --- registry ----------------------------------------------------------------
function loadRegistry() {
  const candidates = [
    join(SCRIPT_DIR, '..', 'assets', 'harness-mcp.json'), // installed skill layout
    join(SCRIPT_DIR, '..', '..', '..', 'skill', 'assets', 'harness-mcp.json'), // repo layout
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      try { return JSON.parse(readFileSync(c, 'utf8')); }
      catch (e) { die(`harness registry at ${c} is not valid JSON: ${e.message}`); }
    }
  }
  die('harness registry not found (assets/harness-mcp.json)');
}
const registry = loadRegistry();

/** THE APPROVAL GATE: MCP configs are only written when the caller passed
 *  --yes (or --dry-run, which writes nothing but still reports the plan). */
const ALLOW_WRITE = opts.yes;

// --- process helpers ---------------------------------------------------------
/** Run a command; never throws. Returns {ok, status, stdout, stderr}. */
function run(cmd, args, { timeout = 120000, cwd, env } = {}) {
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
function which(bin) {
  const exts = process.platform === 'win32' ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  const dirs = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const d of dirs) {
    for (const ext of exts) {
      const p = join(d, bin + ext);
      try { if (statSync(p).isFile()) return p; } catch { /* not here */ }
    }
  }
  return null;
}

/** Resolve the codegraph CLI: absolute path + version, or null. */
function findCodegraph() {
  const bin = which('codegraph');
  if (!bin) return null;
  const v = run(bin, ['--version'], { timeout: 20000 });
  const version = (v.stdout || v.stderr).trim().split('\n')[0] || 'unknown';
  return { bin, version };
}

// npm via its JS entry point: an unshelled .cmd shim fails with EINVAL on
// Windows since the CVE-2024-27980 hardening.
function npmInvocation(npmArgs) {
  const fromEnv = process.env.npm_execpath;
  if (typeof fromEnv === 'string' && fromEnv.endsWith('.js') && existsSync(fromEnv)) {
    return { command: process.execPath, args: [fromEnv, ...npmArgs], shell: false };
  }
  const isWin = process.platform === 'win32';
  return { command: isWin ? 'npm.cmd' : 'npm', args: npmArgs, shell: isWin };
}

// --- telemetry ---------------------------------------------------------------
/** Current telemetry state: 'enabled' | 'disabled' | 'unknown'. */
function telemetryState(bin) {
  if (!bin) return 'unknown';
  const r = run(bin, ['telemetry', 'status'], { timeout: 20000 });
  if (!r.ok) return 'unknown';
  const out = (r.stdout + r.stderr).toLowerCase();
  if (out.includes('enabled')) return 'enabled';
  if (out.includes('disabled')) return 'disabled';
  return 'unknown';
}

// --- harness detection -------------------------------------------------------
const home = homedir();
function expandHome(p) {
  return p.startsWith('~/') ? join(home, p.slice(2)) : p;
}

/** Detect which harnesses are present in this environment. */
function detectHarnesses() {
  const found = [];
  for (const [id, h] of Object.entries(registry.harnesses)) {
    const atHome = (h.detectHome ?? []).some((m) => existsSync(join(home, m)));
    const atProject = (h.detectProject ?? []).some((m) => existsSync(join(projectRoot, m)));
    if (atHome || atProject) found.push({ id, label: h.label, atHome, atProject, spec: h });
  }
  return found;
}

// --- config writing ----------------------------------------------------------
/** Read + parse a JSON config; null when absent, {error} when unparseable. */
function readJsonConfig(abs) {
  if (!existsSync(abs)) return { data: null, existed: false };
  try {
    return { data: JSON.parse(readFileSync(abs, 'utf8')), existed: true };
  } catch (e) {
    return { data: null, existed: true, error: e.message };
  }
}

/** Build the server entry for a harness, substituting the resolved binary path. */
function buildEntry(spec, entryKey, binPath) {
  const source = binPath ? registry.entries[entryKey] : registry.npxEntries[entryKey];
  const entry = JSON.parse(JSON.stringify(source));
  const command = binPath ?? 'codegraph';
  if (Array.isArray(entry.command)) entry.command = [command, ...entry.command.slice(1)];
  else entry.command = command;
  return entry;
}

/**
 * Merge the codegraph entry into a JSON MCP config.
 * @returns {{status:'written'|'unchanged'|'skipped'|'planned'|'error', detail?:string, path?:string}}
 */
function writeJsonConfig(abs, key, entry, dryRun) {
  const { data, existed, error } = readJsonConfig(abs);
  if (error) {
    // A file we cannot parse is never rewritten.
    return { status: 'skipped', detail: `not valid JSON (${error}) — left untouched`, path: abs };
  }
  const obj = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const bucket = obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key]) ? obj[key] : {};
  const existing = bucket.codegraph;
  if (existing && JSON.stringify(existing) === JSON.stringify(entry)) {
    return { status: 'unchanged', path: abs };
  }
  // Approval gate: without --yes nothing is written.
  if (dryRun || !ALLOW_WRITE) {
    return { status: 'planned', detail: dryRun ? 'would write (dry-run)' : 'would write (needs --yes)', path: abs };
  }
  bucket.codegraph = entry;
  obj[key] = bucket;
  try {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  } catch (e) {
    return { status: 'error', detail: e.message, path: abs };
  }
  return { status: 'written', path: abs, detail: existed ? 'updated' : 'created' };
}

// --- actions -----------------------------------------------------------------
const report = {
  mode,
  projectRoot,
  cli: { present: false, version: null, bin: null, latest: null, action: 'none' },
  telemetry: { state: 'unknown', action: 'none' },
  wiring: { native: [], manual: [], skipped: [] },
  index: { initialized: false, action: 'none', files: null, detail: null },
  realtime: { watcher: true, note: 'codegraph serve --mcp runs a file watcher: the index stays in sync automatically while the MCP server runs' },
  ok: true,
};

/** Install CodeGraph when missing; upgrade to the latest published version. */
function ensureCli() {
  let found = findCodegraph();
  if (!found) {
    if (opts.noInstall) {
      // Caller manages the CLI — fall back to the npx form in the MCP config.
      report.cli.action = 'absent';
      report.cli.detail = `not installed and --no-install was passed — the MCP config will use "npx -y ${PACKAGE} serve --mcp"`;
      return { bin: null, version: null };
    }
    if (opts.dryRun) {
      report.cli.action = 'would-install';
      return { bin: null, version: null };
    }
    // Official install path; always the latest published release.
    const inv = npmInvocation(['install', '-g', PACKAGE]);
    const r = run(inv.command, inv.args, { timeout: 600000, shell: inv.shell });
    found = findCodegraph();
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

  if (opts.noUpgrade) return found;

  // Freshness via the official updater (no-op when already current).
  const chk = run(found.bin, ['upgrade', '--check'], { timeout: 120000 });
  const m = /latest\s+v?([0-9][^\s]*)/i.exec((chk.stdout ?? '') + (chk.stderr ?? ''));
  report.cli.latest = m ? m[1] : null; // informational only
  if (opts.dryRun) {
    report.cli.action += '+upgrade';
    return found;
  }
  const up = run(found.bin, ['upgrade'], { timeout: 600000 });
  const after = findCodegraph();
  if (after) {
    report.cli.version = after.version;
    report.cli.bin = after.bin;
    report.cli.action += /already up to date/i.test(up.stdout ?? '') ? '+current' : '+upgraded';
  } else {
    report.cli.action += '+upgrade-failed';
    report.ok = false;
  }
  return found;
}

/** Wire the MCP server into every detected harness. */
function wireHarnesses(cli) {
  const detected = detectHarnesses();
  const wanted = opts.targets
    ? opts.targets.split(',').map((s) => s.trim()).filter(Boolean)
    : detected.map((d) => d.id);
  const selected = detected.filter((d) => wanted.includes(d.id));

  const nativeIds = [];
  for (const d of selected) {
    const target = d.spec.codegraphTarget;
    if (!target) continue;
    // Prefer codegraph's own installer: it knows each platform's exact shape.
    if (opts.location === 'project') {
      if (d.atProject) nativeIds.push(target);
    } else if (opts.location === 'global') {
      if (d.atHome) nativeIds.push(target);
    } else {
      if (d.atHome || d.atProject) nativeIds.push(target);
    }
  }

  const uniqueNative = [...new Set(nativeIds)];
  if (uniqueNative.length) {
    const locations = opts.location === 'both' ? ['global', 'local'] : [opts.location === 'project' ? 'local' : 'global'];
    for (const loc of locations) {
      if (opts.dryRun || !ALLOW_WRITE) {
        report.wiring.native.push({ targets: uniqueNative.join(','), location: loc, status: 'planned' });
        continue;
      }
      const r = run(cli.bin ?? 'codegraph', ['install', `--target=${uniqueNative.join(',')}`, `--location=${loc}`, '--yes'], {
        timeout: 120000,
        // CRITICAL: the installer resolves local config paths from CWD — it
        // must run in the project root or it writes into the wrong project.
        cwd: loc === 'local' ? projectRoot : undefined,
      });
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
  for (const d of selected) {
    if (d.spec.codegraphTarget) continue;
    const configs = d.spec.configs ?? {};
    const wantedLocations = opts.location === 'both' ? ['global', 'project'] : [opts.location];
    for (const loc of wantedLocations) {
      const cfg = configs[loc];
      if (!cfg) continue;
      if (loc === 'global' && !d.atHome) continue;
      if (loc === 'project' && !d.atProject) continue;
      const absPath = cfg.path.startsWith('~') ? expandHome(cfg.path) : join(projectRoot, cfg.path);
      const entry = buildEntry(d.spec, cfg.entry, cli.bin);
      const res = writeJsonConfig(absPath, cfg.key, entry, opts.dryRun);
      report.wiring.manual.push({ harness: d.id, path: absPath, key: cfg.key, ...res });
      if (res.status === 'error') report.ok = false;
    }
  }

  // Fall back to our writer when the native install failed.
  const nativeFailed = report.wiring.native.some((n) => n.status === 'failed');
  if (nativeFailed && !opts.dryRun) {
    for (const d of selected) {
      if (!d.spec.codegraphTarget) continue;
      const configs = d.spec.configs ?? {};
      for (const loc of ['global', 'project']) {
        const cfg = configs[loc];
        if (!cfg || cfg.format === 'toml') continue;
        if (loc === 'global' && !d.atHome) continue;
        if (loc === 'project' && !d.atProject) continue;
        const absPath = cfg.path.startsWith('~') ? expandHome(cfg.path) : join(projectRoot, cfg.path);
        const entry = buildEntry(d.spec, cfg.entry, cli.bin);
        const res = writeJsonConfig(absPath, cfg.key, entry, opts.dryRun);
        report.wiring.manual.push({ harness: d.id, path: absPath, key: cfg.key, fallback: true, ...res });
      }
    }
  }
  return selected;
}

/** Index the project: `codegraph init` builds `.codegraph/` + the first graph. */
function initIndex(cli) {
  const codegraphDir = join(projectRoot, '.codegraph');
  if (existsSync(codegraphDir)) {
    report.index.action = 'already-indexed';
    const st = run(cli.bin ?? 'codegraph', ['status', projectRoot, '--json'], { timeout: 60000 });
    if (st.ok) {
      try {
        const parsed = JSON.parse(st.stdout);
        report.index.files = parsed.files ?? parsed.fileCount ?? parsed.totalFiles ?? null;
        report.index.detail = parsed.status ?? null;
      } catch { /* status shape is informational only */ }
    }
    return;
  }
  if (opts.dryRun) {
    report.index.action = 'would-index';
    return;
  }
  // Official indexing command: creates .codegraph/ AND builds the graph.
  const r = run(cli.bin ?? 'codegraph', ['init', projectRoot], { timeout: 900000 });
  if (!r.ok) {
    report.index.action = 'failed';
    report.index.detail = (r.stderr || r.stdout || 'codegraph init failed').trim().split('\n')[0];
    report.ok = false;
    return;
  }
  report.index.action = 'indexed';
  report.index.initialized = true;
  const st = run(cli.bin ?? 'codegraph', ['status', projectRoot, '--json'], { timeout: 60000 });
  if (st.ok) {
    try {
      const parsed = JSON.parse(st.stdout);
      report.index.files = parsed.files ?? parsed.fileCount ?? parsed.totalFiles ?? null;
      report.index.detail = parsed.status ?? null;
    } catch { /* informational */ }
  }
}

function applyTelemetry(cli) {
  const state = telemetryState(cli.bin);
  report.telemetry.state = state;
  if (opts.telemetry === 'keep' || !cli.bin) return;
  if (opts.telemetry === state) { report.telemetry.action = 'unchanged'; return; }
  if (opts.dryRun) { report.telemetry.action = 'would-set-' + opts.telemetry; return; }
  const r = run(cli.bin, ['telemetry', opts.telemetry], { timeout: 30000 });
  report.telemetry.action = r.ok ? 'set-' + opts.telemetry : 'failed';
  if (!r.ok) report.telemetry.detail = (r.stderr || '').trim().split('\n')[0];
}

// --- run ---------------------------------------------------------------------
if (mode === 'status') {
  const cli = findCodegraph();
  report.cli.present = Boolean(cli);
  report.cli.bin = cli?.bin ?? null;
  report.cli.version = cli?.version ?? null;
  // Official freshness check — reports what "latest" means today, no pin.
  if (cli) {
    const chk = run(cli.bin, ['upgrade', '--check'], { timeout: 120000 });
    const m = /latest\s+v?([0-9][^\s]*)/i.exec((chk.stdout ?? '') + (chk.stderr ?? ''));
    report.cli.latest = m ? m[1] : null;
  }
  report.telemetry.state = telemetryState(cli?.bin ?? null);
  const detected = detectHarnesses();
  for (const d of detected) {
    for (const cfg of Object.values(d.spec.configs ?? {})) {
      if (cfg.format === 'toml') continue;
      const absPath = cfg.path.startsWith('~') ? expandHome(cfg.path) : join(projectRoot, cfg.path);
      const { data, existed, error } = readJsonConfig(absPath);
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
    if (!opts.yes && !opts.dryRun) {
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

// --- output ------------------------------------------------------------------
if (opts.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const p = (s = '') => console.log(s);
  p(`codegraph ${mode} — ${projectRoot}`);
  p(`  cli:      ${report.cli.present ? report.cli.version + ' (' + report.cli.bin + ')' : 'not installed'}${report.cli.latest ? ' · latest available ' + report.cli.latest : ''}${report.cli.action !== 'none' ? ' · ' + report.cli.action : ''}`);
  if (report.cli.detail) p(`  cli note: ${report.cli.detail}`);
  p(`  telemetry: ${report.telemetry.state}${report.telemetry.action !== 'none' ? ' · ' + report.telemetry.action : ''}`);
  for (const w of report.wiring.native) p(`  native:   ${w.targets} (${w.location}) → ${w.status}${w.detail ? ' — ' + w.detail : ''}`);
  for (const w of report.wiring.manual) p(`  manual:   ${w.harness} → ${w.path} [${w.key}] ${w.status}${w.detail ? ' — ' + w.detail : ''}${w.fallback ? ' (fallback)' : ''}`);
  p(`  index:    ${report.index.action}${report.index.files != null ? ' (' + report.index.files + ' files)' : ''}${report.index.detail ? ' — ' + report.index.detail : ''}`);
  if (report.planned) {
    p('');
    p('  PLAN ONLY — no MCP config was written and no project index was built.');
    p('  Re-run with --yes to wire the detected harnesses and index this project.');
  }
  p(`  realtime: ${report.realtime.note}`);
  if (!report.ok) p('  ! one or more steps failed — see the notes above');
}

if (!report.ok) process.exit(1);
