// docs.mjs — markdown document model for doc-index.mjs: one implementation
// shared by the digest index, the --section extractor and anchor validation.
// Line ranges are 1-based post-CRLF normalization.

/** Parse a markdown document: headings, fences, artifact-path references. */
export function parseMarkdown(text) {
  const lines = text.split('\n');
  const headings = [];
  const allHeadings = [];
  const fences = [];
  const links = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^ {0,3}```/.test(line)) {
      const info = line.replace(/^ {0,3}```/, '').trim();
      // CommonMark pairing: inside an open fence only a BARE ``` closes it —
      // an info-carrying ``` is CONTENT, never an opener.
      if (inFence) {
        if (info === '') { fences.push({ line: i + 1, info: null }); inFence = false; }
      } else {
        fences.push({ line: i + 1, info });
        inFence = true;
      }
      continue;
    }
    if (inFence) continue;
    const h = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (h) {
      const entry = { level: h[1].length, text: h[2], line: i + 1 };
      allHeadings.push(entry);
      if (entry.level <= 3) headings.push(entry);
      continue;
    }
    ARTIFACT_PATH_RE.lastIndex = 0;
    let m;
    while ((m = ARTIFACT_PATH_RE.exec(line)) !== null) links.push({ line: i + 1, target: m[1] });
    MD_LINK_RE.lastIndex = 0;
    let lm;
    while ((lm = MD_LINK_RE.exec(line)) !== null) {
      const t = lm[1];
      if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith('#')) continue; // scheme'd or pure anchor
      if (/\.(md|markdown|ya?ml)$/i.test(t.split('#')[0])) links.push({ line: i + 1, target: t });
    }
  }
  // A target reachable by both extractors counts once.
  const seen = new Set();
  const uniqueLinks = links.filter((l) => {
    const k = `${l.line}\u0000${l.target}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { lines, headings, allHeadings, fences, links: uniqueLinks, balanced: fences.length % 2 === 0 };
}

// Artifact-relative cross-references: a slash-carrying path ending in a
// doc/yaml extension, e.g. `../architecture.yaml`.
const ARTIFACT_PATH_RE = /(?<![A-Za-z0-9_./-])((?:\.\.?\/)?[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\.(?:md|markdown|ya?ml))(?![A-Za-z0-9_/-])/g;
const MD_LINK_RE = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/**
 * GitHub-exact heading slug: lowercase, punctuation dropped, each whitespace
 * char becomes a hyphen (runs are NOT collapsed: "TASK-02 — Auth API" ->
 * "task-02--auth-api"). Hand-written anchors are GitHub anchors, so the
 * slugger must match GitHub exactly.
 */
export function slugifyHeading(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** Tolerant comparison: GitHub-exact plus the collapsed-hyphen variant. */
function slugsMatch(a, b) {
  if (a === b) return true;
  const collapse = (s) => s.replace(/-{2,}/g, '-');
  return collapse(a) === collapse(b);
}

/** Heading slugs incl. GitHub's -1/-2 duplicate disambiguation. */
function headingSlugs(doc) {
  const map = new Map();
  const counts = new Map();
  for (const h of doc.allHeadings ?? []) {
    const base = slugifyHeading(h.text);
    if (!base) continue;
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    const slug = n === 0 ? base : `${base}-${n}`;
    if (!map.has(slug)) map.set(slug, h);
  }
  return map;
}

/**
 * The first USABLE line in a span — prose first, then a list item, then a
 * table row.
 *
 * WHY: a purpose is a sentence a reader can act on. The first line of a
 * section is often a heading, a table header, or a code fence, and a purpose
 * that begins "## Provenance header" or "| Scope | Deterministic floor |"
 * says nothing the title did not already say.
 *
 * The order matters: prose carries the most meaning, a list item carries
 * the section's first rule, and a table row carries its first subject. A
 * section that begins with a table still gets a purpose.
 *
 * @param {string[]} lines
 * @param {number} from 0-based start (inclusive)
 * @param {number} to 0-based end (exclusive)
 * @returns {string}
 */
export function firstProse(lines, from, to) {
  let inFence = false;
  let tableHeaderSeen = false;
  for (let i = from; i < to; i++) {
    const line = (lines[i] ?? '').trim();
    if (/^ {0,3}```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!line) continue;
    if (line.startsWith('#')) continue; // a heading, not prose
    if (line.startsWith('>')) continue; // a quote — the authored purpose path
    if (line.startsWith('|')) {
      // A table: the FIRST row is the header, the second is the separator.
      if (!tableHeaderSeen) {
        tableHeaderSeen = true;
        continue;
      }
      if (/^\|[\s:|-]+\|$/.test(line)) continue; // the separator row
      const cell = line.replace(/^\|/, '').split('|')[0].trim();
      if (cell) return cell;
      continue;
    }
    return line;
  }
  return '';
}

/**
 * A one-line purpose from a block of prose.
 *
 * @param {string} text
 * @returns {string}
 */
export function toPurpose(text) {
  const flat = String(text ?? '')
    // A leading list marker is not part of the sentence.
    .replace(/^([-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return '';
  const sentence = flat.split(/(?<=[.!?])\s/)[0] ?? flat;
  // A purpose is a ONE-LINER. The index carries one per section, so a
  // purpose that runs on is a purpose the reader has to skip past.
  return sentence.length > 120 ? `${sentence.slice(0, 117)}…` : sentence;
}

/**
 * A section's PURPOSE — one line that says what the section is FOR.
 *
 * WHY THIS EXISTS. The index returned slug, title, level and line — enough
 * to identify a section, not enough to CHOOSE one. An agent that had to pull
 * a section to learn what it covered paid for every wrong guess, and the
 * sections it did not pull were the ones it had to guess about.
 *
 * So every section carries a purpose, and the index shows it. The purpose is
 * resolved in two steps:
 *
 *   1. an AUTHORED purpose — the first non-empty line after the heading,
 *      when it is a blockquote. It wins, because it was written for this;
 *   2. otherwise the section's first PROSE line, trimmed to one sentence.
 *
 * Step 2 means a section NEVER lacks a purpose, so the index is complete
 * without every reference file being edited first.
 *
 * @param {any} doc
 * @param {object} section
 * @returns {string}
 */
function sectionPurpose(doc, section) {
  const lines = doc?.lines ?? [];
  const start = section.line; // 0-based index of the line AFTER the heading
  // The authored purpose: the first non-empty line, when it is a quote.
  for (let i = start; i < Math.min(start + 6, section.endLine); i++) {
    const line = (lines[i] ?? '').trim();
    if (!line) continue;
    if (!line.startsWith('>')) break;
    const text = line.replace(/^>+\s*/, '').replace(/^PURPOSE:\s*/i, '').trim();
    if (text) return toPurpose(text);
    break;
  }
  // The fallback: the section's first prose line.
  return toPurpose(firstProse(lines, start, section.endLine));
}

/**
 * Sections: a heading owns everything up to the next same-or-shallower
 * heading (nested subsections included).
 */
export function buildSections(doc) {
  const headings = doc.allHeadings ?? [];
  const lines = doc.lines ?? [];
  const counts = new Map();
  const sections = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const base = slugifyHeading(h.text);
    if (!base) continue;
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    const slug = n === 0 ? base : `${base}-${n}`;
    // End line: the line before the next heading at the same or shallower level.
    let endLine = lines.length;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= h.level) { endLine = headings[j].line - 1; break; }
    }
    const body = lines.slice(h.line - 1, endLine).join('\n');
    const section = {
      level: h.level,
      title: h.text,
      slug,
      line: h.line,
      endLine,
      body,
    };
    section.purpose = sectionPurpose(doc, section);
    sections.push(section);
  }
  return sections;
}

/**
 * The nested subsections of a section (its direct children).
 *
 * A section OWNS everything up to the next same-or-shallower heading, so a
 * `## Per-task sections` heading owns its 20 `### T1..T20` children. Fetching
 * the parent therefore fetched the whole subtree — which is how one "pull the
 * section" call delivered most of a plan.
 *
 * The children are what the caller needs to drill down instead: each one has
 * a slug it can fetch on its own.
 *
 * @param {any} doc
 * @param {object} section
 * @returns {Array<{slug: string, title: string, level: number, line: number, endLine: number}>}
 */
export function sectionChildren(doc, section) {
  const headings = doc?.allHeadings ?? [];
  const built = buildSections(doc);
  const out = [];
  for (const h of headings) {
    if (h.level <= section.level) continue;
    if (h.line <= section.line || h.line > section.endLine) continue;
    const child = built.find((s) => s.line === h.line && s.level === h.level);
    if (child) {
      out.push({ slug: child.slug, title: child.title, level: child.level, line: child.line, endLine: child.endLine });
    }
  }
  return out;
}

/**
 * The last line of a section's OWN content — before its first child heading.
 *
 * @param {any} doc
 * @param {object} section
 * @returns {number}
 */
export function sectionOwnEnd(doc, section) {
  const headings = doc?.allHeadings ?? [];
  for (const h of headings) {
    if (h.level > section.level && h.line > section.line && h.line <= section.endLine) return h.line - 1;
  }
  return section.endLine;
}

/**
 * Resolve a section by slug, title, tolerant slug variant, or PREFIX.
 *
 * The PREFIX form matters: the skill's `§` markers use SHORT names
 * (`§artifact-templates/plan-depth`) while the headings produce longer
 * slugs (`plan-depth-by-scope-class`). Every `§` shorthand in the skill is
 * a prefix of a real slug, so accepting a prefix makes the shorthand the
 * skill teaches actually RESOLVABLE — an agent can pass exactly what it was
 * told without a discovery round-trip first.
 *
 * A prefix that matches MORE THAN ONE section is refused, never guessed:
 * two sections sharing a prefix means the caller must use the full slug.
 *
 * @param {any} doc
 * @param {string} ref
 */
export function findSection(doc, ref) {
  const sections = buildSections(doc);
  const wanted = String(ref).trim();
  const bySlug = sections.find((s) => s.slug === wanted);
  if (bySlug) return bySlug;
  const bySlugLoose = sections.find((s) => s.slug === slugifyHeading(wanted));
  if (bySlugLoose) return bySlugLoose;
  const byTitle = sections.find((s) => s.title.toLowerCase() === wanted.toLowerCase());
  if (byTitle) return byTitle;
  // Case-insensitive + collapsed-hyphen comparison: agents type
  // "FR-Catalog-01" or "fr-catalog-01" for the same heading.
  const lower = wanted.toLowerCase();
  const byLoose = sections.find((s) => slugsMatch(s.slug.toLowerCase(), lower));
  if (byLoose) return byLoose;
  // The `§` shorthand: a PREFIX of the slug. Only an UNAMBIGUOUS prefix
  // resolves — a guess would send the agent to the wrong section.
  const needle = slugifyHeading(wanted).toLowerCase();
  if (!needle) return null;
  const byPrefix = sections.filter((s) => s.slug.toLowerCase().startsWith(needle));
  return byPrefix.length === 1 ? byPrefix[0] : null;
}

/** Does `anchor` exist in the target document? */
export function anchorExists(targetDoc, anchor) {
  const wanted = String(anchor).trim().toLowerCase();
  if (!wanted) return false;
  for (const slug of headingSlugs(targetDoc).keys()) {
    if (slugsMatch(slug.toLowerCase(), wanted)) return true;
  }
  return false;
}
