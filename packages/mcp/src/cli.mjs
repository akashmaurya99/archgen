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
import { Context, serverVersion } from './context.mjs';
import { createServer, exposedToolNames } from './server.mjs';
import { getToolSpec, registeredToolNames, runTool } from './tools/_register.mjs';
import { loadAsset } from './context.mjs';
import { uninstallArchgenMcp, archgenMcpStatus } from './core/harness/mcp-server-manager.mjs';
import { assertLocation, findCodegraph } from './core/harness/codegraph-manager.mjs';
import { detectHarnesses } from './core/harness/harness-wiring.mjs';
import { writeOut, writeErr } from './core/protocol/io.mjs';

/**
 * The usage text.
 *
 * It is a FUNCTION, not a template: the tool list is only known
 * after the server is built, and a module-level template evaluated the list
 * at import time — when it was empty. The line printed "Tools:" and nothing.
 *
 * @returns {string}
 */
function usage() {
  return `archgen-mcp — MCP server for archgen

Usage:
  archgen-mcp                                  serve the MCP server over stdio (default)
  archgen-mcp exec <tool> '<json-args>'        run one tool, print JSON
  archgen-mcp version                          print the server version
  archgen-mcp bootstrap [--project <dir>]      wire the archgen MCP + ensure CodeGraph
  archgen-mcp doctor [--project <dir>]         health report
  archgen-mcp platform [--project <dir>]       the runtime facts about THIS harness
  archgen-mcp mcp-list [--project <dir>]      the harnesses and their MCP config paths
  archgen-mcp codegraph status|ensure|wire     the CodeGraph index and its MCP wiring
  archgen-mcp uninstall-mcp [--project <dir>]  remove the archgen MCP entries

Options:
  --project <dir>   project root (default: current directory)
  --location <s>    project | global | both (default: both; uninstall-mcp honours it)
  --yes             approve MCP-config writes
  --no-codegraph    skip the CodeGraph half of the bootstrap
  --no-mcp          skip the MCP wiring half of the bootstrap
  --no-install      resolve the CodeGraph CLI without installing it
  --json            machine-readable output
  --tool <name>     print ONE tool's schema (name + description + JSON schema)
  --tool-profile <p>  lean (default) | full — which tools the server publishes
  --fail-on <p>:<v> exit 3 when the tool result matches (e.g. verdict:ISSUES) — a build gate
  --list            list every REGISTERED tool (published + admin; --catalog is the published set)
  --catalog         print the catalog as the CLI projects it (name + description + input schema)
  --catalog-wire    print the REAL tools/list payload — what a client injects
  --catalog-all     print the projection of EVERY tool, published or not

Tools: ${registeredToolNames().join(', ')}`;
}

/**
 * The REAL `tools/list` payload, asked of the server itself.
 *
 * The SDK owns the wire shape (the title, the output schema, the
 * annotations), so the only honest way to print it is to ASK the server the
 * way a client asks. The projection above is a convenience; this is the fact.
 *
 * @param {any} server the MCP server
 * @returns {Promise<{ok: boolean, tools: any[], reason?: string}>}
 */
async function listWireTools(server) {
  try {
    const handler = server.server?._requestHandlers?.get?.('tools/list');
    if (typeof handler !== 'function') {
      return { ok: false, tools: [], reason: 'the server exposes no tools/list handler' };
    }
    const result = await handler({ method: 'tools/list', params: {} }, { signal: new AbortController().signal });
    return { ok: true, tools: result?.tools ?? [] };
  } catch (e) {
    return { ok: false, tools: [], reason: e instanceof Error ? e.message : String(e) };
  }
}

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
    noCodegraph: false,
    noMcp: false,
    noInstall: false,
    json: false,
    list: false,
    catalog: false,
    catalogWire: false,
    catalogAll: false,
    toolProfile: null,
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
    else if (a === '--no-codegraph') opts.noCodegraph = true;
    else if (a === '--no-mcp') opts.noMcp = true;
    else if (a === '--no-install') opts.noInstall = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--list') opts.list = true;
    else if (a === '--catalog') opts.catalog = true;
    else if (a === '--catalog-wire') opts.catalogWire = true;
    else if (a === '--catalog-all') opts.catalogAll = true;
    else if (a === '--tool-profile') opts.toolProfile = rest[++i];
    else if (a === '--tool') opts.tool = rest[++i];
    else if (a === '--version' || a === '-v') opts.command = 'version';
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
  // The output is SYNCHRONOUS. `process.stdout.write` to a pipe is
  // asynchronous on Node 20, and a process that writes a large payload and
  // exits can lose the tail: the 17KB catalog came back as 8KB of invalid
  // JSON, and the budget gate silently dropped the largest always-on term.
  const out = io.stdout ?? ((s) => writeOut(s));
  const err = io.stderr ?? ((s) => writeErr(s));
  const opts = parseArgs(argv);

  if (opts.command === 'version') {
    // The version is a fact people report in a bug, so it must be
    // obtainable without reading a JSON report.
    out(serverVersion());
    return 0;
  }

  // Register every tool (also populates the spec registry `exec` reads).
  // The PROFILE decides what the server PUBLISHES; every tool stays in the
  // registry, so `exec` can still reach the admin ones.
  const server = createServer({ profile: opts.toolProfile });

  if (opts.command === 'help') {
    // AFTER the server is built: the usage text names the tools, and the
    // registry is only populated once the tools are registered.
    out(usage());
    return 0;
  }

  if (opts.list) {
    out(JSON.stringify(registeredToolNames(), null, 2));
    return 0;
  }

  if (opts.tool && opts.command !== 'exec') {
    // `--tool <name>` prints ONE tool's schema. It used to be documented and
    // consumed by nothing: the flag started the stdio server instead, so a
    // reader asking for a schema got a hanging process.
    const spec = getToolSpec(opts.tool);
    if (!spec) {
      err(`unknown tool '${opts.tool}' — known tools: ${registeredToolNames().join(', ')}`);
      return 2;
    }
    out(JSON.stringify({
      name: opts.tool,
      description: spec.description ?? '',
      inputSchema: server.toolInputSchemaJson(opts.tool) ?? null,
    }, null, 2));
    return 0;
  }

  if (opts.catalogWire) {
    // The REAL wire payload: what the protocol's `tools/list` returns, which
    // carries MORE than the projection above (the title, the output schema
    // and the annotations). It is the number the token budget is measured
    // against, so it must be obtainable from the CLI too.
    const wire = await listWireTools(server);
    if (!wire.ok) {
      err(`the wire catalog could not be read: ${wire.reason}`);
      return 1;
    }
    out(JSON.stringify(wire.tools, null, 2));
    return 0;
  }

  if (opts.catalog || opts.catalogAll) {
    // The catalog AS THE CLI PROJECTS IT: each tool's name, description and
    // input schema. The internal token-budget tool measures the REAL wire
    // payload separately, because the protocol's `tools/list` carries more
    // (the title, the output schema and the annotations).
    //
    // By default it is the PUBLISHED catalog — the tools the active profile
    // exposes. `--catalog-all` adds the ones a profile holds back, so the
    // admin surface can be measured too.
    const names = opts.catalogAll ? registeredToolNames() : exposedToolNames();
    const catalog = names.map((name) => ({
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
      out(usage());
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
      noCodegraph: opts.noCodegraph,
      noMcp: opts.noMcp,
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
    // The scope is explicit. It was hard-coded to 'both', so a caller that
    // asked to remove ONE project's wiring also tore down the global wiring
    // every other project shares.
    const res = uninstallArchgenMcp(ctx.projectRoot, ctx.home, assertLocation(opts.location), ctx.env);
    if (opts.json) out(JSON.stringify(res, null, 2));
    else {
      out(`removed ${res.removed.length} config(s)`);
      for (const r of res.removed) out(`  - ${r}`);
      for (const s of res.skipped) out(`  ! ${s}`);
    }
    return 0;
  }

  // ── the admin surface ────────────────────────────────────────────────────
  //
  // These commands are the CONTROL PLANE: they install software, write
  // harness configuration and change machine state. They are reachable from
  // the CLI — where a human (or CI) asked for them — and NOT from the model
  // in the default profile.

  if (opts.command === 'platform') {
    const envelope = await runTool(getToolSpec('archgen_platform'), ctx, {});
    const data = envelope.data ?? {};
    if (opts.json) {
      out(JSON.stringify(data, null, 2));
    } else {
      out(`archgen-mcp platform — ${ctx.projectRoot}`);
      out(`  harness:  ${data.primary ?? 'unknown'}${data.detected?.length ? ` (detected: ${data.detected.join(', ')})` : ''}`);
      const caps = data.capabilities ?? {};
      out(`  skills:   ${Object.values(caps.skillPaths ?? {}).flat().join(', ') || 'unknown'}`);
      out(`  mcp cfg:  ${caps.mcpConfig?.project?.path ?? 'unknown'} (key ${caps.mcpConfig?.project?.key ?? '?'})`);
      out(`  restart:  ${caps.restart ?? 'unknown'}`);
      out(`  subagent: ${caps.subAgents?.mechanism ?? 'unknown'}`);
      out(`  codegraph: indexed=${data.codegraph?.indexed ?? false} · tools=${(data.codegraph?.tools ?? []).join(',') || 'none'}`);
      if (data.reason) out(`  ! ${data.reason}`);
    }
    return envelope.ok ? 0 : 1;
  }

  if (opts.command === 'mcp-list') {
    const envelope = await runTool(getToolSpec('archgen_setup'), ctx, { action: 'harnesses', location: assertLocation(opts.location) });
    const data = envelope.data ?? {};
    if (opts.json) {
      out(JSON.stringify(data, null, 2));
    } else {
      out(`archgen-mcp mcp-list — ${ctx.projectRoot}`);
      for (const h of data.detected ?? []) {
        const cfgs = (h.configs ?? []).map((c) => `${c.location}:${c.path}`).join(' · ');
        out(`  ${h.id.padEnd(12)} ${cfgs}`);
      }
      if (!(data.detected ?? []).length) out('  no harness detected');
    }
    return envelope.ok ? 0 : 1;
  }

  if (opts.command === 'codegraph') {
    const action = opts.args; // status | ensure | wire
    if (!['status', 'ensure', 'wire'].includes(action)) {
      err(`codegraph needs an action: status | ensure | wire`);
      out(usage());
      return 2;
    }
    // `ensure` and `wire` WRITE: they install the CLI and rewrite harness
    // configuration. WITHOUT --yes the command is a PLAN — it reports what
    // would change and writes nothing — so an agent can show the plan and
    // let the user approve it before applying.
    const envelope = await runTool(getToolSpec('archgen_codegraph'), ctx, {
      action,
      location: assertLocation(opts.location),
      approve: opts.yes === true,
      noInstall: opts.noInstall ?? false,
    });
    const data = envelope.data ?? {};
    if (opts.json) {
      out(JSON.stringify(data, null, 2));
    } else {
      out(`archgen-mcp codegraph ${action} — ${ctx.projectRoot}`);
      out(`  cli:       ${data.cli?.present ? `${data.cli.version} (${data.cli.bin})` : 'not installed'}`);
      out(`  install:   ${data.policy?.install ?? 'latest'} · package ${data.policy?.package ?? '?'}`);
      out(`  wire spec: ${data.policy?.wire ?? 'unpinned'}`);
      out(`  tools:     ${(data.policy?.tools ?? []).join(',') || 'none'}`);
      out(`  telemetry: ${data.policy?.telemetry ?? '?'}`);
      out(`  index:     ${data.indexed ? 'indexed' : (data.index?.action ?? 'none')}`);
      const wired = (data.wiring?.manual ?? []).map((w) => `${w.harness}:${w.status}`);
      out(`  wired:     ${wired.join(' · ') || 'none'}`);
      if (data.planned) {
        out('');
        out('  PLAN only — nothing was written. Re-run with --yes to apply it.');
      }
    }
    return envelope.ok ? 0 : 1;
  }

  if (opts.command === 'serve') return null; // the caller connects the transport

  err(`unknown command '${opts.command}'`);
  out(usage());
  return 2;
}

