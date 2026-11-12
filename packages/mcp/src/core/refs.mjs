// refs.mjs — section-level serving of the reference documents.
//
// WHY A TOOL: an MCP server cannot inject file content into the agent's
// context — the agent must READ it. So when the references moved out of the
// skill directory, the SERVER became the courier: the agent asks for a
// section and gets its text back.
//
// WHY SECTION-LEVEL: a whole reference is ~11 KB; one section is ~1-2 KB.
// Serving sections is strictly better than the file read it replaces — less
// context, no truncation risk, and better retrieval than grepping.
//
// SAME ENGINE, TWO ROOTS: `archgen_docs` indexes the USER's artifacts
// (`.archgen/<slug>/`); this indexes archgen's OWN protocol documents. Both
// use `parseMarkdown` / `buildSections` / `findSection` from `docs.mjs` — one
// implementation of "read a section of a markdown file".
//
// The roots are:
//   1. the package's own `assets/references/` — the canonical protocol docs;
//   2. the INSTALLED skill's `references/` — worker-facing docs (e.g.
//      code-standards.md) that must stay readable as plain files because
//      worker sub-agents may have no MCP tools.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMarkdown, buildSections, findSection, sectionChildren, sectionOwnEnd, sectionPurpose, firstProse, toPurpose } from './docs.mjs';
import { notFound } from './errors.mjs';
import { noSuchSection } from './guidance.mjs';
import { toolCall } from './call.mjs';

/** The reference documents this server serves. */
export const REF_TOPICS = [
  'interview',
  'orchestration',
  'artifact-templates',
  'platforms',
  'mcp-and-skills',
  'code-standards',
];

/**
 * Resolve a topic to a file, searching the package assets first and the
 * installed skill second.
 *
 * @param {string} topic
 * @param {{assetsDir: string, skillDir: string|null}} opts
 * @returns {{topic: string, path: string, root: 'server'|'skill'}|null}
 */
export function resolveTopic(topic, opts) {
  const key = String(topic ?? '').toLowerCase();
  if (!key) return null;
  const candidates = [
    { path: join(opts.assetsDir, `${key}.md`), root: 'server' },
    ...(opts.skillDir ? [{ path: join(opts.skillDir, 'references', `${key}.md`), root: 'skill' }] : []),
  ];
  for (const c of candidates) {
    if (existsSync(c.path)) return { topic: key, path: c.path, root: c.root };
  }
  return null;
}

/**
 * The unknown-topic error — with a KNOWN list that is actually known.
 *
 * The list used to be the full `REF_TOPICS` constant, which names topics
 * this server cannot serve (the skill's own references resolve only when the
 * skill is installed). The error then said "unknown reference
 * 'code-standards'" and listed 'code-standards' as known — a contradiction
 * the caller could not act on.
 *
 * @param {string} topic
 * @param {{assetsDir: string, skillDir: string|null}} opts
 */
function unknownTopic(topic, opts) {
  const known = REF_TOPICS.filter((t) => resolveTopic(t, opts) !== null);
  const missing = REF_TOPICS.filter((t) => !known.includes(t));
  const hint = missing.length
    ? {
        hint:
          `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} served only when the archgen skill is installed — ` +
          'run `npx archgen-skill init` to install it',
      }
    : {};
  return notFound(`unknown reference '${topic}'`, { topic, known, ...hint });
}

/**
 * Index one reference topic: its title, purpose and section list.
 *
 * With `section`, it returns THAT section's entry — the same map, narrowed.
 * A topic has a dozen sections; an agent that wants one of them should not
 * have to take the dozen to find it.
 *
 * @param {string} topic
 * @param {{assetsDir: string, skillDir: string|null, section?: string|null}} opts
 */
export function indexTopic(topic, opts) {
  const resolved = resolveTopic(topic, opts);
  if (!resolved) throw unknownTopic(topic, opts);
  const doc = parseMarkdown(readFileSync(resolved.path, 'utf8'));
  const sections = buildSections(doc)
    // The topic's own H1 is not a SECTION — it is the topic. Listing it
    // would put "the whole document" at index 0 and make every section map
    // carry an entry that says nothing.
    .filter((s) => s.level > 1)
    .map((s) => ({
      slug: s.slug,
      title: s.title,
      // WHAT the section is FOR. The index used to carry a slug and a title
      // — enough to identify a section, not enough to CHOOSE one — so an
      // agent had to pull a section to learn what it covered, and paid for
      // every wrong guess.
      purpose: s.purpose ?? '',
      level: s.level,
      line: s.line,
      endLine: s.endLine,
    }));
  if (opts.section) {
    const hit = findSection(doc, opts.section);
    if (!hit) throw noSuchSection(resolved.topic, opts.section, sections.map((s) => s.slug));
    const one = sections.find((s) => s.slug === hit.slug);
    return {
      topic: resolved.topic,
      root: resolved.root,
      title: doc.headings.find((h) => h.level === 1)?.text ?? resolved.topic,
      section: one,
      sections: [one],
    };
  }
  return {
    topic: resolved.topic,
    root: resolved.root,
    title: doc.headings.find((h) => h.level === 1)?.text ?? resolved.topic,
    sections,
  };
}

/**
 * Read one section (or the topic's section INDEX).
 *
 * WHY THE DEFAULT IS THE INDEX: a whole topic is ~11 KB of English, and the
 * whole design of this module is that the agent reads a SECTION. Returning
 * the entire topic when the caller named no section made the expensive
 * answer the default — so an agent that forgot the section paid for the
 * whole protocol instead of getting the map that would have told it which
 * section it needed.
 *
 * So: no section → the INDEX (the map) plus the exact next call. The whole
 * topic is `section: '*'` — deliberate, never the default.
 *
 * WHY `include` EXISTS: a section returns its OWN content and NAMES its
 * nested subsections, so pulling a parent like `§orchestration/verifier`
 * returned 71 tokens and ten child slugs — and the agent had to make ten
 * more calls to read the protocol it had already been told to load.
 *
 * `include: 'all'` returns the WHOLE subtree in one call, which is the
 * parity `archgen_docs{action:'section', include:'all'}` has always had.
 * `include: 'own'` (the default) is unchanged.
 *
 * @param {string} topic
 * @param {{assetsDir: string, skillDir: string|null, section?: string|null, include?: string|null}} opts
 */
export function readTopic(topic, opts) {
  const resolved = resolveTopic(topic, opts);
  if (!resolved) throw unknownTopic(topic, opts);

  // The whole topic — asked for explicitly.
  if (opts.section === '*') {
    const doc = parseMarkdown(readFileSync(resolved.path, 'utf8'));
    return {
      topic: resolved.topic,
      root: resolved.root,
      section: null,
      whole: true,
      text: doc.lines.join('\n'),
      lines: doc.lines.length,
    };
  }

  // No section named: the MAP, not the text.
  if (!opts.section) {
    const indexed = indexTopic(topic, opts);
    return {
      ...indexed,
      whole: false,
      next: toolCall('archgen_refs', { action: 'read', topic: resolved.topic, section: '<the section you need>' }),
      hint: 'read ONE section — a whole topic is a map plus the text you did not ask for.',
    };
  }

  const doc = parseMarkdown(readFileSync(resolved.path, 'utf8'));
  const section = findSection(doc, opts.section);
  if (!section) {
    const available = buildSections(doc).map((s) => s.slug);
    throw noSuchSection(resolved.topic, opts.section, available);
  }
  // A section OWNS its nested subsections, so returning `section.body`
  // returned the whole subtree — the caller paid for every child and still
  // had no map of what it got. The section returns its OWN content and NAMES
  // its children, exactly like archgen_docs{action:'section'}.
  const children = sectionChildren(doc, section).map((c) => ({ slug: c.slug, title: c.title, line: c.line }));
  const ownEnd = sectionOwnEnd(doc, section);
  const whole = opts.include === 'all';
  const text = doc.lines.slice(section.line - 1, whole ? section.endLine : ownEnd).join('\n');
  const out = {
    topic: resolved.topic,
    root: resolved.root,
    section: section.slug,
    title: section.title,
    purpose: section.purpose ?? '',
    level: section.level,
    line: section.line,
    endLine: whole ? section.endLine : ownEnd,
    text,
    lines: text.split('\n').length,
    bytes: text.length,
    children,
  };
  if (whole) {
    out.subtree = true;
  } else {
    if (ownEnd !== section.endLine) out.sectionEndLine = section.endLine;
    if (children.length) {
      out.next =
        `${toolCall('archgen_refs', { action: 'read', topic: resolved.topic, section: '<child slug>' })} — ` +
        `${children.length} nested subsection(s) were not included`;
    }
  }
  return out;
}

/**
 * Which sections mention a token?
 *
 * The retrieval lens for "where is this talked about?" — the same question
 * `archgen_docs{action:'map'}` answers for the user's artifacts.
 *
 * @param {string} topic
 * @param {string} token
 * @param {{assetsDir: string, skillDir: string|null}} opts
 */
export function searchTopic(topic, token, opts) {
  const resolved = resolveTopic(topic, opts);
  if (!resolved) throw unknownTopic(topic, opts);
  const doc = parseMarkdown(readFileSync(resolved.path, 'utf8'));
  const esc = String(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Whole-word: a hit must not be glued to word characters on either side.
  const re = new RegExp(`(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`, 'i');

  // The sections OVERLAP: a parent section's body runs to the next heading at
  // the same or shallower level, so it CONTAINS its children. Reporting a hit
  // once per containing section therefore delivered the same line three times
  // for a three-level nesting — the agent paid for the same sentence three
  // times to learn one fact.
  //
  // So every hit is reported ONCE, under the DEEPEST section that contains
  // it: the most specific place the line actually lives.
  const sections = buildSections(doc).filter((s) => s.level > 1);
  const ownerOf = (line) => {
    let owner = null;
    for (const s of sections) {
      if (line < s.line || line > s.endLine) continue;
      if (owner === null || s.level > owner.level) owner = s;
    }
    return owner;
  };

  const hits = [];
  for (const section of sections) {
    const bodyLines = doc.lines.slice(section.line - 1, section.endLine);
    const matches = [];
    for (let i = 0; i < bodyLines.length; i++) {
      if (!re.test(bodyLines[i])) continue;
      const line = section.line + i;
      const owner = ownerOf(line);
      if (!owner || owner.slug !== section.slug) continue; // its deepest owner reports it
      // The excerpt must CONTAIN the token: truncating from the start produced
      // hits whose text did not show the word that matched, which is useless to
      // the agent reading the result.
      const raw = bodyLines[i].trim();
      let text = raw;
      if (raw.length > 200) {
        const at = Math.max(0, raw.search(re));
        const start = Math.max(0, at - 80);
        text = `${start > 0 ? '…' : ''}${raw.slice(start, start + 200)}${start + 200 < raw.length ? '…' : ''}`;
      }
      matches.push({ line, text });
    }
    if (matches.length) {
      hits.push({
        section: section.slug,
        title: section.title,
        level: section.level,
        line: section.line,
        endLine: section.endLine,
        occurrences: matches.length,
        // What was left out is COUNTED. `occurrences: 20` next to ten
        // excerpts used to imply twenty were available when ten arrived,
        // with no way to reach the rest.
        excerptsReturned: Math.min(10, matches.length),
        excerptsOmitted: Math.max(0, matches.length - 10),
        matches: matches.slice(0, 10),
      });
    }
  }
  return {
    topic: resolved.topic,
    root: resolved.root,
    token,
    sections: hits,
    sectionCount: hits.length,
    // The distinct lines behind those hits — reported once, counted once.
    matchCount: hits.reduce((n, h) => n + h.occurrences, 0),
  };
}

/**
 * Every topic the agent can load, with a one-line summary of when to load it.
 * This is the DISCOVERY surface: the agent must know the topics exist without
 * reading a file to find out.
 *
 * @param {{assetsDir: string, skillDir: string|null}} opts
 */
export function listTopics(opts) {
  const out = [];
  for (const topic of REF_TOPICS) {
    const resolved = resolveTopic(topic, opts);
    if (!resolved) continue;
    const doc = parseMarkdown(readFileSync(resolved.path, 'utf8'));
    const sections = buildSections(doc);
    // The topic's purpose: the document's first PROSE line under its H1. The
    // list is the DISCOVERY surface — an agent must know which topic exists
    // AND what it covers without reading a file.
    const h1 = doc.headings.find((h) => h.level === 1);
    const afterH1 = h1 ? h1.line : 0;
    out.push({
      topic,
      root: resolved.root,
      title: h1?.text ?? topic,
      purpose: toPurpose(firstProse(doc.lines, afterH1, doc.lines.length)),      sections: sections.length,
    });
  }
  return out;
}
