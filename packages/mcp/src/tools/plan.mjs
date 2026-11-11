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
  validate: ['errors', 'warnings'],
  verify: ['issues', 'warnings'],
  coverage: ['tasks', 'covered', 'uncovered', 'findings', 'requirements', 'edgeCases'],
  impact: ['direct', 'transitive', 'artifacts'],
};
/**
 * The collection a caller named, validated against the action's own set.
 *
 * The `collection` enum is SHARED by four actions, so a caller could name a
 * collection the action does not have — `coverage{collection:'issues'}`
 * answered with a silent zero while the payload carried twenty tasks. A
 * mismatch is a typed error, never a silent fallback.
 *
 * @param {string} action
 * @param {string|undefined} collection
 * @param {string} fallback the action's default collection
 */
function resolveCollection(action, collection, fallback) {
  const allowed = COLLECTIONS[action] ?? [];
  if (collection === undefined || collection === null) return fallback;
  if (!allowed.includes(collection)) {
    throw invalidInput(
      `'${collection}' is not a collection of '${action}' (allowed: ${allowed.join('|') || 'none'})`,
      { action, collection, allowed },
    );
  }
  return collection;
}

/**
 * Reject `collection` on an action that has NO collection.
 *
 * The argument is shared across actions, so a caller could name a collection
 * on an action that ignores it — and the call silently succeeded with the
 * argument dropped. A named collection is a request; an impossible one is an
 * error, never a quiet no-op.
 *
 * @param {string} action
 * @param {string|undefined} collection
 */
function rejectCollection(action, collection) {
  if (collection === undefined || collection === null) return;
  const allowed = COLLECTIONS[action] ?? [];
  throw invalidInput(
    `'${action}' has no collection (allowed elsewhere: ${allowed.join('|') || 'none'})`,
    { action, collection },
  );
}

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
  modules: z
    .union([z.number().int().positive(), z.array(z.unknown()).min(1)])
    .optional()
    .describe('Modules touched/created: a count, or the list itself (profile, scaffold).'),
  tasks: z
    .union([z.number().int().positive(), z.array(z.unknown()).min(1)])
    .optional()
    .describe('Planned tasks: a count, or the list itself (profile, scaffold).'),
  file: z.string().optional().describe('One artifact file (scaffold).'),
  kind: z.enum(BRIEF_KINDS).optional().describe('verifier|review|survey|investigate (brief).'),
  featureRequest: z.string().optional().describe('One-line feature request (brief).'),
  topic: z.string().optional().describe('Investigation topic (brief).'),
  round: z.number().int().positive().optional().describe('Investigation round (brief).'),
  collection: z
    .enum([
      'errors',
      'issues',
      'warnings',
      'tasks',
      'covered',
      'uncovered',
      'findings',
      'requirements',
      'edgeCases',
      'direct',
      'transitive',
      'artifacts',
    ])
    .optional()
    .describe('Which collection `limit`/`offset` window (validate, verify, coverage, impact).'),
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
          const collection = resolveCollection('validate', args.collection, 'errors');
          const report = validateTasksYaml(file, {
            planDir: args.planDir ? ctx.contain(args.planDir) : null,
            limit: args.limit,
            offset: args.offset,
            // The errors and the warnings are SEPARATE collections with
            // separate windows: a 200-task broken plan produced 400 errors
            // and 200 warnings in one answer (16k tokens), with no way to
            // fetch the rest.
            collection,
          });
          const errNext = nextCall('validate', { ...args, collection: 'errors', limit: args.limit }, report.errorsOffset + report.errors.length);
          const warnNext = nextCall('validate', { ...args, collection: 'warnings', limit: args.limit }, report.warningsOffset + report.warnings.length);
          // The truncation test is OFFSET-AWARE. Comparing the page length
          // with the total is true at the tail too, so the continuation
          // pointed at the SAME offset and an agent following it spun
          // forever on an empty page.
          const errTruncated = report.errorsOmitted > 0;
          const warnTruncated = report.warningsOmitted > 0;
          return withMeta(
            report,
            moreMeta({
              total: collection === 'warnings' ? report.warningsTotal : report.errorsTotal,
              returned: collection === 'warnings' ? report.warnings.length : report.errors.length,
              available: { errors: report.errorsTotal, warnings: report.warningsTotal, tasks: report.counts.tasks },
              next:
                collection === 'warnings'
                  ? warnTruncated
                    ? warnNext
                    : undefined
                  : errTruncated
                    ? errNext
                    : undefined,
              more:
                collection === 'warnings'
                  ? errTruncated
                    ? errNext
                    : undefined
                  : warnTruncated
                    ? warnNext
                    : undefined,
            }),
          );
        }
        case 'verify': {
          const file = requireTasksYaml(args, ctx);
          if (!args.planDir) throw invalidInput('verify requires planDir', { action });
          const planDirArg = ctx.contain(args.planDir);
          const collection = resolveCollection('verify', args.collection, 'issues');
          const out = verifyPlan(file, planDirArg, {
            offset: args.offset ?? 0,
            limit: args.limit,
            collection,
          });
          // The findings list is bounded AND walkable: the exact next call is
          // in the payload, so a caller that needs the tail can reach it.
          // The next call is emitted when EITHER list is truncated — the
          // warnings used to vanish with no pointer at all.
          const effective = out.issues.length || out.warnings.length || args.limit || 40;
          const issueNext = nextCall('verify', { ...args, collection: 'issues', limit: effective }, out.issuesOffset + out.issues.length);
          const warningNext = nextCall('verify', { ...args, collection: 'warnings', limit: effective }, out.warningsOffset + out.warnings.length);
          // OFFSET-AWARE: `omitted` is what is LEFT after this window. The
          // old test (`page.length < total`) was true at the tail as well,
          // so the continuation pointed at the same offset forever.
          const issueTruncated = out.omitted.issues > 0;
          const warningTruncated = out.omitted.warnings > 0;
          // `meta.next` CONTINUES THE COLLECTION THE CALLER ASKED FOR; the
          // other list's continuation is named in `meta.more`. A chain that
          // jumped between the two repeated an offset and handed the agent a
          // different query than the one it was paging.
          const next =
            collection === 'warnings' ? (warningTruncated ? warningNext : undefined) : issueTruncated ? issueNext : undefined;
          const more =
            collection === 'warnings' ? (issueTruncated ? issueNext : undefined) : warningTruncated ? warningNext : undefined;
          return withMeta(
            out,
            moreMeta({
              // The SELECTED collection. It always described the issues, so
              // `verify{collection:'warnings'}` reported the ISSUES total
              // over the warnings' payload — and an empty warnings window
              // with a non-zero total read as "the warnings are clean".
              total: collection === 'warnings' ? out.warningsTotal : out.issuesTotal,
              returned: collection === 'warnings' ? out.warnings.length : out.issues.length,
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
          const collection = resolveCollection('coverage', args.collection, 'tasks');
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
            tasks: call('tasks', covered.tasks.offset + covered.tasks.items.length),
            covered: call('covered', covered.covered.offset + covered.covered.items.length),
            uncovered: call('uncovered', covered.uncovered.offset + covered.uncovered.items.length),
            findings: call('findings', covered.findings.offset + covered.findings.items.length),
            requirements: call('requirements', covered.requirements.offset + covered.requirements.uncovered.length),
            edgeCases: call('edgeCases', covered.edgeCases.offset + covered.edgeCases.unlinked.length),
          };
          const truncated = (shown, total) => shown < total;
          // The REQUESTED collection comes first in the continuation list —
          // `meta.next` is the call the agent is told to fetch, so it must
          // continue the collection it asked about, not the default one.
          const order = [
            collection,
            ...['tasks', 'covered', 'uncovered', 'findings', 'requirements', 'edgeCases'].filter(
              (c) => c !== collection,
            ),
          ];
          const shownOf = {
            tasks: covered.tasks.items.length,
            covered: covered.covered.items.length,
            uncovered: covered.uncovered.items.length,
            findings: covered.findings.items.length,
            requirements: covered.requirements.uncovered.length,
            edgeCases: covered.edgeCases.unlinked.length,
          };
          const totalOf = {
            tasks: covered.tasks.total,
            covered: covered.covered.total,
            uncovered: covered.uncovered.total,
            findings: covered.findings.total,
            requirements: covered.requirements.uncoveredTotal,
            edgeCases: covered.edgeCases.unlinkedTotal,
          };
          // OFFSET-AWARE: `omitted` is what is LEFT after this window. The
          // old test (`page.length < total`) was true at the tail as well,
          // so the continuation pointed at the same offset forever.
          const omittedOf = {
            tasks: covered.tasks.omitted,
            covered: covered.covered.omitted,
            uncovered: covered.uncovered.omitted,
            findings: covered.findings.omitted,
            requirements: covered.requirements.omitted,
            edgeCases: covered.edgeCases.omitted,
          };
          const moreList = [];
          for (const c of order) {
            if (c !== collection && omittedOf[c] > 0) moreList.push(next[c]);
          }
          // `meta.next` CONTINUES THE COLLECTION THE CALLER ASKED FOR. The
          // other collections' continuations are named in `meta.more` — a
          // chain that jumped between collections repeated an offset and
          // handed the agent a different query than the one it was paging.
          const selectedNext = omittedOf[collection] > 0 ? next[collection] : undefined;
          void truncated;
          // `meta.total`/`meta.returned` describe the SELECTED collection.
          // They described the whole set before, so `returned` could exceed
          // `total` and neither number matched the answer.
          const selectedTotal = totalOf[collection] ?? 0;
          const selectedShown = shownOf[collection] ?? 0;
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
              total: selectedTotal,
              returned: selectedShown,
              next: selectedNext,
              more: moreList.length ? moreList.join(' | ') : undefined,
              available: {
                tasks: covered.tasks.total,
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
          //
          // Each list has its OWN cursor: `collection` says which one the
          // window walks, so an agent paging the artifacts is not silently
          // paging the task ids too.
          const collection = resolveCollection('impact', args.collection, 'direct');
          const window = { limit: args.limit };
          const direct = project(blast.direct ?? [], { ...window, offset: collection === 'direct' ? args.offset : 0 });
          const transitive = project(blast.transitive ?? [], { ...window, offset: collection === 'transitive' ? args.offset : 0 });
          const artifacts = project(blast.artifacts ?? [], { ...window, offset: collection === 'artifacts' ? args.offset : 0 });
          // ONE CONTINUATION PER LIST. The offset walks only the selected
          // list, so a continuation that always named the selected list
          // could never reach the other two — the agent had to guess the
          // collection name the tool never mentioned.
          const cont = (c, off) =>
            `archgen_plan{action:'impact',tasksYaml:'${file}',target:'${args.target}',collection:'${c}',limit:${args.limit ?? 50},offset:${off}}`;
          const nextOf = {
            direct: cont('direct', direct.offset + direct.items.length),
            transitive: cont('transitive', transitive.offset + transitive.items.length),
            artifacts: cont('artifacts', artifacts.offset + artifacts.items.length),
          };
          const omittedOf = {
            direct: Math.max(0, direct.total - (direct.offset + direct.items.length)),
            transitive: Math.max(0, transitive.total - (transitive.offset + transitive.items.length)),
            artifacts: Math.max(0, artifacts.total - (artifacts.offset + artifacts.items.length)),
          };
          const order = [
            collection,
            ...['direct', 'transitive', 'artifacts'].filter((c) => c !== collection),
          ];
          const moreList = [];
          for (const c of order) {
            if (c !== collection && omittedOf[c] > 0) moreList.push(nextOf[c]);
          }
          // `meta.next` CONTINUES THE COLLECTION THE CALLER ASKED FOR; the
          // others are named in `meta.more`.
          const selectedNext = omittedOf[collection] > 0 ? nextOf[collection] : undefined;
          const selectedTotal =
            collection === 'direct' ? direct.total : collection === 'transitive' ? transitive.total : artifacts.total;
          const selectedShown =
            collection === 'direct' ? direct.returned : collection === 'transitive' ? transitive.returned : artifacts.returned;
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
              // The total covers EVERY list the payload carries — a `returned`
              // larger than the `total` is impossible to reconcile.
              total: direct.total + transitive.total + artifacts.total,
              returned: selectedShown,
              next: selectedNext,
              more: moreList.length ? moreList.join(' | ') : undefined,
              available: {
                direct: direct.total,
                transitive: transitive.total,
                artifacts: artifacts.total,
              },
            }),
          );
        }
        case 'profile': {
          rejectCollection('profile', args.collection);
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
          rejectCollection('scaffold', args.collection);
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
            // An artifact the profile marks OMIT (or, in class mode,
            // conditional) must not be served as "write this" — there is no
            // skeleton for it, and writing it is the defect the profile
            // exists to prevent. The one-file call said "write this" with
            // `skeleton: null`, and the floor then reported the copy.
            if (artifact && artifact.decision && artifact.decision !== 'create') {
              throw invalidInput(
                `the profile marks '${artifact.path}' as ${artifact.decision} — do not write it (${artifact.reason ?? 'no reason recorded'})`,
                { action, file: wanted, decision: artifact.decision, reason: artifact.reason ?? null },
              );
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
                decision: artifact?.decision ?? 'create',
                purpose: artifact?.purpose ?? null,
                reason: artifact?.reason ?? null,
                required: artifact?.required ?? null,
              },
              skeleton,
              writeThese: artifact ? [artifact.path] : [],
              nextStep: `Write ${artifact?.path ?? wanted} from the skeleton above, then archgen_plan{action:'validate'}.`,
            };
          }
          // The one-file cursor carries the SAME inputs the call did, and the
          // class the scaffold SERVED. It used to carry only the requested
          // scope, so following it re-entered CLASS mode — and class mode
          // refused the very artifacts the profile had marked `create`.
          const servedScope = built.scopeClass ?? args.scope;
          const sameInputs = [
            `scope:'${servedScope}'`,
            args.intent ? `intent:'${args.intent}'` : null,
            args.signals?.length ? `signals:[${args.signals.map((s) => `'${s}'`).join(',')}]` : null,
            args.modules !== undefined ? `modules:${JSON.stringify(args.modules)}` : null,
            args.tasks !== undefined ? `tasks:${JSON.stringify(args.tasks)}` : null,
            `slug:'${args.slug ?? '<slug>'}'`,
          ].filter(Boolean);
          return withMeta(
            built,
            moreMeta({
              total: (built.writeThese ?? []).length,
              returned: (built.writeThese ?? []).length,
              available: { files: (built.writeThese ?? []).length },
              more: `archgen_plan{action:'scaffold',${sameInputs.join(',')},file:'<one file>'}`,
            }),
          );
        }
        case 'brief': {
          rejectCollection('brief', args.collection);
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
          rejectCollection('graph', args.collection);
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
