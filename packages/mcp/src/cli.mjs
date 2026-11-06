// cli.mjs — the command-line facade over the MCP server.
//
// WHY A CLI FACADE: three consumers need the same capability, and they must
// never drift apart:
//   - agents          -> MCP over stdio
//   - the CLI installer -> `archgen-mcp bootstrap`
//   - the VS Code extension -> `archgen-mcp exec archgen_tasks '{"action":"next",…}'`
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
import { guard } from './envelope.mjs';
import { Context } from './context.mjs';
import { createServer } from './server.mjs';
import { getToolSpec, registeredToolNames } from './tools/_register.mjs';
import { loadAsset } from './context.mjs';
import { wireArchgenMcp, uninstallArchgenMcp, archgenMcpStatus } from './core/mcp-server-manager.mjs';
import { manageCodegraph, assertLocation, findCodegraph } from './core/codegraph-manager.mjs';
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
    const envelope = await guard(spec.handler, ctx, check.data);
    out(JSON.stringify(envelope, null, 2));
    return envelope.ok ? 0 : 1;
  }

  const registry = loadAsset('harness-mcp.json');

  if (opts.command === 'bootstrap') {
    const location = assertLocation(opts.location);
    const mcp = wireArchgenMcp({
      projectRoot: ctx.projectRoot,
      registry,
      home: ctx.home,
      location,
      approved: opts.yes,
      env: ctx.env,
    });
    const codegraph = await manageCodegraph({
      mode: 'ensure',
      projectRoot: ctx.projectRoot,
      registry,
      location,
      approved: opts.yes,
      home: ctx.home,
      env: ctx.env,
    });
    if (opts.json) {
      out(JSON.stringify({ mcp, codegraph }, null, 2));
    } else {
      out(`archgen-mcp bootstrap — ${ctx.projectRoot}`);
      out(`  mcp:     ${mcp.detected.length} harness(es) detected — ${mcp.wired.map((w) => `${w.harness}:${w.status}`).join(', ') || 'none'}`);
      out(`  binary: ${mcp.binary.bin ?? 'npx fallback'}`);
      out(`  codegraph: ${codegraph.cli.present ? codegraph.cli.version : 'not installed'} · index ${codegraph.index.action}`);
    }
    return codegraph.ok === false ? 1 : 0;
  }

  if (opts.command === 'doctor') {
    const status = archgenMcpStatus({ projectRoot: ctx.projectRoot, registry, home: ctx.home });
    const codegraph = findCodegraph(ctx.env);
    const report = {
      projectRoot: ctx.projectRoot,
      skill: ctx.skill ? { path: ctx.skill.path, version: ctx.skill.version, scope: ctx.skill.scope } : null,
      server: ctx.serverVersion,
      node: process.versions.node,
      codegraph: codegraph ? { bin: codegraph.bin, version: codegraph.version } : null,
      mcpBinary: status.binary,
      mcpTargets: status.targets,
      harnesses: detectHarnesses(registry, ctx.projectRoot, ctx.home).map((d) => d.id),
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
    const res = uninstallArchgenMcp(ctx.projectRoot, ctx.home);
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

