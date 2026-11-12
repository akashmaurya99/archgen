// plan.mjs — the `archgen_plan` tool: plan validation & graph analysis.
//
// One tool, one action enum. The tool catalog is injected into the model's
// context by every client, so a single well-described tool with a short action
// enum costs far less context than five thin tools — and it removes the
// "which one do I call?" confusion the whole MCP exercise exists to fix.
import { z } from 'zod/v4';
import { registerTool, projectRootArg, LIMIT_DESC, OFFSET_DESC } from './_register.mjs';
import { routingSentence } from '../core/protocol/routing.mjs';
import { loadAsset, BRIEFS_DIR, TEMPLATES_DIR, serverVersion } from '../context.mjs';
import { buildScaffold, skeletonKeyForPath } from '../core/plan/scaffold.mjs';
import { buildPlanProfile, INTENTS, SCOPE_SIGNALS } from '../core/plan/plan-profile.mjs';
import { loadBrief, renderBriefContext, BRIEF_KINDS } from '../core/docs/briefs.mjs';
import { resolveBriefScope, briefVars } from '../core/docs/brief-scope.mjs';
import { buildBriefContext } from '../core/docs/brief-context.mjs';
import { validateTasksYaml } from '../core/plan/validator.mjs';
import { verifyPlan, planCoverage } from '../core/plan/verifier.mjs';
import { planGraph } from '../core/plan/plan-grapher.mjs';
import { analyzeImpact } from '../core/plan/impact-analyzer.mjs';
import { invalidInput } from '../core/protocol/errors.mjs';
import { assertPathToken } from '../core/protocol/slug.mjs';
import { toolCall } from '../core/protocol/call.mjs';
import { moreMeta, project, withMeta } from '../envelope.mjs';
import { hint } from '../core/protocol/guidance.mjs';
import { resolutionWarning, resolveTasksFile } from '../core/fs/tasks-file.mjs';

// The action list lives in archgen_help (one call away). Repeating it here
// would tax every request's context for no extra information. What DOES
// live here is the GENERATED routing map: one line built from the tables
// below, so a model can see which arguments an action reads without
// guessing — and without the hand-written parentheticals that used to
// disagree with these very tables.

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
      `'${collection}' is not a collection of '${action}' (allowed: ${allowed.join('|') || 'none'})`, { ...hint({ action: toolCall('archgen_help', { topic: 'plan' }), reason: "the collections of each action are listed there." }), action, collection, allowed });
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
    `'${action}' has no collection (allowed elsewhere: ${allowed.join('|') || 'none'})`, { ...hint({ action: toolCall('archgen_help', { topic: 'plan' }), reason: "the collections of each action are listed there." }), action, collection });
}

/**
 * The arguments each action takes.
 *
 * The schema is flat, so this table is what keeps a call honest: an argument
 * that belongs to another action is a typed error, not a silent no-op.
 */
const PLAN_ACTION_ARGS = {
  validate: ['tasksYaml', 'planDir', 'collection', 'limit', 'offset'],
  verify: ['tasksYaml', 'planDir', 'collection', 'limit', 'offset'],
  graph: ['tasksYaml', 'planDir', 'node', 'module', 'format', 'status', 'collection', 'limit', 'offset'],
  impact: ['tasksYaml', 'target', 'collection', 'limit', 'offset'],
  coverage: ['tasksYaml', 'planDir', 'taskId', 'collection', 'limit', 'offset'],
  profile: ['intent', 'signals', 'modules', 'tasks', 'slug', 'collection'],
  scaffold: ['scope', 'intent', 'signals', 'modules', 'tasks', 'slug', 'file', 'collection'],
  brief: ['kind', 'tasksYaml', 'planDir', 'slug', 'featureRequest', 'topic', 'round', 'collection'],
};

const schema = z.object({
  action: z.enum(['validate', 'verify', 'graph', 'impact', 'coverage', 'profile', 'scaffold', 'brief']),
  tasksYaml: z
    .string()
    .optional()
    .describe('tasks.yaml path; omit → the active .archgen/<slug>/tasks.yaml.'),
  planDir: z.string().optional().describe('plans/ dir.'),
  target: z.string().optional().describe('Task id or artifact path.'),
  taskId: z.string().optional().describe('One task.'),
  node: z.string().optional().describe('One task neighborhood.'),
  format: z.enum(['json', 'mermaid']).optional(),
  status: z.boolean().optional().describe('Status styling.'),
  module: z.string().optional().describe('One module.'),
  scope: z.enum(['SMALL', 'MEDIUM', 'LARGE']).optional(),
  slug: z.string().optional().describe('Project slug.'),
  intent: z.enum(INTENTS).optional(),
  signals: z.array(z.enum(SCOPE_SIGNALS)).optional().describe('Evidence signals.'),
  modules: z
    .union([z.number().int().positive(), z.array(z.unknown()).min(1)])
    .optional()
    .describe('Modules touched/created: a count, or the list itself.'),
  tasks: z
    .union([z.number().int().positive(), z.array(z.unknown()).min(1)])
    .optional()
    .describe('Planned tasks: a count, or the list itself.'),
  file: z.string().optional().describe('One artifact file.'),
  kind: z.enum(BRIEF_KINDS).optional(),
  featureRequest: z.string().optional().describe('One-line feature request.'),
  topic: z.string().optional().describe('Investigation topic.'),
  round: z.number().int().positive().optional().describe('Investigation round.'),
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
    .describe('Which collection the limit/offset window walks.'),
  limit: z.number().int().positive().optional().describe(LIMIT_DESC),
  offset: z.number().int().nonnegative().optional().describe(OFFSET_DESC),
  projectRoot: projectRootArg,
});

/**
 * @param {import('@modelcontextprotocol/server').McpServer} server
 */
export function registerPlanTools(server) {
  registerTool(server, 'archgen_plan', {
    actionArgs: PLAN_ACTION_ARGS,
    title: 'ArchGen plan',
    description:
      'Validate and analyze an archgen plan: schema validation, the deterministic floor, dependency graph, ' +
      'blast radius, coverage, evidence-based scope profile, artifact scaffold, and dispatch brief. ' +
      routingSentence(PLAN_ACTION_ARGS),
    inputSchema: schema,
    readOnly: true,
    idempotent: true,
    handler: (ctx, args) => {
      const action = args.action;

      switch (action) {
        case 'validate': {
          const { file, warning } = requireTasksYaml(args, ctx);
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
          const errNext = nextCall('validate', args, report.errorsOffset + report.errors.length, file);
          const warnNext = nextCall('validate', args, report.warningsOffset + report.warnings.length, file);
          // The truncation test is OFFSET-AWARE. Comparing the page length
          // with the total is true at the tail too, so the continuation
          // pointed at the SAME offset and an agent following it spun
          // forever on an empty page.
          const errTruncated = report.errorsOmitted > 0;
          const warnTruncated = report.warningsOmitted > 0;
          return withMeta(
            report,
            { ...moreMeta({
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
            }), ...resolvedMeta(warning) },
          );
        }
        case 'verify': {
          const { file, warning } = requireTasksYaml(args, ctx);
          if (!args.planDir) throw invalidInput(
            'verify requires planDir',
            { ...hint({ action: toolCall('archgen_plan', { action: 'verify', tasksYaml: '<tasks.yaml>', planDir: '<planDir>' }), reason: "verify needs the plans directory." }), action },
          );
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
          const issueNext = nextCall('verify', args, out.issuesOffset + out.issues.length, file);
          const warningNext = nextCall('verify', args, out.warningsOffset + out.warnings.length, file);
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
            { ...moreMeta({
              // The SELECTED collection. It always described the issues, so
              // `verify{collection:'warnings'}` reported the ISSUES total
              // over the warnings' payload — and an empty warnings window
              // with a non-zero total read as "the warnings are clean".
              total: collection === 'warnings' ? out.warningsTotal : out.issuesTotal,
              returned: collection === 'warnings' ? out.warnings.length : out.issues.length,
              next,
              more,
              available: { issues: out.issuesTotal, warnings: out.warningsTotal },
            }), ...resolvedMeta(warning) },
          );
        }
        case 'coverage': {
          const { file, warning } = requireTasksYaml(args, ctx);
          if (!args.planDir) throw invalidInput(
            'coverage requires planDir',
            { ...hint({ action: toolCall('archgen_plan', { action: 'coverage', tasksYaml: '<tasks.yaml>', planDir: '<planDir>' }), reason: "coverage needs the plans directory." }), action },
          );
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
          const call = (c, off) => nextCall('coverage', args, off, file);
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
            { ...moreMeta({
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
            }), ...resolvedMeta(warning) },
          );
        }
        case 'impact': {
          const { file, warning } = requireTasksYaml(args, ctx);
          if (!args.target) throw invalidInput(
            'impact requires target (a task id or an artifact path)',
            { ...hint({ action: toolCall('archgen_plan', { action: 'impact', tasksYaml: '<tasks.yaml>', target: '<task id>' }), reason: "impact needs the task to trace." }), action },
          );
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
            toolCall('archgen_plan', { action: 'impact', tasksYaml: file, target: args.target, collection: c, limit: args.limit ?? 50, offset: off });
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
            { ...moreMeta({
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
            }), ...resolvedMeta(warning) },
          );
        }
        case 'profile': {
          rejectCollection('profile', args.collection);
          if (!args.intent) {
            throw invalidInput(
              'profile requires intent (GREENFIELD-SYSTEM | GREENFIELD-MODULE | BROWNFIELD-FEATURE | BROWNFIELD-CHANGE)',
              { ...hint({ action: toolCall('archgen_plan', { action: 'profile', intent: 'GREENFIELD-SYSTEM', slug: '<slug>' }), reason: "the profile starts from one of four intents." }), action, },
            );
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
          if (!args.scope) throw invalidInput(
            'scaffold requires scope (SMALL | MEDIUM | LARGE)',
            { ...hint({ action: toolCall('archgen_plan', { action: 'scaffold', scope: 'LARGE', intent: 'GREENFIELD-SYSTEM', slug: '<slug>' }), reason: "the scaffold serves one scope class." }), action },
          );
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
              throw invalidInput(
                `no skeleton '${wanted}' for scope ${args.scope}`,
                { ...hint({ action: toolCall('archgen_plan', { action: 'scaffold', scope: 'LARGE', slug: '<slug>', file: '<one file>' }), reason: "the scaffold serves the artifacts the profile marked create." }), action,
                file: wanted,
                available: (built.artifacts ?? []).map((a) => a.path),
                skeletons: Object.keys(built.skeletons ?? {}), },
              );
            }
            // An artifact the profile marks OMIT (or, in class mode,
            // conditional) must not be served as "write this" — there is no
            // skeleton for it, and writing it is the defect the profile
            // exists to prevent. The one-file call said "write this" with
            // `skeleton: null`, and the floor then reported the copy.
            if (artifact && artifact.decision && artifact.decision !== 'create') {
              throw invalidInput(
                `the profile marks '${artifact.path}' as ${artifact.decision} — do not write it (${artifact.reason ?? 'no reason recorded'})`, { ...hint({ action: toolCall('archgen_plan', { action: 'profile', intent: 'GREENFIELD-SYSTEM', slug: '<slug>' }), reason: "the profile decides which artifacts to create." }), action, file: wanted, decision: artifact.decision, reason: artifact.reason ?? null });
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
              nextStep: `Write ${artifact?.path ?? wanted} from the skeleton above, then ${toolCall('archgen_plan', { action: 'validate' })}.`,
            };
          }
          // The one-file cursor carries the SAME inputs the call did, and the
          // class the scaffold SERVED. It used to carry only the requested
          // scope, so following it re-entered CLASS mode — and class mode
          // refused the very artifacts the profile had marked `create`.
          const servedScope = built.scopeClass ?? args.scope;
          const sameInputs = {
            scope: servedScope,
            intent: args.intent,
            signals: args.signals?.length ? args.signals : undefined,
            modules: args.modules,
            tasks: args.tasks,
            slug: args.slug ?? '<slug>',
          };
          return withMeta(
            built,
            moreMeta({
              total: (built.writeThese ?? []).length,
              returned: (built.writeThese ?? []).length,
              available: { files: (built.writeThese ?? []).length },
              more: toolCall('archgen_plan', { action: 'scaffold', ...sameInputs, file: '<one file>' }),
            }),
          );
        }
        case 'brief': {
          rejectCollection('brief', args.collection);
          if (!args.kind) throw invalidInput(
            'brief requires kind',
            { ...hint({ action: toolCall('archgen_plan', { action: 'brief', kind: 'verifier', tasksYaml: '<tasks.yaml>', planDir: '<planDir>' }), reason: "the brief kinds are verifier, review, survey and investigate." }), action },
          );
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
          // The investigate brief writes its notes to `.agent/notes/<topic>.md`,
          // so a topic of "../../evil" told the worker to write OUTSIDE the
          // artifact space.
          if (args.topic) assertPathToken(args.topic, 'topic', 'brief');
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

          const { kind, brief, missing } = loadBrief(BRIEFS_DIR, args.kind, vars);
          // A brief with a placeholder still in it is a brief that would
          // send a worker looking for a directory named "<slug dir>". The
          // placeholders are the TEMPLATE's — the agent's own text is never
          // read as one.
          if (missing.length) {
            const passable = missing.filter((m) => m === 'topic' || m === 'round');
            throw invalidInput(
              `brief '${kind}' is missing ${missing.join(', ')} — pass ${passable.length ? passable.join(', ') : 'the missing values'}`, { ...hint({ action: toolCall('archgen_plan', { action: 'brief', kind: 'investigate', tasksYaml: '<tasks.yaml>', planDir: '<planDir>', topic: '<topic>', round: '1' }), reason: "an investigate brief needs a topic." }), action, kind, missing });
          }
          return { kind, brief: `${renderBriefContext(briefContext)}\n${brief}`, scope };
        }
        case 'graph': {
          rejectCollection('graph', args.collection);
          // The task file is resolved the same way every other action
          // resolves it: the caller's path, the slug, the plans directory, or
          // the active artifact space.
          const { file, warning } = requireTasksYaml(args, ctx);
          const format = args.format ?? 'json';
          if (format === 'mermaid' && args.module) {
            throw invalidInput(
              'module cannot combine with mermaid output',
              { ...hint({ action: toolCall('archgen_plan', { action: 'graph', tasksYaml: file, node: '<task id>' }), reason: "scope the graph to one task." }), action },
            );
          }
          if (args.status && format !== 'mermaid') {
            throw invalidInput(
              'status requires mermaid output',
              { ...hint({ action: toolCall('archgen_plan', { action: 'graph', tasksYaml: file, format: 'mermaid' }), reason: "status styling applies to the mermaid rendering only." }), action },
            );
          }
          const rendered = planGraph(file, {
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
            return withMeta(
              { format: rendered.format, ...(typeof rendered.data === 'object' && rendered.data ? rendered.data : { text: rendered.data }) },
              warning ? { warnings: [warning] } : {},
            );
          }
          // The waves are a collection: they are windowed, and the window's
          // tail is reachable.
          const graph = rendered.data ?? {};
          const waves = project(graph.waves ?? [], {
            limit: args.limit,
            offset: args.offset,
          });
          const next = toolCall('archgen_plan', { action: 'graph', tasksYaml: file, limit: args.limit ?? 50, offset: (args.offset ?? 0) + (args.limit ?? 50) });
          return withMeta(
            { ...graph, file, waves: waves.items },
            {
              ...moreMeta({
                total: waves.total,
                returned: waves.returned,
                next: waves.truncated ? next : undefined,
                available: { waves: waves.total, tasks: graph.taskCount ?? 0 },
              }),
              ...(warning ? { warnings: [warning] } : {}),
            },
          );
        }
        default:
          // The schema rejects unknown actions before this point; the explicit
          // default guarantees an unknown action can never fall through into
          // the wrong branch if validation is ever bypassed.
          throw invalidInput(
            `unknown action '${action}'`,
            { ...hint({ action: toolCall('archgen_help', { topic: 'plan' }), reason: "the actions are listed there." }), action },
          );
      }
    },
  });
}


/**
 * The meta block for a resolved task file: the warning when the file was
 * chosen rather than named.
 *
 * @param {string|null} warning
 * @returns {object}
 */
function resolvedMeta(warning) {
  return warning ? { warnings: [warning] } : {};
}

/**
 * Resolve the tasks.yaml argument, defaulting to the project's active slug.
 *
 * The path is OPTIONAL: the task file is always `.archgen/<slug>/tasks.yaml`
 * inside the project, so a caller that knows the project can act on the plan
 * it is working in. The resolution is reported — the payload names the file —
 * and an ambiguous project (several artifact spaces) warns instead of
 * guessing silently.
 *
 * @param {any} args
 * @param {import('../context.mjs').Context} ctx
 * @returns {{file: string, warning: string|null}}
 */
function requireTasksYaml(args, ctx) {
  const resolved = resolveTasksFile({
    tasksYaml: args.tasksYaml ? ctx.contain(args.tasksYaml) : null,
    slug: args.slug ?? null,
    planDir: args.planDir ? ctx.contain(args.planDir) : null,
    projectRoot: ctx.projectRoot,
    action: args.action,
  });
  return { file: resolved.file, warning: resolutionWarning(resolved) };
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
/**
 * The continuation call for a collection window.
 *
 * The call carries the arguments the ACTION takes — not every argument the
 * caller passed. A continuation that carried the whole argument set put the
 * dead ones back in front of the agent, and the agent kept passing them.
 *
 * @param {string} action
 * @param {Record<string, unknown>} args the caller's arguments
 * @param {number} offset the offset of the NEXT slice
 */
function nextCall(action, args, offset, file = null) {
  const carried = {};
  for (const key of PLAN_ACTION_ARGS[action] ?? []) {
    if (args[key] !== undefined) carried[key] = args[key];
  }
  // The RESOLVED task file, not the caller's own argument. The continuation
  // used to carry the caller's argument — which was undefined when the
  // caller had not passed one — so the tool published a "next call" that
  // named no plan at all.
  if (file) carried.tasksYaml = file;
  return toolCall('archgen_plan', {
    action,
    ...carried,
    collection: args.collection,
    limit: args.limit ?? 50,
    offset: Math.max(0, offset),
  });
}
