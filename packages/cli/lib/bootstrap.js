// bootstrap.js — the install-time server bootstrap for `archgen init` /
// `archgen install`.
//
// The CLI used to shell out to the skill's scripts/codegraph.mjs. That script
// no longer exists: ALL deterministic capability now lives in the archgen MCP
// server, so the CLI drives THAT instead. One implementation, three ways in
// (agent -> MCP stdio, CLI -> `archgen-mcp bootstrap`, extension -> exec).
//
// The bootstrap does two things in one pass:
//   1. wires the archgen MCP entry into every detected harness
//   2. ensures CodeGraph: its CLI, its MCP entry, and the project index
//
// NEVER FATAL: no npm, no network, a read-only config, or a missing MCP
// server must still leave a working skill install. Failures are REPORTED,
// never thrown.
import { bootstrapMcp, resolveMcpBinary } from './mcp-server.js';

/**
 * @param {{
 *   projectDir: string,
 *   location?: 'project'|'global'|'both',
 *   log?: (line: string) => void,
 *   env?: Record<string, string|undefined>,
 *   noCodegraph?: boolean,
 *   noMcp?: boolean,
 * }} opts
 * @returns {{ok: boolean, skipped?: string, detail?: string, report?: any}}
 */
export function bootstrapServers(opts) {
  const {
    projectDir,
    location = 'both',
    log = () => {},
    env = process.env,
    noCodegraph = false,
    noMcp = false,
  } = opts;

  // ARCHGEN_CODEGRAPH=0 skips the bootstrap (no spawn, no network, no writes)
  // — without it the test suite would wire the developer's real MCP configs.
  if (env.ARCHGEN_CODEGRAPH === '0' || env.ARCHGEN_CODEGRAPH === 'off') {
    return { ok: true, skipped: 'ARCHGEN_CODEGRAPH=0 (bootstrap disabled)' };
  }
  if (noMcp && noCodegraph) {
    return { ok: true, skipped: '--no-mcp and --no-codegraph passed' };
  }

  const resolved = resolveMcpBinary({ projectRoot: projectDir, env });
  log(`  + mcp server: ${resolved.bin ?? 'npx -y archgen-mcp'} (${resolved.source})`);

  if (noMcp) {
    log('  ! archgen MCP wiring skipped (--no-mcp)');
  }
  if (noCodegraph) {
    log('  ! CodeGraph bootstrap skipped (--no-codegraph)');
  }

  const r = bootstrapMcp({
    projectDir,
    location,
    approved: true,
    env,
  });

  if (!r.report) {
    return {
      ok: true, // never fatal — the skill install itself succeeded
      detail: `server bootstrap incomplete: ${r.detail ?? 'unknown error'}`,
    };
  }

  const report = r.report;
  const mcp = report.mcp ?? {};
  const codegraph = report.codegraph ?? {};

  for (const w of mcp.wired ?? []) {
    log(`  + harness: ${w.harness} → ${w.path} [${w.key}] ${w.status}${w.detail ? ' — ' + w.detail : ''}`);
  }
  if (codegraph.cli) {
    log(
      `  + codegraph ${codegraph.cli.version ?? 'unknown'}${codegraph.cli.action !== 'none' ? ' (' + codegraph.cli.action + ')' : ''}${codegraph.cli.latest ? ' · latest available ' + codegraph.cli.latest : ''}`,
    );
  }
  if (codegraph.telemetry) {
    log(`  + telemetry: ${codegraph.telemetry.state ?? 'unknown'}${codegraph.telemetry.action !== 'none' ? ' → ' + codegraph.telemetry.action : ''}`);
  }
  for (const w of codegraph.wiring?.native ?? []) {
    log(`  + harness: ${w.targets} (${w.location}) → ${w.status}${w.detail ? ' — ' + w.detail : ''}`);
  }
  if (codegraph.index) {
    log(`  + index: ${codegraph.index.action ?? 'none'}${codegraph.index.files != null ? ' (' + codegraph.index.files + ' files)' : ''}`);
  }
  log('  + realtime: the MCP server watches files — the index stays live, no re-indexing needed');

  if (r.ok === false || codegraph.ok === false) {
    return {
      ok: false,
      report,
      detail: 'one or more server bootstrap steps failed',
    };
  }
  return { ok: true, report };
}
