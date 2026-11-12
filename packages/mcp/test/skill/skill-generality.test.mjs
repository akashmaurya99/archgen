// skill-generality.test.mjs — the skill defines invariants, not a stack.
//
// The skill used to prescribe TypeScript/Next.js/Prisma conventions as if they
// were universal: workers on Python, Go, Rust, or plain JavaScript were handed
// rules that did not apply and templates they could not copy. Scope profiling
// fixes the "always LARGE" default; this gate fixes the "always TypeScript"
// default.
//
// The host ecosystem owns style, naming, toolchain, and test runner. These
// files may describe archgen's own Node.js requirement, but they must not make
// an application language or framework mandatory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, inRepo } from '../support/repo-root.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = REPO_ROOT;
const SKILL = join(REPO, 'skill', 'SKILL.md');
const STANDARDS = join(REPO, 'skill', 'references', 'code-standards.md');
const TEMPLATES = join(REPO, 'packages', 'mcp', 'assets', 'templates');

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : null);

/** Language/framework tokens that must never be normative in the skill. */
const FORBIDDEN = [
  /\bTypeScript\b/,
  /\bPython\b/,
  /\bRust\b/,
  /\bPrisma\b/,
  /\bNext\.js\b/i,
  /\bNextjs\b/i,
  /\bReact\b/,
  /\bpnpm\b/,
  /\byarn\b/,
  /\bnpm run\b/,
  /\.tsx?\b/,
];

test('the always-on skill does not prescribe an application language or framework', () => {
  for (const file of [SKILL, STANDARDS]) {
    const text = read(file);
    if (!text) continue;
    for (const pattern of FORBIDDEN) {
      assert.doesNotMatch(text, pattern, `${file} makes '${pattern}' normative`);
    }
  }
});

test('the canonical templates are language-neutral placeholders', () => {
  if (!inRepo()) return; // published package — the templates are not shipped
  assert.ok(existsSync(TEMPLATES), 'the templates must be present in the repository');
  for (const name of readdirSync(TEMPLATES)) {
    const text = read(join(TEMPLATES, name));
    if (!text) continue;
    for (const pattern of FORBIDDEN) {
      assert.doesNotMatch(text, pattern, `${name} makes '${pattern}' normative`);
    }
    // A neutral template names the host toolchain instead of assuming one.
    if (name === 'architecture.yaml') {
      assert.match(text, /toolchain:/, 'architecture.yaml must carry a toolchain block');
      assert.match(text, /existing_docs:/, 'architecture.yaml must carry an existing_docs inventory');
    }
  }
});

test('the standards point at the host toolchain rather than a fixed layout', () => {
  const text = read(STANDARDS);
  if (!text) return;
  assert.match(text, /host repository|host ecosystem|host language/i, 'the standards must defer to the host ecosystem');
  assert.match(text, /<source-root>/, 'the layout must use a source root placeholder');
  assert.match(text, /<test-root>/, 'the layout must use a test root placeholder');
  // The place is fixed; the file NAME belongs to the language.
  assert.match(text, /FILE NAME is the language's business/i);
});

test('the survey records the host toolchain and existing docs', () => {
  const text = read(join(REPO, 'packages', 'mcp', 'assets', 'briefs', 'survey.md'));
  if (!text) return;
  assert.match(text, /## Existing docs/, 'the survey must inventory host documents');
  assert.match(text, /## Toolchain/, 'the survey must record the host toolchain');
  assert.match(text, /source root/i);
  assert.match(text, /test root/i);
});

// ── the guardrail extends to the protocol documents and the core ───────────
//
// "Language-neutral" is a promise; a test is what keeps it one. The protocol
// documents and the MCP core must not name a language, a framework, a package
// manager or a path shape — the host repo declares those, archgen reads them.

test('the protocol references and briefs prescribe no language or toolchain', () => {
  const dir = join(REPO, 'packages', 'mcp', 'assets', 'references');
  if (!inRepo()) return; // published package — the templates are not shipped
  assert.ok(existsSync(dir), 'the templates must be present in the repository');
  for (const name of readdirSync(dir)) {
    const text = read(join(dir, name));
    if (!text) continue;
    for (const pattern of FORBIDDEN) {
      assert.doesNotMatch(text, pattern, `references/${name} makes '${pattern}' normative`);
    }
  }
  const briefs = join(REPO, 'packages', 'mcp', 'assets', 'briefs');
  for (const name of readdirSync(briefs)) {
    const text = read(join(briefs, name));
    if (!text) continue;
    for (const pattern of FORBIDDEN) {
      assert.doesNotMatch(text, pattern, `briefs/${name} makes '${pattern}' normative`);
    }
  }
});

test('the audit core guesses no layout — it reads the declared roots', () => {
  const text = read(join(REPO, 'packages', 'mcp', 'src', 'core', 'plan-audit.mjs'));
  if (!text) return;
  // A default path prefix would silently enforce the wrong rule for half the
  // ecosystems. The roots come from architecture.yaml or the rule stays off.
  assert.doesNotMatch(text, /'src\/'|"src\/"/, 'the audit must not default to a source prefix');
  assert.doesNotMatch(text, /'tests\//, 'the audit must not default to a test prefix');
  assert.match(text, /source_root/, 'the audit must read the declared source root');
  assert.match(text, /test_root/, 'the audit must read the declared test root');
});
