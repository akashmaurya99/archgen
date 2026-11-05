// codegraph.js — CodeGraph bootstrap for `archgen init` / `archgen install`.
// Delegates to the skill's scripts/codegraph.mjs (CLI and agent then behave
// identically): install the CLI if missing, wire every DETECTED harness, and
// run `codegraph init` (the server's watcher keeps the index live afterwards).
// NEVER FATAL: no npm, no network or a read-only config must still leave a
// working skill install — failures are reported, never thrown.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/** @returns {{ok: boolean, skipped?: string, detail?: string}} */
export function bootstrapCodegraph({ source, projectDir, location = 'both', log = () => {}, env = process.env, noCodegraph = false } = {}) {
  // ARCHGEN_CODEGRAPH=0 skips the bootstrap (no spawn, no network, no writes)
  // — without it the test suite would wire the developer's real MCP configs.
  if (env.ARCHGEN_CODEGRAPH === '0' || env.ARCHGEN_CODEGRAPH === 'off') {
    return { ok: true, skipped: 'ARCHGEN_CODEGRAPH=0 (bootstrap disabled)' };
  }
  if (noCodegraph) return { ok: true, skipped: '--no-codegraph passed' };
  const script = join(source, 'scripts', 'codegraph.mjs');
  if (!existsSync(script)) {
    return { ok: true, skipped: 'scripts/codegraph.mjs not present in this skill payload (older skill)' };
  }
  let r;
  try {
    r = spawnSync(
      process.execPath,
      [script, 'ensure', '--project', projectDir, '--location', location, '--yes', '--json'],
      { encoding: 'utf8', timeout: 600_000, env, cwd: projectDir },
    );
  } catch (e) {
    return { ok: false, detail: String(e?.message ?? e) };
  }
  if (r.error) return { ok: false, detail: String(r.error.message ?? r.error) };
  if (r.stdout) {
    // Print the structured report as readable lines (keeps JSON out of the
    // console for humans).
    try {
      const out = JSON.parse(r.stdout);
      if (out.cli?.present) log(`  + codegraph ${out.cli.version}${out.cli.action !== 'present' ? ' (' + out.cli.action + ')' : ''}${out.cli.latest ? ' · latest available ' + out.cli.latest : ''}`);
      else log(`  ! codegraph not installed${out.cli?.detail ? ' — ' + out.cli.detail : ''}`);
      log(`  + telemetry: ${out.telemetry?.state ?? 'unknown'}${out.telemetry?.action !== 'none' ? ' → ' + out.telemetry.action : ''}`);
      for (const w of out.wiring?.native ?? []) log(`  + harness: ${w.targets} (${w.location}) → ${w.status}${w.detail ? ' — ' + w.detail : ''}`);
      for (const w of out.wiring?.manual ?? []) log(`  + harness: ${w.harness} → ${w.path} [${w.key}] ${w.status}${w.detail ? ' — ' + w.detail : ''}`);
      log(`  + index: ${out.index?.action ?? 'none'}${out.index?.files != null ? ' (' + out.index.files + ' files)' : ''}`);
      log('  + realtime: the MCP server watches files — the index stays live, no re-indexing needed');
      if (out.ok === false) return { ok: false, detail: 'one or more codegraph steps failed' };
      return { ok: true };
    } catch {
      for (const line of r.stdout.split('\n')) if (line.trim()) log('  ' + line);
      return { ok: r.status === 0 };
    }
  }
  if (r.stderr) log('  ! codegraph bootstrap: ' + r.stderr.trim().split('\n')[0]);
  return { ok: r.status === 0 };
}
