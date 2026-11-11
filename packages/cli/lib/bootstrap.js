// bootstrap.js — the install-time server bootstrap for `archgen init` /
// `archgen install`.
//
// The CLI used to shell out to the skill's scripts/codegraph.mjs. That script
// no longer exists: ALL deterministic capability now lives in the archgen MCP
// server, so the CLI drives THAT instead. One implementation, two ways in
// (agent -> MCP stdio, CLI -> `archgen-mcp bootstrap`).
//
// The bootstrap does two things in one pass:
//   1. wires the archgen MCP entry into every detected harness
//   2. ensures CodeGraph: its CLI, its MCP entry, and the project index
//
// NEVER FATAL: no npm, no network, a read-only config, or a missing MCP
// server must still leave a working skill install. Failures are REPORTED to
// the caller (ok:false + detail) and rendered as a warning by it — never
// thrown, and never swallowed.
import { bootstrapMcp, resolveMcpBinary } from './mcp-server.js';
import { ensureGlobalServer, serverVersion } from './global-server.js';

/**
 * @param {{
 *   projectDir: string,
 *   packageRoot?: string,
 *   location?: 'project'|'global'|'both',
 *   log?: (line: string) => void,
 *   env?: Record<string, string|undefined>,
 *   noCodegraph?: boolean,
 *   noMcp?: boolean,
 *   global?: boolean,
 * }} opts
 * @returns {{ok: boolean, skipped?: string, detail?: string, report?: any}}
 */
export function bootstrapServers(opts) {
  const {
    projectDir,
    packageRoot = null,
    location = 'both',
    log = () => {},
    env = process.env,
    noCodegraph = false,
    noMcp = false,
    global = true,
  } = opts;

  // ARCHGEN_CODEGRAPH=0 skips the bootstrap (no spawn, no network, no writes)
  // — without it the test suite would wire the developer's real MCP configs.
  if (env.ARCHGEN_CODEGRAPH === '0' || env.ARCHGEN_CODEGRAPH === 'off') {
    return { ok: true, skipped: 'ARCHGEN_CODEGRAPH=0 (bootstrap disabled)' };
  }
  if (noMcp && noCodegraph) {
    return { ok: true, skipped: '--no-mcp and --no-codegraph passed' };
  }

  // ONE server for every harness. A global install gives every harness the
  // same binary at a stable path, so a harness config can name an absolute
  // executable that keeps working — instead of pointing into npm's npx
  // CACHE, which `npm cache clean` removes out from under it.
  //
  // The server is refreshed to the version THIS CLI ships with: the CLI and
  // the server are released together, so an older server is an older
  // implementation of the very tools the CLI wires.
  //
  // An `ARCHGEN_MCP_BIN` OVERRIDE means the caller has chosen the binary.
  // The global install is then left exactly as it is: upgrading it would
  // mutate a machine-wide install nobody asked for — and for a build that is
  // not published yet the upgrade can only fail.
  let serverNote = '';
  const override = env.ARCHGEN_MCP_BIN;
  if (global && !noMcp && !override) {
    const version = packageRoot ? serverVersion(packageRoot) : 'latest';
    const installed = ensureGlobalServer({ env, version });
    serverNote = installed.note;
    if (installed.detail) serverNote += ` (${installed.detail})`;
  } else if (override) {
    serverNote = 'the global install is untouched — ARCHGEN_MCP_BIN names the server to use';
  }

  const resolved = resolveMcpBinary({ projectRoot: projectDir, env });
  log(`  + mcp server: ${resolved.bin ?? 'npx -y archgen-mcp'} (${resolved.source})`);
  if (serverNote) log(`  + mcp server: ${serverNote}`);

  if (noMcp) {
    log('  ! archgen MCP wiring skipped (--no-mcp)');
  }
  if (noCodegraph) {
    log('  ! CodeGraph bootstrap skipped (--no-codegraph)');
  }

  const r = bootstrapMcp({
    projectRoot: projectDir,
    location,
    approved: true,
    env,
  });

  if (!r.report) {
    // The bootstrap did NOT run: report it as a failure so the caller tells
    // the user. The skill install itself still succeeded — this is a warning,
    // not a fatal error — but it must never be swallowed silently.
    return {
      ok: false,
      detail: `server bootstrap incomplete: ${r.detail ?? 'unknown error'}`,
    };
  }

  const report = r.report;
  const problems = renderBootstrapReport(report, log);
  if (report.alreadyConfigured !== true) {
    log('  + realtime: the MCP server watches files — the index stays live, no re-indexing needed');
  }

  const codegraph = report.codegraph ?? {};
  if (r.ok === false || codegraph.ok === false || problems.length) {
    return {
      ok: false,
      report,
      detail: r.detail
        ? `server bootstrap incomplete: ${r.detail}`
        : `server bootstrap incomplete: ${problems[0] ?? 'one or more server bootstrap steps failed'}`,
    };
  }
  return { ok: true, report };
}

/**
 * Render a bootstrap report as human-readable lines.
 *
 * The CLI and the server are released together, but the global server refresh
 * is best-effort: an OLDER server can still answer `bootstrap`. So this
 * renderer accepts BOTH shapes — the historical per-config `wired` array and
 * the compact counts (`written` / `unchanged` / `planned`) — and never assumes
 * a block exists. A fully configured project answers with the compact no-op
 * shape (`alreadyConfigured`), which earns one line, not a report.
 *
 * @param {any} report the `archgen_setup { action: "bootstrap" }` payload
 * @param {(line: string) => void} [log]
 * @returns {string[]} failures the caller must surface as a warning
 */
export function renderBootstrapReport(report, log = () => {}) {
  const mcp = report.mcp ?? {};
  const codegraph = report.codegraph ?? {};
  const problems = [];

  if (report.alreadyConfigured === true) {
    const parts = ['already configured — nothing to change'];
    if (typeof mcp.wired === 'number') parts.push(`mcp wired in ${mcp.wired} config${mcp.wired === 1 ? '' : 's'}`);
    if (codegraph.version) parts.push(`codegraph ${codegraph.version}${codegraph.indexed ? ' (indexed)' : ''}`);
    log(`  + ${parts.join(' · ')}`);
    return problems;
  }

  // MCP wiring: the historical shape is an array of rows; the compact shape
  // is counts. Both are valid answers from a server this CLI may meet.
  if (Array.isArray(mcp.wired)) {
    for (const w of mcp.wired) {
      if (w.status === 'error' || w.status === 'failed') {
        problems.push(`harness ${w.harness}: ${w.detail ?? 'wiring failed'}`);
        continue;
      }
      // A skipped config is still missing the server. The historical shape
      // reports it as a row, so it must be surfaced here too — the new
      // `skipped` bucket is not the only way a server can say "not wired".
      if (w.status === 'skipped') {
        log(`  ! harness: ${w.harness} → ${w.path} skipped${w.detail ? ' — ' + w.detail : ''}`);
        problems.push(`harness ${w.harness}: ${w.detail ?? 'config skipped'}`);
        continue;
      }
      log(`  + harness: ${w.harness} → ${w.path} [${w.key}] ${w.status}${w.detail ? ' — ' + w.detail : ''}`);
    }
  } else {
    const counts = [
      mcp.written ? `${mcp.written} written` : '',
      mcp.unchanged ? `${mcp.unchanged} already wired` : '',
      mcp.planned ? `${mcp.planned} planned` : '',
    ].filter(Boolean);
    if (counts.length) log(`  + mcp: ${counts.join(', ')}`);
  }
  for (const f of mcp.failed ?? []) {
    problems.push(`harness ${f.harness}: ${f.detail ?? 'wiring failed'}`);
  }
  for (const s of mcp.skipped ?? []) {
    log(`  ! harness: ${s.harness} → ${s.path} skipped${s.detail ? ' — ' + s.detail : ''}`);
    problems.push(`harness ${s.harness}: ${s.detail ?? 'config skipped'}`);
  }

  if (codegraph.cli) {
    log(
      `  + codegraph ${codegraph.cli.version ?? 'unknown'}${codegraph.cli.action && codegraph.cli.action !== 'none' ? ' (' + codegraph.cli.action + ')' : ''}${codegraph.cli.latest ? ' · latest available ' + codegraph.cli.latest : ''}`,
    );
  } else if (codegraph.installed === true) {
    // Compact no-op shape: no cli/wiring/index blocks, just the facts.
    log(
      `  + codegraph ${codegraph.version ?? 'installed'} · ${codegraph.indexed ? 'index ready' : 'not indexed'}` +
        (typeof codegraph.wired === 'number' ? ` · wired in ${codegraph.wired} config${codegraph.wired === 1 ? '' : 's'}` : ''),
    );
  }
  if (codegraph.telemetry) {
    log(`  + telemetry: ${codegraph.telemetry.state ?? 'unknown'}${codegraph.telemetry.action && codegraph.telemetry.action !== 'none' ? ' → ' + codegraph.telemetry.action : ''}`);
  }
  for (const w of codegraph.wiring?.native ?? []) {
    log(`  + harness: ${w.targets} (${w.location}) → ${w.status}${w.detail ? ' — ' + w.detail : ''}`);
    if (w.status === 'failed') problems.push(`codegraph install for ${w.targets} (${w.location}) failed${w.detail ? ': ' + w.detail : ''}`);
  }
  for (const w of codegraph.wiring?.manual ?? []) {
    log(`  + harness: ${w.harness} → ${w.path} [${w.key}] ${w.status}${w.detail ? ' — ' + w.detail : ''}`);
    if (w.status === 'error' || w.status === 'skipped') {
      problems.push(`codegraph wiring for ${w.harness}: ${w.detail ?? w.status}`);
    }
  }
  if (codegraph.index) {
    log(`  + index: ${codegraph.index.action ?? 'none'}${codegraph.index.files != null ? ' (' + codegraph.index.files + ' files)' : ''}`);
  }
  return problems;
}
