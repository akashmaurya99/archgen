// refs.test.mjs — the tool that serves archgen's own protocol documents.
//
// The references moved out of the skill directory, so the server became the
// courier. Two properties matter:
//   1. the agent gets CONTENT (not a path it cannot resolve);
//   2. it gets a SECTION (not an 11 KB document) — that is the whole point of
//      moving them behind a tool.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { indexTopic, readTopic, searchTopic, listTopics, resolveTopic, REF_TOPICS } from '../../src/core/docs/refs.mjs';
import { TEMPLATES_DIR } from '../../src/context.mjs';
import { ASSETS_DIR } from '../../src/context.mjs';

const REFS_DIR = join(ASSETS_DIR, 'references');

function roots(skillDir = null) {
  return { assetsDir: REFS_DIR, skillDir };
}

// ── discovery ───────────────────────────────────────────────────────────────

test('every reference topic is discoverable', () => {
  // Without a skill installed, the five server-owned topics are discoverable;
  // code-standards joins them once a skill is present.
  const serverOnly = listTopics(roots()).map((t) => t.topic).sort();
  assert.deepEqual(serverOnly, [
    'artifact-templates',
    'interview',
    'mcp-and-skills',
    'orchestration',
    'platforms',
  ]);

  const skillDir = mkdtempSync(join(tmpdir(), 'archgen-refs-'));
  try {
    mkdirSync(join(skillDir, 'references'), { recursive: true });
    writeFileSync(join(skillDir, 'references', 'code-standards.md'), '# Code standards\n', 'utf8');
    const withSkill = listTopics(roots(skillDir)).map((t) => t.topic).sort();
    assert.deepEqual(withSkill, [...REF_TOPICS].sort());
  } finally {
    rmSync(skillDir, { recursive: true, force: true });
  }
});

test('every reference topic has a title and sections', () => {
  for (const t of listTopics(roots())) {
    assert.ok(t.title, `${t.topic} needs a title`);
    assert.ok(t.sections >= 1, `${t.topic} needs at least one section`);
  }
});

test('the server owns the five orchestrator references', () => {
  for (const topic of ['interview', 'orchestration', 'artifact-templates', 'platforms', 'mcp-and-skills']) {
    const r = resolveTopic(topic, roots());
    assert.ok(r, `${topic} must resolve`);
    assert.equal(r.root, 'server');
  }
});

test('code-standards resolves from the INSTALLED SKILL, not the package', () => {
  // It must not be duplicated into the package — one copy, no drift.
  assert.equal(resolveTopic('code-standards', roots()), null, 'code-standards must not ship in the package');
  const skillDir = mkdtempSync(join(tmpdir(), 'archgen-refs-'));
  try {
    mkdirSync(join(skillDir, 'references'), { recursive: true });
    writeFileSync(join(skillDir, 'references', 'code-standards.md'), '# Code standards\n\n## Typing\n\n- no any\n', 'utf8');
    const r = resolveTopic('code-standards', roots(skillDir));
    assert.ok(r, 'code-standards must resolve from the skill');
    assert.equal(r.root, 'skill');
  } finally {
    rmSync(skillDir, { recursive: true, force: true });
  }
});

test('an unknown topic is a typed NOT_FOUND', () => {
  assert.throws(() => indexTopic('not-a-topic', roots()), (e) => e.code === 'NOT_FOUND');
});

// ── index ───────────────────────────────────────────────────────────────────

test('index returns the section list with GitHub-exact slugs', () => {
  const idx = indexTopic('orchestration', roots());
  assert.equal(idx.topic, 'orchestration');
  assert.ok(idx.sections.length > 5);
  for (const s of idx.sections) {
    assert.match(s.slug, /^[a-z0-9-]+$/, `slug '${s.slug}' must be a GitHub-exact slug`);
    assert.ok(s.line > 0 && s.endLine >= s.line);
  }
  assert.ok(idx.sections.some((s) => s.slug.includes('dispatch')));
});

// ── read ────────────────────────────────────────────────────────────────────

test('read returns ONE section, not the whole document', () => {
  const idx = indexTopic('interview', roots());
  const target = idx.sections.find((s) => s.slug === 'how-to-ask');
  assert.ok(target, 'the interview reference must have a how-to-ask section');
  const read = readTopic('interview', { ...roots(), section: 'how-to-ask' });
  assert.equal(read.section, 'how-to-ask');
  // Identify the section by its CONTENT, not by one fixed wording: the pin
  // must survive a rewrite of the reference without going blind.
  assert.match(read.text, /Recommendation-first/);
  // The section must be materially smaller than the whole topic.
  const whole = readTopic('interview', { ...roots(), section: '*' });
  assert.ok(read.text.length < whole.text.length / 2, 'a section must cost far less than the whole topic');
});

test('read without a section returns the MAP, not the whole topic', () => {
  // The whole topic is ~11 KB of English. It used to be the DEFAULT, so an
  // agent that forgot the section paid for the entire protocol instead of
  // getting the map that would have told it which section it needed.
  const read = readTopic('platforms', roots());
  assert.equal(read.section, undefined);
  assert.equal(read.text, undefined, 'no section named must NOT return the topic text');
  assert.ok(Array.isArray(read.sections) && read.sections.length > 0, 'it must return the section index');
  assert.match(read.next, /archgen_refs/, 'it must name the next call');
  // The topic's own H1 is not a section — listing it would put "the whole
  // document" at index 0.
  assert.ok(read.sections.every((s) => s.level > 1), 'the topic title must not be listed as a section');
});

test('the whole topic is still available — deliberately', () => {
  const read = readTopic('platforms', { ...roots(), section: '*' });
  assert.equal(read.whole, true);
  assert.ok(read.text.includes('## Platform detection'));
});

test('an unknown section is a typed NOT_FOUND that lists the valid ones', () => {
  assert.throws(
    () => readTopic('interview', { ...roots(), section: 'not-a-section' }),
    (e) => e.code === 'NOT_FOUND' && Array.isArray(e.details.available) && e.details.available.length > 0,
  );
});

// ── search ──────────────────────────────────────────────────────────────────

test('search finds the sections that mention a token', () => {
  const res = searchTopic('orchestration', 'APPROVE', roots());
  assert.equal(res.token, 'APPROVE');
  assert.ok(res.sectionCount > 0);
  for (const hit of res.sections) {
    assert.ok(hit.occurrences > 0);
    assert.ok(hit.matches.length > 0);
  }
});

test('search is WHOLE-WORD, not substring', () => {
  // "APPROVE" must not fire inside "APPROVED_BY" style tokens glued to letters.
  const res = searchTopic('orchestration', 'APPROVE', roots());
  for (const hit of res.sections) {
    for (const m of hit.matches) {
      assert.match(m.text, /(?<![A-Za-z0-9_])APPROVE(?![A-Za-z0-9_])/i, `substring match leaked: ${m.text}`);
    }
  }
});

test('a token nobody mentions returns zero hits (not an error)', () => {
  const res = searchTopic('interview', 'zzzzz-not-a-real-token', roots());
  assert.equal(res.sectionCount, 0);
  assert.deepEqual(res.sections, []);
});

// ── the templates stay separate ─────────────────────────────────────────────

test('the artifact templates are a SEPARATE root from the references', () => {
  // The templates are served by archgen_plan{action:'scaffold'}; the protocol
  // documents are served by archgen_refs. Two tools, two roots, one engine.
  assert.notEqual(TEMPLATES_DIR, REFS_DIR);
  assert.ok(TEMPLATES_DIR.endsWith('templates'));
  assert.ok(REFS_DIR.endsWith('references'));
  // A template FILE is not a reference topic — the two roots never overlap.
  for (const name of ['tasks.yaml', 'architecture.yaml', 'prd.md', 'adr.md', 'edge-matrix.md']) {
    assert.equal(resolveTopic(name, roots()), null, `${name} is a template, not a reference topic`);
  }
});
