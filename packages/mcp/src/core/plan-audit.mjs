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
// The rule that keeps the floor honest: it reports only what it can PROVE from
// the artifacts. Anything it cannot prove is a warning (informational), never
// a blocking issue. A floor that cries wolf gets bypassed, and a bypassed
// floor is worse than no floor.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseYaml } from './yaml.mjs';
import { buildGraph, computeWaves, globsMayOverlap } from './graph.mjs';

/** A requirement id: FR-<MODULE>-nn. */
const FR_ID = /\bFR-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/g;
/** A matrix citation: <task-id>#<acceptance index>. */
const MATRIX_REF = /([A-Za-z0-9][A-Za-z0-9._-]*)#(\d+)/g;

/**
 * Audit one plan's artifacts.
 *
 * @param {{slugDir: string, tasks: any[]}} input
 * @returns {{issues: string[], warnings: string[], maps: object}}
 */
export function auditPlan({ slugDir, tasks }) {
  const issues = [];
  const warnings = [];
  const maps = { requirements: [], edgeMatrix: [], ownership: [], modules: [], decisions: [] };
  if (!slugDir || !Array.isArray(tasks) || tasks.length === 0) return { issues, warnings, maps };

  const architecture = readYaml(join(slugDir, 'architecture.yaml'));
  const prdText = readText(join(slugDir, 'docs', 'prd.md'));
  const planText = readPlans(join(slugDir, 'plans'));
  const decisionFiles = listFiles(join(slugDir, 'decisions'));

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

  // ── 1. the mirrored test tree ────────────────────────────────────────────
  const roots = sourceAndTestRoots(architecture, tasks);
  for (const t of tasks) {
    const id = String(t?.id ?? '');
    for (const g of t?.file_ownership ?? []) {
      if (!roots.sourceRoot || !g.startsWith(`${roots.sourceRoot}/`)) continue;
      const rest = g.slice(roots.sourceRoot.length + 1);
      // The mirror is checked at DIRECTORY level: the test FILE NAME belongs
      // to the language (`foo.ts` -> `foo_test.py` is legitimate), the test
      // PATH does not.
      const dir = rest.split('/').slice(0, -1).join('/');
      const mirroredDir = dir ? `${roots.testRoot}/${dir}` : roots.testRoot;
      const covered = tasks.some((o) =>
        (o?.file_ownership ?? []).some((og) => globsMayOverlap(og, mirroredDir)),
      );
      if (!covered) {
        const msg =
          `task '${id}' owns '${g}' but no task owns the mirrored test path '${mirroredDir}/**' ` +
          '(code-standards: the test tree is a sibling and mirrors the source path)';
        (roots.confidence === 'explicit' ? issues : warnings).push(msg);
      }
    }
  }

  // ── 2. edge-case matrix traceability ─────────────────────────────────────
  for (const row of parseEdgeMatrix(planText)) {
    const acc = acceptanceOf(row.task);
    const cited = acc[row.index - 1] ?? null;
    maps.edgeMatrix.push({
      row: row.row,
      case: row.case,
      task: row.task,
      index: row.index,
      acceptance: cited,
      valid: Boolean(cited),
    });
    if (!byId.has(row.task)) {
      issues.push(`edge-case matrix row '${row.row}' cites unknown task '${row.task}'`);
    } else if (!cited) {
      issues.push(
        `edge-case matrix row '${row.row}' cites ${row.task}#${row.index}, but '${row.task}' has ${acc.length} acceptance criteria`,
      );
    }
  }

  // ── 3. requirement coverage ──────────────────────────────────────────────
  if (prdText) {
    const defined = new Set();
    for (const m of prdText.matchAll(/^\s*[-*]?\s*(FR-[A-Z0-9]+(?:-[A-Z0-9]+)*)\s*[:—]/gm)) defined.add(m[1]);
    const cited = new Map();
    for (const t of tasks) {
      const id = String(t?.id ?? '');
      (t?.acceptance ?? []).forEach((a, i) => {
        for (const m of String(a).matchAll(FR_ID)) {
          if (!cited.has(m[0])) cited.set(m[0], []);
          cited.get(m[0]).push(`${id}#${i + 1}`);
        }
      });
    }
    for (const id of defined) {
      const where = cited.get(id) ?? [];
      maps.requirements.push({ id, citedBy: where, covered: where.length > 0 });
      if (!where.length) {
        issues.push(`requirement '${id}' is defined in docs/prd.md but no task acceptance cites it`);
      }
    }
    for (const [id, where] of cited) {
      if (!defined.has(id)) {
        issues.push(
          `task acceptance cites requirement '${id}' (${where.join(', ')}) which is not defined in docs/prd.md`,
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

  return { issues, warnings, maps };
}

/**
 * The source and test roots, and how sure we are about them.
 *
 * `explicit` — architecture.yaml's toolchain block names both. A missing
 * mirror is then a blocking issue.
 * `derived` — inferred from the ownership globs and the test-placement
 * convention. A missing mirror is a warning: the inference can be wrong, and
 * a wrong block is worse than a late catch.
 */
export function sourceAndTestRoots(architecture, tasks) {
  const tool = architecture?.toolchain ?? {};
  const src = typeof tool.source_root === 'string' ? tool.source_root.trim() : '';
  const tst = typeof tool.test_root === 'string' ? tool.test_root.trim() : '';
  const usable = (v) => v && !v.startsWith('<') && !v.includes('<');
  if (usable(src) && usable(tst)) {
    return { sourceRoot: src.replace(/\/+$/, ''), testRoot: tst.replace(/\/+$/, ''), confidence: 'explicit' };
  }

  // The test-placement convention names the test root: "tests/unit/<path>".
  const placement = String(architecture?.naming_conventions?.test_placement ?? '');
  const m = /((?:[\w.-]+\/)+[\w.-]+)\/<[^>]*>/.exec(placement);
  const testRoot = m ? m[1].replace(/\/+$/, '') : '';
  if (!testRoot) return { sourceRoot: null, testRoot: null, confidence: 'none' };

  // The source root is the most common leading segment of owned paths that is
  // not the test root and not a docs folder.
  const counts = new Map();
  for (const t of tasks ?? []) {
    for (const g of t?.file_ownership ?? []) {
      const seg = String(g).split('/')[0];
      if (!seg || seg === testRoot.split('/')[0] || seg === 'docs') continue;
      counts.set(seg, (counts.get(seg) ?? 0) + 1);
    }
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const sourceRoot = ranked.length === 1 || (ranked.length > 1 && ranked[0][1] > ranked[1][1]) ? ranked[0][0] : null;
  return { sourceRoot, testRoot, confidence: sourceRoot ? 'derived' : 'none' };
}

/**
 * Parse the edge-case matrices out of the plan markdown.
 *
 * A matrix is a markdown table with a `Covered by` column; each body row's
 * citations are `<task-id>#<index>`. The returned rows are the raw claims —
 * the audit checks that each citation RESOLVES, and the map lets the gate
 * agent judge whether it MEANS what the row says.
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
