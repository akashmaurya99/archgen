// plan-audit.mjs — the MECHANICAL floor of the gate.
//
// WHY THIS MODULE EXISTS.
//
// The gate agent was doing arithmetic by hand, every round: checking that a
// source-owning task owns the mirrored test path, that an edge-case matrix row
// points at an acceptance that exists, that every PRD requirement is cited, that
// a declared decision file is on disk, that a declared path has an owner, that
// a wave label matches the DAG. Those are all FACTS, and facts belong in a
// tool: an agent re-deriving them burns rounds, misses some, and reports
// "small small issues" one category at a time.
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
//
// It is also language-neutral BY CONSTRUCTION: the ids it joins are artifact
// ids (edge rows, requirement ids, task ids), never code-level names.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from './yaml.mjs';
import { buildGraph, computeWaves, globsMayOverlap } from './graph.mjs';

/** A requirement id: FR-<MODULE>-nn. */
const FR_ID = /\bFR-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g;
/** An edge-case row id: E1, E12. */
const EDGE_ID = /^E\d+$/;
/** A matrix citation: <task-id>#<acceptance index>. */
const MATRIX_REF = /([A-Za-z0-9][A-Za-z0-9._-]*)#(\d+)/g;
/** What an acceptance claims to cover: "(covers E4, FR-API-01)". */
const CLAIMS = /\bcovers\s+([A-Z][A-Z0-9-]*(?:\s*,\s*[A-Z][A-Z0-9-]*)*)/gi;

/**
 * Audit one plan's artifacts.
 *
 * @param {{slugDir: string, tasks: any[]}} input
 * @returns {{issues: string[], warnings: string[], maps: object, waivers: object[]}}
 */
export function auditPlan({ slugDir, tasks }) {
  const issues = [];
  const warnings = [];
  const maps = { requirements: [], edgeMatrix: [], ownership: [], modules: [], decisions: [] };
  if (!slugDir || !Array.isArray(tasks) || tasks.length === 0) return { issues, warnings, maps, waivers: [] };

  const architecture = readYaml(join(slugDir, 'architecture.yaml'));
  const prdText = readText(join(slugDir, 'docs', 'prd.md'));
  const planText = readPlans(join(slugDir, 'plans'));
  const decisionFiles = listFiles(join(slugDir, 'decisions'));
  const waivers = readWaivers(join(slugDir, 'waivers.yaml'));

  const byId = new Map(tasks.map((t) => [String(t?.id ?? ''), t]));
  const acceptanceOf = (id) => (byId.get(id)?.acceptance ?? []).map(String);

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
  let claimsUsed = false;
  for (const t of tasks) {
    const id = String(t?.id ?? '');
    (t?.acceptance ?? []).forEach((a, i) => {
      const text = String(a);
      const key = `${id}#${i + 1}`;
      const found = { edges: new Set(), reqs: new Set() };
      for (const m of text.matchAll(CLAIMS)) {
        for (const raw of m[1].split(',')) {
          const token = raw.trim().toUpperCase();
          if (EDGE_ID.test(token)) found.edges.add(token);
          else if (/^FR-[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(token)) found.reqs.add(token);
          if (found.edges.size || found.reqs.size) claimsUsed = true;
        }
      }
      claims.set(key, found);
    });
  }

  // ── 1. the mirrored test tree ────────────────────────────────────────────
  const roots = sourceAndTestRoots(architecture);
  if (!roots.enforced) {
    // FAIL LOUD: a rule that cannot run must say so, not quietly pass.
    warnings.push(
      architecture
        ? 'the mirrored-test-tree rule is NOT ENFORCED — declare toolchain.source_root and toolchain.test_root in architecture.yaml'
        : 'no architecture.yaml — the mirrored-test-tree, declared-path and decision-file rules are NOT ENFORCED',
    );
  } else {
    for (const t of tasks) {
      const id = String(t?.id ?? '');
      for (const g of t?.file_ownership ?? []) {
        if (!g.startsWith(`${roots.sourceRoot}/`)) continue;
        const rest = g.slice(roots.sourceRoot.length + 1);
        // The mirror is checked at DIRECTORY level: the test FILE NAME belongs
        // to the ecosystem's own naming rule, the test PATH does not.
        const dir = rest.split('/').slice(0, -1).join('/');
        const mirroredDir = dir ? `${roots.testRoot}/${dir}` : roots.testRoot;
        const covered = tasks.some((o) =>
          (o?.file_ownership ?? []).some((og) => globsMayOverlap(og, mirroredDir)),
        );
        if (!covered) {
          issues.push(
            `task '${id}' owns '${g}' but no task owns the mirrored test path '${mirroredDir}/**' ` +
              '(code-standards: the test tree is a sibling and mirrors the source path)',
          );
        }
      }
    }
  }

  // ── 2. edge-case matrix traceability AND the explicit claim link ─────────
  const matrixRows = parseEdgeMatrix(planText);
  const definedEdges = new Set(matrixRows.map((r) => String(r.row).trim().toUpperCase()));
  for (const row of matrixRows) {
    const acc = acceptanceOf(row.task);
    const cited = acc[row.index - 1] ?? null;
    const key = `${row.task}#${row.index}`;
    const claimed = claims.get(key);
    const edgeId = String(row.row).trim().toUpperCase();
    const claimOk = claimed ? claimed.edges.has(edgeId) : false;
    maps.edgeMatrix.push({
      row: edgeId,
      case: row.case,
      task: row.task,
      index: row.index,
      acceptance: cited,
      claims: claimed ? [...claimed.edges] : [],
      valid: Boolean(cited),
      claimOk,
    });
    if (!byId.has(row.task)) {
      issues.push(`edge-case matrix row '${edgeId}' cites unknown task '${row.task}'`);
    } else if (!cited) {
      issues.push(
        `edge-case matrix row '${edgeId}' cites ${row.task}#${row.index}, but '${row.task}' has ${acc.length} acceptance criteria`,
      );
    } else if (claimsUsed && !claimOk) {
      // The explicit link: the acceptance the row points at does not claim the
      // row. Either the citation is wrong or the acceptance does not cover it.
      const claimedElsewhere = [...claims.entries()]
        .filter(([, c]) => c.edges.has(edgeId))
        .map(([k]) => k);
      const detail = claimedElsewhere.length
        ? `the acceptance that claims it is ${claimedElsewhere.join(', ')}`
        : 'no acceptance claims it';
      issues.push(
        `edge-case matrix row '${edgeId}' cites ${row.task}#${row.index}, but that acceptance does not claim '${edgeId}' — ${detail}. ` +
          'Fix the citation or add "(covers ' + edgeId + ')" to the acceptance.',
      );
    }
  }
  // An acceptance may not claim an edge row that does not exist.
  if (matrixRows.length) {
    for (const [key, c] of claims) {
      for (const edge of c.edges) {
        if (!definedEdges.has(edge)) {
          issues.push(`acceptance ${key} claims edge case '${edge}' but no matrix row defines it`);
        }
      }
    }
  }

  // ── 3. requirement coverage ──────────────────────────────────────────────
  if (prdText) {
    const defined = new Map();
    for (const m of prdText.matchAll(/^\s*[-*]?\s*(FR-[A-Z0-9]+(?:-[A-Z0-9]+)*)\s*[:—]\s*(.*)$/gm)) {
      defined.set(m[1], m[2].trim());
    }
    const cited = new Map();
    for (const t of tasks) {
      const id = String(t?.id ?? '');
      (t?.acceptance ?? []).forEach((a, i) => {
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
        issues.push(`requirement '${id}' is defined in docs/prd.md but no task acceptance cites it`);
      }
    }
    for (const [id, where] of cited) {
      if (!defined.has(id)) {
        issues.push(
          `task acceptance cites requirement '${id}' (${where.map((w) => w.ref).join(', ')}) which is not defined in docs/prd.md`,
        );
      }
    }
  }

  // ── 4. declared decisions exist on disk ──────────────────────────────────
  for (const d of architecture?.decisions ?? []) {
    const id = String(d?.id ?? '');
    const title = String(d?.title ?? '');
    const n = /^D(\d+)$/i.exec(id);
    const file = n
      ? decisionFiles.find((f) => f.startsWith(String(Number(n[1])).padStart(4, '0')))
      : decisionFiles.find((f) => slug(title) && f.includes(slug(title)));
    maps.decisions.push({ id, title, file: file ?? null, exists: Boolean(file) });
    if (!file) {
      issues.push(`architecture.yaml declares decision '${id}' but no decisions/ file matches it`);
    }
  }

  // ── 5. every declared path has an owner ──────────────────────────────────
  const declared = [];
  for (const s of architecture?.structure ?? []) {
    if (typeof s?.path === 'string' && !s.path.includes('<')) declared.push(s.path);
  }
  for (const mod of architecture?.modules ?? []) {
    for (const o of mod?.owns ?? []) if (typeof o === 'string' && !o.includes('<')) declared.push(o);
  }
  for (const p of declared) {
    const covered = tasks.some((t) => (t?.file_ownership ?? []).some((g) => globsMayOverlap(g, p)));
    if (!covered) issues.push(`architecture.yaml declares '${p}' but no task owns it`);
  }

  // ── 6. wave labels agree with the DAG ────────────────────────────────────
  const groups = new Map();
  for (const t of tasks) {
    const id = String(t?.id ?? '');
    const g = typeof t?.parallel_group === 'string' ? t.parallel_group.trim() : '';
    if (!g) continue;
    const m = /wave[-_ ]?(\d+)/i.exec(g);
    const wave = waveOf.get(id);
    if (m && wave && Number(m[1]) !== wave) {
      issues.push(
        `task '${id}' is labeled parallel_group '${g}' but its dependency wave is ${wave} — recompute the label from the DAG or drop it`,
      );
    }
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(id);
  }
  for (const [g, ids] of groups) {
    const ws = new Set(ids.map((id) => waveOf.get(id)).filter(Boolean));
    if (ws.size > 1) {
      issues.push(
        `parallel_group '${g}' spans ${ws.size} dependency waves (${ids.join(', ')}) — tasks in one group must share a wave`,
      );
    }
  }

  // ── 7. ownership containment across waves ────────────────────────────────
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i];
      const b = tasks[j];
      if (waveOf.get(String(a?.id)) === waveOf.get(String(b?.id))) continue; // same wave is already an error
      for (const g1 of a?.file_ownership ?? []) {
        for (const g2 of b?.file_ownership ?? []) {
          if (containsGlob(g1, g2)) {
            warnings.push(
              `task '${b.id}' owns '${g2}', which is INSIDE '${g1}' owned by '${a.id}' — a later wave can overwrite the earlier task's files`,
            );
          } else if (containsGlob(g2, g1)) {
            warnings.push(
              `task '${a.id}' owns '${g1}', which is INSIDE '${g2}' owned by '${b.id}' — a later wave can overwrite the earlier task's files`,
            );
          }
        }
      }
    }
  }

  // ── 8. the waiver ledger and the recorded gate metrics ───────────────────
  const answers = readYaml(join(slugDir, 'answers.yaml'));
  const recorded = answers?.plan_profile?.gate ?? answers?.gate ?? null;
  if (recorded) {
    const waived = Number(recorded.waived ?? 0);
    if (Number.isFinite(waived) && waived !== waivers.length) {
      warnings.push(
        `the plan records ${waived} waived finding(s) but waivers.yaml lists ${waivers.length} — keep the ledger and the record in step`,
      );
    }
  }

  // ── maps the gate agent reads instead of re-deriving ─────────────────────
  for (const t of tasks) {
    const id = String(t?.id ?? '');
    const globs = t?.file_ownership ?? [];
    maps.ownership.push({ id, globs, wave: waveOf.get(id) ?? null });
  }
  for (const mod of architecture?.modules ?? []) {
    const name = String(mod?.name ?? '');
    const owns = (mod?.owns ?? []).filter((o) => typeof o === 'string');
    const ownedBy = tasks
      .filter((t) => (t?.file_ownership ?? []).some((g) => owns.some((o) => globsMayOverlap(g, o))))
      .map((t) => String(t.id));
    maps.modules.push({
      name,
      dependsOn: (mod?.depends_on_modules ?? []).map(String),
      ownedBy,
    });
  }

  return { issues, warnings, maps, waivers };
}

/**
 * The source and test roots — DECLARED, never guessed.
 *
 * The host repo owns its layout. If `architecture.yaml` does not declare the
 * roots, the mirrored-tree rule cannot run: it is reported as NOT ENFORCED
 * rather than guessed from a path prefix (a guess would be wrong for half the
 * ecosystems, and a wrong guess that silently skips a check is worse than no
 * check).
 *
 * @returns {{enforced: boolean, sourceRoot: string|null, testRoot: string|null}}
 */
export function sourceAndTestRoots(architecture) {
  const tool = architecture?.toolchain ?? {};
  const src = typeof tool.source_root === 'string' ? tool.source_root.trim() : '';
  const tst = typeof tool.test_root === 'string' ? tool.test_root.trim() : '';
  const usable = (v) => Boolean(v) && !v.startsWith('<') && !v.includes('<');
  if (usable(src) && usable(tst)) {
    return { enforced: true, sourceRoot: src.replace(/\/+$/, ''), testRoot: tst.replace(/\/+$/, '') };
  }
  return { enforced: false, sourceRoot: null, testRoot: null };
}

/**
 * Parse the edge-case matrices out of the plan markdown.
 *
 * A matrix is a markdown table with a `Covered by` column; each body row's
 * citations are `<task-id>#<index>`. The returned rows are the raw claims —
 * the audit checks that each citation RESOLVES and that the acceptance it
 * points at CLAIMS the row, and the map lets the gate agent judge whether it
 * MEANS what the row says.
 */
export function parseEdgeMatrix(planText) {
  const rows = [];
  if (!planText) return rows;
  let header = null;
  for (const line of String(planText).split('\n')) {
    const t = line.trim();
    if (!t.startsWith('|')) {
      header = null;
      continue;
    }
    const cells = t.split('|').slice(1, -1).map((c) => c.trim());
    if (!header) {
      const idx = cells.findIndex((c) => /covered by/i.test(c));
      if (idx >= 0) header = { idx };
      continue;
    }
    if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // the separator row
    const cell = cells[header.idx];
    if (!cell) continue;
    for (const m of cell.matchAll(MATRIX_REF)) {
      rows.push({
        row: cells[0] ?? '',
        case: cells.slice(1, header.idx).join(' · '),
        task: m[1],
        index: Number(m[2]),
      });
    }
  }
  return rows;
}

/** Does `container` (a recursive glob) contain `inner`? */
function containsGlob(container, inner) {
  if (!container.includes('**')) return false;
  const c = container.split('/');
  const i = String(inner).split('/');
  const prefix = c.slice(0, c.indexOf('**'));
  if (i.length < prefix.length) return false;
  return prefix.every((seg, idx) => seg === i[idx]);
}

/** A filename-ish slug of a decision title, for a best-effort file match. */
function slug(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
}

function readText(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

function readYaml(path) {
  const text = readText(path);
  if (!text) return null;
  try {
    return parseYaml(text, { filename: path }).data;
  } catch {
    return null;
  }
}

/**
 * The waiver ledger: the approved deviations, with who and why.
 *
 * A waived finding is an AUDIT EVENT, not a conversation. The file is the
 * record; the floor reports its size, and the gate brief shows it so the next
 * reviewer knows the deviation exists.
 */
export function readWaivers(path) {
  const data = readYaml(path);
  const list = Array.isArray(data?.waivers) ? data.waivers : [];
  return list
    .filter((w) => w && typeof w === 'object')
    .map((w) => ({
      id: String(w.id ?? ''),
      scope: Array.isArray(w.scope) ? w.scope.map(String) : [],
      finding: String(w.finding ?? ''),
      reason: String(w.reason ?? ''),
      approvedBy: String(w.approved_by ?? ''),
      approvedAt: String(w.approved_at ?? ''),
    }));
}

function readPlans(dir) {
  if (!existsSync(dir)) return '';
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md'))
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n');
  } catch {
    return '';
  }
}

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
}
