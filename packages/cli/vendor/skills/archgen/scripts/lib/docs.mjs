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
export function headingSlugs(doc) {
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
    sections.push({
      level: h.level,
      title: h.text,
      slug,
      line: h.line,
      endLine,
      body,
    });
  }
  return sections;
}

/** Resolve a section by slug, title, or tolerant slug variant. */
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
  return sections.find((s) => slugsMatch(s.slug.toLowerCase(), lower)) ?? null;
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
