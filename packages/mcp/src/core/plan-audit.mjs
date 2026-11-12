// plan-audit.mjs — the MECHANICAL floor of the gate.
//
// WHY THIS MODULE EXISTS.
//
// The gate agent was doing arithmetic by hand, every round: checking that a
// source-owning task owns the mirrored test path, that an edge-case matrix row
// points at an acceptance that exists, that every PRD requirement is cited, that
// a declared decision file is on disk, that a declared path has an owner, that
// a wave label matches the DAG, that the recorded profile was honoured. Those
// are all FACTS, and facts belong in a tool: an agent re-deriving them burns
// rounds, misses some, and reports "small small issues" one category at a time.
//
// So the floor computes them, and the agent is left with the judgment it is
// actually for: does this plan deliver what the user agreed to?
//
// THE RULES THAT KEEP THE FLOOR HONEST:
//
//   1. It reports only what it can PROVE from the artifacts. Anything it
//      cannot prove is a warning (informational), never a blocking issue.
//   2. It NEVER guesses a convention. If the host repo does not declare its
//      source/test roots, the rule that needs them is reported as NOT
//      ENFORCED — loudly — instead of silently weakening.
//   3. It never assumes a language, a framework, a package manager or a path
//      shape. The host repo declares those; this file only reads them.
//   4. Every finding carries a STABLE CODE, so fixes can be grouped, tests
//      can assert behaviour, and CI can count classes.
//
// It is language-neutral BY CONSTRUCTION: the ids it joins are artifact ids
// (edge rows, requirement ids, task ids), never code-level names.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, sep } from 'node:path';
import { parseYaml } from './yaml.mjs';
import { buildGraph, computeWaves, globsMayOverlap, ownedPaths } from './graph.mjs';
import { WARNING_CODES } from './codes.mjs';
import { loadAsset } from '../context.mjs';
import {
  artifactFamilies,
  containsGlob,
  existsUnder,
  familyOf,
  listArtifacts,
  listFiles,
  matchesFamily,
  normalizeArtifactPath,
  normalizeGlob,
  parseEdgeMatrix,
  projectRootOf,
  readPlans,
  readText,
  readYaml,
  sourceAndTestRoots,
} from './artifact-space.mjs';
import { readWaivers, waiverCovers } from './waivers.mjs';

/** A requirement id: FR-<MODULE>-nn. */
const FR_ID = /\bFR-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g;
/** An edge-case row id: E1, E12. */
const EDGE_ID = /^E\d+$/;
/** What an acceptance claims to cover: "(covers E4, FR-API-01)". */
const CLAIMS = /\bcovers\s+([A-Z][A-Z0-9-]*(?:\s*,\s*[A-Z][A-Z0-9-]*)*)/gi;


/** Format one finding with its stable code. */
function finding(code, message) {
  return `${code}: ${message}`;
}

/**
 * Audit one plan's artifacts.
 *
 * @param {{slugDir: string, tasks: any[]}} input
 * @returns {{issues: string[], warnings: string[], maps: object, waivers: object[], profile: object|null}}
 */
export function auditPlan({ slugDir, tasks }) {
  const issues = [];
  const warnings = [];
  const maps = { requirements: [], edgeMatrix: [], ownership: [], modules: [], decisions: [] };
  if (!slugDir || !Array.isArray(tasks) || tasks.length === 0) {
    return {
      issues,
      warnings,
      issuesTotal: 0,
      warningsTotal: 0,
      issueCodes: {},
      warningCodes: {},
      waivedFindings: [],
      waivedCodes: {},
      maps,
      waivers: [],
      profile: null,
      snapshot: null,
    };
  }

  const architectureFile = readYaml(join(slugDir, 'architecture.yaml'));
  const architecture = architectureFile.data;
  const prdText = readText(join(slugDir, 'docs', 'prd.md'));
  const planText = readPlans(join(slugDir, 'plans'));
  const decisionFiles = listFiles(join(slugDir, 'decisions'));
  const waivers = readWaivers(join(slugDir, 'waivers.yaml'));
  const answersFile = readYaml(join(slugDir, 'answers.yaml'));
  const answers = answersFile.data;

  // A file that is present and unparseable is a DEFECT, not an absence. The
  // floor's whole purpose is to catch broken plans; reporting a syntax error
  // as "not there" hid the defect and sent the agent after the wrong fix.
  if (architectureFile.error) {
    warnings.push(
      finding('CONFIG_UNPARSEABLE', `architecture.yaml does not parse: ${architectureFile.error}`),
    );
  }
  if (answersFile.error) {
    warnings.push(
      finding('PROFILE_UNPARSEABLE', `answers.yaml does not parse: ${answersFile.error}`),
    );
  }

  const byId = new Map(tasks.map((t) => [String(t?.id ?? ''), t]));
  // The acceptance list may be a STRING — the validator reports that — so
  // the audit reads what it can instead of throwing the whole audit away.
  const acceptanceList = (t) => (Array.isArray(t?.acceptance) ? t.acceptance : []);
  const acceptanceOf = (id) => acceptanceList(byId.get(id)).map(String);

  // ── waves ────────────────────────────────────────────────────────────────
  const waveOf = new Map();
  try {
    const { byId: gById, prerequisites } = buildGraph(tasks);
    const { waves } = computeWaves(gById, prerequisites);
    waves.forEach((wave, i) => {
      for (const t of wave) waveOf.set(String(t.id), i + 1);
    });
  } catch {
    // A cycle or a dangling ref is the graph's error to report; the audit
    // simply has no wave numbers to compare labels against.
  }

  // ── what each acceptance CLAIMS to cover ─────────────────────────────────
  // The claim is the explicit link: "(covers E4)". It turns "does this
  // acceptance verify that edge case?" from a judgement into a join.
  const claims = new Map(); // `${taskId}#${index}` -> {edges:Set, reqs:Set}
  for (const t of tasks) {
    const id = String(t?.id ?? '');
    acceptanceList(t).forEach((a, i) => {
      const text = String(a);
      const key = `${id}#${i + 1}`;
      const found = { edges: new Set(), reqs: new Set() };
      for (const m of text.matchAll(CLAIMS)) {
        for (const raw of m[1].split(',')) {
          const token = raw.trim().toUpperCase();
          if (EDGE_ID.test(token)) found.edges.add(token);
          else if (/^FR-[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(token)) found.reqs.add(token);
        }
      }
      claims.set(key, found);
    });
  }

  // ── 1. the recorded profile was honoured ─────────────────────────────────
  //
  // A decision is recorded against a PATH, but a plan may legitimately name
  // its files differently (a second plan, an ADR whose title became the
  // filename, a per-module diagram). The floor therefore resolves every
  // recorded path and every file on disk to a FAMILY — the rule's path
  // pattern — and proves the decision against the family. Without that, a
  // recorded "create decisions/NNNN-<title>.md" could never be satisfied by
  // the real file "decisions/0001-store-engine.md", and every such plan
  // reported PROFILE_CREATE_MISSING forever.
  const profile = readProfile(answers, planText);
  const families = artifactFamilies();
  if (!profile) {
    // The floor's principle: it reports what it can PROVE. A missing profile
    // means artifact necessity CANNOT be checked — that is a warning, and
    // the gate brief asks the reviewer to judge it. (An artifact that exists
    // while a profile IS recorded is a different case: PROFILE_UNRECORDED,
    // and that one blocks.)
    warnings.push(finding('PROFILE_NOT_RECORDED', WARNING_CODES.PROFILE_NOT_RECORDED));
  } else {
    const projectRoot = projectRootOf(slugDir);
    const onDisk = listArtifacts(slugDir);
    /** The files that physically exist, for the create/omit/reuse checks. */
    const presentIn = (family, recordedPath) => {
      // The family ASSIGNMENT, not the pattern match. `docs/prd.md` and
      // `docs/<module>.md` are different families that OVERLAP as patterns:
      // matching the pattern let a PRD satisfy the module-diagram family's
      // decision, so a missing diagram passed and a present PRD blocked a
      // plan that said omit.
      const byFamily = onDisk.filter((f) => familyOf(f, families) === family);
      if (byFamily.length) return byFamily;
      // `answers.yaml` carries the profile itself, so it is exempt from the
      // "needs a decision" list — but it still exists, and an `omit` or
      // `reuse` decision about it must be honoured.
      if (recordedPath && existsUnder(slugDir, recordedPath)) {
        return [normalizeArtifactPath(recordedPath)];
      }
      return [];
    };
    /** family -> the recorded decision for it. */
    const decided = new Map();
    for (const a of profile.artifacts ?? []) {
      const path = String(a?.path ?? '').trim();
      const decision = String(a?.decision ?? '').trim().toLowerCase();
      if (!path) continue;
      const rel = normalizeArtifactPath(path);
      const family = familyOf(rel, families);
      // A family may be named more than once (two plan files, two ADRs); the
      // FIRST decision wins, and the rest are checked against the same family.
      if (!decided.has(family)) {
        decided.set(family, {
          path,
          decision,
          reason: String(a?.reason ?? '').trim(),
          hostPath: String(a?.host_path ?? '').trim(),
        });
      }
      if (decision === 'create') {
        const present = presentIn(family, path);
        // The recorded path's OWN existence counts. `answers.yaml` is where
        // the profile is RECORDED, so it is deliberately exempt from the
        // "needs a decision" list — but it is still an artifact the profile
        // marks `create`, and the create check has to see it. Without this
        // a MEDIUM/LARGE plan could never satisfy its own profile.
        if (!present.length && !existsUnder(slugDir, path)) {
          issues.push(
            finding(
              'PROFILE_CREATE_MISSING',
              `the profile marks '${path}' as create, but no file matching '${family ?? path}' exists under the artifact space`,
            ),
          );
        }
      } else if (decision === 'omit') {
        const present = presentIn(family, path);
        if (present.length) {
          issues.push(
            finding(
              'PROFILE_OMIT_PRESENT',
              `the profile marks '${path}' as omit, but '${present.join(', ')}' exists — delete it or record the decision`,
            ),
          );
        }
      } else if (decision === 'reuse') {
        const host = String(a?.host_path ?? '').trim();
        if (!host) {
          // A reuse decision without the host file it cites is a decision
          // about nothing: the floor cannot check it, and the reader cannot
          // find what the plan reused.
          issues.push(
            finding(
              'PROFILE_DECISION_INVALID',
              `'${path}' is marked reuse but records no host_path — name the existing repository file it cites`,
            ),
          );
        } else if (!existsUnder(projectRoot, host)) {
          issues.push(
            finding(
              'PROFILE_REUSE_MISSING',
              `the profile marks '${path}' as reuse of '${host}', but that file does not exist`,
            ),
          );
        }        // A REUSE decision means "the host owns this fact — do not write a
        // copy". A generated copy of a host document is the defect the
        // artifact-necessity mechanism exists to prevent.
        const present = presentIn(family, path);
        if (present.length) {
          issues.push(
            finding(
              'PROFILE_OMIT_PRESENT',
              `the profile marks '${path}' as reuse of '${host}', but '${present.join(', ')}' exists — ` +
                'delete the copy and cite the host file',
            ),
          );
        }
      } else {
        issues.push(
          finding('PROFILE_DECISION_INVALID', `'${path}' has an unknown decision '${a.decision}'`),
        );
      }
    }
    // Every artifact on disk needs a decision: an artifact without a consumer
    // is the defect this whole mechanism exists to prevent.
    for (const artifact of onDisk) {
      const family = familyOf(artifact, families) ?? artifact;
      if (!decided.has(family)) {
        issues.push(
          finding(
            'PROFILE_UNRECORDED',
            `'${artifact}' exists but the profile records no create/reuse/omit decision for it`,
          ),
        );
      }
    }
  }

  // ── 2. the mirrored test tree ────────────────────────────────────────────
  const roots = sourceAndTestRoots(architecture);
  if (!roots.enforced) {
    // FAIL LOUD: a rule that cannot run must say so, not quietly pass.
    //
    // It is a WARNING, not a block, and that is deliberate: the floor
    // reports what it can PROVE. Without declared roots it cannot prove the
    // mirrored-tree invariant — it does not know where the host keeps its
    // tests — so the layout becomes the REVIEWER's judgement, named loudly
    // instead of silently passing. The declared-path and decision-file rules
    // do not need the roots, so they still run.
    //
    // A file that is PRESENT and unparseable is a different case: the roots
    // are missing because the file is broken, not because it was never
    // written. CONFIG_UNPARSEABLE already says that — repeating it as "no
    // architecture.yaml" sent the agent to declare roots instead of fixing
    // the syntax error.
    if (!architectureFile.error) {
      warnings.push(
        finding(
          'CONFIG_NOT_ENFORCED',
          architecture
            ? 'the mirrored-test-tree rule is NOT ENFORCED — architecture.yaml does not declare usable toolchain.source_root and toolchain.test_root'
            : 'no architecture.yaml — the mirrored-test-tree, declared-path and decision-file rules are NOT ENFORCED',
        ),
      );
    }
  } else {
    for (const t of tasks) {
      const id = String(t?.id ?? '');
      for (const raw of ownedPaths(t)) {
        const glob = normalizeGlob(raw);
        if (glob !== roots.sourceRoot && !glob.startsWith(`${roots.sourceRoot}/`)) continue;
        // THE MIRROR: the path under the source root, preserved, under the
        // DECLARED test root. `src/features/catalog/api/x.ts` with
        // `test_root: tests/unit` → `tests/unit/features/catalog/api/x.ts`.
        //
        // The test root is DECLARED, so no path convention is hardcoded: the
        // floor never guesses a `tests/` prefix, a `unit/` level, or any
        // other layout. The host owns its tree; the floor only checks that
        // the mirror exists.
        const under = glob === roots.sourceRoot ? '' : glob.slice(roots.sourceRoot.length + 1);
        const dir = under.split('/').slice(0, -1).join('/');
        const mirroredDir = dir ? `${roots.testRoot}/${dir}` : roots.testRoot;
        const covered = tasks.some((o) =>
          ownedPaths(o).some((og) => globsMayOverlap(normalizeGlob(og), `${mirroredDir}/**`)),
        );
        if (!covered) {
          issues.push(
            finding(
              'MIRROR_MISSING',
              `task '${id}' owns '${glob}' but no task owns the mirrored test path '${mirroredDir}/**' ` +
                '(code-standards: the test tree is a sibling and mirrors the source path under the declared test_root)',
            ),
          );
        }
      }
    }
  }

  // ── 3. edge-case matrix traceability AND the explicit claim link ─────────
  const matrixRows = parseEdgeMatrix(planText);
  const definedEdges = new Set(matrixRows.map((r) => String(r.row).trim().toUpperCase()));
  // Did ANY acceptance declare which edge row it covers? The convention is
  // detected by use, and a plan that has rows but declares nothing has an
  // UNBOUND matrix: the rows exist, but nothing proves they are verified.
  const edgeClaimsUsed = [...claims.values()].some((c) => c.edges.size > 0);
  for (const row of matrixRows) {
    const edgeId = String(row.row).trim().toUpperCase();
    if (row.placeholder) {
      issues.push(
        finding(
          'MATRIX_CITATION_UNRESOLVED',
          `edge-case matrix row '${edgeId}' still cites the template placeholder '${row.task}#${row.index}' — ` +
            'replace it with <task-id>#<acceptance index>',
        ),
      );
      continue;
    }
    const acc = acceptanceOf(row.task);
    const cited = acc[row.index - 1] ?? null;
    const key = `${row.task}#${row.index}`;
    const claimed = claims.get(key);
    const claimOk = claimed ? claimed.edges.has(edgeId) : false;
    maps.edgeMatrix.push({
      row: edgeId,
      case: row.case,
      expected: row.expected ?? '',
      task: row.task,
      index: row.index,
      acceptance: cited,
      claims: claimed ? [...claimed.edges] : [],
      valid: Boolean(cited),
      claimOk,
    });
    if (!byId.has(row.task)) {
      issues.push(finding('MATRIX_UNKNOWN_TASK', `edge-case matrix row '${edgeId}' cites unknown task '${row.task}'`));
    } else if (!cited) {
      issues.push(
        finding(
          'MATRIX_INDEX_OUT_OF_RANGE',
          `edge-case matrix row '${edgeId}' cites ${row.task}#${row.index}, but '${row.task}' has ${acc.length} acceptance criteria`,
        ),
      );
    } else if (edgeClaimsUsed && !claimOk) {
      // The explicit link: the acceptance the row points at does not claim the
      // row. Either the citation is wrong or the acceptance does not cover it.
      const claimedElsewhere = [...claims.entries()]
        .filter(([, c]) => c.edges.has(edgeId))
        .map(([k]) => k);
      const detail = claimedElsewhere.length
        ? `the acceptance that claims it is ${claimedElsewhere.join(', ')}`
        : 'no acceptance claims it';
      issues.push(
        finding(
          'MATRIX_CLAIM_MISMATCH',
          `edge-case matrix row '${edgeId}' cites ${row.task}#${row.index}, but that acceptance does not claim '${edgeId}' — ${detail}. ` +
            `Fix the citation or add "(covers ${edgeId})" to the acceptance.`,
        ),
      );
    }
  }
  // A matrix whose rows are never claimed is an UNBOUND matrix. The floor
  // used to say nothing here, so the reference's promise ("the floor reports
  // that the claims are not declared") was false and the gap was invisible.
  if (matrixRows.length && !edgeClaimsUsed) {
    issues.push(
      finding(
        'MATRIX_CLAIMS_UNDECLARED',
        `the plan has ${matrixRows.length} edge-case row(s) but no acceptance declares which row it covers — ` +
          'add "(covers E4)" to the acceptance each row cites, so the floor can bind the two sides',
      ),
    );
  }
  // An acceptance may not claim an edge row that does not exist.
  if (matrixRows.length) {
    for (const [key, c] of claims) {
      for (const edge of c.edges) {
        if (!definedEdges.has(edge)) {
          issues.push(finding('MATRIX_DANGLING_CLAIM', `acceptance ${key} claims edge case '${edge}' but no matrix row defines it`));
        }
      }
    }
  }

  // ── 4. requirement coverage ──────────────────────────────────────────────
  if (prdText) {
    const defined = new Map();
    for (const m of prdText.matchAll(/^\s*[-*]?\s*(FR-[A-Z0-9]+(?:-[A-Z0-9]+)*)\s*[:—]\s*(.*)$/gm)) {
      defined.set(m[1], m[2].trim());
    }
    const cited = new Map();
    for (const t of tasks) {
      const id = String(t?.id ?? '');
      acceptanceList(t).forEach((a, i) => {
        const text = String(a);
        const ids = new Set([...text.matchAll(FR_ID)].map((m) => m[0]));
        for (const m of text.matchAll(CLAIMS)) {
          for (const raw of m[1].split(',')) {
            const token = raw.trim().toUpperCase();
            if (/^FR-[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(token)) ids.add(token);
          }
        }
        for (const fr of ids) {
          if (!cited.has(fr)) cited.set(fr, []);
          cited.get(fr).push({ ref: `${id}#${i + 1}`, text });
        }
      });
    }
    for (const [id, text] of defined) {
      const where = cited.get(id) ?? [];
      maps.requirements.push({
        id,
        text,
        citedBy: where.map((w) => w.ref),
        acceptanceText: where[0]?.text ?? null,
        covered: where.length > 0,
      });
      if (!where.length) {
        issues.push(finding('REQ_UNCITED', `requirement '${id}' is defined in docs/prd.md but no task acceptance cites it`));
      }
    }
    for (const [id, where] of cited) {
      if (!defined.has(id)) {
        issues.push(
          finding(
            'REQ_UNKNOWN',
            `task acceptance cites requirement '${id}' (${where.map((w) => w.ref).join(', ')}) which is not defined in docs/prd.md`,
          ),
        );
      }
    }
  }

  // ── 5. declared decisions exist on disk ──────────────────────────────────
  for (const d of architecture?.decisions ?? []) {
    const id = String(d?.id ?? '');
    const title = String(d?.title ?? '');
    const n = /^D(\d+)$/i.exec(id);
    const file = n
      ? decisionFiles.find((f) => f.startsWith(String(Number(n[1])).padStart(4, '0')))
      : decisionFiles.find((f) => slug(title) && f.includes(slug(title)));
    maps.decisions.push({ id, title, file: file ?? null, exists: Boolean(file) });
    if (!file) {
      issues.push(finding('DECISION_MISSING', `architecture.yaml declares decision '${id}' but no decisions/ file matches it`));
    }
  }

  // ── 6. every declared path has an owner ──────────────────────────────────
  const declared = [];
  for (const s of architecture?.structure ?? []) {
    if (typeof s?.path === 'string' && !s.path.includes('<')) declared.push(s.path);
  }
  for (const mod of architecture?.modules ?? []) {
    for (const o of mod?.owns ?? []) if (typeof o === 'string' && !o.includes('<')) declared.push(o);
  }
  for (const p of declared) {
    const covered = tasks.some((t) => ownedPaths(t).some((g) => globsMayOverlap(g, p)));
    if (!covered) issues.push(finding('PATH_UNOWNED', `architecture.yaml declares '${p}' but no task owns it`));
  }

  // ── 7. wave labels agree with the DAG ────────────────────────────────────
  const groups = new Map();
  for (const t of tasks) {
    const id = String(t?.id ?? '');
    const g = typeof t?.parallel_group === 'string' ? t.parallel_group.trim() : '';
    if (!g) continue;
    const m = /wave[-_ ]?(\d+)/i.exec(g);
    const wave = waveOf.get(id);
    if (m && wave && Number(m[1]) !== wave) {
      issues.push(
        finding(
          'WAVE_LABEL_DRIFT',
          `task '${id}' is labeled parallel_group '${g}' but its dependency wave is ${wave} — recompute the label from the DAG or drop it`,
        ),
      );
    }
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(id);
  }
  for (const [g, ids] of groups) {
    const ws = new Set(ids.map((id) => waveOf.get(id)).filter(Boolean));
    if (ws.size > 1) {
      issues.push(
        finding(
          'WAVE_GROUP_SPANS',
          `parallel_group '${g}' spans ${ws.size} dependency waves (${ids.join(', ')}) — tasks in one group must share a wave`,
        ),
      );
    }
  }

  // ── 8. ownership containment across waves ────────────────────────────────
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i];
      const b = tasks[j];
      if (waveOf.get(String(a?.id)) === waveOf.get(String(b?.id))) continue; // same wave is already an error
      for (const g1 of ownedPaths(a)) {
        for (const g2 of ownedPaths(b)) {
          if (containsGlob(g1, g2)) {
            warnings.push(
              finding(
                'OWNERSHIP_CONTAINED',
                `task '${b.id}' owns '${g2}', which is INSIDE '${g1}' owned by '${a.id}' — a later wave can overwrite the earlier task's files`,
              ),
            );
          } else if (containsGlob(g2, g1)) {
            warnings.push(
              finding(
                'OWNERSHIP_CONTAINED',
                `task '${a.id}' owns '${g1}', which is INSIDE '${g2}' owned by '${b.id}' — a later wave can overwrite the earlier task's files`,
              ),
            );
          }
        }
      }
    }
  }

  // ── 9. the waiver ledger and the recorded gate ───────────────────────────
  //
  // A WAIVER IS AN APPROVED DEVIATION. The references say so in three places
  // ("a waived finding is not a defect to fix", "the verifier must not
  // re-raise it"). The floor used to read the ledger and then ignore it: the
  // finding stayed an issue, the verdict stayed ISSUES, and a plan could
  // never be approved no matter what the user had signed off. The waiver now
  // SUPPRESSES the findings it covers, and the suppressed list is reported so
  // the deviation stays visible.
  const waiverIssues = [];
  const validWaivers = [];
  for (const w of waivers) {
    const missing = [];
    if (!w.scope.length) missing.push('scope');
    if (!w.finding.trim()) missing.push('finding');
    if (!w.reason.trim()) missing.push('reason');
    if (!w.approvedBy.trim()) missing.push('approved_by');
    if (!w.approvedAt.trim()) missing.push('approved_at');
    // A BARE WILDCARD is not a scope — it is a blanket. `scope: ["*"]`
    // matched every subject of every finding, so one line in the ledger
    // approved the entire plan.
    const blanket = w.scope.filter((s) => /^\*+$/.test(String(s).trim()));
    if (blanket.length) missing.push(`a scope of ${blanket.join(', ')} (a bare wildcard approves everything)`);
    if (missing.length) {
      waiverIssues.push(
        finding(
          'WAIVER_INVALID',
          `waiver ${w.id || '(unnamed)'} is missing ${missing.join(', ')} — a waiver without a reason and an approver is not an approval`,
        ),
      );
      continue;
    }
    validWaivers.push(w);
  }

  // Suppress the covered findings.
  const waivedFindings = [];
  const remaining = [];
  for (const issue of issues) {
    const w = validWaivers.find((v) => waiverCovers(v, issue));
    if (w) {
      waivedFindings.push({ waiver: w.id, finding: issue });
      continue;
    }
    remaining.push(issue);
  }
  issues.length = 0;
  issues.push(...remaining, ...waiverIssues);

  // The gate record. THREE PLACES, ONE SHAPE: `answers.yaml` →
  // `plan_profile.gate`, `answers.yaml` → `gate`, or the plan's own Profile
  // fence (which is where a SMALL plan keeps it). The fence is read
  // INDEPENDENTLY of `answers.yaml`: a plan may keep its artifacts in
  // answers.yaml and its gate in the fence, and the floor has to find the
  // gate wherever it was written.
  const fenceRead = readPlanProfile(planText);
  if (fenceRead.error) {
    warnings.push(
      finding('PROFILE_UNPARSEABLE', `the plan's Profile fence does not parse: ${fenceRead.error}`),
    );
  }
  const fenceProfile = fenceRead.data;
  const recorded =
    answers?.plan_profile?.gate ?? answers?.gate ?? fenceProfile?.gate ?? profile?.gate ?? null;
  if (recorded) {
    const waived = Number(recorded.waived ?? 0);
    if (Number.isFinite(waived) && waived !== waivers.length) {
      warnings.push(
        finding(
          'WAIVER_COUNT_MISMATCH',
          `the plan records ${waived} waived finding(s) but waivers.yaml lists ${waivers.length} — keep the ledger and the record in step`,
        ),
      );
    }
    if (!String(recorded.verifier ?? '').trim()) {
      warnings.push(
        finding('GATE_IDENTITY_MISSING', 'the gate block records no verifier — an approval needs a subject'),
      );
    }
  }

  // ── maps the gate agent reads instead of re-deriving ─────────────────────
  for (const t of tasks) {
    const id = String(t?.id ?? '');
    const globs = ownedPaths(t);
    maps.ownership.push({ id, globs, wave: waveOf.get(id) ?? null });
  }
  for (const mod of architecture?.modules ?? []) {
    const name = String(mod?.name ?? '');
    const owns = (mod?.owns ?? []).filter((o) => typeof o === 'string');
    const ownedBy = tasks
      .filter((t) => ownedPaths(t).some((g) => owns.some((o) => globsMayOverlap(g, o))))
      .map((t) => String(t.id));
    maps.modules.push({
      name,
      dependsOn: (mod?.depends_on_modules ?? []).map(String),
      ownedBy,
    });
  }

  return {
    issues,
    warnings,
    issuesTotal: issues.length,
    warningsTotal: warnings.length,
    issueCodes: countCodes(issues),
    warningCodes: countCodes(warnings),
    // The findings a waiver approved. They are NOT issues — but they are
    // reported, so the deviation stays visible to the next reviewer.
    waivedFindings,
    waivedCodes: countCodes(waivedFindings.map((w) => w.finding)),
    maps,
    waivers,
    profile,
    snapshot: planSnapshot(tasks, maps, planText, prdText, architecture),
  };
}

/** Count findings by their stable code (the prefix before the colon). */
function countCodes(list) {
  const out = {};
  for (const m of list) {
    const code = String(m).split(':')[0];
    out[code] = (out[code] ?? 0) + 1;
  }
  return out;
}

/**
 * What the brief claims about the plan — and how to tell it is STALE.
 *
 * The brief is rendered once, at dispatch. If the plan changes afterwards,
 * the agent would judge content the brief never described. The snapshot is
 * the cheap check: the counts are readable, so the agent can compare what it
 * reads against what it was handed, and the fingerprint lets the orchestrator
 * prove it.
 */
export function planSnapshot(tasks, maps, planText, prdText, architecture) {
  const rows = maps?.edgeMatrix ?? [];
  const fingerprint = createHash('sha256')
    .update(
      [JSON.stringify(tasks ?? []), planText ?? '', prdText ?? '', JSON.stringify(architecture ?? null)].join('\n'),
    )
    .digest('hex')
    .slice(0, 12);
  return {
    tasks: Array.isArray(tasks) ? tasks.length : 0,
    requirements: (maps?.requirements ?? []).length,
    edgeRows: rows.length,
    linkedRows: rows.filter((r) => r.valid && r.claimOk).length,
    fingerprint: `sha256:${fingerprint}`,
  };
}

/**
 * The recorded plan profile.
 *
 * MEDIUM/LARGE keep it in `answers.yaml` (`plan_profile`); SMALL keeps it in
 * the plan's Profile section as a fenced YAML block. Both are machine-readable,
 * so the floor can check the recorded decisions against the files on disk.
 *
 * @param {object|null} answers the parsed answers.yaml
 * @param {string} planText the plan markdown
 * @returns {{artifacts: Array<object>, scope_class?: string}|null}
 */
export function readProfile(answers, planText) {
  const fromAnswers = answers?.plan_profile ?? answers?.profile ?? null;
  if (fromAnswers && Array.isArray(fromAnswers.artifacts)) return fromAnswers;
  const fence = readPlanProfile(planText).data;
  // A fence with NO artifact decisions is not an artifact profile. Returning
  // it would make the decision set EMPTY, and every artifact on disk would
  // then read as PROFILE_UNRECORDED — a plan that records no artifact
  // profile at all would BLOCK the floor instead of warning about it.
  // The fence's GATE is read separately, at the gate check.
  if (fence && Array.isArray(fence.artifacts)) return fence;
  return null;
}

/**
 * The Profile section's fenced YAML block — the SMALL plan's record.
 *
 * @param {string} planText
 * @returns {{data: {artifacts: Array<object>}|null, error: string|null}}
 *   `error` is set when the fence is present and does not parse — an absent
 *   fence is not an error.
 */
export function readPlanProfile(planText) {
  const text = String(planText ?? '');
  const heading = /^(#{1,4})[^\n]*profile[^\n]*$/im.exec(text);
  if (!heading) return { data: null, error: null };
  const level = heading[1].length;
  // The fence must be INSIDE the Profile section. Scanning the rest of the
  // document for the first ```yaml block adopted an APPENDIX's block as the
  // plan's profile — and the floor then blocked on a record it invented.
  const after = text.slice(heading.index + heading[0].length);
  const nextHeading = new RegExp(`^#{1,${level}}\\s`, 'm').exec(after);
  const section = nextHeading ? after.slice(0, nextHeading.index) : after;
  const fence = /```ya?ml\s*\n([\s\S]*?)```/i.exec(section);
  if (!fence) return { data: null, error: null };
  try {
    const data = parseYaml(fence[1], { filename: 'plan-profile' }).data;
    if (!data || typeof data !== 'object') return { data: null, error: null };
    // The fence counts as a profile record when it carries the artifact
    // decisions OR a gate block. A fence holding only `gate:` used to be
    // skipped entirely, so the gate was never checked at all.
    if (Array.isArray(data.artifacts) || data.gate) return { data, error: null };
    return { data: null, error: null };
  } catch (e) {
    return { data: null, error: String(e?.message ?? e) };
  }
}

/**
 * The artifact FAMILIES a plan's files fall into.
 *
 * A family is the ladder rule's path PATTERN: `plans/*.md` is the family of
 * every plan file, `decisions/*.md` the family of every decision record. The
 * recorded decision is proved against the family, so a plan may name its
 * files as it likes without the floor calling a satisfied decision missing.
 *
 * @returns {Array<{pattern: string, literals: number}>} most specific first
 */
let FAMILY_CACHE = null;