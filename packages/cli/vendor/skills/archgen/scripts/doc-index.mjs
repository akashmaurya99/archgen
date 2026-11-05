#!/usr/bin/env node
// doc-index.mjs — deterministic markdown-artifact lens over `.archgen/<slug>/`:
// overview tree, backlink queries, reference-integrity gate, freshness audit,
// Mermaid inventory.
// Usage:
//   node doc-index.mjs <slug-dir>                        overview JSON
//   node doc-index.mjs <slug-dir> --refs-to <token>      backlink JSON
//   node doc-index.mjs <slug-dir> --validate             integrity JSON (exit 1 when broken)
//   node doc-index.mjs <slug-dir> --stale                freshness JSON
//   node doc-index.mjs <slug-dir> --diagrams             Mermaid inventory JSON
// Any mode accepts `--file <path>` (repo-root-relative or slug-relative) to
// scope it to one document. Paths in output are repo-root-relative and
// slash-normalized; identical input yields byte-identical stdout.
// Scope-hardened: refuses any input outside .archgen/<slug>/ (see lib/scope.mjs).
// Exit codes: 0 ok · 1 broken references (--validate) · 2 structurally invalid
// tasks.yaml during --validate (duplicate task id / dangling depends_on, via
// GraphError) · 4 invalid input/flags.
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
import { parseYaml } from './lib/yaml.mjs';
import { buildGraph, GraphError } from './lib/graph.mjs';
import { resolveSlugInput, ScopeError } from './lib/scope.mjs';
import { parseMarkdown, buildSections, findSection, anchorExists } from './lib/docs.mjs';

const USAGE = 'usage: doc-index.mjs <slug-dir> [--refs-to <token>] [--validate] [--stale] [--diagrams] [--file <path>] [--digest] [--section <path>[#<anchor>]] [--map <token>]';
// Overview emits at most this many files (sorted); above it, truncated:true.
const OVERVIEW_MAX_FILES = 100;
function die(msg, code = 4) { console.error(msg); process.exit(code); }

// --- argument parsing -------------------------------------------------------
const argv = process.argv.slice(2);
const opts = { input: null, refsTo: null, validate: false, stale: false, diagrams: false, file: null, digest: false, section: null, map: null };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--refs-to') opts.refsTo = argv[++i];
  else if (a === '--validate') opts.validate = true;
  else if (a === '--stale') opts.stale = true;
  else if (a === '--diagrams') opts.diagrams = true;
  else if (a === '--file') opts.file = argv[++i];
  else if (a === '--digest') opts.digest = true;
  else if (a === '--section') opts.section = argv[++i];
  else if (a === '--map') opts.map = argv[++i];
  else if (a.startsWith('--')) die(`${USAGE} — unknown option '${a}'`);
  else if (opts.input === null) opts.input = a;
  else die(`${USAGE} — unexpected extra argument '${a}'`);
}
if (!opts.input) die(USAGE);
if (opts.refsTo === undefined || opts.file === undefined || opts.section === undefined || opts.map === undefined) die(`${USAGE} — --refs-to/--file/--section/--map require a value`);
if (opts.refsTo === '') die(`${USAGE} — --refs-to requires a non-empty token`);
if (opts.section === '') die(`${USAGE} — --section requires a non-empty path`);
if (opts.map === '') die(`${USAGE} — --map requires a non-empty token`);
const modes = [opts.refsTo !== null, opts.validate, opts.stale, opts.diagrams, opts.digest, opts.section !== null, opts.map !== null].filter(Boolean).length;
if (modes > 1) die(`${USAGE} — --refs-to/--validate/--stale/--diagrams/--digest/--section/--map are mutually exclusive`);

// --- input resolution -------------------------------------------------------
// The scope gate is the ONLY way in: the slug dir must be an immediate child of
// a `.archgen` segment (symlinks judged by their real target); everything below
// runs off the resolved absolute root.
let scoped;
try {
  scoped = resolveSlugInput(opts.input);
} catch (e) {
  if (e instanceof ScopeError) die(`doc-index: ${e.message}`);
  die(`cannot read ${opts.input} (missing or not a directory)`);
}
const slugDir = scoped.root;
const repoRoot = dirname(slugDir); // the `.archgen` directory — output vocabulary stays root-relative
const slug = scoped.slug;

/** Repo-root-relative, slash-normalized path (never absolute in output). */
const relFromRoot = (abs) => relative(repoRoot, abs).split(sep).join('/');
const relFromSlug = (abs) => relative(slugDir, abs).split(sep).join('/');

// Optional --file scoping: accept repo-root-relative (the output vocabulary) or
// slug-relative paths; anything resolving outside the slug directory is refused.
// The hit is judged by real path so a symlink inside the slug cannot smuggle in
// out-of-scope content either.
let fileScope = null; // slug-relative posix path or null
if (opts.file !== null) {
  const candidates = [join(repoRoot, opts.file), join(slugDir, opts.file)];
  const hit = candidates.find((p) => { try { return statSync(p).isFile(); } catch { return false; } });
  if (!hit) die(`cannot read --file ${opts.file} (missing or not a file)`);
  let hitReal;
  try { hitReal = realpathSync(hit); } catch { hitReal = resolve(hit); }
  if (!hitReal.startsWith(slugDir + sep)) die(`--file ${opts.file} is outside ${opts.input}`);
  fileScope = relFromSlug(hit);
}

// --- shared engine ----------------------------------------------------------
const MD_RE = /\.md$/i;
const YAML_RE = /\.ya?ml$/i;

/** Read text as UTF-8 with BOM stripped and CRLF/CR normalized to LF. */
function readText(abs) {
  let t;
  try { t = readFileSync(abs, 'utf8'); } catch { return null; }
  if (t.charCodeAt(0) === 0xfeff) t = t.slice(1);
  return t.replace(/\r\n?/g, '\n');
}

/**
 * Parse-and-cache a markdown document by absolute path.
 * Anchor validation resolves a link's target file OUTSIDE the tracked doc
 * set (the target may be a file we did not walk), so it needs its own
 * on-demand parser. Cached so a file referenced 50 times is parsed once.
 */
const parsedDocCache = new Map();
function parsedDocAt(abs) {
  if (parsedDocCache.has(abs)) return parsedDocCache.get(abs);
  const text = readText(abs);
  const doc = text === null ? null : parseMarkdown(text);
  parsedDocCache.set(abs, doc);
  return doc;
}

/** Depth-first collect of files matching `filter`, dot-directories skipped,
 * DEDUPLICATED by real path, sorted lexicographically by slug-relative path —
 * the determinism backbone.
 *
 * Dedup contract (A3): every tracked document is indexed/emitted exactly once
 * regardless of how many directory entries reach it. Candidates are keyed by
 * fs.realpathSync, which collapses symlink aliases (a doc symlinked inside the
 * slug pointing at another tracked doc) and case-colliding spellings on
 * case-insensitive filesystems; `/./` noise never survives realpath either.
 * The canonical spelling kept per group is the non-symlink entry when one
 * exists (the file's own name beats an alias), else the lexicographically
 * first candidate — deterministic under identical input, always.
 * Dangling symlinks (realpath throws) are kept and keyed by their spelled
 * path: they alias nothing, so they cannot be duplicates of anything.
 */
function walkFiles(filter) {
  const candidates = [];
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    for (const e of readdirSync(rel ? join(slugDir, rel) : slugDir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) stack.push(r);
      else if (filter.test(e.name)) candidates.push(r);
    }
  }
  const chosen = new Map(); // real key -> { rel, isLink }
  let duplicatesSkipped = 0;
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
    const prev = chosen.get(key);
    if (!prev) { chosen.set(key, { rel: r, isLink }); continue; }
    duplicatesSkipped++;
    if (prev.isLink && !isLink) chosen.set(key, { rel: r, isLink }); // real spelling wins over alias
  }
  return { files: [...chosen.values()].map((v) => v.rel).sort(), duplicatesSkipped };
}

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

// Artifact-relative cross-references (artifact-templates.md rule 5): a slash-
// carrying path ending in a doc/yaml extension, e.g. `../architecture.yaml`.
// Bare same-dir names are only trusted inside explicit markdown links
// (`](c4-container.md)`) — prose mentions like "tasks.yaml" resolve
// file-relatively and would be false positives.
const GENERATED_AT_RE = /generated_at:\s*(\S+)/;

/** Every markdown doc under the slug (or just the --file scope), pre-parsed.
 * Returns { docs, duplicatesSkipped } so overview can report collapsed aliases. */
function collectDocs() {
  const { files, duplicatesSkipped } = walkFiles(MD_RE);
  const docs = files
    .filter((r) => fileScope === null || r === fileScope)
    .map((r) => {
      const abs = join(slugDir, r);
      const text = readText(abs) ?? '';
      return { rel: r, abs, ...parseMarkdown(text) };
    });
  return { docs, duplicatesSkipped };
}

const wordCount = (lines) => lines.join(' ').split(/\s+/).filter(Boolean).length;

// --- modes ------------------------------------------------------------------
if (opts.validate || opts.stale) {
  // Both gated modes need tasks.yaml: validate cross-checks its ids, stale
  // derives the freshness threshold from it. Absent/unparseable = bad input.
  const tasksRel = 'tasks.yaml';
  const tasksAbs = join(slugDir, tasksRel);
  let raw;
  try { raw = readFileSync(tasksAbs, 'utf8'); } catch { die(`cannot read ${tasksRel} in ${opts.input} (missing or unreadable)`); }
  let taskIds = new Set();
  let tasks = null; // hoisted: the validate branch's structural gate needs it
  if (opts.validate) {
    let data;
    try { ({ data } = parseYaml(raw, { filename: tasksRel })); } catch (e) {
      die(`${tasksRel}: unparseable YAML (${String(e?.message ?? e).replace(/^[^:]*:\d+:\s*/, '')})`);
    }
    tasks = data?.tasks;
    if (!Array.isArray(tasks)) die(`${tasksRel}: missing 'tasks:' sequence`);
    taskIds = new Set(tasks.map((t) => String(t?.id)));
  }

  if (opts.stale) {
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
      (() => { const m = GENERATED_AT_RE.exec(raw); const t = m ? Date.parse(m[1]) : NaN; return Number.isFinite(t) ? t : -Infinity; })(),
      statSync(tasksAbs).mtimeMs,
    );
    const stale = walkFiles(/\.md$|\.ya?ml$/i)
      .files
      .filter((r) => r !== tasksRel && (fileScope === null || r === fileScope))
      .map((r) => ({ file: relFromRoot(join(slugDir, r)), generatedAt: stampOf(join(slugDir, r)) }))
      .filter((e) => Date.parse(e.generatedAt) < threshold);
    console.log(JSON.stringify({ newestSource: 'tasks.yaml', stale }, null, 2));
  } else {
    // Structural gate first: a tasks.yaml with duplicate task ids or dangling
    // depends_on is unexecutable — surface it as exit 2 (GraphError class),
    // naming the offending id, before any reference scanning.
    try {
      buildGraph(tasks);
    } catch (e) {
      if (e instanceof GraphError) die(e.message, 2);
      throw e;
    }
    // --validate: five broken classes — unknown TASK-nn, unresolved FR-id,
    // dangling artifact link, unbalanced (odd) mermaid/code fences, and
    // 'dup-definition' (the same FR id defined on 2+ lines inside prd.md is
    // ambiguity, and highest-quality data forbids silently picking one).
    // Plus non-fatal `warnings` (heading-level sanity) that never move `ok`
    // or the exit code — only the verifier owns pass/fail.
    //
    // Counting semantics: `checked.*` counts UNIQUE refs; every entry in
    // `broken[]` appears exactly ONCE, at its first occurrence line. (--refs-to
    // intentionally lists EVERY occurrence line instead — lens vs gate.)
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
          while ((m = re.exec(doc.lines[i])) !== null) bump(sink, m[0], { file: relFromRoot(doc.abs), line: i + 1 });
        }
      };
      scan(TASK_ID_SOURCE, taskOcc);
      scan(FR_ID_SOURCE, isPrd ? frDefOcc : frRefOcc);
      checked.taskRefs = taskOcc.size;
      checked.frRefs = frRefOcc.size;

      // Links: dedup by (file, target) — the same link repeated in one file is
      // ONE ref: counted once in checked.links, reported once if broken.
      // ANCHOR ACCURACY: `doc.md#section` used to pass as long as the FILE
      // existed, so a link to a deleted/renamed section sailed through the
      // gate while pointing nowhere. Anchors now resolve against the target
      // document's real heading slugs.
      const linkSeen = new Set();
      for (const link of doc.links) {
        const lkey = `${doc.rel}\u0000${link.target}`;
        if (linkSeen.has(lkey)) continue;
        linkSeen.add(lkey);
        checked.links++;
        const hash = link.target.indexOf('#');
        const target = hash === -1 ? link.target : link.target.slice(0, hash);
        const anchor = hash === -1 ? null : link.target.slice(hash + 1);
        if (target && !existsSync(resolve(dirname(doc.abs), target))) {
          broken.push({ kind: 'link', ref: link.target, file: relFromRoot(doc.abs), line: link.line });
          continue;
        }
        if (anchor && target && /\.md$/i.test(target)) {
          const targetAbs = resolve(dirname(doc.abs), target);
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
      // file signals a skipped structural level (H1 titles don't count as
      // section context). Warning only — never fatal.
      let seenH2 = false;
      for (const h of doc.headings) {
        if (h.level === 2) seenH2 = true;
        else if (h.level === 3 && !seenH2) warnings.push({ kind: 'heading-skip', file: relFromRoot(doc.abs), line: h.line });
      }
    }
    for (const [ref, occ] of taskOcc) if (!taskIds.has(ref)) broken.push({ kind: 'task', ref, ...occ.first });
    for (const [ref, occ] of frRefOcc) if (!frDefOcc.has(ref)) broken.push({ kind: 'fr', ref, ...occ.first });
    for (const [ref, occ] of frDefOcc) if (occ.n > 1) broken.push({ kind: 'dup-definition', ref, ...occ.first });
    broken.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.ref < b.ref ? -1 : 1)));
    warnings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
    const ok = broken.length === 0;
    console.log(JSON.stringify({ ok, checked, broken, warnings }, null, 2));
    process.exit(ok ? 0 : 1);
  }
} else if (opts.refsTo !== null) {
  // Backlink query: any line in any markdown artifact containing the token as
  // a whole word — TASK-nn, FR-<MODULE>-nn, ADR NNNN[-slug], or a relative
  // artifact path alike; the matcher is uniform by design.
  // INTENTIONAL asymmetry vs --validate: this lens lists EVERY occurrence
  // line (a "where is this mentioned" report), while --validate reports each
  // unique broken ref once at its first occurrence. Do not "dedup" this mode.
  const re = new RegExp(wholeWordSource(opts.refsTo));
  const matches = [];
  for (const doc of collectDocs().docs) {
    for (let i = 0; i < doc.lines.length; i++) {
      if (re.test(doc.lines[i])) matches.push({ file: relFromRoot(doc.abs), line: i + 1, text: doc.lines[i].trim() });
    }
  }
  console.log(JSON.stringify({ ref: opts.refsTo, matches }, null, 2));
} else if (opts.diagrams) {
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
  console.log(JSON.stringify({ diagrams }, null, 2));
} else if (opts.digest) {
  // DIGEST — section index the agent reads instead of whole documents;
  // fetch exactly the sections it needs with --section.
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
  console.log(JSON.stringify({ slug, totalFiles: files.length, files }, null, 2));
} else if (opts.section !== null) {
  // SECTION — fetch ONE section (or one whole file) instead of the tree.
  const raw = opts.section;
  const hash = raw.indexOf('#');
  const filePart = hash === -1 ? raw : raw.slice(0, hash);
  const anchor = hash === -1 ? null : raw.slice(hash + 1);
  const candidates = [join(repoRoot, filePart), join(slugDir, filePart)];
  const hit = candidates.find((p) => { try { return statSync(p).isFile(); } catch { return false; } });
  if (!hit) die(`cannot read --section ${raw} (missing or not a file)`);
  let hitReal;
  try { hitReal = realpathSync(hit); } catch { hitReal = resolve(hit); }
  if (!hitReal.startsWith(slugDir + sep)) die(`--section ${raw} is outside ${opts.input}`);
  const doc = parsedDocAt(hit);
  if (!doc) die(`cannot read --section ${raw} (unreadable)`);
  if (anchor) {
    const section = findSection(doc, anchor);
    if (!section) die(`--section ${raw}: no section '${anchor}' in ${filePart}`);
    console.log(`<!-- archgen section: ${relFromRoot(hit)}#${section.slug} · lines ${section.line}-${section.endLine} -->`);
    console.log(section.body);
  } else {
    console.log(`<!-- archgen file: ${relFromRoot(hit)} -->`);
    console.log(doc.lines.join('\n'));
  }
} else if (opts.map !== null) {
  // MAP — section-level retrieval: WHERE is this token mentioned?
  const re = new RegExp(wholeWordSource(opts.map));
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
  hits.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line);
  console.log(JSON.stringify({ ref: opts.map, sections: hits, sectionCount: hits.length }, null, 2));
} else {
  // Overview (scale guard): the deduped inventory is always computed in full
  // and sorted, but only the FIRST 100 files are emitted — with
  // `truncated:true` whenever anything was cut — so agents reading the JSON
  // are never silently surprised by deterministic truncation. totalFiles
  // reports the true post-dedup count either way.
  const { docs, duplicatesSkipped } = collectDocs();
  const allFiles = docs.map((doc) => ({
    path: relFromRoot(doc.abs),
    title: doc.headings.find((h) => h.level === 1)?.text ?? basename(doc.rel),
    headings: doc.headings,
    wordCount: wordCount(doc.lines),
  }));
  const truncated = allFiles.length > OVERVIEW_MAX_FILES;
  const files = truncated ? allFiles.slice(0, OVERVIEW_MAX_FILES) : allFiles;
  console.log(JSON.stringify({ slug, files, totalFiles: allFiles.length, duplicatesSkipped, truncated }, null, 2));
}

// ---------------------------------------------------------------------------
// WHY doc-index.mjs EXISTS: source-symbol indexers cannot graph markdown
// headings or YAML task semantics, so they cannot see what archgen writes into
// .archgen/<slug>/. This is archgen's deterministic markdown layer: zero
// dependencies, byte-stable JSON, safe to gate CI on.
// ---------------------------------------------------------------------------
