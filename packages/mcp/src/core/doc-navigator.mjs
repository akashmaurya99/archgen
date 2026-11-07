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
import { parseMarkdown, buildSections, findSection, anchorExists } from './docs.mjs';
import { cycle, invalidInput, notFound } from './errors.mjs';
import { artifactSpaceMissing } from './guidance.mjs';

// Overview emits at most this many files (sorted); above it, truncated:true.
export const OVERVIEW_MAX_FILES = 100;

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
    if (e instanceof ScopeError) throw invalidInput(`doc-index: ${e.message}`, { input });
    // The artifact space does not exist yet. Say WHY, and what to do: the
    // scaffold tool returns CONTENT and writes nothing, so the caller has to
    // write it before any artifact tool can read it.
    throw artifactSpaceMissing(null, input);
  }
  return {
    slugDir: scoped.root,
    repoRoot: dirname(scoped.root), // the `.archgen` directory — output vocabulary stays root-relative
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
 * Query the markdown artifacts under a slug directory.
 *
 * @param {string} input slug directory (or a tasks.yaml inside one)
 * @param {{mode?: 'overview'|'refs'|'validate'|'stale'|'diagrams'|'digest'|'section'|'map', token?: string|null, section?: string|null, file?: string|null}} [opts]
 * @returns {{mode: string, data: unknown}}
 */
export function docIndex(input, opts = {}) {
  const mode = opts.mode ?? 'overview';
  const token = opts.token ?? null;
  const sectionRef = opts.section ?? null;
  const fileScopeArg = opts.file ?? null;

  const { slugDir, repoRoot, slug } = resolveDocScope(input, opts.projectRoot ?? null);
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
      throw invalidInput(`file ${fileScopeArg} is outside ${input}`, { file: fileScopeArg });
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
      throw invalidInput(`cannot read ${tasksRel} in ${input} (missing or unreadable)`, { file: tasksRel });
    }
    let taskIds = new Set();
    let tasks = null; // hoisted: the validate branch's structural gate needs it
    if (mode === 'validate') {
      let data;
      try {
        ({ data } = parseYaml(raw, { filename: tasksRel }));
      } catch (e) {
        throw invalidInput(
          `${tasksRel}: unparseable YAML (${String(e?.message ?? e).replace(/^[^:]*:\d+:\s*/, '')})`,
          { file: tasksRel },
        );
      }
      tasks = data?.tasks;
      if (!Array.isArray(tasks)) throw invalidInput(`${tasksRel}: missing 'tasks:' sequence`, { file: tasksRel });
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
        // A link target is resolved against the document's directory, so a
        // link like `../../../secrets.md` would otherwise point outside the
        // artifact space. The link is checked, never READ from outside: a
        // target outside the slug directory is reported as broken rather
        // than followed.
        const targetAbs = target ? resolve(dirname(doc.abs), target) : '';
        const inside = targetAbs && (targetAbs === slugDir || targetAbs.startsWith(slugDir + sep));
        if (target && (!inside || !existsSync(targetAbs))) {
          broken.push({ kind: 'link', ref: link.target, file: relFromRoot(doc.abs), line: link.line });
          continue;
        }
        if (anchor && target && /\.md$/i.test(target)) {
          const targetDoc = parsedDocAt(targetAbs);
          if (targetDoc && !anchorExists(targetDoc, anchor)) {
            broken.push({ kind: 'anchor', ref: link.target, file: relFromRoot(doc.abs), line: link.line });
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
    if (!token) throw invalidInput('refs mode requires a token', {});
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
    const { docs } = collectDocs();
    const files = docs.map((doc) => ({
      path: relFromRoot(doc.abs),
      title: doc.headings.find((h) => h.level === 1)?.text ?? basename(doc.rel),
      sections: buildSections(doc).map((s) => ({
        slug: s.slug,
        title: s.title,
        level: s.level,
        line: s.line,
        endLine: s.endLine,
      })),
    }));
    return { mode, data: { slug, totalFiles: files.length, files } };
  }

  if (mode === 'section') {
    if (!sectionRef) throw invalidInput('section mode requires a path', {});

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
    const fileCandidates = [];
    if (filePart) fileCandidates.push(join(repoRoot, filePart), join(slugDir, filePart));
    if (fileScopeArg) fileCandidates.push(join(repoRoot, fileScopeArg), join(slugDir, fileScopeArg));

    const hit = fileCandidates.find((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });

    if (hit) {
      let hitReal;
      try {
        hitReal = realpathSync(hit);
      } catch {
        hitReal = resolve(hit);
      }
      if (!hitReal.startsWith(slugDir + sep)) {
        throw invalidInput(`section ${sectionRef} is outside ${input}`, { section: sectionRef });
      }
      const doc = parsedDocAt(hit);
      if (!doc) throw notFound(`cannot read section ${sectionRef} (unreadable)`, { section: sectionRef });
      if (anchor) {
        const section = findSection(doc, anchor);
        if (!section) {
          throw notFound(`section ${sectionRef}: no section '${anchor}' in ${filePart}`, {
            section: sectionRef,
            file: relFromRoot(hit),
            available: buildSections(doc).map((s) => s.slug),
          });
        }
        return {
          mode,
          data: {
            path: relFromRoot(hit),
            anchor: section.slug,
            line: section.line,
            endLine: section.endLine,
            text: section.body,
          },
        };
      }
      return { mode, data: { path: relFromRoot(hit), text: doc.lines.join('\n') } };
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
        data: {
          path: relFromRoot(doc.abs),
          anchor: section.slug,
          title: section.title,
          line: section.line,
          endLine: section.endLine,
          text: section.body,
        },
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
    if (!token) throw invalidInput('map mode requires a token', {});
    // Section-level retrieval: WHERE is this token mentioned?
    const re = new RegExp(wholeWordSource(token));
    const hits = [];
    for (const doc of collectDocs().docs) {
      for (const section of buildSections(doc)) {
        const bodyLines = doc.lines.slice(section.line - 1, section.endLine);
        const matching = [];
        for (let i = 0; i < bodyLines.length; i++) {
          if (re.test(bodyLines[i])) {
            matching.push({ line: section.line + i, text: bodyLines[i].trim().slice(0, 200) });
          }
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
          matches: matching.slice(0, 10),
        });
      }
    }
    hits.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
    return { mode, data: { ref: token, sections: hits, sectionCount: hits.length } };
  }

  // Overview (scale guard): the deduped inventory is always computed in full
  // and sorted, but only the FIRST 100 files are emitted — with
  // `truncated:true` whenever anything was cut.
  const { docs, duplicatesSkipped } = collectDocs();
  const allFiles = docs.map((doc) => ({
    path: relFromRoot(doc.abs),
    title: doc.headings.find((h) => h.level === 1)?.text ?? basename(doc.rel),
    headings: doc.headings,
    wordCount: wordCount(doc.lines),
  }));
  const truncated = allFiles.length > OVERVIEW_MAX_FILES;
  const files = truncated ? allFiles.slice(0, OVERVIEW_MAX_FILES) : allFiles;
  return { mode, data: { slug, files, totalFiles: allFiles.length, duplicatesSkipped, truncated } };
}
