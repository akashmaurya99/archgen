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
// Usage: node internal/tools/lint/teaching-lint.mjs
// Exit 0 ok · 1 contract violation · 4 usage/IO error
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');
const SRC = join(ROOT, 'packages', 'mcp', 'src');

/**
 * Failure sites that cannot carry a next-call hint.
 *
 * Each one is a fact about the CALL, not about the tool: the caller named no
 * path, so there is no call to name. A new entry needs a reason.
 *
 * The exemption is keyed by the file AND a SNIPPET of the site, never by a
 * line number: a line-numbered exemption silently stops applying when a line
 * is inserted above it, and silently starts applying to a DIFFERENT site when
 * the original one is deleted.
 *
 * An exemption that matches no site is a STALE exemption, and the lint says
 * so — a list nobody prunes rots into a hole in the gate.
 */
const ALLOWED_UNTAUGHT = new Map([
  // key: `file | snippet-prefix`   value: the reason
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
 * EVERY error constructor is inspected. The lint used to match only
 * `invalidInput(`, so a `notFound`, a `permissionDenied` or a `cycle` could
 * throw with no next step and the gate stayed green — the doctrine ("every
 * failure teaches the agent its next call") was enforced for one error code
 * out of nine.
 *
 * @param {string} text
 * @returns {Array<{line: number, snippet: string}>}
 */
function untaughtSites(text) {
  const out = [];
  for (const m of text.matchAll(/\b(invalidInput|notFound|permissionDenied|unavailable|timeout|conflict|ownershipConflict|cycle)\(/g)) {
    const args = callArguments(text, m.index + m[0].length - 1);
    const code = withoutStrings(args);
    if (/\bhint\s*\(/.test(code) || /\bteach\s*\(/.test(code)) continue;
    const line = text.slice(0, m.index).split('\n').length;
    out.push({ line, snippet: text.slice(m.index, m.index + 90).split('\n')[0].trim() });
  }
  return out;
}

/**
 * The exemption that applies to a site, if any.
 *
 * An exemption is keyed `file | snippet-prefix`, and ONE FILE MAY CARRY
 * SEVERAL of them. The one that applies is the one whose snippet-prefix the
 * site's snippet CONTAINS — not merely the first one registered for the
 * file. Matching on the file alone let the first exemption shadow every
 * later one, so a site that a later exemption was written for was reported
 * as a violation.
 *
 * The prefix is everything after the FIRST `|`, so a snippet that itself
 * contains a `|` is compared whole rather than truncated at the separator.
 * Both halves are trimmed, so the spacing a human writes around the `|`
 * cannot change which exemption applies.
 *
 * @param {string} rel the site's file, relative to src/
 * @param {string} snippet the site's snippet
 * @returns {string|null} the matching exemption key, or null when none applies
 */
function exemptionFor(rel, snippet) {
  for (const key of ALLOWED_UNTAUGHT.keys()) {
    const sep = key.indexOf('|');
    if (sep === -1) continue; // malformed: names no file, so it names no site
    // Both halves are trimmed: the key is written for a human to read, so
    // `file | prefix` (spaced) and `file|prefix` (tight) must mean the same
    // thing. A key whose spacing is read as a DIFFERENCE would make an
    // exemption stop applying for a reason no reader can see.
    if (key.slice(0, sep).trim() !== rel) continue;
    const prefix = key.slice(sep + 1).trim();
    if (!prefix) continue; // an exemption with no prefix identifies no site
    if (snippet.includes(prefix)) return key;
  }
  return null;
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

/**
 * The admin tools, and the files allowed to name them.
 *
 * A failure hint must teach a step the MODEL can take. In the lean profile
 * the admin tools (`archgen_setup`, `archgen_codegraph`) are NOT published —
 * so a hint that points at one teaches a call the model cannot make, and the
 * agent burns a round discovering that.
 *
 * The admin tools' own files are exempt: their hints describe what the
 * CLI (which CAN reach them) does.
 */
const ADMIN_TOOLS = ['archgen_setup', 'archgen_codegraph'];
const ADMIN_TOOL_FILES = ['tools/setup.mjs', 'tools/codegraph.mjs'];

/**
 * The hints in one file that name an admin tool.
 *
 * @param {string} text
 * @returns {Array<{line: number, snippet: string}>}
 */
function adminToolHints(text) {
  const out = [];
  for (const m of text.matchAll(/hint\s*\(\s*\{[^}]*action\s*:\s*toolCall\(\s*'(archgen_setup|archgen_codegraph)'/gs)) {
    const line = text.slice(0, m.index).split('\n').length;
    out.push({ line, snippet: text.slice(m.index, m.index + 90).split('\n')[0].trim() });
  }
  return out;
}

function main() {
  const files = sourceFiles(SRC);
  const violations = [];
  const privileged = [];
  const used = new Set();
  for (const file of files) {
    const rel = file.slice(SRC.length + 1);
    const text = readFileSync(file, 'utf8');
    const sites = untaughtSites(text);
    for (const site of sites) {
      const exemption = exemptionFor(rel, site.snippet);
      if (exemption) {
        used.add(exemption);
        continue;
      }
      violations.push({ rel, site });
    }
    // A hint that points at an unpublished tool teaches nothing. The admin
    // tools' own files are the exception: they describe the CLI.
    if (!ADMIN_TOOL_FILES.some((f) => rel.endsWith(f))) {
      for (const site of adminToolHints(text)) {
        privileged.push({ rel, site });
      }
    }
  }
  const stale = [...ALLOWED_UNTAUGHT.keys()].filter((k) => !used.has(k));
  if (violations.length || stale.length || privileged.length) {
    if (violations.length) {
      console.error('teaching-lint: failures that do not teach the next call.');
      for (const v of violations) {
        console.error(`  ${v.rel}:${v.site.line}: ${v.site.snippet}`);
      }
      console.error('  Every failure carries a hint({action, reason}) — see core/guidance.mjs.');
      console.error('  A site that cannot carry one belongs in ALLOWED_UNTAUGHT, with a reason.');
    }
    if (privileged.length) {
      console.error('teaching-lint: a failure hint points at an ADMIN tool the model cannot call.');
      for (const v of privileged) {
        console.error(`  ${v.rel}:${v.site.line}: ${v.site.snippet}`);
      }
      console.error('  The lean profile does not publish archgen_setup / archgen_codegraph.');
      console.error('  Point the hint at a published tool, or at the CLI command that does the work.');
    }
    if (stale.length) {
      console.error('teaching-lint: exemptions that match no site — they are stale.');
      // The reason is shown WITH the exemption: a reason nobody can read is
      // not a reason, and the reader is deciding whether to delete the entry
      // or to fix the site it was written for.
      for (const k of stale) console.error(`  ${k}  — ${ALLOWED_UNTAUGHT.get(k) ?? 'no reason given'}`);
    }
    process.exit(1);
  }
  console.log(`teaching-lint: every failure site in ${files.length} files teaches its next call.`);
  console.log(`teaching-lint: no failure hint points at an unpublished admin tool (${ADMIN_TOOLS.join(', ')}).`);
}

try {
  main();
} catch (e) {
  console.error(`teaching-lint: ${e.message}`);
  process.exit(4);
}
