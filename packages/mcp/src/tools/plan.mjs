// plan.mjs — the `archgen_plan` tool: plan validation & graph analysis.
//
// One tool, one action enum. The tool catalog is injected into the model's
// context by every client, so a single well-described tool with a short action
// enum costs far less context than five thin tools — and it removes the
// "which one do I call?" confusion the whole MCP exercise exists to fix.
import { z } from 'zod/v4';
import { registerTool, projectRootArg, LIMIT_DESC, OFFSET_DESC } from './_register.mjs';
import { loadAsset, BRIEFS_DIR, TEMPLATES_DIR, serverVersion } from '../context.mjs';
import { buildScaffold, skeletonKeyForPath } from '../core/scaffold.mjs';
import { buildPlanProfile, INTENTS, SCOPE_SIGNALS } from '../core/plan-profile.mjs';
import { loadBrief, remainingPlaceholders, renderBriefContext, BRIEF_KINDS } from '../core/briefs.mjs';
import { resolveBriefScope, briefVars } from '../core/brief-scope.mjs';
import { buildBriefContext } from '../core/brief-context.mjs';
import { validateTasksYaml } from '../core/validator.mjs';
import { verifyPlan, planCoverage } from '../core/verifier.mjs';
import { planGraph } from '../core/plan-grapher.mjs';
import { analyzeImpact } from '../core/impact-analyzer.mjs';
import { invalidInput } from '../core/errors.mjs';
import { moreMeta, project, withMeta } from '../envelope.mjs';

// The action list lives in archgen_help (one call away). Repeating it here
// would tax every request's context for no extra information.
const ACTION_DESC = 'validate|verify|graph|impact|coverage|profile|scaffold|brief';

/**
 * The collections a bounded action can walk.
 *
 * One action, several collections — each with its own window and its own
 * cursor. The offset used to apply to ONE concatenated list, so a second
 * collection's tail was unreachable (and, in coverage, the ids the tool
 * called "covered" were the tail of the uncovered list).
 */
const COLLECTIONS = {
  verify: 'issues|warnings',
  coverage: 'tasks|covered|uncovered|findings|requirements|edgeCases',
};

const schema = z.object({
  action: z.enum(['validate', 'verify', 'graph', 'impact', 'coverage', 'profile', 'scaffold', 'brief']).describe(ACTION_DESC),
  tasksYaml: z
    .string()
    .optional()
    .describe('tasks.yaml path (validate, verify, impact, coverage, graph).'),
  planDir: z.string().optional().describe('plans/ dir (verify, coverage, brief, graph).'),
  target: z.string().optional().describe('Task id or artifact path (impact).'),
  taskId: z.string().optional().describe('One task (coverage).'),
  node: z.string().optional().describe('One task neighborhood (graph).'),
  format: z.enum(['json', 'mermaid']).optional().describe('json|mermaid (graph).'),
  status: z.boolean().optional().describe('Status styling (graph, mermaid).'),
  module: z.string().optional().describe('One module (graph).'),
  scope: z.enum(['SMALL', 'MEDIUM', 'LARGE']).optional().describe('SMALL|MEDIUM|LARGE (scaffold).'),
  slug: z.string().optional().describe('Project slug (profile, scaffold, brief).'),
  intent: z.enum(INTENTS).optional().describe('Scope intent (profile, scaffold).'),
  signals: z.array(z.enum(SCOPE_SIGNALS)).optional().describe('Evidence signals (profile, scaffold).'),
  modules: z.number().int().positive().optional().describe('Modules touched/created (profile, scaffold).'),
  tasks: z.number().int().positive().optional().describe('Estimated task count (profile, scaffold).'),
  file: z.string().optional().describe('One artifact file (scaffold).'),
  kind: z.enum(BRIEF_KINDS).optional().describe('verifier|review|survey|investigate (brief).'),
  featureRequest: z.string().optional().describe('One-line feature request (brief).'),
  topic: z.string().optional().describe('Investigation topic (brief).'),
  round: z.number().int().positive().optional().describe('Investigation round (brief).'),
  collection: z
    .enum([
      'issues',
      'warnings',
      'tasks',
      'covered',
      'uncovered',
      'findings',
      'requirements',
      'edgeCases',
    ])
    .optional()
    .describe('Which collection `limit`/`offset` window (verify, coverage).'),
  limit: z.number().int().positive().optional().describe(LIMIT_DESC),
  offset: z.number().int().nonnegative().optional().describe(OFFSET_DESC),
  projectRoot: projectRootArg,
});

/**
 * @param {import('@modelcontextprotocol/server').McpServer} server
 */
export function registerPlanTools(server) {
  registerTool(server, 'archgen_plan', {
    title: 'ArchGen plan',
    description:
      'Validate and analyze an archgen plan: schema validation, verifier gate, dependency graph, ' +
      'blast radius, coverage, evidence-based scope profile, artifact scaffold, and dispatch brief.',
    inputSchema: schema,
    readOnly: true,
    idempotent: true,
    handler: (ctx, args) => {
      const action = args.action;

      switch (action) {
        case 'validate': {
          const file = requireTasksYaml(args, ctx);
          const report = validateTasksYaml(file, {
            planDir: args.planDir ? ctx.contain(args.planDir) : null,
            limit: args.limit,
            offset: args.offset,
          });
          // The errors and the warnings are SEPARATE collections with
          // separate windows: a 200-task broken plan produced 400 errors and
          // 200 warnings in one answer (16k tokens), with no way to fetch the
          // rest.
          const errNext = nextCall('validate', { ...args, collection: 'errors' }, report.errorsOffset + report.errors.length);
          const warnNext = nextCall('validate', { ...args, collection: 'warnings' }, report.warningsOffset + report.warnings.length);
          return withMeta(
            report,
            moreMeta({
              total: report.errorsTotal,
              returned: report.errors.length,
              available: { errors: report.errorsTotal, warnings: report.warningsTotal, tasks: report.counts.tasks },
              next: report.errors.length < report.errorsTotal ? errNext : undefined,
              more: report.warnings.length < report.warningsTotal ? warnNext : undefined,
            }),
          );
        }
        case 'verify': {
          const file = requireTasksYaml(args, ctx);
          if (!args.planDir) throw invalidInput('verify requires planDir', { action });
          const planDirArg = ctx.contain(args.planDir);
          const collection = args.collection === 'warnings' ? 'warnings' : 'issues';
          const out = verifyPlan(file, planDirArg, {
            offset: args.offset ?? 0,
            limit: args.limit,
            collection,
          });
          // The findings list is bounded AND walkable: the exact next call is
          // in the payload, so a caller that needs the tail can reach it.
          // The next call is emitted when EITHER list is truncated — the
          // warnings used to vanish with no pointer at all.
          const issueNext = nextCall('verify', { ...args, collection: 'issues' }, out.issuesOffset + out.issues.length);
          const warningNext = nextCall('verify', { ...args, collection: 'warnings' }, out.warningsOffset + out.warnings.length);
          const next =
            collection === 'warnings'
              ? out.warnings.length < out.warningsTotal
                ? warningNext
                : undefined
              : out.issues.length < out.issuesTotal
                ? issueNext
                : undefined;
          const more =
            collection === 'warnings'
              ? out.issues.length < out.issuesTotal
                ? issueNext
                : undefined
              : out.warnings.length < out.warningsTotal
                ? warningNext
                : undefined;
          return withMeta(
            out,
            moreMeta({
              total: out.issuesTotal,
              returned: out.issues.length,
              next,
              more,
              available: { issues: out.issuesTotal, warnings: out.warningsTotal },
            }),
          );
        }
        case 'coverage': {
          const file = requireTasksYaml(args, ctx);
          if (!args.planDir) throw invalidInput('coverage requires planDir', { action });
          const planDirArg = ctx.contain(args.planDir);
          const collection = args.collection ?? 'tasks';
          // ONE task, when the caller named one: the answer is about THAT
          // task, not about the plan.
          if (args.taskId) {
            const one = planCoverage(file, planDirArg, { taskId: args.taskId });
            return one;
          }
          const covered = planCoverage(file, planDirArg, {
            offset: args.offset ?? 0,
            limit: args.limit,
            collection,
          });
          const call = (c, off) => nextCall('coverage', { ...args, collection: c }, off);
          const next = {
            tasks: call('uncovered', covered.tasks.uncovered.length ? covered.tasks.offset + covered.tasks.uncovered.length : covered.tasks.offset),
            covered: call('covered', covered.tasks.covered.length),
            uncovered: call('uncovered', covered.tasks.uncovered.length),
            findings: call('findings', covered.findings.offset + covered.findings.items.length),
            requirements: call('requirements', covered.requirements.offset + covered.requirements.uncovered.length),
            edgeCases: call('edgeCases', covered.edgeCases.offset + covered.edgeCases.unlinked.length),
          };
          const truncated = (shown, total) => shown < total;
          const moreList = [];
          if (truncated(covered.tasks.covered.length, covered.tasks.coveredTotal)) moreList.push(next.covered);
          if (truncated(covered.tasks.uncovered.length, covered.tasks.uncoveredTotal)) moreList.push(next.uncovered);
          if (truncated(covered.findings.items.length, covered.findings.total)) moreList.push(next.findings);
          if (truncated(covered.requirements.uncovered.length, covered.requirements.uncoveredTotal)) moreList.push(next.requirements);
          if (truncated(covered.edgeCases.unlinked.length, covered.edgeCases.unlinkedTotal)) moreList.push(next.edgeCases);
          return withMeta(
            {
              ...covered,
              // ONE copy of each collection. The requirements and the edge
              // cases used to be delivered twice — byte-identical, under two
              // keys — so the payload said the same thing twice.
              traceability: {
                requirements: {
                  total: covered.requirements.total,
                  covered: covered.requirements.covered,
                  uncoveredTotal: covered.requirements.uncoveredTotal,
                },
                edgeCases: {
                  total: covered.edgeCases.total,
                  linked: covered.edgeCases.linked,
                  unlinkedTotal: covered.edgeCases.unlinkedTotal,
                },
                profileRecorded: covered.profileRecorded === true,
              },
            },
            moreMeta({
              total: covered.tasks.coveredTotal + covered.tasks.uncoveredTotal,
              returned:
                covered.tasks.covered.length +
                covered.tasks.uncovered.length +
                covered.findings.items.length +
                covered.requirements.uncovered.length +
                covered.edgeCases.unlinked.length,
              next: moreList[0],
              more: moreList.length > 1 ? moreList.slice(1).join(' | ') : undefined,
              available: {
                tasks: covered.tasks.coveredTotal + covered.tasks.uncoveredTotal,
                covered: covered.tasks.coveredTotal,
                uncovered: covered.tasks.uncoveredTotal,
                findings: covered.findings.total,
                requirements: covered.requirements.uncoveredTotal,
                edgeCases: covered.edgeCases.unlinkedTotal,
              },
            }),
          );
        }
        case 'impact': {
          const file = requireTasksYaml(args, ctx);
          if (!args.target) throw invalidInput('impact requires target (a task id or an artifact path)', { action });
          const blast = analyzeImpact(file, args.target);
          // The payload is WINDOWED. It used to carry every impacted id while
          // the meta reported a limit of 3 — and the "next" call returned the
          // very same payload, so the limit was a lie.
          const direct = project(blast.direct ?? [], { limit: args.limit, offset: args.offset });
          const transitive = project(blast.transitive ?? [], { limit: args.limit, offset: args.offset });
          const artifacts = project(blast.artifacts ?? [], { limit: args.limit, offset: args.offset });
          const nextOffset = (args.offset ?? 0) + (args.limit ?? 50);
          const next = `archgen_plan{action:'impact',tasksYaml:'${file}',target:'${args.target}',limit:${args.limit ?? 50},offset:${nextOffset}}`;
          return withMeta(
            {
              target: args.target,
              direct: direct.items,
              transitive: transitive.items,
              artifacts: artifacts.items,
              directTotal: direct.total,
              transitiveTotal: transitive.total,
              artifactsTotal: artifacts.total,
            },
            moreMeta({
              total: direct.total + transitive.total,
              returned: direct.returned + transitive.returned + artifacts.returned,
              next: direct.truncated || transitive.truncated || artifacts.truncated ? next : undefined,
              available: {
                direct: direct.total,
                transitive: transitive.total,
                artifacts: artifacts.total,
              },
            }),
          );
        }
        case 'profile': {
          if (!args.intent) {
            throw invalidInput('profile requires intent (GREENFIELD-SYSTEM | GREENFIELD-MODULE | BROWNFIELD-FEATURE | BROWNFIELD-CHANGE)', {
              action,
            });
          }
          return buildPlanProfile(loadAsset('depth-ladder.json'), {
            intent: args.intent,
            signals: args.signals ?? [],
            modules: args.modules,
            tasks: args.tasks,
            slug: args.slug ?? null,
          });
        }
        case 'scaffold': {
          if (!args.scope) throw invalidInput('scaffold requires scope (SMALL | MEDIUM | LARGE)', { action });
          const built = buildScaffold(loadAsset('depth-ladder.json'), args.scope, {
            slug: args.slug ?? null,
            templatesDir: TEMPLATES_DIR,
            // With an intent, the PROFILE decides the artifact set: the
            // scaffold then serves exactly the artifacts marked `create`, and
            // reports the reuse and omit decisions with their reasons. Without
            // one, the class's candidate set is served and `writeThese` is the
            // required subset.
            intent: args.intent ?? null,
            signals: args.signals ?? [],
            modules: args.modules ?? null,
            tasks: args.tasks ?? null,
            // The generator token carries the RUNNING server's version. The
            // server knows it exactly, so the artifact records the truth
            // instead of the agent having to guess, copy or type a version —
            // and no release ever has to update a version written by hand.
            generator: `archgen v${serverVersion()}`,
          });
          // ONE file's skeleton, when the caller named one.
          //
          // The caller names the file the way the tool PUBLISHED it — the
          // artifact path (`.archgen/demo/tasks.yaml`). It used to be matched
          // against the TEMPLATE names only, so the path the tool had just
          // given the agent was rejected, and the error listed the template
          // names — which the agent could not use.
          if (args.file) {
            const wanted = String(args.file);
            const artifact = (built.artifacts ?? []).find(
              (a) =>
                a.path === wanted ||
                a.path.endsWith(`/${wanted}`) ||
                a.path.replace(/^\.archgen\/[^/]+\//, '') === wanted.replace(/^\.archgen\/[^/]+\//, ''),
            );
            const key = artifact
              ? skeletonKeyForPath(artifact.path)
              : Object.keys(built.skeletons ?? {}).find((k) => k === wanted || k.endsWith(`/${wanted}`));
            const skeleton = key ? built.skeletons?.[key] : null;
            if (!artifact && !skeleton) {
              throw invalidInput(`no skeleton '${wanted}' for scope ${args.scope}`, {
                action,
                file: wanted,
                available: (built.artifacts ?? []).map((a) => a.path),
                skeletons: Object.keys(built.skeletons ?? {}),
              });
            }
            // ONLY the file. The old payload kept the whole scaffold and
            // replaced the skeletons map, so a "one file" call still carried
            // ~1,900 tokens of profile, artifacts, notes and budgets.
            return {
              scopeClass: built.scopeClass,
              label: built.label,
              mode: built.mode,
              writes: false,
              one: {
                path: artifact?.path ?? wanted,
                skeletonKey: key ?? null,
                decision: artifact?.decision ?? null,
                purpose: artifact?.purpose ?? null,
                reason: artifact?.reason ?? null,
                required: artifact?.required ?? null,
              },
              skeleton,
              writeThese: artifact ? [artifact.path] : [],
              nextStep: `Write ${artifact?.path ?? wanted} from the skeleton above, then archgen_plan{action:'validate'}.`,
            };
          }
          return withMeta(
            built,
            moreMeta({
              total: (built.writeThese ?? []).length,
              returned: (built.writeThese ?? []).length,
              available: { files: (built.writeThese ?? []).length },
              more: `archgen_plan{action:'scaffold',scope:'${args.scope}',slug:'${args.slug ?? '<slug>'}',file:'<one file>'}`,
            }),
          );
        }
        case 'brief': {
          if (!args.kind) throw invalidInput('brief requires kind', { action });
          // The artifact space is resolved from whatever the caller named:
          // the tasks.yaml it already holds, the plans dir, or the slug alone.
          //
          // The slug is DERIVED from the path when the path implies it — the
          // caller must not have to state the same fact twice. And every path
          // the brief carries is ABSOLUTE, because a brief is read by a
          // sub-agent whose working directory is not necessarily the
          // project's: a project-relative path in a brief resolves against
          // the SERVER's root and silently points at the wrong tree.
          const scope = resolveBriefScope({
            tasksYaml: args.tasksYaml ? ctx.contain(args.tasksYaml) : null,
            planDir: args.planDir ? ctx.contain(args.planDir) : null,
            slug: args.slug ?? null,
            projectRoot: ctx.projectRoot,
          });
          const vars = briefVars(scope, {
            featureRequest: args.featureRequest ?? null,
            topic: args.topic ?? null,
            round: args.round ?? null,
          });

          // The context the brief carries: the evidence map, the pre-rendered
          // graph and the reference-integrity result.
          //
          // RENDERING THEM HERE (instead of telling the orchestrator to
          // "attach" them) saves two tool calls per gate round, and removes a
          // dependency on a call that used to fail on every plan.
          const briefContext = buildBriefContext(args.kind, scope, ctx);

          const { kind, brief } = loadBrief(BRIEFS_DIR, args.kind, vars);
          // A brief with a placeholder still in it is a brief that would
          // send a worker looking for a directory named "<slug dir>".
          const missing = remainingPlaceholders(brief);
          if (missing.length) {
            const passable = missing.filter((m) => m === 'topic' || m === 'round');
            throw invalidInput(
              `brief '${kind}' is missing ${missing.join(', ')} — pass ${passable.length ? passable.join(', ') : 'the missing values'}`,
              { action, kind, missing },
            );
          }
          return { kind, brief: `${renderBriefContext(briefContext)}\n${brief}`, scope };
        }
        case 'graph': {
          const input = args.tasksYaml ?? args.planDir;
          if (!input) throw invalidInput('graph requires tasksYaml (a slug directory or a tasks.yaml path)', { action });
          const format = args.format ?? 'json';
          if (format === 'mermaid' && args.module) {
            throw invalidInput('module cannot combine with mermaid output', { action });
          }
          if (args.status && format !== 'mermaid') {
            throw invalidInput('status requires mermaid output', { action });
          }
          const rendered = planGraph(ctx.contain(input), {
            node: args.node ?? null,
            mermaid: format === 'mermaid',
            status: args.status === true,
            module: args.module ?? null,
            projectRoot: ctx.projectRoot,
          });
          // The payload is UNWRAPPED. The tool used to return the grapher's
          // `{format, data}` verbatim, so `data.data.waves` held the graph
          // while every sibling action put its result at `data.waves` — a
          // client reading one shape got `undefined` from the other.
          if (format === 'mermaid' || args.node || args.module) {
            return { format: rendered.format, ...(typeof rendered.data === 'object' && rendered.data ? rendered.data : { text: rendered.data }) };
          }
          // The waves are a collection: they are windowed, and the window's
          // tail is reachable.
          const graph = rendered.data ?? {};
          const waves = project(graph.waves ?? [], {
            limit: args.limit,
            offset: args.offset,
          });
          const next = `archgen_plan{action:'graph',tasksYaml:'${input}',limit:${args.limit ?? 50},offset:${(args.offset ?? 0) + (args.limit ?? 50)}}`;
          return withMeta(
            { ...graph, waves: waves.items },
            moreMeta({
              total: waves.total,
              returned: waves.returned,
              next: waves.truncated ? next : undefined,
              available: { waves: waves.total, tasks: graph.taskCount ?? 0 },
            }),
          );
        }
        default:
          // The schema rejects unknown actions before this point; the explicit
          // default guarantees an unknown action can never fall through into
          // the wrong branch if validation is ever bypassed.
          throw invalidInput(`unknown action '${action}'`, { action });
      }
    },
  });
}

/**
 * Resolve the tasks.yaml argument, defaulting to the project's active slug.
 * @param {any} args
 * @param {import('../context.mjs').Context} ctx
 */
function requireTasksYaml(args, ctx) {
  if (!args.tasksYaml) throw invalidInput('tasksYaml is required for this action', { action: args.action });
  return ctx.contain(args.tasksYaml);
}

/**
 * The EXACT next call for a windowed collection.
 *
 * The agent never has to assemble a cursor: the payload names the call that
 * returns the next slice, with the same scope and the same collection. A
 * bound that hides the tail without naming the way to reach it is a loss.
 *
 * @param {string} action
 * @param {any} args the caller's arguments
 * @param {number} offset the offset of the NEXT slice
 */
function nextCall(action, args, offset) {
  const parts = [`archgen_plan{action:'${action}'`];
  if (args.tasksYaml) parts.push(`tasksYaml:'${args.tasksYaml}'`);
  if (args.planDir) parts.push(`planDir:'${args.planDir}'`);
  if (args.collection) parts.push(`collection:'${args.collection}'`);
  parts.push(`limit:${args.limit ?? 50}`);
  parts.push(`offset:${Math.max(0, offset)}`);
  return `${parts.join(',')}}`;
}
