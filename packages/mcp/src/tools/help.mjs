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

**When**
- After writing or editing tasks.yaml—before anything else.
- Before the verifier gate (\`verify\`); for the dependency graph (\`graph\`) or blast radius (\`impact\`).

**Actions**
| action | what it does | args |
|---|---|---|
| \`validate\` | schema, cycles, dangling refs, ownership, acceptance | tasksYaml, planDir? |
| \`verify\` | the deterministic floor → APPROVE or ISSUES (+ warnings) | tasksYaml, planDir, offset? |
| \`coverage\` | tasks covered vs missing in the plans | tasksYaml, planDir |
| \`profile\` | evidence-based scope + per-artifact create/reuse/omit decisions | intent, signals?, modules?, tasks?, slug? |
| \`scaffold\` | the artifact set + skeletons (with an intent: EXACTLY the create set) | scope, slug?, intent?, signals?, file? |
| \`brief\` | ready-to-send sub-agent prompt (graph, docs check, evidence map rendered) | kind, tasksYaml? |
| \`graph\` | dependency graph; \`format:'mermaid'\` for a diagram | tasksYaml, node?, module?, format?, status? |
| \`impact\` | direct + transitive dependents of a task id or path | tasksYaml, target |

**Reading the result**
- \`ok\` = the CALL succeeded; plan health is \`data.valid\` (\`data.verdict\` for verify). A broken plan is still \`ok:true\`.
- \`valid:false\` with \`errors\`: fix every error, re-run; never pass the gate with errors outstanding.
- \`warnings\` never block; unknown keys are warnings.
- \`verify\` ISSUES = gate failure: fix, re-verify (max 2 automatic rounds, then ask the user).

**Gotchas**
- \`status\` only affects mermaid; \`module\` cannot combine with \`node\` or mermaid.
- Whole-graph mermaid is refused above 250 nodes—scope with \`node\` or \`module\`.
- \`verify\` IS the mechanical floor: ownership overlap, the mirrored test tree, matrix citations, PRD requirement coverage, the recorded profile decisions, decision files, declared paths, wave labels. Run it to APPROVE BEFORE dispatching a gate agent; the gate brief then carries the floor's result, a plan snapshot, and the maps, so the agent judges instead of re-deriving. Every finding carries a stable CODE (\`issueCodes\`/\`warningCodes\` count them); \`issues\` block, \`warnings\` (e.g. one task's glob containing another's, or a rule that is NOT ENFORCED) do not. The findings list is BOUNDED but WALKABLE: \`offset\` returns the next window and \`meta.next\` names the call.
- \`scaffold\` returns each file's CONTENT and **writes nothing**—you write under \`.archgen/<slug>/\`. The profile decides which artifacts are create/reuse/omit; required files must exist and every omission needs a recorded reason.
- \`brief\` kinds: verifier | review | survey | investigate. It derives the slug from \`tasksYaml\` when omitted; every path is ABSOLUTE (works from any cwd). Verifier/review briefs render the graph, reference-integrity result, and evidence map, so the sub-agent needs no tool call.
- Verifier/reviewer return \`VERDICT:\` + a COVERAGE table (every dimension PASS / FAIL / N/A); findings without it are INCOMPLETE.
- Every error carries the exact next call (\`Next:\`/\`Why:\`)—do not retry the same call.
- Batch with \`allSettled\`, not \`all\`.
- Narrow before fetching: \`coverage{taskId}\`, \`scaffold{file}\`, \`limit\`/\`offset\`.`,

  tasks: `# archgen_tasks

The wave execution loop.

**When**
- \`next\` at wave start and after every wave settles.
- \`set_status\` the moment a task finishes—same turn, never batched.
- \`snapshot\` after each wave: writes the compaction-safe resume file.

**Actions**
| action | what it does | args |
|---|---|---|
| \`next\` | dependency frontier → waves | tasksYaml |
| \`set_status\` | atomically set one task status | tasksYaml, taskId, status, force? |
| \`list\` | flat task list, filterable | tasksYaml, filterStatus?, module? |
| \`snapshot\` | write \`.archgen/<slug>/.agent/resume.md\` | tasksYaml |
| \`contract\` | full worker prompt for one task | tasksYaml, taskId, slugDir? |

**Status discipline (non-negotiable)**—after EVERY task, same turn:
1. \`set_status\` done|failed—verify it landed.
2. Complete the tracker/todo item.
3. \`archgen_registry{action:'update'}\`.
Never dispatch the next wave while any of those lag.

**Gotchas**
- Leaving \`done\` needs \`force:true\`.
- \`next\` fails CYCLE/OWNERSHIP_CONFLICT on a broken plan—fix tasks.yaml.
- \`blockedByFailure\` tasks are excluded, not auto-retried.
- \`contract\` carries acceptance criteria VERBATIM, owned files, dependency neighbourhood, doc sections, EVERY matched skill's rules inline, the CodeGraph directive, and worker rules. Use it—never hand-assemble a prompt.
- \`contract\` warns when a required capability skill is uninstalled—install it before dispatch.
- \`contract\` returns \`dispatchKey\`; keep \`dispatchKey → session\` so follow-ups continue the same agent.
- Max 3 parallel workers; larger waves run in batches.
- \`next\`/\`list\` narrow to one task with \`taskId\`; \`meta\` gives totals.`,

  docs: `# archgen_docs

Navigates markdown artifacts under \`.archgen/<slug>/\`.

**Read sections, not files.** A plan can be 20k tokens; the needed section is usually a few hundred. \`digest\` gives the section index; \`section\` fetches one.

**Actions**
| action | what it does | args |
|---|---|---|
| \`digest\` | compact section index per document—start here | slugDir? |
| \`section\` | one section by bare slug, \`path\`, or \`path#anchor\` | section, slugDir?, include? |
| \`map\` | sections mentioning a token | token, slugDir? |
| \`refs\` | every line mentioning a token | token, slugDir? |
| \`index\` | file map: path, title, section count | slugDir? |
| \`validate\` | reference-integrity gate | slugDir? |

**Gotchas**
- A section resolves by exact slug, title, or unambiguous PREFIX (\`plan-depth\` → \`plan-depth-by-scope-class\`).
- \`digest\` returns bare section slugs; \`section\` accepts one, a \`path\`, or a \`path#anchor\`. An ambiguous slug returns an \`ambiguous\` list, not a guess.
- \`file\` + \`section\` extracts THAT section from that file; \`file\` alone scopes any action to ONE document.
- A section returns its OWN text and NAMES its nested subsections (\`children\`) with their slugs; \`include:'all'\` returns the whole subtree. The response always carries \`lines\` and \`bytes\`.
- \`index\` is the file map; \`digest\` is the outline (with the slugs you can fetch). Do not pay for both.
- Anchors validate against real heading slugs—a renamed section is a broken anchor, not a silent pass.
- \`map\` is section-level; \`refs\` is line-level. Use \`map\` to navigate, \`refs\` for exact lines.
- \`validate\` reports each broken reference once, at its first occurrence.
- Not found → available sections are returned; one call recovers.
- \`slugDir\` defaults to the most recently modified \`.archgen/<slug>/\` under the project root.
- Batch with \`allSettled\`, not \`all\`.`,

  registry: `# archgen_registry

Keeps the \`AGENTS.md\` features registry in sync with \`.archgen/\`.

**When**
- After every task completes (same turn as \`set_status\`).
- After generating a plan and after any artifact change.

**Actions**
| action | what it does | args |
|---|---|---|
| \`update\` | rewrite the registry table from \`.archgen/\` | slug?, status? |
| \`show\` | read the registry without writing | — |

**Gotchas**
- Machine-maintained: never hand-edit—change \`.archgen/\` state and call \`update\`.
- \`slug\` and \`status\` must be passed together.
- Managed block: \`<!-- archgen:features:start -->\` … \`<!-- archgen:features:end -->\`; every byte outside it is preserved.`,

  codegraph: `# archgen_codegraph

Installs, wires, or inspects CodeGraph (source-symbol index) and its MCP server.

**When**
- \`.codegraph/\` absent: \`ensure\` once per project.
- Check state: \`status\`. Wire configs only: \`wire\`.

**Actions**
| action | what it does | args |
|---|---|---|
| \`ensure\` | install missing CLI + wire MCPs + build index | projectRoot?, approve? |
| \`status\` | installed / wired / indexed (read-only, offline) | projectRoot? |
| \`wire\` | wire the MCP into detected harnesses only | projectRoot?, approve?, location? |

**Gotchas**
- The index is built ONCE per project; the server watcher keeps it live—never re-index by hand.
- Config writes need \`approve:true\`; without it you get the PLAN, nothing is written.
- Only DETECTED harnesses are touched.
- Telemetry is ON by default on a fresh install and reports a machine ID; it is disclosed—never claim "100% local".`,

  setup: `# archgen_setup

Installation, MCP wiring, and health.

**When**
- Tools missing: \`npx archgen-skill init\`, then reload the harness.
- Install into other harnesses: \`install_mcp\`. Check an install: \`doctor\`.

**Actions**
| action | what it does | args |
|---|---|---|
| \`doctor\` | issues only (WARN/FAIL) + status/summary/versions | projectRoot? |
| \`bootstrap\` | wire archgen MCP + ensure CodeGraph in one call; a no-op when already configured | projectRoot?, location?, approve?, telemetry? |
| \`install_mcp\` | write ONLY the archgen MCP entry into detected harnesses | projectRoot?, location?, approve? |
| \`uninstall_mcp\` | remove the archgen MCP entries this server wrote | projectRoot?, location?, approve? |
| \`harnesses\` | detected harnesses + exact config path/key | projectRoot?, harness? |
| \`harness_info\` | platform capabilities; no argument = detect current | harness? |

**Gotchas**
- Every config write needs \`approve:true\`; without it you get the PLAN, nothing is written.
- \`location\`: project | global | both. Global writes touch \$HOME.
- Known top-level keys: \`mcpServers\` / \`servers\` / \`mcp\` / \`context_servers\`—never assume one.
- \`harness_info\` returns the fallback procedure for an unknown platform instead of failing.`,

  skills: `# archgen_skills

Matches a task against the capability-skill registry, installs exactly the matched skill, and reads its rules and section index.

**When**
- Before dispatching work that touches a registered domain (UI, accessibility, motion, design systems).
- To install a missing match, or to read the rules a worker must follow.

**Actions**
| action | what it does | args |
|---|---|---|
| \`match\` | skills a task needs (title + summary + file_ownership) | title?, summary?, fileOwnership? |
| \`install\` | install ONE capability skill | skillId, harness?, global?, approve? |
| \`installed\` | what is installed for this project | — |
| \`load\` | a skill's RULES or ONE section | skillId, section? |
| \`digest\` | section index of an installed skill | skillId |
| \`list\` | the registry | — |

**Gotchas**
- \`install\` needs \`approve:true\`; without it you get the PLAN, nothing is written.
- Exactly ONE skill per install—never a bundle. A task mentioning "animation" gets motion, not the whole UI family.
- Installs write \`<project>/.agents/skills/<slug>/SKILL.md\`—point workers at that file.
- \`match\` reports \`required\` vs \`on-demand\`; a \`required\` match MUST be installed before dispatch.
- \`load\` returns the normative MUST/SHOULD/NEVER rules + section index, not the whole file. One section at a time: \`section:'<slug>'\`.
- \`list{skillId}\` and \`digest{section}\` narrow to one row/section.
- A skill not named in a worker contract is never applied; \`archgen_tasks{action:'contract'}\` names every matched required skill.`,

  refs: `# archgen_refs

Loads archgen's own protocol documents—the judgment layer: interviewing, artifacts, gates, dispatch, platform capabilities.

**When**
- At the start of a mode: load the sections the mode table names; every \`§\` is an obligation.
- After compaction: reload the current mode's sections.
- Before guessing protocol details—don't; load it.

**Actions**
| action | what it does | args |
|---|---|---|
| \`list\` | every topic + section count | — |
| \`index\` | section list of one topic | topic |
| \`read\` | ONE section (index when no section; whole topic only with \`'*'\`) | topic, section? |
| \`search\` | sections mentioning a token | topic, token |

**Gotchas**
- Load the SECTION, not the topic: ~1–2 KB vs ~11 KB.
- A section resolves by exact slug, title, or unambiguous PREFIX. The skill's \`§\` names are prefixes—\`§artifact-templates/plan-depth\` → \`plan-depth-by-scope-class\`—so pass them through. Use \`index\` only for an ambiguous prefix.
- \`code-standards.md\` is served too when the skill is installed, but workers read it as a plain file—they may have no MCP server.`,

  all: `# archgen — the complete tool surface

Nine tools, one domain each. The server resolves paths, validates input, and returns \`{ok,data,error,meta}\`; \`ok:false\` carries a typed \`error.code\`.

| tool | domain | use it for |
|---|---|---|
| \`archgen_plan\` | plan | validate / verify / graph / impact / coverage / scaffold / brief |
| \`archgen_tasks\` | execution | next wave / set_status / list / snapshot / contract |
| \`archgen_docs\` | artifacts | digest / section / map / refs / index / validate |
| \`archgen_registry\` | registry | show / update the AGENTS.md features table |
| \`archgen_codegraph\` | code index | ensure / status / wire CodeGraph + its MCP |
| \`archgen_setup\` | install | doctor / bootstrap / install_mcp / uninstall_mcp / harnesses / harness_info |
| \`archgen_skills\` | capability skills | match / install / installed / load / digest / list |
| \`archgen_refs\` | protocols | list / index / read / search |
| \`archgen_help\` | this | a detailed briefing for one domain |

**Error codes**
\`INVALID_INPUT\` · \`NOT_FOUND\` · \`CYCLE\` · \`OWNERSHIP_CONFLICT\` · \`CONFLICT\` · \`PERMISSION_DENIED\` · \`UNAVAILABLE\` · \`TIMEOUT\` · \`INTERNAL\`

**Fetch, don't dump**
- Every collection-shaped tool takes \`limit\` and \`offset\` (default 50).
- One-item narrowing: \`taskId\` (tasks, coverage), \`skillId\` (skills), \`file\`+\`section\` (docs), \`harness\` (setup).
- \`meta\` carries \`available\` (what else exists), \`more\` (the call that fetches one item), and \`next\` (the next slice); \`meta.total\` is always the full count.

**Call \`archgen_help{topic}\`** for the full briefing on any domain.`,
};

const schema = z.object({
  topic: z
    .enum(['plan', 'tasks', 'docs', 'registry', 'codegraph', 'setup', 'skills', 'refs', 'all'])
    .describe('Domain to explain.'),
  projectRoot: projectRootArg,
});

/**
 * @param {import('@modelcontextprotocol/server').McpServer} server
 */
export function registerHelpTools(server) {
  registerTool(server, 'archgen_help', {
    title: 'ArchGen help',
    description:
      'Detailed briefing for one archgen tool domain: actions, arguments, and gotchas. ' +
      'Call it instead of guessing an argument shape.',
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
