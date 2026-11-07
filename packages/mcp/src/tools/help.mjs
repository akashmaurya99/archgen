// help.mjs — the `archgen_help` tool: progressive disclosure.
//
// The skill used to carry every procedural detail inline, which meant every
// agent paid for it in every session whether it needed it or not. The detail
// lives HERE now and is fetched only when the agent actually needs it.
//
// This is the single largest context saving in the whole design: SKILL.md
// keeps the orchestration rules, and the "how exactly do I do X" knowledge
// arrives on demand.
import { z } from 'zod/v4';
import { registerTool, projectRootArg } from './_register.mjs';

const TOPICS = {
  plan: `# archgen_plan

Validates and analyzes a plan (tasks.yaml + plans/).

**When to call**
- After writing or editing tasks.yaml — before anything else.
- Before the verifier gate (action \`verify\`).
- When you need the dependency graph (\`graph\`) or the blast radius of a change (\`impact\`).

**Actions**
| action | what it does | required args |
|---|---|---|
| \`validate\` | schema, dependency cycles, dangling refs, ownership, acceptance criteria | tasksYaml, planDir? |
| \`verify\` | the deterministic verifier gate — returns APPROVE or ISSUES | tasksYaml, planDir |
| \`coverage\` | which tasks the plans cover and which they miss | tasksYaml, planDir |
| \`scaffold\` | the REQUIRED artifact set + skeletons for a scope class | scope, slug? |
| \`brief\` | the dispatch brief for a sub-agent — carries the evidence map, the graph and the docs-validate result already rendered | kind, tasksYaml? |
| \`graph\` | dependency graph; \`format:'mermaid'\` for a diagram | tasksYaml, node?, module?, format?, status? |
| \`impact\` | direct + transitive dependents of a task id or artifact path | tasksYaml, target |

**Reading the result**
- The envelope's \`ok\` says whether the CALL succeeded. The plan's health is \`data.valid\`
  (and \`data.verdict\` for verify). A call that reports a broken plan is still \`ok:true\`.
- \`data.valid:false\` with a non-empty \`errors\` array means the plan is broken — fix every
  error, then re-run. Never proceed past the gate with errors outstanding.
- \`warnings\` never block. Unknown keys and an unknown root key are warnings, not errors.
- \`verify\` returning ISSUES is a gate failure: fix and re-verify (max two automatic rounds, then ask the user).

**Gotchas**
- \`status\` only applies to mermaid output.
- \`module\` cannot be combined with \`node\` or mermaid.
- Whole-graph mermaid is refused above 250 nodes — scope it with \`node\` or \`module\`.
- \`scaffold\` returns the artifact set a scope class MUST have — adding or dropping files is a right-sizing defect.
- \`brief\` returns a ready-to-send sub-agent prompt (verifier | review | survey | investigate). It derives the slug from \`tasksYaml\` when you do not pass one, and every path in it is ABSOLUTE — so it works from any working directory. The verifier and review briefs carry the graph, the reference-integrity result and the evidence map rendered, so the sub-agent makes no tool call of its own.
- The verifier and reviewer return \`VERDICT:\` plus a COVERAGE table (every dimension PASS / FAIL / N-A). A report with findings but no coverage table is INCOMPLETE.`,

  tasks: `# archgen_tasks

The wave execution loop.

**When to call**
- \`next\` at the start of every wave, and after every wave settles.
- \`set_status\` the moment a task finishes — same turn, never batched.
- \`snapshot\` after each wave: it writes the compaction-safe resume file.

**Actions**
| action | what it does | required args |
|---|---|---|
| \`next\` | resolves the dependency frontier into waves | tasksYaml |
| \`set_status\` | atomically sets one task status | tasksYaml, taskId, status, force? |
| \`list\` | flat task list, filterable | tasksYaml, filterStatus?, module? |
| \`snapshot\` | writes \`.archgen/<slug>/.agent/resume.md\` | tasksYaml |
| \`contract\` | assembles the FULL worker prompt for one task | tasksYaml, taskId, slugDir? |

**Status discipline (non-negotiable)**
After EVERY task completes, in the SAME turn:
1. \`set_status\` to \`done\` or \`failed\` — and VERIFY it landed.
2. Mark the tracker/todo item completed.
3. \`archgen_registry { action: 'update' }\`.

Dispatching the next wave while any of those lag is forbidden.

**Gotchas**
- Moving a task OUT of \`done\` needs \`force: true\` — reopening completed work requires explicit intent.
- \`next\` fails with CYCLE or OWNERSHIP_CONFLICT when the plan is broken; fix tasks.yaml, do not work around it.
- \`blockedByFailure\` lists tasks excluded because an upstream task failed. They are not retried automatically.
- \`contract\` is the worker prompt — use it instead of assembling one by hand. It carries the acceptance criteria VERBATIM, the owned files, the dependency neighbourhood, the pre-located doc sections, EVERY matched capability skill with its RULES inline, the CodeGraph directive, and the rules the worker must not break.
- \`contract\` warns when a REQUIRED capability skill is not installed yet — install it before dispatching.
- \`contract\` returns a \`dispatchKey\`. Keep a ledger of \`dispatchKey → agent session\` so a follow-up CONTINUES that agent instead of starting a fresh one.
- MAX 3 parallel workers at a time. A larger wave runs in batches of three.`,

  docs: `# archgen_docs

Navigates the markdown artifacts under \`.archgen/<slug>/\`.

**Context economics — read this first.** Pull SECTIONS, not files. A whole plan can be 20k tokens; the sections
you need are usually a few hundred. \`digest\` gives you the section index, \`section\` fetches exactly one section.

**Actions**
| action | what it does | required args |
|---|---|---|
| \`digest\` | compact section index per document — start here | slugDir? |
| \`section\` | one section — a bare section slug, a \`path\`, or \`path#anchor\` | section, slugDir? |
| \`map\` | the SECTIONS mentioning a token — "where is this talked about?" | token, slugDir? |
| \`refs\` | every LINE mentioning a token | token, slugDir? |
| \`index\` | full document overview with headings | slugDir? |
| \`validate\` | reference-integrity gate | slugDir? |

**Gotchas**
- \`map\` is section-level, \`refs\` is line-level. Use \`map\` to navigate, \`refs\` when you need exact lines.
- \`section\` takes a BARE SECTION SLUG straight from \`digest\` — e.g. \`section:'non-functional-requirements'\`. It resolves the section across the documents. A slug that matches more than one document comes back as an \`ambiguous\` list, not a guess. \`path\` and \`path#anchor\` also work.
- Anchors are validated against the target document's real heading slugs — a renamed section is a broken anchor, not a silent pass.
- \`validate\` reports each broken reference once, at its first occurrence.
- A section that is not found comes back with the list of available sections — one failed call is enough to recover.
- \`slugDir\` defaults to the most recently modified \`.archgen/<slug>/\` under the project root.`,

  registry: `# archgen_registry

Keeps the \`AGENTS.md\` features registry in sync with \`.archgen/\`.

**When to call**
- After every task completes (same turn as \`set_status\`).
- Right after generating a plan, with the new slug and status.
- Whenever an artifact changes, so the registry never goes stale.

**Actions**
| action | what it does | required args |
|---|---|---|
| \`update\` | rewrites the registry table from \`.archgen/\` | slug?, status? |
| \`show\` | reads the current registry without writing | — |

**Gotchas**
- The registry is machine-maintained. Never hand-edit it — edit the \`.archgen/\` state and call \`update\`.
- \`slug\` and \`status\` must be passed together.
- The managed block lives between \`<!-- archgen:features:start -->\` and \`<!-- archgen:features:end -->\`; every byte outside it is preserved.`,

  codegraph: `# archgen_codegraph

Installs, wires and indexes CodeGraph — the source-symbol index — and its own MCP server.

**When to call**
- Once per project, when \`.codegraph/\` is absent: \`ensure\`.
- To check what is installed: \`status\`.
- To wire the CodeGraph MCP into detected harnesses without installing: \`wire\`.

**Actions**
| action | what it does | required args |
|---|---|---|
| \`ensure\` | install the CLI if missing + wire the MCP + build the index | projectRoot?, approve? |
| \`status\` | what is installed / wired / indexed (read-only) | projectRoot? |
| \`wire\` | wire the MCP into detected harnesses only | projectRoot?, approve? |

**Gotchas**
- The index is built ONCE per project; the CodeGraph server's watcher keeps it live. Never re-index by hand.
- MCP-config writes are approval-gated: without \`approve: true\` the tool prints its plan and writes nothing.
- Only DETECTED harnesses are touched. A harness that is not installed is never modified.
- CodeGraph telemetry is ON by default on a fresh install and reports a machine ID. It is disclosed in the
  result — never claim "100% local".`,

  setup: `# archgen_setup

Installation, MCP wiring and health.

**When to call**
- When the archgen tools are missing from your tool set: run \`npx archgen-skill init\` in the project root,
  then ask the user to reload the harness.
- To install the archgen MCP into other harnesses: \`install_mcp\`.
- To check the install: \`doctor\`.

**Actions**
| action | what it does | required args |
|---|---|---|
| \`doctor\` | health report: skill, MCP wiring, CodeGraph, node, versions | projectRoot? |
| \`bootstrap\` | wire the archgen MCP + ensure CodeGraph, in one call | projectRoot?, location?, approve? |
| \`install_mcp\` | write ONLY the archgen MCP entry into detected harnesses | projectRoot?, location?, approve? |
| \`uninstall_mcp\` | remove the archgen MCP entries this server wrote | projectRoot?, location?, approve? |
| \`harnesses\` | detected harnesses + the exact config path/key/diff each would get | projectRoot? |

**Gotchas**
- Every MCP-config write needs \`approve: true\`. Without it you get the PLAN, and nothing is written.
- \`location\` is \`project\`, \`global\` or \`both\`. Global writes touch files under \$HOME.
- The four known top-level config keys are \`mcpServers\` / \`servers\` / \`mcp\` / \`context_servers\` — never assume one.
- \`harness_info\` with no argument DETECTS the harness and returns its row; with an unknown platform it returns the fallback procedure instead of failing.`,

  ui: `# archgen_ui

Controls the ArchGen VS Code extension in real time.

**When to call**
- After changing a task's status, to point the user at what changed.
- When the user asks to show a task, a document, or a different feature.
- \`status\` first, if you are unsure whether the extension is running.

**Actions**
| action | what it does | required args |
|---|---|---|
| \`status\` | is the extension running, what can it do | projectRoot? |
| \`select_feature\` | switch the board to a feature | slug |
| \`reveal_task\` | focus the board on a task node | taskId |
| \`open_doc\` | open a document in the DOCS tab | path |
| \`focus\` | bring a view forward | view |
| \`refresh\` | force a model re-push | — |

**Gotchas**
- These are BEST-EFFORT. With the extension closed you get \`available:false\` — that is not an error, and it
  never blocks your work. The file writes themselves already update the board in real time.
- \`path\` for \`open_doc\` is repo-root-relative.`,

  skills: `# archgen_skills

Matches a task against the capability-skill registry, installs EXACTLY the matched skill, and loads its SKILL.md.

**When to call**
- Before dispatching a worker whose work touches a registered capability domain (UI, accessibility, motion, design systems).
- To install a capability skill that the match reported as missing.
- To load a skill's SKILL.md so you can point a worker at it.

**Actions**
| action | what it does | required args |
|---|---|---|
| \`match\` | which capability skills a task needs (title + summary + file_ownership) | title?, summary?, fileOwnership? |
| \`install\` | install ONE capability skill | skillId, harness?, global?, approve? |
| \`installed\` | what is already installed for this project | — |
| \`load\` | read a skill's SKILL.md, its RULES, or ONE section of it | skillId, section? |
| \`digest\` | the section index of an installed skill — the lens | skillId |
| \`list\` | the registry | — |

**Gotchas**
- Installing needs \`approve: true\`. Without it you get the PLAN and nothing is written.
- Exactly ONE skill is installed — never a bundle. A task that mentions "animation" gets the motion skill, not the whole UI family.
- The installer writes \`<project>/.agents/skills/<slug>/SKILL.md\` — that is the file you point a worker at.
- \`match\` reports \`required\` vs \`on-demand\`: a \`required\` match MUST be installed before dispatch.
- \`load\` returns the skill's NORMATIVE RULES (the MUST / SHOULD / NEVER lines) and its section index. The rules are what a worker must follow — pull them from here rather than re-reading the file.
- A skill that is installed but never named in a worker contract is a skill that is never applied. \`archgen_tasks{action:'contract'}\` names EVERY matched required skill.`,

  refs: `# archgen_refs

Loads archgen's OWN protocol documents — the judgment layer: how to interview, what artifacts to write, how to run the gates, how to dispatch workers, what this platform can do.

**When to call**
- At the START of a mode: the SKILL's mode table names the sections to load, and every \`§\` mark is an obligation.
- After a compaction: a compaction drops the loaded section — re-load the current mode's sections as part of re-entry.
- When you are about to guess a protocol's details. Don't — load it.

**Actions**
| action | what it does | required args |
|---|---|---|
| \`list\` | every reference topic with its section count | — |
| \`index\` | the section list of one topic | topic |
| \`read\` | ONE section (or the whole topic when no section is given) | topic, section? |
| \`search\` | the sections mentioning a token | topic, token |

**Gotchas**
- Load the SECTION, not the topic: a topic is ~11 KB, a section is ~1-2 KB.
- Section slugs are GitHub-exact (lowercase, punctuation dropped, whitespace to hyphens). Call \`index\` for the exact slug rather than guessing it.
- \`code-standards.md\` is served too when the skill is installed — but WORKERS read it as a plain file, because they may have no MCP server at all.`,

  all: `# archgen — the complete tool surface

Eight tools, one domain each. Call them by name; the server resolves paths, validates input and returns a
structured result. Every result is \`{ ok, data, error, meta }\` — \`ok:false\` carries a typed \`error.code\`.

| tool | domain | use it for |
|---|---|---|
| \`archgen_plan\` | plan | validate / verify / graph / impact / coverage |
| \`archgen_tasks\` | execution | next wave / set status / list / resume snapshot |
| \`archgen_docs\` | artifacts | digest, section, map, refs, index, validate |
| \`archgen_registry\` | registry | refresh / read the AGENTS.md features table |
| \`archgen_codegraph\` | code index | install + wire + index CodeGraph and its MCP |
| \`archgen_setup\` | install | doctor / bootstrap / install_mcp / uninstall_mcp / harnesses |
| \`archgen_ui\` | VS Code UI | status / select_feature / reveal_task / open_doc / focus / refresh |
| \`archgen_skills\` | capability skills | match / install / installed / load / list |
| \`archgen_refs\` | archgen's protocols | list / index / read / search |
| \`archgen_help\` | this | a detailed briefing for one domain |

**Error codes**
\`INVALID_INPUT\` · \`NOT_FOUND\` · \`CYCLE\` · \`OWNERSHIP_CONFLICT\` · \`CONFLICT\` · \`PERMISSION_DENIED\` ·
\`UNAVAILABLE\` · \`TIMEOUT\` · \`INTERNAL\`

**Call \`archgen_help { topic: "<domain>" }\`** for the full briefing on any one of them.`,
};

const schema = z.object({
  topic: z
    .enum(['plan', 'tasks', 'docs', 'registry', 'codegraph', 'setup', 'ui', 'skills', 'refs', 'all'])
    .describe('Which domain to explain.'),
  projectRoot: projectRootArg,
});

/**
 * @param {import('@modelcontextprotocol/server').McpServer} server
 */
export function registerHelpTools(server) {
  registerTool(server, 'archgen_help', {
    title: 'ArchGen help',
    description:
      'Get the detailed briefing for one archgen tool domain — when to call it, every action, and its gotchas. ' +
      'Call this instead of guessing an argument shape.',
    inputSchema: schema,
    readOnly: true,
    idempotent: true,
    handler: (ctx, args) => ({
      topic: args.topic,
      briefing: TOPICS[args.topic] ?? TOPICS.all,
    }),
  });
}

export { TOPICS };
