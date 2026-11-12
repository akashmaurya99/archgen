// cli.mjs — the command-line facade over the MCP server.
//
// WHY A CLI FACADE: two consumers need the same capability, and they must
// never drift apart:
//   - agents          -> MCP over stdio
//   - the CLI installer -> `archgen-mcp bootstrap`
//
// `exec` runs the SAME tool handlers the MCP server exposes — there is no
// second implementation of any capability, only a second way to reach it.
//
// Commands:
//   serve                              (default) the stdio MCP server
//   exec <tool> '<json-args>'          run one tool, print the envelope as JSON
//   bootstrap [--project <dir>]         wire the archgen MCP + ensure CodeGraph
//   doctor [--project <dir>]            health report
//   uninstall-mcp [--project <dir>]     remove the archgen MCP entries
import { Context } from './context.mjs';
import { createServer } from './server.mjs';
import { getToolSpec, registeredToolNames, runTool } from './tools/_register.mjs';
import { loadAsset } from './context.mjs';
import { uninstallArchgenMcp, archgenMcpStatus } from './core/mcp-server-manager.mjs';
import { assertLocation, findCodegraph } from './core/codegraph-manager.mjs';
import { detectHarnesses } from './core/harness-wiring.mjs';

const USAGE = `archgen-mcp — MCP server for archgen

Usage:
  archgen-mcp                                  serve the MCP server over stdio (default)
  archgen-mcp exec <tool> '<json-args>'        run one tool, print JSON
  archgen-mcp bootstrap [--project <dir>]      wire the archgen MCP + ensure CodeGraph
  archgen-mcp doctor [--project <dir>]         health report
  archgen-mcp uninstall-mcp [--project <dir>]  remove the archgen MCP entries

Options:
  --project <dir>   project root (default: current directory)
  --location <s>    project | global | both (default: both)
  --yes             approve MCP-config writes
  --json            machine-readable output
  --tool <name>     list a tool's schema
  --fail-on <p>:<v> exit 3 when the tool result matches (e.g. verdict:ISSUES) — a build gate
  --list            list every tool
  --catalog         print the injected tool catalog (name + description + JSON schema)

Tools: ${registeredToolNames().join(', ')}`;

/**
 * Parse the CLI arguments.
 * @param {string[]} argv
 */
export function parseArgs(argv) {
  const opts = {
    command: 'serve',
    tool: null,
    args: null,
    failOn: null,
    project: null,
    location: 'both',
    yes: false,
    json: false,
    list: false,
    catalog: false,
  };
  const rest = [...argv];
  const command = rest[0];
  if (command && !command.startsWith('-')) {
    opts.command = command;
    rest.shift();
  }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--project') opts.project = rest[++i];
    else if (a === '--location') opts.location = rest[++i];
    else if (a === '--yes') opts.yes = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--list') opts.list = true;
    else if (a === '--catalog') opts.catalog = true;
    else if (a === '--tool') opts.tool = rest[++i];
    else if (a === '--fail-on') opts.failOn = rest[++i];
    else if (a === '--help' || a === '-h') opts.command = 'help';
    else if (!a.startsWith('-')) {
      if (opts.tool === null && opts.command === 'exec') opts.tool = a;
      else if (opts.args === null) opts.args = a;
      else opts.extra = a;
    }
  }
  return opts;
}

/**
 * Run the CLI facade.
 * @param {string[]} argv
 * @param {{stdout?: (s: string) => void, stderr?: (s: string) => void}} [io]
 * @returns {Promise<number>} the process exit code
 */
/**
 * Does a tool result match a `--fail-on <path>:<value>` rule?
 *
 * The path is resolved inside `data` (dotted; a leading `data.` is accepted
 * and ignored). The value is compared as a string, so `verdict:ISSUES` matches
 * a plan whose verdict is ISSUES — which is what turns the deterministic floor
 * into a CI gate.
 *
 * @param {any} data the envelope's `data`
 * @param {string} rule `<path>:<value>`
 * @returns {boolean}
 */
export function failOnMatches(data, rule) {
  const raw = String(rule ?? '');
  const at = raw.lastIndexOf(':');
  if (at <= 0) return false;
  const path = raw.slice(0, at).trim();
  const value = raw.slice(at + 1).trim();
  if (!path) return false;
  const resolve = (p) => {
    let current = data;
    for (const key of p.split('.').filter(Boolean)) {
      if (current === null || typeof current !== 'object') return undefined;
      current = current[key];
    }
    return current;
  };
  // The path is resolved inside `data`; a leading `data.` is accepted as an
  // alias for the envelope root when the payload has no such key.
  let found = resolve(path);
  if ((found === undefined || found === null) && path.startsWith('data.')) found = resolve(path.slice(5));
  if (found === undefined || found === null) return false;
  return String(found) === value;
}

export async function runCli(argv, io = {}) {
  const out = io.stdout ?? ((s) => process.stdout.write(s + '\n'));
  const err = io.stderr ?? ((s) => process.stderr.write(s + '\n'));
  const opts = parseArgs(argv);

  if (opts.command === 'help') {
    out(USAGE);
    return 0;
  }

  // Register every tool (also populates the spec registry `exec` reads).
  const server = createServer();

  if (opts.list) {
    out(JSON.stringify(registeredToolNames(), null, 2));
    return 0;
  }

  if (opts.catalog) {
    // The EXACT payload a client injects into the model's context for every
    // request: each tool's name, description and JSON schema. The internal
    // token-budget tool measures this, so the catalog cost is budgeted like
    // any other context expense.
    const catalog = registeredToolNames().map((name) => ({
      name,
      description: getToolSpec(name)?.description ?? '',
      inputSchema: server.toolInputSchemaJson(name) ?? null,
    }));
    out(JSON.stringify(catalog, null, 2));
    return 0;
  }

  const ctx = new Context({ projectRoot: opts.project ?? process.cwd() });

  if (opts.command === 'exec') {
    if (!opts.tool) {
      err('exec requires a tool name');
      out(USAGE);
      return 2;
    }
    const spec = getToolSpec(opts.tool);
    if (!spec) {
      err(`unknown tool '${opts.tool}' — known tools: ${registeredToolNames().join(', ')}`);
      return 2;
    }
    if (opts.tool === undefined) return 2;
    let parsed = {};
    if (opts.args) {
      try {
        parsed = JSON.parse(opts.args);
      } catch (e) {
        err(`arguments must be valid JSON: ${e.message}`);
        return 2;
      }
    }
    if (parsed.projectRoot === undefined && opts.project) parsed.projectRoot = opts.project;
    const check = spec.inputSchema.safeParse(parsed);
    if (!check.success) {
      const envelope = {
        ok: false,
        error: { code: 'INVALID_INPUT', message: 'arguments do not match the tool schema', details: { issues: check.error.issues } },
        meta: ctx.meta(),
      };
      out(JSON.stringify(envelope, null, 2));
      return 1;
    }
    // The validated values win, but an argument the schema does not DECLARE
    // is still the CALLER'S — and the tracker reports that the action
    // ignored it. Zod strips unknown keys, so passing `check.data` alone
    // made the CLI blind to exactly what the MCP server warns about.
    const envelope = await runTool(spec, ctx, { ...parsed, ...check.data });
    out(JSON.stringify(envelope, null, 2));
    if (!envelope.ok) return 1;
    // `--fail-on <path>:<value>` turns a tool result into a BUILD GATE.
    //
    // WHY: the deterministic floor was only ever reachable from an agent
    // session. A CI job needs the same answer as an exit code:
    //   archgen-mcp exec archgen_plan '{"action":"verify",...}' --fail-on verdict:ISSUES
    // The path is resolved inside `data`; the value is compared as a string.
    if (opts.failOn) {
      const hit = failOnMatches(envelope.data, opts.failOn);
      if (hit) {
        err(`archgen-mcp exec: --fail-on ${opts.failOn} matched — the gate is not green`);
        return 3;
      }
    }
    return 0;
  }

  const registry = loadAsset('harness-mcp.json');

  if (opts.command === 'bootstrap') {
    // ONE implementation: the CLI runs the SAME handler the agent calls.
    // The old inline composition re-ran the installer and the indexer on
    // every install and answered with the full report — the exact cost the
    // MCP tool's no-op gate exists to remove. Delegating also means the CLI
    // and the tool can never disagree about what "already configured" means.
    const location = assertLocation(opts.location);
    const envelope = await runTool(getToolSpec('archgen_setup'), ctx, {
      action: 'bootstrap',
      location,
      approve: opts.yes,
    });
    const report = envelope.data ?? { ok: false, detail: envelope.error?.message ?? 'bootstrap failed' };
    if (opts.json) {
      out(JSON.stringify(report, null, 2));
    } else if (report.alreadyConfigured === true) {
      const facts = ['already configured — nothing to change'];
      if (typeof report.mcp?.wired === 'number') facts.push(`mcp wired in ${report.mcp.wired} config(s)`);
      if (report.codegraph?.version) facts.push(`codegraph ${report.codegraph.version}`);
      out(`archgen-mcp bootstrap — ${ctx.projectRoot}`);
      out(`  + ${facts.join(' · ')}`);
    } else {
      const mcp = report.mcp ?? {};
      const counts = [
        mcp.written ? `${mcp.written} written` : '',
        mcp.unchanged ? `${mcp.unchanged} already wired` : '',
        mcp.planned ? `${mcp.planned} planned` : '',
      ].filter(Boolean);
      // A server this CLI meets may answer with the historical per-config
      // array instead of counts; render either, never crash on `.map`.
      const rows = Array.isArray(mcp.wired)
        ? mcp.wired.map((w) => `${w.harness}:${w.status}`).join(', ')
        : '';
      out(`archgen-mcp bootstrap — ${ctx.projectRoot}`);
      out(`  mcp:     ${mcp.detected?.length ?? 0} harness(es) detected — ${rows || counts.join(', ') || 'no changes'}`);
      out(`  binary: ${report.mcp?.binary?.bin ?? 'npx fallback'}`);
      const cgVersion = report.codegraph?.cli?.present
        ? report.codegraph.cli.version
        : report.codegraph?.version ?? 'not installed';
      const cgIndex = report.codegraph?.index?.action ?? (report.codegraph?.indexed ? 'already-indexed' : 'none');
      out(`  codegraph: ${cgVersion} · index ${cgIndex}`);
    }
    // A bootstrap that could not write a config is not a success: the
    // handler's `ok` folds in both the MCP and CodeGraph sides.
    return envelope.ok && report.ok !== false && report.codegraph?.ok !== false ? 0 : 1;
  }

  if (opts.command === 'doctor') {
    const status = archgenMcpStatus({ projectRoot: ctx.projectRoot, registry, home: ctx.home, env: ctx.env });
    const codegraph = findCodegraph(ctx.env);
    const report = {
      projectRoot: ctx.projectRoot,
      skill: ctx.skill ? { path: ctx.skill.path, version: ctx.skill.version, scope: ctx.skill.scope } : null,
      server: ctx.serverVersion,
      node: process.versions.node,
      codegraph: codegraph ? { bin: codegraph.bin, version: codegraph.version } : null,
      mcpBinary: status.binary,
      mcpTargets: status.targets,
      harnesses: detectHarnesses(registry, ctx.projectRoot, ctx.home, ctx.env).map((d) => d.id),
    };
    if (opts.json) {
      out(JSON.stringify(report, null, 2));
    } else {
      out(`archgen-mcp doctor — ${ctx.projectRoot}`);
      out(`  node:    ${report.node}`);
      out(`  server:  ${report.server}`);
      out(`  skill:   ${report.skill ? `${report.skill.path} (${report.skill.version ?? 'unknown'})` : 'NOT FOUND'}`);
      out(`  mcp bin: ${report.mcpBinary.bin ?? 'not on PATH (npx fallback)'} (${report.mcpBinary.source})`);
      out(`  codegraph: ${report.codegraph ? report.codegraph.version : 'not installed'}`);
      out(`  harnesses: ${report.harnesses.join(', ') || 'none detected'}`);
    }
    return 0;
  }

  if (opts.command === 'uninstall-mcp') {
    if (!opts.yes) {
      err('uninstall-mcp needs --yes (nothing was removed)');
      return 2;
    }
    const res = uninstallArchgenMcp(ctx.projectRoot, ctx.home, 'both', ctx.env);
    if (opts.json) out(JSON.stringify(res, null, 2));
    else {
      out(`removed ${res.removed.length} config(s)`);
      for (const r of res.removed) out(`  - ${r}`);
      for (const s of res.skipped) out(`  ! ${s}`);
    }
    return 0;
  }

  if (opts.command === 'serve') return null; // the caller connects the transport

  err(`unknown command '${opts.command}'`);
  out(USAGE);
  return 2;
}

