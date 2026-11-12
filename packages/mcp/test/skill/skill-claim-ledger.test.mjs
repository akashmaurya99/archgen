// skill-claim-ledger.test.mjs — every obligation the guidance owes survives.
//
// WHY THIS FILE EXISTS.
//
// The skill, the five protocol references, the four dispatch briefs and the
// worker code standards are PROSE. An obligation lives in a sentence, and a
// sentence can be reworded, merged, or deleted without anything failing.
//
// That is a problem the moment anyone edits the prose for ANY reason — a
// compression pass, a rewording, a "this is redundant" cleanup. A dropped
// prohibition looks exactly like a dropped filler word, and the only thing
// that can tell them apart is a RECORD of what was promised.
//
// So the obligations are extracted once, as ATOMIC claims with stable ids
// (`internal/claims/skill-claims.json`), and each one is checked here. A
// claim may be REWORDED — the matcher is written against the obligation's
// load-bearing words, not the whole sentence — but it may not DISAPPEAR, and
// it may not WEAKEN.
//
// THE LEDGER IS NOT A FREEZE. A deleted obligation deletes its claim in the
// same commit, and that diff is the record. What the gate forbids is a
// SILENT deletion: a claim whose text no longer matches.
//
// WHY THE MATCHERS ARE REGEXES, NOT EXACT STRINGS. A matcher that pinned the
// exact wording would fail on every legitimate reword, and a gate that fails
// on every legitimate change gets disabled. The matchers here are written
// against the obligation's load-bearing words — "at most two rounds",
// "ARCHGEN_MCP", "BLOCKING" — so a reword that preserves the rule passes and
// a reword that removes the rule does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { REPO_ROOT, inRepo } from '../support/repo-root.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// packages/mcp/test/<domain> -> repo root (four levels up).
const REPO = REPO_ROOT;
const LEDGER = join(REPO, 'internal', 'claims', 'skill-claims.json');

/**
 * The guidance files that MUST carry claims.
 *
 * A new guidance file that carries obligations and no claims is invisible to
 * the ledger — so the set is pinned. Adding a file means adding its claims.
 */
const GUIDANCE_FILES = [
  'skill/SKILL.md',
  'skill/references/code-standards.md',
  'packages/mcp/assets/references/interview.md',
  'packages/mcp/assets/references/orchestration.md',
  'packages/mcp/assets/references/artifact-templates.md',
  'packages/mcp/assets/references/platforms.md',
  'packages/mcp/assets/references/mcp-and-skills.md',
  'packages/mcp/assets/briefs/_gate-protocol.md',
  'packages/mcp/assets/briefs/verifier.md',
  'packages/mcp/assets/briefs/review.md',
  'packages/mcp/assets/briefs/survey.md',
  'packages/mcp/assets/briefs/investigate.md',
];

const ledger = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : null;

test('the claim ledger is present and well formed', () => {
  if (!inRepo()) return;
  assert.ok(ledger, 'internal/claims/skill-claims.json must exist');
  assert.ok(Array.isArray(ledger.claims), 'the ledger must carry a claims array');
  assert.ok(ledger.claims.length >= 100, `the ledger must carry the obligations (found ${ledger.claims.length})`);

  const ids = new Set();
  for (const c of ledger.claims) {
    assert.ok(c.id, 'every claim needs an id');
    assert.ok(!ids.has(c.id), `duplicate claim id '${c.id}'`);
    ids.add(c.id);
    assert.ok(c.file, `claim '${c.id}' needs a file`);
    assert.ok(c.match, `claim '${c.id}' needs a matcher`);
    assert.ok(c.obligation, `claim '${c.id}' needs a stated obligation`);
  }
});

test('every guidance file that carries obligations has claims', () => {
  if (!inRepo() || !ledger) return;
  const covered = new Set(ledger.claims.map((c) => c.file));
  for (const f of GUIDANCE_FILES) {
    assert.ok(covered.has(f), `no claims cover '${f}' — a guidance file that carries obligations must be in the ledger`);
  }
  for (const f of covered) {
    assert.ok(GUIDANCE_FILES.includes(f), `claim file '${f}' is not a known guidance file`);
  }
});

test('every claim still matches — no obligation was dropped or weakened', () => {
  if (!inRepo() || !ledger) return;
  const cache = new Map();
  const read = (rel) => {
    if (!cache.has(rel)) {
      const p = join(REPO, rel);
      assert.ok(existsSync(p), `the guidance file '${rel}' must exist`);
      cache.set(rel, readFileSync(p, 'utf8'));
    }
    return cache.get(rel);
  };

  const failures = [];
  for (const c of ledger.claims) {
    const text = read(c.file);
    let re;
    try {
      re = new RegExp(c.match, 'i');
    } catch (e) {
      failures.push(`${c.id}: the matcher is not a valid regex (${e.message})`);
      continue;
    }
    if (!re.test(text)) {
      failures.push(`${c.id}: '${c.obligation}' — no longer matches ${c.file}`);
    }
  }
  assert.deepEqual(failures, [], `\n${failures.length} obligation(s) lost:\n  ${failures.join('\n  ')}`);
});

test('no claim is vacuous — a matcher that matches anything pins nothing', () => {
  if (!inRepo() || !ledger) return;
  // A matcher that matches EVERYTHING is a claim that can never fail, and a
  // claim that can never fail is a claim nobody wrote. The control string
  // shares no word with any obligation, so a matcher that still matches it
  // is pinning nothing.
  const CONTROL = 'quux frobnicate zzzz wibble';
  const vacuous = [];
  for (const c of ledger.claims) {
    let re;
    try {
      re = new RegExp(c.match, 'i');
    } catch {
      continue; // an invalid matcher is reported by the matching test
    }
    if (re.test(CONTROL)) vacuous.push(c.id);
  }
  assert.deepEqual(vacuous, [], `vacuous matchers pin nothing: ${vacuous.join(', ')}`);
});
