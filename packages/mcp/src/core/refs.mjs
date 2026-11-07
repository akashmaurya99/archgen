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
import { parseMarkdown, buildSections, findSection } from './docs.mjs';
import { notFound } from './errors.mjs';
import { noSuchSection } from './guidance.mjs';

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
 * Index one reference topic: its title, purpose and section list.
 *
 * @param {string} topic
 * @param {{assetsDir: string, skillDir: string|null}} opts
 */
export function indexTopic(topic, opts) {
  const resolved = resolveTopic(topic, opts);
  if (!resolved) throw notFound(`unknown reference '${topic}'`, { topic, known: REF_TOPICS });
  const doc = parseMarkdown(readFileSync(resolved.path, 'utf8'));
  return {
    topic: resolved.topic,
    root: resolved.root,
    title: doc.headings.find((h) => h.level === 1)?.text ?? resolved.topic,
    sections: buildSections(doc).map((s) => ({
      slug: s.slug,
      title: s.title,
      level: s.level,
      line: s.line,
      endLine: s.endLine,
    })),
  };
}

/**
 * Read one section (or the whole topic).
 *
 * @param {string} topic
 * @param {{assetsDir: string, skillDir: string|null, section?: string|null}} opts
 */
export function readTopic(topic, opts) {
  const resolved = resolveTopic(topic, opts);
  if (!resolved) throw notFound(`unknown reference '${topic}'`, { topic, known: REF_TOPICS });
  const text = readFileSync(resolved.path, 'utf8');
  const doc = parseMarkdown(text);

  if (!opts.section) {
    return {
      topic: resolved.topic,
      root: resolved.root,
      section: null,
      text: doc.lines.join('\n'),
      lines: doc.lines.length,
    };
  }

  const section = findSection(doc, opts.section);
  if (!section) {
    const available = buildSections(doc).map((s) => s.slug);
    throw noSuchSection(resolved.topic, opts.section, available);
  }
  return {
    topic: resolved.topic,
    root: resolved.root,
    section: section.slug,
    title: section.title,
    line: section.line,
    endLine: section.endLine,
    text: section.body,
  };
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
  if (!resolved) throw notFound(`unknown reference '${topic}'`, { topic, known: REF_TOPICS });
  const doc = parseMarkdown(readFileSync(resolved.path, 'utf8'));
  const esc = String(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Whole-word: a hit must not be glued to word characters on either side.
  const re = new RegExp(`(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`, 'i');

  const hits = [];
  for (const section of buildSections(doc)) {
    const bodyLines = doc.lines.slice(section.line - 1, section.endLine);
    const matches = [];
    for (let i = 0; i < bodyLines.length; i++) {
      if (re.test(bodyLines[i])) {
        matches.push({ line: section.line + i, text: bodyLines[i].trim().slice(0, 200) });
      }
    }
    if (matches.length) {
      hits.push({
        section: section.slug,
        title: section.title,
        level: section.level,
        line: section.line,
        endLine: section.endLine,
        occurrences: matches.length,
        matches: matches.slice(0, 10),
      });
    }
  }
  return { topic: resolved.topic, root: resolved.root, token, sections: hits, sectionCount: hits.length };
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
    out.push({
      topic,
      root: resolved.root,
      title: doc.headings.find((h) => h.level === 1)?.text ?? topic,
      sections: buildSections(doc).length,
    });
  }
  return out;
}
