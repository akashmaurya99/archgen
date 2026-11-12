// doc-navigator.mjs — deterministic markdown-artifact lens over `.archgen/<slug>/`:
// overview tree, backlink queries, reference-integrity gate, freshness audit,
// Mermaid inventory, section index, section-level retrieval.
//
// Extracted verbatim from skill/scripts/doc-index.mjs (deleted in the MCP-first
// cutover).
//
// DEDUP GUARANTEES (stateless idempotency): identical input yields byte-
// identical output AND zero duplicated entities inside one output. The file
// inventory dedups by fs.realpathSync — a symlinked doc aliasing another
// tracked doc, case-colliding spellings on case-insensitive filesystems, and
// `/./` path noise all collapse to ONE entry; the canonical repo-root-relative
// spelling kept is the non-symlink one when the group contains it, else the
// lexicographically first (overview reports how many via `duplicatesSkipped`).
// --validate counts UNIQUE refs in `checked.*` and lists each broken ref ONCE,
// at its first occurrence line; duplicate FR-id DEFINITIONS inside docs/prd.md
// are their own broken kind 'dup-definition' (ambiguity is surfaced, never
// silently resolved). By deliberate contrast, --refs-to backlinks list EVERY
// occurrence line — that mode is a "where is this mentioned" lens, not a gate.
//
// SCALE GUARDS: all traversals are iterative (explicit stack — no recursion on
// tree depth); overview returns at most the first 100 files, sorted, with
// `truncated:true` above that (totalFiles still reports the true deduped
// count) so agents are never silently surprised by deterministic truncation;
// fence pairing follows CommonMark (an info-carrying ``` inside an open fence
// is content, not an opener), which keeps nested-fence blocks from producing
// phantom diagram entries or false titles.
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { parseYaml } from './yaml.mjs';
import { buildGraph, GraphError } from './graph.mjs';
import { resolveSlugInput, ScopeError } from './scope.mjs';
import { parseMarkdown, buildSections, findSection, anchorExists, sectionChildren, sectionOwnEnd } from './docs.mjs';
import { cycle, invalidInput, notFound } from './errors.mjs';
import { artifactSpaceMissing, hint } from './guidance.mjs';
import { toolCall } from './call.mjs';

// Overview emits at most this many files (sorted); above it, truncated:true.
// The cap is a BACKSTOP for a caller that bypasses the tool's own paging —
// the tool bounds the list itself, so a normal call reaches every file.
/**
 * How many section ENTRIES one digest page carries.
 *
 * The digest is the outline the agent navigates by. An outline that costs more
 * than the plan it indexes is worse than no outline: 13 files x 20 sections
 * rendered 11,775 tokens. The budget is a CEILING — the count per file is
 * always reported, and the agent scopes the digest to one file when it needs
 * that file's sections.
 */
export const DIGEST_SECTION_BUDGET = 80;

/**
 * A digest scoped to ONE file carries that file's whole outline.
 *
 * The budget bounds the artifact SET. It must never bound a document the
 * caller explicitly asked about: 501 sections in one file returned 400 and
 * the remaining 101 were unreachable by ANY call.
 */
export const SINGLE_FILE_SECTION_BUDGET = 100000;

// Separator for composite map keys. NUL cannot occur in a path or a link
// target, so it is collision-proof — plain concatenation is not ("a"+"bc" vs
// "ab"+"c").
const NUL = String.fromCharCode(0);

const MD_RE = /\.md$/i;
const YAML_RE = /\.ya?ml$/i;

// Artifact-relative cross-references (artifact-templates.md rule 5).
const GENERATED_AT_RE = /generated_at:\s*(\S+)/;

// Whole-word token matcher: a hit must not be glued to word characters on
// either side, but path punctuation (`/`, `.`, `-`) may border it — so
// "0001" finds "decisions/0001-postgres-over-mongo.md" while "TASK-05"
// still refuses to match "TASK-055" or "XTASK-05".
function wholeWordSource(token) {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`;
}
const TASK_ID_SOURCE = '(?<![A-Za-z0-9_])TASK-\\d+(?![A-Za-z0-9_])';
const FR_ID_SOURCE = '(?<![A-Za-z0-9_])FR-[A-Z0-9]+-\\d+(?![A-Za-z0-9_])';

/**
 * Resolve the slug directory + the `.archgen` root used for output paths.
 * The scope gate is the ONLY way in: the slug dir must be an immediate child of
 * a `.archgen` segment (symlinks judged by their real target).
 * @param {string} input
 * @returns {{slugDir: string, repoRoot: string, slug: string}}
 */
export function resolveDocScope(input, projectRoot = null) {
  let scoped;
  try {
    scoped = resolveSlugInput(input, projectRoot);
  } catch (e) {
    if (e instanceof ScopeError) throw invalidInput(
      `doc-index: ${e.message}`,
      { ...hint({ action: toolCall('archgen_docs', { action: 'index' }), reason: "the index lists every document in the artifact space." }), input },
    );
    // The artifact space does not exist yet. Say WHY, and what to do: the
    // scaffold tool returns CONTENT and writes nothing, so the caller has to
    // write it before any artifact tool can read it.
    throw artifactSpaceMissing(null, input);
  }
  return {
    slugDir: scoped.root,
    repoRoot: dirname(scoped.root), // the `.archgen` directory — output vocabulary stays root-relative
    // The PROJECT root — where repository paths live. The skill mandates
    // repo-root-relative paths (`configs/base.yaml`, `.archgen/<slug>/x.yaml`),
    // so a reference can only be resolved against it.
    projectRoot: resolve(dirname(scoped.root), '..'),
    slug: scoped.slug,
  };
}

/** Read text as UTF-8 with BOM stripped and CRLF/CR normalized to LF. */
function readText(abs) {
  let t;
  try {
    t = readFileSync(abs, 'utf8');
  } catch {
    return null;
  }
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return t.replace(/\r\n?/g, '\n');
}

/**
 * Parse-and-cache a markdown document by absolute path.
 * Anchor validation resolves a link's target file OUTSIDE the tracked doc
 * set (the target may be a file we did not walk), so it needs its own
 * on-demand parser. Cached so a file referenced 50 times is parsed once.
 */
function makeDocCache() {
  const cache = new Map();
  return (abs) => {
    if (cache.has(abs)) return cache.get(abs);
    const text = readText(abs);
    const doc = text === null ? null : parseMarkdown(text);
    cache.set(abs, doc);
    return doc;
  };
}

/**
 * Depth-first collect of files matching `filter`, dot-directories skipped,
 * DEDUPLICATED by real path, sorted lexicographically by slug-relative path —
 * the determinism backbone.
 */
function walkFiles(slugDir, filter) {
  const candidates = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    for (const e of readdirSync(rel ? join(slugDir, rel) : slugDir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : rel === '' ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) stack.push(r);
      else if (filter.test(e.name)) candidates.push(r);
    }
  }
  const chosen = new Map(); // real key -> { rel, isLink }
  let duplicatesSkipped = 0;
  let escapesSkipped = 0;
  for (const r of candidates.sort()) {
    const abs = join(slugDir, r);
    let key;
    let isLink;
    try {
      key = realpathSync(abs);
      isLink = key !== join(slugDir, r); // slugDir is already fully resolved (scope gate)
    } catch {
      key = resolve(abs); // dangling symlink: keep, keyed by spelled path
      isLink = false;
    }
    // A file whose REAL path is outside the artifact space is a symlink out
    // of it. Reading it would return whatever it points at — a private key,
    // a file from elsewhere on the machine — inside a tool that promises to
    // read nothing but archgen's own artifacts. Such a file is skipped.
    if (key !== slugDir && !key.startsWith(slugDir + sep)) {
      escapesSkipped++;
      continue;
    }
    const prev = chosen.get(key);
    if (!prev) {
      chosen.set(key, { rel: r, isLink });
      continue;
    }
    duplicatesSkipped++;
    if (prev.isLink && !isLink) chosen.set(key, { rel: r, isLink }); // real spelling wins over alias
  }
  return {
    files: [...chosen.values()].map((v) => v.rel).sort(),
    duplicatesSkipped,
    escapesSkipped,
  };
}

const wordCount = (lines) => lines.join(' ').split(/\s+/).filter(Boolean).length;

/**
 * The payload of ONE section.
 *
 * `include: 'own'` (the default) returns the section's OWN content — the
 * heading and the lines up to its first child heading. `include: 'all'`
 * returns the whole subtree.
 *
 * WHY: a section owns every nested subsection, so fetching `## Per-task
 * sections` used to return all twenty task sections with it. The agent then
 * pulled each task AGAIN, paying twice for the same plan. The default is now
 * the section itself, and the nested children are NAMED (slug + title + line)
 * so the caller pulls only the ones it needs.
 *
 * The size of what was returned is always reported (`lines`, `bytes`): a
 * caller that did not expect 2,000 lines can see it.
 */
function sectionPayload(doc, section, { path, include = 'own' }) {
  const children = sectionChildren(doc, section).map((c) => ({ slug: c.slug, title: c.title, line: c.line }));
  const ownEnd = include === 'all' ? section.endLine : sectionOwnEnd(doc, section);
  const text = doc.lines.slice(section.line - 1, ownEnd).join('\n');
  const out = {
    path,
    anchor: section.slug,
    title: section.title,
    level: section.level,
    line: section.line,
    endLine: ownEnd,
    text,
    lines: text.split('\n').length,
    bytes: text.length,
    children,
  };
  if (ownEnd !== section.endLine) out.sectionEndLine = section.endLine;
  if (children.length) {
    out.next = `archgen_docs{action:'section',section:'<child slug>'} — ${children.length} nested subsection(s) were not included; include:'all' returns the whole subtree`;
  }
  return out;
}

/**
 * HOW A REFERENCE RESOLVES — the rule, in one place.
 *
 * The rule is the SKILL's path contract, not an implementation detail:
 *
 *   1. A target that starts with `./` or `../` is relative to the
 *      DOCUMENT's own directory. It must land inside the artifact space and
 *      exist.
 *   2. Any other target is relative to the PROJECT root — because the skill
 *      mandates repo-root-relative paths. It resolves when it exists.
 *   3. A project-root path that lands INSIDE the artifact space must exist:
 *      it names an artifact of the plan.
 *   4. A project-root path OUTSIDE the artifact space is not a link. It is a
 *      repository path or an OUTPUT DECLARATION — a file the plan will
 *      create — and it is not broken for not existing yet.
 *
 * Rule 4 is the correction. The old rule resolved EVERY target against the
 * document and demanded it land inside the artifact space, so the paths the
 * skill MANDATES — a repo-root product path like `configs/base.yaml`, and the
 * profile's own `.archgen/<slug>/architecture.yaml` — were reported broken
 * in the very files the profile told the agent to write them in.
 */
export const REFERENCE_RULE =
  'a reference starting with ./ or ../ is relative to the document\'s directory and must land inside the artifact space; ' +
  'any other reference is relative to the project root — it must exist if it names an artifact of the artifact space, ' +
  'and a repository path that does not exist yet is an output declaration, not a broken link';

/**
 * Resolve one reference target.
 *
 * @param {string} target the link target (no anchor)
 * @param {string} docAbs the absolute path of the referencing document
 * @param {string} projectRoot the project root
 * @param {string} slugDir the artifact space
 * @returns {{ok: boolean, path?: string, label?: string, detail?: string}}
 */
export function resolveReference(target, docAbs, projectRoot, slugDir) {
  if (!target) return { ok: true };
  const inSlug = (p) => p === slugDir || p.startsWith(slugDir + sep);
  const exists = (p) => {
    try {
      return existsSync(p);
    } catch {
      return false;
    }
  };

  if (target.startsWith('./') || target.startsWith('../')) {
    // Document-relative: the explicit way to say "beside this document".
    const abs = resolve(dirname(docAbs), target);
    if (inSlug(abs) && exists(abs)) return { ok: true, path: abs, label: abs };
    if (!inSlug(abs)) {
      return {
        ok: false,
        detail: `'${target}' resolves outside the artifact space — a './' or '../' reference must land inside it`,
      };
    }
    return { ok: false, detail: `'${target}' does not exist (looked for ${abs})` };
  }

  // Project-root-relative: the skill's mandated form.
  const abs = resolve(projectRoot, target);
  if (exists(abs)) return { ok: true, path: abs, label: abs };
  if (inSlug(abs)) {
    return { ok: false, detail: `'${target}' names an artifact of the artifact space, but ${abs} does not exist` };
  }
  // Outside the artifact space and not there yet: an output declaration.
  return { ok: true };
}

/**
 * Query the markdown artifacts under a slug directory.
 *
 * @param {string} input slug directory (or a tasks.yaml inside one)
 * @param {{mode?: 'overview'|'refs'|'validate'|'stale'|'diagrams'|'digest'|'section'|'map', token?: string|null, section?: string|null, file?: string|null, include?: 'own'|'all'}} [opts]
 * @returns {{mode: string, data: unknown}}
 */
export function docIndex(input, opts = {}) {
  const mode = opts.mode ?? 'overview';
  const token = opts.token ?? null;
  const sectionRef = opts.section ?? null;
  const fileScopeArg = opts.file ?? null;

  const { slugDir, repoRoot, projectRoot, slug } = resolveDocScope(input, opts.projectRoot ?? null);
  const relFromRoot = (abs) => relative(repoRoot, abs).split(sep).join('/');
  const relFromSlug = (abs) => relative(slugDir, abs).split(sep).join('/');
  const parsedDocAt = makeDocCache();

  // Optional file scoping: accept repo-root-relative (the output vocabulary) or
  // slug-relative paths; anything resolving outside the slug directory is refused.
  let fileScope = null; // slug-relative posix path or null
  if (fileScopeArg !== null) {
    const candidates = [join(repoRoot, fileScopeArg), join(slugDir, fileScopeArg)];
    const hit = candidates.find((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });
    if (!hit) throw notFound(`cannot read file ${fileScopeArg} (missing or not a file)`, { file: fileScopeArg });
    let hitReal;
    try {
      hitReal = realpathSync(hit);
    } catch {
      hitReal = resolve(hit);
    }
    if (!hitReal.startsWith(slugDir + sep)) {
      throw invalidInput(
        `file ${fileScopeArg} is outside ${input}`,
        { ...hint({ action: toolCall('archgen_docs', { action: 'index', slugDir: '<artifact space>', file: '<file>' }), reason: "a document outside the artifact space is not this plan's." }), file: fileScopeArg },
      );
    }
    fileScope = relFromSlug(hit);
  }

  /** Every markdown doc under the slug (or just the file scope), pre-parsed. */
  const collectDocs = () => {
    const { files, duplicatesSkipped } = walkFiles(slugDir, MD_RE);
    const docs = files
      .filter((r) => fileScope === null || r === fileScope)
      .map((r) => {
        const abs = join(slugDir, r);
        const text = readText(abs) ?? '';
        return { rel: r, abs, ...parseMarkdown(text) };
      });
    return { docs, duplicatesSkipped };
  };

  if (mode === 'validate' || mode === 'stale') {
    // Both gated modes need tasks.yaml: validate cross-checks its ids, stale
    // derives the freshness threshold from it. Absent/unparseable = bad input.
    const tasksRel = 'tasks.yaml';
    const tasksAbs = join(slugDir, tasksRel);
    let raw;
    try {
      raw = readFileSync(tasksAbs, 'utf8');
    } catch {
      throw invalidInput(
        `cannot read ${tasksRel} in ${input} (missing or unreadable)`,
        { ...hint({ action: toolCall('archgen_plan', { action: 'validate', tasksYaml: '<tasks.yaml>' }), reason: "validate reports what the task file is missing." }), file: tasksRel },
      );
    }
    let taskIds = new Set();
    let tasks = null; // hoisted: the validate branch's structural gate needs it
    if (mode === 'validate') {
      let data;
      try {
        ({ data } = parseYaml(raw, { filename: tasksRel }));
      } catch (e) {
        throw invalidInput(
          `${tasksRel}: unparseable YAML (${String(e?.message ?? e).replace(/^[^:]*:\d+:\s*/, '')})`, { ...hint({ action: toolCall('archgen_plan', { action: 'validate', tasksYaml: '<tasks.yaml>' }), reason: "the task file must parse before the documents can be read against it." }), file: tasksRel });
      }
      tasks = data?.tasks;
      if (!Array.isArray(tasks)) throw invalidInput(
        `${tasksRel}: missing 'tasks:' sequence`,
        { ...hint({ action: toolCall('archgen_plan', { action: 'validate', tasksYaml: '<tasks.yaml>' }), reason: "validate reports what the task file is missing." }), file: tasksRel },
      );
      taskIds = new Set(tasks.map((t) => String(t?.id)));
    }

    if (mode === 'stale') {
      // Freshness stamp: the file's `generated_at:` provenance comment when
      // present, else its filesystem mtime. Threshold = max(tasks.yaml
      // generated_at, tasks.yaml mtime) — the newest claim tasks.yaml makes.
      const stampOf = (abs) => {
        const text = readText(abs);
        if (text) {
          for (const line of text.split('\n')) {
            const m = GENERATED_AT_RE.exec(line);
            if (m && Number.isFinite(Date.parse(m[1]))) return m[1];
          }
        }
        return new Date(statSync(abs).mtimeMs).toISOString();
      };
      const threshold = Math.max(
        (() => {
          const m = GENERATED_AT_RE.exec(raw);
          const t = m ? Date.parse(m[1]) : NaN;
          return Number.isFinite(t) ? t : -Infinity;
        })(),
        statSync(tasksAbs).mtimeMs,
      );
      const stale = walkFiles(slugDir, /\.md$|\.ya?ml$/i)
        .files.filter((r) => r !== tasksRel && (fileScope === null || r === fileScope))
        .map((r) => ({ file: relFromRoot(join(slugDir, r)), generatedAt: stampOf(join(slugDir, r)) }))
        .filter((e) => Date.parse(e.generatedAt) < threshold);
      return { mode, data: { newestSource: 'tasks.yaml', stale } };
    }

    // Structural gate first: a tasks.yaml with duplicate task ids or dangling
    // depends_on is unexecutable — surface it before any reference scanning.
    try {
      buildGraph(tasks);
    } catch (e) {
      if (e instanceof GraphError) throw cycle(e.message, { file: tasksRel });
      throw e;
    }
    // Five broken classes — unknown TASK-nn, unresolved FR-id, dangling artifact
    // link, unbalanced (odd) mermaid/code fences, and 'dup-definition' (the
    // same FR id defined on 2+ lines inside prd.md is ambiguity, and
    // highest-quality data forbids silently picking one). Plus non-fatal
    // `warnings` (heading-level sanity) that never move `ok`.
    const { docs } = collectDocs();
    const broken = [];
    const warnings = [];
    const checked = { taskRefs: 0, frRefs: 0, links: 0, mermaidFences: 0 };

    // ref -> { n, first } : occurrence COUNT plus FIRST site (docs arrive
    // path-sorted and lines ascend, so `first` is deterministic).
    const taskOcc = new Map();
    const frDefOcc = new Map(); // occurrences inside docs/prd.md define
    const frRefOcc = new Map(); // everywhere else references
    const PRD_REL = 'docs/prd.md';
    for (const doc of docs) {
      const isPrd = doc.rel === PRD_REL;
      const bump = (sink, ref, at) => {
        const e = sink.get(ref);
        if (e) e.n++;
        else sink.set(ref, { n: 1, first: at });
      };
      const scan = (source, sink) => {
        const re = new RegExp(source, 'g');
        for (let i = 0; i < doc.lines.length; i++) {
          re.lastIndex = 0;
          let m;
          while ((m = re.exec(doc.lines[i])) !== null) {
            bump(sink, m[0], { file: relFromRoot(doc.abs), line: i + 1 });
          }
        }
      };
      scan(TASK_ID_SOURCE, taskOcc);
      scan(FR_ID_SOURCE, isPrd ? frDefOcc : frRefOcc);
      checked.taskRefs = taskOcc.size;
      checked.frRefs = frRefOcc.size;

      // Links: dedup by (file, target) — the same link repeated in one file is
      // ONE ref: counted once in checked.links, reported once if broken.
      // ANCHOR ACCURACY: anchors resolve against the target document's real
      // heading slugs, so a link to a renamed section is a broken `anchor`.
      const linkSeen = new Set();
      for (const link of doc.links) {
        const lkey = `${doc.rel}${NUL}${link.target}`;
        if (linkSeen.has(lkey)) continue;
        linkSeen.add(lkey);
        checked.links++;
        const hash = link.target.indexOf('#');
        const target = hash === -1 ? link.target : link.target.slice(0, hash);
        const anchor = hash === -1 ? null : link.target.slice(hash + 1);
        const resolved = resolveReference(target, doc.abs, projectRoot, slugDir);
        if (!resolved.ok) {
          // The finding carries the RULE, not just the verdict: a caller
          // handed only the broken list could not repair a single link
          // without reading the implementation to learn how a link resolves.
          broken.push({
            kind: 'link',
            ref: link.target,
            file: relFromRoot(doc.abs),
            line: link.line,
            detail: resolved.detail,
            resolution: REFERENCE_RULE,
          });
          continue;
        }
        if (anchor && resolved.path && /\.md$/i.test(target)) {
          const targetDoc = parsedDocAt(resolved.path);
          if (targetDoc && !anchorExists(targetDoc, anchor)) {
            broken.push({
              kind: 'anchor',
              ref: link.target,
              file: relFromRoot(doc.abs),
              line: link.line,
              detail: `the anchor '#${anchor}' does not exist in ${resolved.label}`,
              resolution: REFERENCE_RULE,
            });
          }
        }
      }

      checked.mermaidFences += doc.fences.length;
      if (!doc.balanced) {
        broken.push({
          kind: 'mermaid',
          ref: `unbalanced fences (${doc.fences.length})`,
          file: relFromRoot(doc.abs),
          line: doc.fences[doc.fences.length - 1].line,
        });
      }

      // Cheap heading-level sanity: an H3 with no preceding H2 in the same
      // file signals a skipped structural level. Warning only — never fatal.
      let seenH2 = false;
      for (const h of doc.headings) {
        if (h.level === 2) seenH2 = true;
        else if (h.level === 3 && !seenH2) {
          warnings.push({ kind: 'heading-skip', file: relFromRoot(doc.abs), line: h.line });
        }
      }
    }
    for (const [ref, occ] of taskOcc) if (!taskIds.has(ref)) broken.push({ kind: 'task', ref, ...occ.first });
    for (const [ref, occ] of frRefOcc) if (!frDefOcc.has(ref)) broken.push({ kind: 'fr', ref, ...occ.first });
    for (const [ref, occ] of frDefOcc) if (occ.n > 1) broken.push({ kind: 'dup-definition', ref, ...occ.first });
    broken.sort((a, b) =>
      a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.ref < b.ref ? -1 : 1),
    );
    warnings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
    return { mode, data: { valid: broken.length === 0, checked, broken, warnings } };
  }

  if (mode === 'refs') {
    if (!token) throw invalidInput(
      'refs mode requires a token',
      { ...hint({ action: toolCall('archgen_docs', { action: 'refs', token: '<token>' }), reason: "refs searches for one token." }) },
    );
    // Backlink query: any line in any markdown artifact containing the token as
    // a whole word. INTENTIONAL asymmetry vs validate: this lens lists EVERY
    // occurrence line (a "where is this mentioned" report), while validate
    // reports each unique broken ref once at its first occurrence.
    const re = new RegExp(wholeWordSource(token));
    const matches = [];
    for (const doc of collectDocs().docs) {
      for (let i = 0; i < doc.lines.length; i++) {
        if (re.test(doc.lines[i])) matches.push({ file: relFromRoot(doc.abs), line: i + 1, text: doc.lines[i].trim() });
      }
    }
    return { mode, data: { ref: token, matches } };
  }

  if (mode === 'diagrams') {
    const diagrams = [];
    for (const doc of collectDocs().docs) {
      for (let k = 0; k < doc.fences.length; k++) {
        const f = doc.fences[k];
        if (f.info !== 'mermaid') continue;
        const closer = doc.fences[k + 1]; // fence toggling pairs opens with closes
        const endLine = closer ? closer.line : doc.lines.length + 1;
        const body = doc.lines.slice(f.line, endLine - 1);
        const comment = body.map((l) => /^\s*%%\s?(.*)$/.exec(l)).find(Boolean);
        const heading = [...doc.allHeadings].reverse().find((h) => h.line < f.line);
        diagrams.push({
          file: relFromRoot(doc.abs),
          startLine: f.line,
          title: heading ? heading.text : comment ? comment[1].trim() : null,
          nodeCount: body.filter((l) => /^\s*[A-Za-z0-9_]+[[{(]/.test(l)).length,
          balanced: Boolean(closer),
        });
      }
    }
    return { mode, data: { diagrams } };
  }

  if (mode === 'digest') {
    // Section index the agent reads instead of whole documents; fetch exactly
    // the sections it needs with the `section` action.
    //
    // The section LIST is budgeted: 13 files x 20 sections rendered 11,775
    // tokens of outline — more than the plan it indexes. The COUNT per file is
    // always reported, so the agent knows the scale; the entries are the
    // sample it can act on.
    //
    // THE TAIL IS REACHABLE. A digest scoped to ONE file is that file's
    // COMPLETE outline — the budget bounds the artifact SET, never a
    // document the caller explicitly asked about. So the continuation is
    // always the same call the caller can make: scope to the file.
    const { docs } = collectDocs();
    const budget = Number.isFinite(opts.sectionBudget)
      ? opts.sectionBudget
      : docs.length === 1
        ? SINGLE_FILE_SECTION_BUDGET
        : DIGEST_SECTION_BUDGET;
    let left = budget;
    // FAIR SHARE FIRST. A budget spent in file order starves the last files of
    // their outline — the agent then cannot navigate them at all. Every file
    // keeps the head of its outline; the remainder is then shared round-robin.
    const allSections = docs.map((doc) => buildSections(doc));
    const share = Math.max(1, Math.floor(budget / Math.max(1, docs.length)));
    const taken = allSections.map((all) => {
      const t = all.slice(0, Math.min(all.length, share));
      left -= t.length;
      return t;
    });
    let moved = true;
    while (left > 0 && moved) {
      moved = false;
      for (let i = 0; i < allSections.length && left > 0; i++) {
        const all = allSections[i];
        if (taken[i].length < all.length) {
          taken[i].push(all[taken[i].length]);
          left--;
          moved = true;
        }
      }
    }
    const files = docs.map((doc, i) => {
      const all = allSections[i];
      const take = taken[i].sort((a, b) => a.line - b.line);
      return {
        path: relFromRoot(doc.abs),
        title: doc.headings.find((h) => h.level === 1)?.text ?? basename(doc.rel),
        sectionCount: all.length,
        sections: take.map((s) => ({
          slug: s.slug,
          title: s.title,
          // WHAT the section covers. The digest used to carry a slug and a
          // title — enough to identify a section, not enough to CHOOSE one —
          // so an agent had to pull a section to learn what it held, and paid
          // for every wrong guess.
          purpose: s.purpose ?? '',
          level: s.level,
          line: s.line,
          // The section's SIZE, not its end line: the caller needs to know
          // whether pulling it is cheap, and one number answers that.
          lines: s.endLine - s.line + 1,
        })),
        ...(take.length < all.length ? { truncated: all.length - take.length } : {}),
      };
    });
    // The omissions are REAL omissions, not "the budget ran out". The old
    // flag was `left <= 0`, so a set that exactly filled the budget reported
    // omissions it did not have — and a set that did not fill it reported
    // omissions it did not have either.
    const omittedFiles = files.filter((f) => f.truncated > 0);
    const sectionsOmitted = omittedFiles.length > 0;
    return {
      mode,
      data: {
        slug,
        totalFiles: files.length,
        files,
        ...(sectionsOmitted
          ? {
              sectionsOmitted: true,
              omittedSections: omittedFiles.reduce((n, f) => n + f.truncated, 0),
              // The EXACT continuation: the file's own digest is complete.
              hint: `scope the digest to one file for its complete outline — e.g. ${toolCall('archgen_docs', { action: 'digest', file: omittedFiles[0].path })}`,
            }
          : {}),
      },
    };
  }

  if (mode === 'section') {
    if (!sectionRef) throw invalidInput(
      'section mode requires a path',
      { ...hint({ action: toolCall('archgen_docs', { action: 'section', section: '<section>' }), reason: "section fetches one section." }) },
    );

    const hash = sectionRef.indexOf('#');
    const filePart = hash === -1 ? sectionRef : sectionRef.slice(0, hash);
    const anchor = hash === -1 ? null : sectionRef.slice(hash + 1);

    // The ref may name a FILE, a file#anchor, or a bare SECTION SLUG.
    //
    // The bare-slug form is not a convenience — it is REQUIRED for the
    // digest -> section round trip to work. `digest` hands out
    // `sections[].slug` (the GitHub-exact heading slug), so the obvious next
    // call is `section: "<slug>"`. That call used to fail on EVERY plan,
    // because the whole ref was treated as a FILE path and no file is named
    // after a heading. The agent had to re-join `path` + '#' + `slug` by
    // hand, and nothing — not the digest, not the schema, not archgen_help —
    // said so.
    // The FILE may arrive in the ref (`section: "path#anchor"`) OR in the
    // `file` argument (`file: "path", section: "anchor"`). The second shape
    // is the natural one — and it used to return the WHOLE FILE, because a
    // file hit with no `#anchor` meant "no section was named". The agent
    // asked for one section and paid for the document.
    const candidates = [];
    if (filePart) candidates.push({ path: join(repoRoot, filePart), from: 'ref' }, { path: join(slugDir, filePart), from: 'ref' });
    if (fileScopeArg) candidates.push({ path: join(repoRoot, fileScopeArg), from: 'scope' }, { path: join(slugDir, fileScopeArg), from: 'scope' });

    const found = candidates.find((c) => {
      try {
        return statSync(c.path).isFile();
      } catch {
        return false;
      }
    });
    const hit = found?.path ?? null;

    if (hit) {
      let hitReal;
      try {
        hitReal = realpathSync(hit);
      } catch {
        hitReal = resolve(hit);
      }
      if (!hitReal.startsWith(slugDir + sep)) {
        throw invalidInput(
          `section ${sectionRef} is outside ${input}`,
          { ...hint({ action: toolCall('archgen_docs', { action: 'digest', slugDir: '<artifact space>' }), reason: "a section outside the artifact space is not this plan's." }), section: sectionRef },
        );
      }
      const doc = parsedDocAt(hit);
      if (!doc) throw notFound(`cannot read section ${sectionRef} (unreadable)`, { section: sectionRef });

      // The section NAME: an explicit `#anchor`, or — when the FILE came from
      // the `file` scope — the ref itself, which then names a heading.
      const wanted = anchor ?? (found.from === 'scope' ? filePart : null);
      if (wanted) {
        const section = findSection(doc, wanted);
        if (!section) {
          throw notFound(`section ${sectionRef}: no section '${wanted}' in ${relFromRoot(hit)}`, {
            section: sectionRef,
            file: relFromRoot(hit),
            available: buildSections(doc).map((s) => s.slug),
          });
        }
        return { mode, data: sectionPayload(doc, section, { path: relFromRoot(hit), include: opts.include ?? 'own' }) };
      }
      // No section was named: the caller asked for the document.
      return { mode, data: { path: relFromRoot(hit), text: doc.lines.join('\n'), lines: doc.lines.length, bytes: doc.lines.join('\n').length } };
    }

    // No file matched: the ref is a SECTION SLUG (possibly with a '#anchor'
    // whose file part was empty). Resolve it against the documents.
    const wanted = anchor && !filePart ? anchor : filePart;
    if (!wanted) {
      throw notFound(`cannot read section ${sectionRef} (missing or not a file)`, { section: sectionRef });
    }

    const { docs } = collectDocs();
    const hits = [];
    for (const doc of docs) {
      const section = findSection(doc, wanted);
      if (section) hits.push({ doc, section });
    }

    if (hits.length === 1) {
      const { doc, section } = hits[0];
      return {
        mode,
        data: sectionPayload(doc, section, { path: relFromRoot(doc.abs), include: opts.include ?? 'own' }),
      };
    }

    if (hits.length > 1) {
      // Ambiguous: report the candidates, never guess. A wrong guess costs
      // the agent a whole extra read cycle.
      return {
        mode,
        data: {
          ambiguous: true,
          ref: wanted,
          matches: hits.map(({ doc, section }) => ({
            path: relFromRoot(doc.abs),
            section: section.slug,
            title: section.title,
            line: section.line,
            endLine: section.endLine,
          })),
          hint: 'the section slug matches more than one document — fetch it as path#anchor, e.g. demo/docs/prd.md#install',
        },
      };
    }

    // Nothing matched: name the available vocabulary, so one failed call is
    // enough to recover — the same courtesy archgen_refs already gives.
    const available = [];
    for (const doc of docs) {
      for (const s of buildSections(doc)) available.push(`${relFromRoot(doc.abs)}#${s.slug}`);
    }
    throw notFound(`no section '${wanted}' under ${slug}`, {
      section: sectionRef,
      available: available.slice(0, 50),
      availableCount: available.length,
    });
  }

  if (mode === 'map') {
    if (!token) throw invalidInput(
      'map mode requires a token',
      { ...hint({ action: toolCall('archgen_docs', { action: 'map', token: '<token>' }), reason: "map finds the sections that mention one token." }) },
    );
    // Section-level retrieval: WHERE is this token mentioned?
    //
    // The sections OVERLAP — a parent section's body contains its children's —
    // so a naive walk reports the same line once per containing section. The
    // agent then paid for the same sentence three times to learn one fact.
    // Every hit is reported ONCE, under the DEEPEST section that contains it.
    const re = new RegExp(wholeWordSource(token));
    const hits = [];
    for (const doc of collectDocs().docs) {
      const sections = buildSections(doc);
      const ownerOf = (line) => {
        let owner = null;
        for (const s of sections) {
          if (line < s.line || line > s.endLine) continue;
          if (owner === null || s.level > owner.level) owner = s;
        }
        return owner;
      };
      for (const section of sections) {
        const bodyLines = doc.lines.slice(section.line - 1, section.endLine);
        const matching = [];
        for (let i = 0; i < bodyLines.length; i++) {
          if (!re.test(bodyLines[i])) continue;
          const line = section.line + i;
          const owner = ownerOf(line);
          if (!owner || owner.slug !== section.slug) continue; // its deepest owner reports it
          matching.push({ line, text: bodyLines[i].trim().slice(0, 120) });
        }
        if (!matching.length) continue;
        hits.push({
          file: relFromRoot(doc.abs),
          section: section.slug,
          title: section.title,
          level: section.level,
          line: section.line,
          endLine: section.endLine,
          occurrences: matching.length,
          // Five excerpts per section: enough to judge the hit, not enough to
          // smuggle the document back in. The count of what was LEFT OUT is
          // reported too — `occurrences: 20` next to five excerpts used to
          // tell the caller twenty were available when five arrived, with
          // no way to reach the rest.
          excerptsReturned: Math.min(5, matching.length),
          excerptsOmitted: Math.max(0, matching.length - 5),
          matches: matching.slice(0, 5),
        });
      }
    }
    hits.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
    return {
      mode,
      data: { ref: token, sections: hits, sectionCount: hits.length, matchCount: hits.reduce((n, h) => n + h.occurrences, 0) },
    };
  }

  // Overview (scale guard): the deduped inventory is always computed in full
  // and sorted. The 100-file cap used to live HERE, inside the core, so the
  // tool's own limit/offset could never reach files 101+ — and the sibling
  // `digest` action, which had no cap, could. The bound belongs to the TOOL,
  // where the caller can page it; the core returns the whole inventory.
  const { docs, duplicatesSkipped } = collectDocs();
  // The overview is the FILE map. It used to carry every heading's raw TEXT —
  // which the agent could not act on (fetching needs a SLUG), so it paid for
  // an outline it could not use and then called `digest` for the same outline
  // with slugs. One outline now: the overview counts the sections, `digest`
  // lists them.
  const allFiles = docs.map((doc) => ({
    path: relFromRoot(doc.abs),
    title: doc.headings.find((h) => h.level === 1)?.text ?? basename(doc.rel),
    sections: buildSections(doc).length,
    words: wordCount(doc.lines),
  }));
  return { mode, data: { slug, files: allFiles, totalFiles: allFiles.length, duplicatesSkipped, truncated: false } };
}
