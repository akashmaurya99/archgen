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
import { getToolSpec } from './_register.mjs';
import { routingMap } from '../core/protocol/routing.mjs';
import { YAML_SUBSET } from '../core/fs/yaml-subset.mjs';

/**
 * Which tool each help topic describes.
 *
 * The routing map is generated from that tool's per-action tables, so the
 * briefing and the schema cannot disagree about which action reads which
 * argument.
 */
const HELP_TOOL_FOR_TOPIC = {
  plan: 'archgen_plan',
  tasks: 'archgen_tasks',
  docs: 'archgen_docs',
  registry: 'archgen_registry',
  codegraph: 'archgen_codegraph',
  setup: 'archgen_setup',
  skills: 'archgen_skills',
  refs: 'archgen_refs',
};

/**
 * The YAML subset briefing, rendered from the contract the tests check.
 *
 * One source: core/fs/yaml-subset.mjs states each rule with an example, the
 * test runs every example through the real parser, and this briefing and
 * the reference section both render the same table. The agent can therefore
 * learn the rules on demand — instead of discovering them by failing.
 */
function yamlBriefing() {
  const supported = YAML_SUBSET.filter((r) => !r.expect.error);
  const refused = YAML_SUBSET.filter((r) => r.expect.error);
  const line = (r) => `- \`${r.id}\` — ${r.rule}`;
  return `# archgen YAML subset

\`tasks.yaml\` and \`architecture.yaml\` are parsed by a hand-rolled YAML subset. Every rule below is checked against the real parser by the test suite, so it is exactly what the server does.

**Supported**

${supported.map(line).join('\n')}

**Refused — the parser says so, with the line**

${refused.map(line).join('\n')}

Two habits remove every failure this subset can cause: **quote every acceptance criterion** (\`- "the api returns the list"\`), and **quote every value that contains \`": "\`**. A flow collection splits on commas — use a block list for a value that contains one.

A finding names the field and the line: \`archgen_plan{action:'validate'}\` returns every defect at once, each with a code, a message and the fix that clears it.`;
}

const TOPICS = {
  yaml: yamlBriefing(),
  plan: `# archgen_plan

Validates and analyzes a plan (tasks.yaml + plans/).

**When**
- After writing or editing tasks.yaml—before anything else.
- Before the verifier gate (\`verify\`); for the dependency graph (\`graph\`) or blast radius (\`impact\`).

**Actions**
| action | what it does |
|---|---|---|
| \`validate\` | schema, cycles, dangling refs, ownership, acceptance |
| \`verify\` | the deterministic floor → APPROVE or ISSUES (+ warnings) |
| \`coverage\` | tasks covered vs missing in the plans |
| \`profile\` | evidence-based scope + per-artifact create/reuse/omit decisions |
| \`scaffold\` | the artifact set + skeletons (with an intent: EXACTLY the create set) |
| \`brief\` | ready-to-send sub-agent prompt (graph, docs check, evidence map rendered) |
| \`graph\` | dependency graph; \`format:'mermaid'\` for a diagram |
| \`impact\` | direct + transitive dependents of a task id or path |

**Reading the result**
- \`ok\` = the CALL succeeded; plan health is \`data.valid\` (\`data.verdict\` for verify). A broken plan is still \`ok:true\`.
- \`valid:false\` with \`errors\`: fix every error, re-run; never pass the gate with errors outstanding.
- \`validate\` returns EVERY defect at once — each finding carries a \`code\`, the field and line it is in, and the \`fix\` that clears it. Fix them in ONE pass, then re-run; \`errorCodes\` counts them by class.
- \`warnings\` never block; unknown keys are warnings.
- \`verify\` ISSUES = gate failure: fix, re-verify (max 2 automatic rounds, then ask the user).

**Gotchas**
- \`tasksYaml\` is OPTIONAL: omit it and the active \`.archgen/<slug>/tasks.yaml\` is used; the answer names the file it read.
- \`status\` only affects mermaid; \`module\` cannot combine with \`node\` or mermaid.
- Whole-graph mermaid is refused above 250 nodes—scope with \`node\` or \`module\`.
- \`profile\` takes \`modules\`/\`tasks\` as a COUNT — a number, or the list itself (its length is the count).
- \`tasks.yaml\` is a hand-rolled YAML subset: quote every value, and never use a block scalar (\`|\`, \`>\`). A plain value MAY contain \`": "\`; an UNQUOTED \`key: value\` list item is read as a MAPPING, so quote a criterion that contains one. \`archgen_help{topic:'yaml'}\` and \`§artifact-templates/the-yaml-subset\` state the rules.
- \`verify\` IS the mechanical floor: ownership overlap, the mirrored test tree, matrix citations, PRD requirement coverage, the recorded profile decisions, decision files, declared paths, wave labels. Run it to APPROVE BEFORE dispatching a gate agent; the gate brief then carries the floor's result, a plan snapshot, and the maps, so the agent judges instead of re-deriving. Every finding carries a stable CODE (\`issueCodes\`/\`warningCodes\` count them); \`issues\` block, \`warnings\` (e.g. one task's glob containing another's, or a rule that is NOT ENFORCED) do not. The findings list is BOUNDED but WALKABLE: \`collection\` selects which list \`offset\`/\`limit\` window (\`issues\` or \`warnings\`), and \`meta.next\` names the call that continues the collection you asked for.
- Where an action has several collections, \`collection\` says which one the window walks, and naming a collection the action does not have is an \`INVALID_INPUT\` error — never a silently dropped argument.
- \`scaffold\` returns each file's CONTENT and **writes nothing**—you write under \`.archgen/<slug>/\`. The profile decides which artifacts are create/reuse/omit; required files must exist and every omission needs a recorded reason. It also returns the \`writeOrder\`: the order the files must be written in, each step naming the artifacts it depends on and the fact it must carry forward. Write them in that order, one file at a time (\`scaffold{file}\`); the one-file cursor refuses a step whose hard dependency does not exist yet.
- \`brief\` kinds: verifier | review | survey | investigate. It derives the slug from \`tasksYaml\` when omitted; every path is ABSOLUTE (works from any cwd). Verifier/review briefs render the graph, reference-integrity result, and evidence map, so the sub-agent needs no tool call. A \`survey\` brief wants \`featureRequest\`; an \`investigate\` brief wants \`topic\` and \`round\`.
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
| action | what it does |
|---|---|---|
| \`next\` | dependency frontier → waves |
| \`set_status\` | atomically set one task status |
| \`list\` | flat task list, filterable |
| \`snapshot\` | write \`.archgen/<slug>/.agent/resume.md\` |
| \`contract\` | full worker prompt for one task |

**Status discipline (non-negotiable)**—after EVERY task, same turn:
1. \`set_status\` done|failed—verify it landed.
2. Complete the tracker/todo item.
3. \`archgen_registry{action:'update'}\`.
Never dispatch the next wave while any of those lag.

**Gotchas**
- \`tasksYaml\` is OPTIONAL: omit it and the active \`.archgen/<slug>/tasks.yaml\` is used; every answer names the file it read. A project with several artifact spaces resolves the most recently changed one and WARNS—pass \`tasksYaml\` to name one.
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
| action | what it does |
|---|---|---|
| \`digest\` | compact section index per document—start here |
| \`section\` | one section by bare slug, \`path\`, or \`path#anchor\` |
| \`map\` | sections mentioning a token |
| \`refs\` | every line mentioning a token |
| \`index\` | file map: path, title, section count |
| \`validate\` | reference-integrity gate |

**Gotchas**
- A section resolves by exact slug, title, or unambiguous PREFIX (\`plan-depth\` → \`plan-depth-by-scope-class\`).
- \`digest\` returns bare section slugs; \`section\` accepts one, a \`path\`, or a \`path#anchor\`. An ambiguous slug returns an \`ambiguous\` list, not a guess.
- \`file\` + \`section\` extracts THAT section from that file; \`file\` alone scopes any action to ONE document.
- A section returns its OWN text and NAMES its nested subsections (\`children\`) with their slugs; \`include:'all'\` returns the whole subtree. The response always carries \`lines\` and \`bytes\`.
- \`index\` is the file map; \`digest\` is the outline (with the slugs you can fetch). Do not pay for both.
- Anchors validate against real heading slugs—a renamed section is a broken anchor, not a silent pass.
- \`map\` is section-level; \`refs\` is line-level. Use \`map\` to navigate, \`refs\` for exact lines.
- \`validate\` reports each broken reference once, at its first occurrence, and each finding carries the RULE it was judged by.
- **HOW A REFERENCE RESOLVES:** a target starting with \`./\` or \`../\` is relative to the DOCUMENT's directory and must land inside the artifact space; any other target is relative to the PROJECT root. A project-root path that names an artifact of the artifact space must exist; one outside it is a repository path or an OUTPUT DECLARATION (a file the plan will create) and is not broken for not existing yet.
- Not found → available sections are returned; one call recovers.
- \`slugDir\` defaults to the most recently modified \`.archgen/<slug>/\` under the project root.
- Batch with \`allSettled\`, not \`all\`.`,

  registry: `# archgen_registry

Keeps the \`AGENTS.md\` features registry in sync with \`.archgen/\`.

**When**
- After every task completes (same turn as \`set_status\`).
- After generating a plan and after any artifact change.

**Actions**
| action | what it does |
|---|---|---|
| \`update\` | rewrite the registry table from \`.archgen/\` |
| \`show\` | read the registry without writing |

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
| action | what it does |
|---|---|---|
| \`ensure\` | install missing CLI + wire MCPs + build index |
| \`status\` | installed / wired / indexed (read-only, offline) |
| \`wire\` | wire the MCP into detected harnesses only |

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
| action | what it does |
|---|---|---|
| \`doctor\` | issues only (WARN/FAIL) + status/summary/versions + \`serverActions\` |
| \`bootstrap\` | wire archgen MCP + ensure CodeGraph in one call; a no-op when already configured |
| \`install_mcp\` | write ONLY the archgen MCP entry into detected harnesses |
| \`uninstall_mcp\` | remove the archgen MCP entries this server wrote |
| \`harnesses\` | detected harnesses + exact config path/key |
| \`harness_info\` | platform capabilities; no argument = detect current |

**Gotchas**
- Every config write needs \`approve:true\`; without it you get the PLAN, nothing is written.
- \`location\`: project | global | both. Global writes touch \$HOME.
- Known top-level keys: \`mcpServers\` / \`servers\` / \`mcp\` / \`context_servers\`—never assume one.
- \`doctor\` also reports \`serverActions\`: the actions this server offers. Fewer actions in YOUR tool schema means your client holds a stale catalog—reload the session.
- \`harness_info\` with NO harness returns the fallback procedure for a platform it could not detect. With a harness NAME it returns that harness's capabilities — and a harness the registry does not know is refused, with the list of the ones it does.`,

  skills: `# archgen_skills

Matches a task against the capability-skill registry, installs exactly the matched skill, and reads its rules and section index.

**When**
- Before dispatching work that touches a registered domain (UI, accessibility, motion, design systems).
- To install a missing match, or to read the rules a worker must follow.

**Actions**
| action | what it does |
|---|---|---|
| \`match\` | skills a task needs (title + summary + file_ownership) |
| \`install\` | install ONE capability skill |
| \`installed\` | what is installed for this project |
| \`load\` | a skill's RULES or ONE section |
| \`digest\` | section index of an installed skill |
| \`list\` | the registry |

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
| action | what it does |
|---|---|---|
| \`list\` | every topic + section count |
| \`index\` | section list of one topic |
| \`read\` | ONE section (index when no section; whole topic only with \`'*'\`) |
| \`search\` | sections mentioning a token |

**Gotchas**
- Load the SECTION, not the topic: ~1–2 KB vs ~11 KB.
- A section resolves by exact slug, title, or unambiguous PREFIX. The skill's \`§\` names are prefixes—\`§artifact-templates/plan-depth\` → \`plan-depth-by-scope-class\`—so pass them through. Use \`index\` only for an ambiguous prefix.
- \`code-standards.md\` is served too when the skill is installed, but workers read it as a plain file—they may have no MCP server.`,

  all: `# archgen — the complete tool surface

Nine tools, one domain each. The server resolves paths, validates input, and returns \`{ok,data,error,meta}\`; \`ok:false\` carries a typed \`error.code\`.

| tool | domain | use it for |
|---|---|---|
| \`archgen_plan\` | plan | validate / verify / graph / impact / coverage / profile / scaffold / brief |
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
    .enum(['plan', 'tasks', 'docs', 'registry', 'codegraph', 'setup', 'skills', 'refs', 'yaml', 'all'])
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
    handler: (ctx, args) => {
      const topic = args.topic;
      const briefing = TOPICS[topic] ?? TOPICS.all;
      // The ROUTING MAP — which arguments each action reads — is GENERATED
      // from the same per-action tables the handlers use, and it is appended
      // to the briefing here.
      //
      // It used to be a hand-written column in each action table, and a
      // hand-written copy of a table is a copy that drifts: the schema and
      // the briefing disagreed about which action read `collection`. One
      // generated rendering, used by both the tool description and this
      // briefing, cannot disagree with itself.
      const map = routingMapFor(topic);
      return {
        topic,
        briefing: map ? `${briefing}\n\n**Args by action**\n\n${map}` : briefing,
      };
    },
  });
}

/**
 * The generated routing map for one help topic.
 *
 * It is built from the LIVE tool specs, so it cannot drift from the
 * handlers — and it is the same rendering the tool descriptions carry.
 *
 * It is resolved at CALL time, not at import time: the specs are registered
 * when the server is created, and a map built before that would be empty.
 */
function routingMapFor(topic) {
  const tool = HELP_TOOL_FOR_TOPIC[topic];
  if (!tool) return '';
  const spec = getToolSpec(tool);
  if (!spec) return '';
  const map = routingMap(spec.actionArgs);
  return map ? `Args — ${map}.` : '';
}
