// artifact-space.mjs — the primitives of an artifact space.
//
// WHY THIS FILE EXISTS. The audit needed to know what an artifact space
// CONTAINS: which family a path belongs to, which roots the plan declares,
// which files are on disk. Those primitives are filesystem and path facts —
// they are not audit rules — and they grew to the point where the audit
// module carried two responsibilities. A rule that changes must not be able
// to change how a path is read, and a path reader must not have to know
// what a rule is.
//
// One module for the space, one for the rules that judge it.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { parseYaml } from './yaml.mjs';
import { loadAsset } from '../context.mjs';

export // The asset is a PROCESS-WIDE constant, so its derived families are too.
// The cache is keyed on nothing for that reason: there is nothing to key it
// on. A project, a slug or a plan cannot change it.
let FAMILY_CACHE = null;

export function artifactFamilies() {
  if (FAMILY_CACHE) return FAMILY_CACHE;
  // The asset is the SERVER's, and it is read as a TYPED error when it is
  // missing or corrupt. Swallowing that error and continuing with an empty
  // family set made every on-disk file match the one family, and the floor
  // then told the agent to delete files that were perfectly fine. The cache
  // made it permanent: an empty array is truthy, so the poison stuck for the
  // life of the process.
  const rules = loadAsset('depth-ladder.json')?.profile?.artifactRules ?? [];
  const seen = new Set();
  const out = [];
  for (const r of rules) {
    const pattern = String(r?.pattern ?? deriveFamily(r?.path ?? '')).replace(/^\.\//, '');
    if (!pattern || seen.has(pattern)) continue;
    seen.add(pattern);
    // Specificity: a literal pattern beats a wildcard one; among wildcards,
    // the one with more literal segments wins.
    const literals = pattern.split('/').filter((s) => !s.includes('*')).length;
    out.push({ pattern, literals, wildcard: pattern.includes('*') });
  }
  out.sort((a, b) => {
    if (a.wildcard !== b.wildcard) return a.wildcard ? 1 : -1;
    if (a.literals !== b.literals) return b.literals - a.literals;
    return b.pattern.length - a.pattern.length;
  });
  FAMILY_CACHE = out;
  return out;
}

/** Derive a family pattern from a rule path when the rule carries none. */
/** Derive a family pattern from a rule path when the rule carries none. */
export function deriveFamily(path) {
  const p = normalizeArtifactPath(path);
  return p.replaceAll('<slug>', '*').replaceAll('<module>', '*').replaceAll('<title>', '*');
}

/**
 * The family a path belongs to (null when no rule claims it).
 * @param {string} rel slug-relative path
 * @param {Array<{pattern: string}>} families
 */
/**
 * The family a path belongs to (null when no rule claims it).
 * @param {string} rel slug-relative path
 * @param {Array<{pattern: string}>} families
 */
export function familyOf(rel, families) {
  const p = String(rel ?? '').replaceAll('\\', '/');
  for (const f of families) {
    if (matchesFamily(f.pattern, p)) return f.pattern;
  }
  return null;
}

/**
 * Does a path match a family pattern?
 *
 * `*` matches ONE path segment; `**` matches zero or more. The patterns are
 * the ladder's own, so this is a small, total glob — never a general one.
 */
/**
 * Does a path match a family pattern?
 *
 * `*` matches ONE path segment; `**` matches zero or more. The patterns are
 * the ladder's own, so this is a small, total glob — never a general one.
 */
export function matchesFamily(pattern, path) {
  const pat = String(pattern ?? '').replaceAll('\\', '/').split('/');
  const seg = String(path ?? '').replaceAll('\\', '/').split('/');
  const walk = (i, j) => {
    if (i === pat.length) return j === seg.length;
    const p = pat[i];
    if (p === '**') {
      for (let k = j; k <= seg.length; k++) {
        if (walk(i + 1, k)) return true;
      }
      return false;
    }
    if (j >= seg.length) return false;
    if (p.includes('*')) {
      const re = new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*')}$`);
      if (!re.test(seg[j])) return false;
    } else if (p !== seg[j]) {
      return false;
    }
    return walk(i + 1, j + 1);
  };
  return walk(0, 0);
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
    return {
      enforced: true,
      sourceRoot: normalizeRoot(src),
      testRoot: normalizeRoot(tst),
    };
  }
  return { enforced: false, sourceRoot: null, testRoot: null };
}

/**
 * A declared root, normalised.
 *
 * `./src` and `src` are the same root. The floor compared the declared root
 * against an ownership glob literally, so a plan that declared `./src` — or
 * owned `./src/core/**` — silently skipped the mirrored-tree rule and still
 * reached APPROVE. A rule that cannot run must say so, never weaken
 * silently.
 */
/**
 * A declared root, normalised.
 *
 * `./src` and `src` are the same root. The floor compared the declared root
 * against an ownership glob literally, so a plan that declared `./src` — or
 * owned `./src/core/**` — silently skipped the mirrored-tree rule and still
 * reached APPROVE. A rule that cannot run must say so, never weaken
 * silently.
 */
function normalizeRoot(root) {
  return String(root).replace(/^\.\//, '').replace(/\/+$/, '');
}

/** An ownership glob, normalised the same way a root is. */
/** An ownership glob, normalised the same way a root is. */
export function normalizeGlob(glob) {
  return String(glob).replace(/^\.\//, '');
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
/**
 * Parse the edge-case matrices out of the plan markdown.
 *
 * A matrix is a markdown table with a `Covered by` column; each body row's
 * citations are `<task-id>#<index>`. The returned rows are the raw claims —
 * the audit checks that each citation RESOLVES and that the acceptance it
 * points at CLAIMS the row, and the map lets the gate agent judge whether it
 * MEANS what the row says.
 */
/** A matrix citation: <task-id>#<acceptance index>. */
const MATRIX_REF = /([^\s|,]+)#(\d+)/g;
/** A citation that is still a TEMPLATE PLACEHOLDER (`<ID>#1`, `<task-id>#1`). */
const MATRIX_PLACEHOLDER = /[<>]/;
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
        // The EXPECTED BEHAVIOUR is what an acceptance has to verify — the
        // last column before `Covered by`. It is separated from the input
        // state because it is the judgement input: "does this acceptance
        // deliver THIS?".
        expected: header.idx > 1 ? cells[header.idx - 1] : '',
        task: m[1],
        index: Number(m[2]),
        // A row that still carries the template's placeholder was never
        // bound to an acceptance. It used to be invisible (the citation did
        // not parse), so the row escaped every traceability check.
        placeholder: MATRIX_PLACEHOLDER.test(m[1]),
      });
    }
  }
  return rows;
}

/** Does `container` (a recursive glob) contain `inner`? */
/** Does `container` (a recursive glob) contain `inner`? */
export function containsGlob(container, inner) {
  if (!container.includes('**')) return false;
  const c = container.split('/');
  const i = String(inner).split('/');
  const prefix = c.slice(0, c.indexOf('**'));
  if (i.length < prefix.length) return false;
  return prefix.every((seg, idx) => seg === i[idx]);
}

/** A filename-ish slug of a decision title, for a best-effort file match. */
/** A filename-ish slug of a decision title, for a best-effort file match. */
function slug(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
}

/** The project root that contains an artifact space (`<root>/.archgen/<slug>`). */
/** The project root that contains an artifact space (`<root>/.archgen/<slug>`). */
export function projectRootOf(slugDir) {
  const parent = resolve(slugDir, '..');
  return resolve(parent, '..');
}

/**
 * An artifact path relative to the artifact space, whatever form it was
 * recorded in.
 *
 * The `.archgen/<slug>/` prefix is stripped only when it is the PATH'S OWN
 * prefix. It used to be stripped from anywhere in the string, so a
 * repository path that merely CONTAINED an `.archgen/` segment
 * (`packages/app/.archgen/config.md`) was rewritten to `config.md` and
 * reported as missing.
 */
/**
 * An artifact path relative to the artifact space, whatever form it was
 * recorded in.
 *
 * The `.archgen/<slug>/` prefix is stripped only when it is the PATH'S OWN
 * prefix. It used to be stripped from anywhere in the string, so a
 * repository path that merely CONTAINED an `.archgen/` segment
 * (`packages/app/.archgen/config.md`) was rewritten to `config.md` and
 * reported as missing.
 */
export function normalizeArtifactPath(path) {
  const p = String(path).replaceAll('\\', '/').replace(/^\.\//, '');
  const anchored = /^\.archgen\/[^/]+\//.exec(p);
  if (anchored) return p.slice(anchored[0].length);
  return p;
}

/**
 * Does a recorded path exist under a base directory?
 *
 * The path is CONTAINED first. A recorded `../outside.md` used to resolve
 * to a sibling of the slug dir — outside the artifact space, where a
 * `create` decision could be "satisfied" by a file the plan does not own.
 */
/**
 * Does a recorded path exist under a base directory?
 *
 * The path is CONTAINED first. A recorded `../outside.md` used to resolve
 * to a sibling of the slug dir — outside the artifact space, where a
 * `create` decision could be "satisfied" by a file the plan does not own.
 */
export function existsUnder(base, path) {
  const rel = normalizeArtifactPath(path);
  if (!rel) return false;
  try {
    const root = resolve(base);
    const target = resolve(root, rel);
    // The target must be INSIDE the base directory.
    if (target !== root && !target.startsWith(root + sep)) return false;
    return existsSync(target);
  } catch {
    return false;
  }
}

/**
 * The artifacts that live in an artifact space.
 *
 * The run state (`.agent/`) and the waiver ledger are NOT artifacts: they are
 * process state, and a profile decision about them would be noise.
 *
 * `answers.yaml` is excluded too: it is where the profile is RECORDED, so
 * demanding a decision for it would be circular.
 */
/**
 * The artifacts that live in an artifact space.
 *
 * The run state (`.agent/`) and the waiver ledger are NOT artifacts: they are
 * process state, and a profile decision about them would be noise.
 *
 * `answers.yaml` is excluded too: it is where the profile is RECORDED, so
 * demanding a decision for it would be circular.
 */
export function listArtifacts(slugDir) {
  const out = [];
  const names = ['tasks.yaml', 'architecture.yaml', 'codebase-map.md'];
  for (const n of names) if (existsSync(join(slugDir, n))) out.push(n);
  for (const dir of ['docs', 'decisions', 'plans']) {
    const full = join(slugDir, dir);
    if (!existsSync(full)) continue;
    for (const f of listFiles(full)) out.push(`${dir}/${f}`);
  }
  return out;
}
export function readText(path) {
  try {
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  } catch {
    return null;
  }
}

/**
 * Read a YAML artifact of the plan.
 *
 * A file that EXISTS and does not parse is a different fact from a file that
 * is absent. The floor used to swallow the parse error and report the file
 * as missing — so a broken `architecture.yaml` was announced as "no
 * architecture.yaml", and the agent was told to declare roots when the real
 * defect was a syntax error in a file it had already written.
 *
 * @param {string} path
 * @returns {{data: any, error: string|null}} `error` is set only when the
 *   file is present and unparseable.
 */
/**
 * Read a YAML artifact of the plan.
 *
 * A file that EXISTS and does not parse is a different fact from a file that
 * is absent. The floor used to swallow the parse error and report the file
 * as missing — so a broken `architecture.yaml` was announced as "no
 * architecture.yaml", and the agent was told to declare roots when the real
 * defect was a syntax error in a file it had already written.
 *
 * @param {string} path
 * @returns {{data: any, error: string|null}} `error` is set only when the
 *   file is present and unparseable.
 */
export function readYaml(path) {
  const text = readText(path);
  if (!text) return { data: null, error: null };
  try {
    return { data: parseYaml(text, { filename: path }).data, error: null };
  } catch (e) {
    return { data: null, error: String(e?.message ?? e) };
  }
}

/**
 * The waiver ledger: the approved deviations, with who and why.
 *
 * A waived finding is an AUDIT EVENT, not a conversation. The file is the
 * record; the floor reports its size, and the gate brief shows it so the next
 * reviewer knows the deviation exists.
 */
/** The plan markdown of an artifact space (every plans/*.md, concatenated). */
export function readPlans(dir) {
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
export function listFiles(dir) {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.md'));
  } catch {
    return [];
  }
}
