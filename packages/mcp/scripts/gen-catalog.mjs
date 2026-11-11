// gen-catalog.mjs — generate the skill's tool table from the live schemas.
//
// WHY THIS FILE EXISTS. The table in SKILL.md listed every tool and every
// action by hand, while the schema was the real contract. Two incidents came
// from that copy: the table named a `search` action that did not exist, and
// a `read` action that did not exist either — both always-on, both fatal on
// the first call.
//
// So the table is GENERATED. The schema is the only source; the table is
// build output, and a drift gate proves it current.
//
// Usage: node scripts/gen-catalog.mjs [--check]
// Exit 0 ok · 1 out of date · 4 usage/IO error
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer, TOOL_NAMES } from '../src/server.mjs';
import { getToolSpec } from '../src/tools/_register.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MCP_ROOT = resolve(SCRIPT_DIR, '..');
const REPO_ROOT = resolve(MCP_ROOT, '..', '..');
const SKILL_MD = join(REPO_ROOT, 'skill', 'SKILL.md');

const START = '<!-- archgen:catalog:start -->';
const END = '<!-- archgen:catalog:end -->';

/** The one-line summary of each tool, in the order the table lists them. */
const SUMMARIES = {
  archgen_help: 'Full briefing for one domain—use it instead of guessing argument shapes',
};

/**
 * The trailing note of each tool's row.
 *
 * The action list says WHAT a tool does; the note says what it acts on, and
 * it is the part a hand-written table kept drifting.
 */
const NOTES = {
  archgen_registry: 'the `AGENTS.md` features registry',
  archgen_codegraph: 'CodeGraph & its MCP',
  archgen_refs: "topics: `interview`, `artifact-templates`, `orchestration`, `platforms`, `mcp-and-skills`, `code-standards`",
};

/** The actions a tool offers, read from its live schema. */
function actionsOf(name) {
  const shape = getToolSpec(name)?.inputSchema?.shape ?? {};
  const action = shape.action;
  const options = action?._def?.values ?? action?.options ?? null;
  return Array.isArray(options) ? options : [];
}

/** The rendered rows. The table header lives outside the generated block. */
function render() {
  return TOOL_NAMES.map((name) => {
    const actions = actionsOf(name);
    const summary = SUMMARIES[name] ?? '';
    const note = NOTES[name] ?? '';
    // A tool with no action enum (archgen_help) has no list — its summary IS
    // the row.
    if (!actions.length) return `| \`${name}\` | ${summary} |`;
    const list = actions.map((a) => `\`${a}\``).join(' · ');
    return `| \`${name}\` | ${list}${note ? ` — ${note}` : ''} |`;
  }).join('\n');
}

/**
 * Replace the generated block in the skill file.
 *
 * @param {string} text
 * @returns {string}
 */
export function applyCatalog(text) {
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start === -1 || end === -1) {
    throw new Error(`skill/SKILL.md must carry the ${START} / ${END} markers`);
  }
  const block = `${START}\n${render()}\n${END}`;
  return text.slice(0, start) + block + text.slice(end + END.length);
}

/**
 * The skill file with the generated table applied.
 *
 * @returns {string}
 */
export function catalogText() {
  return applyCatalog(readFileSync(SKILL_MD, 'utf8'));
}

function main() {
  const check = process.argv.includes('--check');
  createServer();
  const current = readFileSync(SKILL_MD, 'utf8');
  const next = applyCatalog(current);
  if (current === next) {
    console.log('gen-catalog: the skill tool table matches the live schemas.');
    return;
  }
  if (check) {
    console.error('gen-catalog: the skill tool table is out of date — run `npm run sync`.');
    process.exit(1);
  }
  writeFileSync(SKILL_MD, next);
  console.log('gen-catalog: the skill tool table was regenerated from the live schemas.');
}

try {
  main();
} catch (e) {
  console.error(`gen-catalog: ${e.message}`);
  process.exit(4);
}
