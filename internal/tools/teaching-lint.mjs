// teaching-lint.mjs — the CI gate for the failure-teaching contract.
//
// WHY THIS FILE EXISTS. `core/guidance.mjs` declares the doctrine: every
// archgen failure is ONE line carrying the cause, the fix, and the exact
// next call. It was applied to roughly one failure site in seven — the rest
// threw a bare sentence and left the agent to guess.
//
// A doctrine nobody checks decays. This gate checks it: every `invalidInput`
// in `packages/mcp/src` must carry a machine-readable next-step hint, unless
// it is listed in ALLOWED_UNTAUGHT with a reason.
//
// Usage: node internal/tools/teaching-lint.mjs
// Exit 0 ok · 1 contract violation · 4 usage/IO error
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const SRC = join(ROOT, 'packages', 'mcp', 'src');

/**
 * Failure sites that cannot carry a next-call hint.
 *
 * Each one is a fact about the CALL, not about the tool: the caller named no
 * path, so there is no call to name. A new entry needs a reason.
 *
 * The list is per SITE, not per file: a file with one exempt site and forty
 * taught ones must still be checked for the other forty.
 */
const ALLOWED_UNTAUGHT = new Map([
  ['tools/registry.mjs:37', 'the registry row is self-describing — the call carries no arguments to repair'],
]);

/** Every source file under the package's src. */
function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (entry.endsWith('.mjs')) out.push(p);
  }
  return out;
}

/**
 * The failure sites in one file that carry no next-step hint.
 *
 * A call is taught when its OWN arguments reach a `hint(...)` or a
 * `teach(...)` — the two helpers that carry the contract. A hint elsewhere
 * in the file does not teach this call, and a STRING that merely mentions
 * "hint(" does not teach it either.
 *
 * @param {string} text
 * @returns {Array<{line: number, snippet: string}>}
 */
function untaughtSites(text) {
  const out = [];
  for (const m of text.matchAll(/invalidInput\(/g)) {
    const args = callArguments(text, m.index + m[0].length - 1);
    const code = withoutStrings(args);
    if (/\bhint\s*\(/.test(code) || /\bteach\s*\(/.test(code)) continue;
    const line = text.slice(0, m.index).split('\n').length;
    out.push({ line, snippet: text.slice(m.index, m.index + 90).split('\n')[0].trim() });
  }
  return out;
}

/**
 * The argument text with every string literal blanked out.
 *
 * A message that happens to contain the word "hint" is not a hint.
 *
 * @param {string} args
 * @returns {string}
 */
function withoutStrings(args) {
  return args
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

/**
 * The argument text of a call that starts at the given open parenthesis.
 *
 * @param {string} text
 * @param {number} open the index of the '('
 * @returns {string}
 */
function callArguments(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return text.slice(open + 1);
}

function main() {
  const files = sourceFiles(SRC);
  const violations = [];
  for (const file of files) {
    const rel = file.slice(SRC.length + 1);
    const text = readFileSync(file, 'utf8');
    const sites = untaughtSites(text);
    for (const site of sites) {
      if (ALLOWED_UNTAUGHT.has(`${rel}:${site.line}`)) continue;
      violations.push({ rel, site });
    }
  }
  if (violations.length) {
    console.error('teaching-lint: failures that do not teach the next call.');
    for (const v of violations) {
      console.error(`  ${v.rel}:${v.site.line}: ${v.site.snippet}`);
    }
    console.error('  Every failure carries a hint({action, reason}) — see core/guidance.mjs.');
    console.error('  A site that cannot carry one belongs in ALLOWED_UNTAUGHT, with a reason.');
    process.exit(1);
  }
  console.log(`teaching-lint: every failure site in ${files.length} files teaches its next call.`);
}

try {
  main();
} catch (e) {
  console.error(`teaching-lint: ${e.message}`);
  process.exit(4);
}
