// skill-manager.mjs — capability-skill matching, installation and loading.
//
// The archgen skill used to carry the FETCH-SKILL procedure as PROSE and a
// JSON registry the agent read by hand. Both are now tool calls: the agent
// asks "which capability skills does this task need?", the server matches
// against the registry, installs EXACTLY the matched skill, and hands back the
// file path a worker should follow.
//
// WHY EXACTLY ONE SKILL: the old registry entry was `npx skills add
// ibelick/ui-skills` — that installs the WHOLE family (9 skills) into every
// harness. It is also INTERACTIVE without --yes/--agent, so an automated
// install could hang. This module installs one named skill, non-interactively,
// with a machine-readable result.
//
// NO CLUSTERING: the registry maps a capability DOMAIN to ONE precise skill.
// A task that mentions "animation" gets the motion skill; a task that mentions
// "accessibility" gets the a11y skill. Never a bundle.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { skillSearchPaths } from './skill-roots.mjs';
import { slugifyHeading } from '../docs/docs.mjs';
import { invalidInput } from '../protocol/errors.mjs';
import { hint, teach } from '../protocol/guidance.mjs';
import { toolCall } from '../protocol/call.mjs';
import { satisfies } from '../protocol/compat.mjs';

/**
 * Registry shape (see assets/skill-registry.json).
 *
 * @typedef {{
 *   version: number,
 *   installer: {package: string, version: string, nodeEngine: string, addCommand: string, listCommand: string, telemetryEnv?: Record<string,string>},
 *   skills: Array<{id: string, slug: string, family: string, repo: string, purpose: string, matches: string[], policy: 'required'|'on-demand'}>,
 *   routing?: {id: string, slug: string, family: string, repo: string, purpose: string, matches: string[], policy: 'required'|'on-demand'},
 * }} SkillRegistry
 */

/**
 * Whole-word token matcher: a hit must not be glued to word characters on
 * either side, but path punctuation (`/`, `.`, `-`) may border it — so
 * "0001" finds "decisions/0001-postgres-over-mongo.md" while "TASK-05"
 * still refuses to match "TASK-055" or "XTASK-05".
 *
 * This is the same rule the skill's FETCH-SKILL procedure used.
 */
export function wholeWordSource(token) {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`;
}

/**
 * Match a task's title, summary and file ownership against the registry.
 *
 * @param {Registry} registry
 * @param {{title?: string, summary?: string, fileOwnership?: string[]}} task
 * @returns {Array<{id: string, slug: string, repo: string, purpose: string, policy: string, matched: string[]}>}
 */
export function matchSkills(registry, task) {
  const haystack = [task.title ?? '', task.summary ?? '', ...(task.fileOwnership ?? [])].join('\n');
  const out = [];
  for (const entry of registry.skills) {
    const matched = [];
    for (const pattern of entry.matches ?? []) {
      const re = new RegExp(wholeWordSource(pattern), 'i');
      if (re.test(haystack)) matched.push(pattern);
    }
    if (matched.length) {
      out.push({
        id: entry.id,
        slug: entry.slug,
        repo: entry.repo,
        purpose: entry.purpose,
        domain: entry.domain ?? entry.family ?? 'Capability',
        policy: entry.policy,
        matched,
      });
    }
  }
  return out;
}

/**
 * Map an archgen harness id to the `skills` CLI's agent id.
 *
 * The CLI installs into `.agents/skills/` universally and adds the
 * harness-specific dir/symlink itself; the agent id only selects which
 * directories get a link.
 */
export const HARNESS_AGENT_IDS = {
  claude: 'claude-code',
  opencode: 'opencode',
  cursor: 'cursor',
  codex: 'codex',
  gemini: 'gemini-cli',
  antigravity: 'antigravity-cli',
  copilot: 'github-copilot',
  windsurf: 'windsurf',
  zed: 'zed',
  kiro: 'kiro',
  trae: 'trae',
  universal: 'universal',
};

/**
 * Where a skill lands on disk.
 *
 * The installer writes `.agents/skills/` universally — every harness READS it
 * — plus a `.claude/skills/` symlink for Claude Code. A capability skill is
 * therefore always at `<project>/.agents/skills/<slug>/SKILL.md`.
 */
export function skillInstallPaths(projectRoot, slug, opts = {}) {
  const home = opts.home ?? homedir();
  const root = opts.global ? join(home, '.agents', 'skills') : join(projectRoot, '.agents', 'skills');
  const canonical = join(root, slug);
  return {
    canonical,
    skillFile: join(canonical, 'SKILL.md'),
    alt: [join(canonical, 'SKILL.md')],
  };
}

/**
 * Is a capability skill already installed for this project?
 *
 * The SEARCH walks the same roots the archgen skill itself is resolved from
 * (core/skill/skill-roots.mjs): the project chain upward, across every harness
 * directory, then the user-global roots.
 *
 * It used to look at exactly ONE path — `<projectRoot>/.agents/skills/<slug>/
 * SKILL.md` — so a skill installed one level up, or under a harness-specific
 * directory, was reported as "not installed" by the very tool that had just
 * installed it. `archgen_skills{action:'load'}` then returned
 * `loaded:false` for a skill that was sitting on disk.
 *
 * @returns {{installed: boolean, path: string|null, scope: 'project'|'global'|null, searchedPaths: string[]}}
 */
export function findInstalledSkill(projectRoot, slug, opts = {}) {
  const home = opts.home ?? homedir();
  const searched = [];
  for (const candidate of skillSearchPaths(projectRoot, slug, { home })) {
    const file = join(candidate.dir, 'SKILL.md');
    searched.push(file);
    if (existsSync(file)) {
      return { installed: true, path: file, scope: candidate.scope, searchedPaths: searched };
    }
  }
  return { installed: false, path: null, scope: null, searchedPaths: searched.slice(0, 24) };
}

/**
 * Run the `skills` CLI.
 *
 * NEVER throws — a missing CLI, a network failure or a non-zero exit is
 * reported, not raised. The CLI is INTERACTIVE unless `--yes` and an agent
 * are given, so both are ALWAYS passed.
 *
 * @param {string[]} args the CLI arguments
 * @param {{cwd: string, timeout?: number, env?: Record<string, string|undefined>}} opts
 */
function runSkillsCli(args, opts) {
  const { cwd, timeout = 300000, env = process.env } = opts;
  const merged = {
    ...env,
    // The CLI collects anonymous telemetry for public repos by default.
    DISABLE_TELEMETRY: '1',
    DO_NOT_TRACK: '1',
    ...(opts.env ?? {}),
  };
  let r;
  try {
    r = spawnSync('npx', ['-y', 'skills', ...args], {
      encoding: 'utf8',
      timeout,
      cwd,
      env: merged,
      shell: false,
      // On Windows the npx shim is a .cmd file, which needs a shell.
      ...(process.platform === 'win32' ? { shell: true } : {}),
    });
  } catch (e) {
    return { ok: false, code: null, stdout: '', stderr: '', detail: String(e?.message ?? e) };
  }
  if (r.error) {
    return { ok: false, code: null, stdout: '', stderr: '', detail: String(r.error.message ?? r.error) };
  }
  const stdout = r.stdout ?? '';
  const stderr = r.stderr ?? '';
  return {
    ok: r.status === 0,
    code: r.status ?? null,
    stdout,
    stderr,
    detail: r.status === 0 ? undefined : (stderr || stdout).trim().split('\n')[0],
  };
}

/**
 * Install ONE capability skill into the given harness.
 *
 * @param {{
 *   registry: SkillRegistry,
 *   entry: {id: string; slug: string; repo: string},
 *   projectRoot: string,
 *   harness?: string,
 *   global?: boolean,
 *   approved?: boolean,
 *   home?: string,
 *   env?: Record<string, string|undefined>,
 * }} opts
 * @returns {Promise<Record<string, unknown>>}
 */
export async function installSkill(opts) {
  const {
    registry,
    entry,
    projectRoot,
    harness = 'universal',
    global = false,
    approved = false,
    home = homedir(),
    env = process.env,
  } = opts;

  const existing = findInstalledSkill(projectRoot, entry.slug, { home });
  // An UNKNOWN harness used to fall back to 'universal' — a typo silently
  // installed for the wrong target and reported success. A harness name is a
  // target: an unknown one is a typed error, never a guess.
  if (!Object.prototype.hasOwnProperty.call(HARNESS_AGENT_IDS, harness)) {
    throw invalidInput(
      `unknown harness '${harness}' (allowed: ${Object.keys(HARNESS_AGENT_IDS).join('|')})`, { ...hint({ action: toolCall('archgen_skills', { action: 'list' }), reason: "the registry lists every harness the server can install into." }), harness, allowed: Object.keys(HARNESS_AGENT_IDS) });
  }
  const agentId = HARNESS_AGENT_IDS[harness];

  if (existing.installed) {
    return {
      installed: true,
      alreadyInstalled: true,
      skill: entry.slug,
      path: existing.path,
      scope: existing.scope,
      detail: 'already installed — nothing to do',
    };
  }

  // Approval gate: an install writes into the user's harness directories.
  if (!approved) {
    const paths = skillInstallPaths(projectRoot, entry.slug, { global, home });
    return {
      installed: false,
      planned: true,
      skill: entry.slug,
      repo: entry.repo,
      agent: agentId,
      scope: global ? 'global' : 'project',
      wouldWrite: paths.skillFile,
      command: `npx -y skills add ${entry.repo} --skill ${entry.slug} --agent ${agentId} --yes${global ? ' --global' : ''}`,
      detail: 'needs approval — nothing was installed',
    };
  }

  const args = [
    'add',
    entry.repo,
    '--skill',
    entry.slug,
    '--agent',
    agentId,
    '--yes',
    '--json',
  ];
  if (global) args.push('--global');

  // The capability-skill installer is a THIRD-PARTY package with its own Node
  // requirement — `skills` needs a newer Node than the server does. On an
  // older Node the install died inside npx with a message about the
  // installer, not about what to do. The requirement is in the registry, so
  // it is checked HERE, before anything is spawned.
  const nodeEngine = registry?.installer?.nodeEngine ?? null;
  if (nodeEngine) {
    let ok = true;
    try {
      ok = satisfies(process.versions.node, nodeEngine);
    } catch {
      ok = true; // an unparseable requirement must not block the install
    }
    if (!ok) {
      throw invalidInput(
        teach(
          `the capability-skill installer needs Node ${nodeEngine}; this server runs on Node ${process.versions.node}`,
          'every other capability works on this Node — only installing a capability skill needs the newer one',
          'upgrade Node, then install the skill',
        ),
        {
          ...hint({
            action: 'upgrade Node, then install the skill',
            reason: `the \`skills\` installer package declares node ${nodeEngine}.`,
          }),
          required: nodeEngine,
          running: process.versions.node,
          skill: entry.slug,
        },
      );
    }
  }

  const r = runSkillsCli(args, { cwd: projectRoot, env });

  // The CLI writes its result as JSON on stdout; parse it when it is there.
  let cliResult = null;
  try {
    const parsed = JSON.parse(r.stdout);
    cliResult = Array.isArray(parsed) ? parsed[0] ?? null : parsed;
  } catch {
    /* not JSON — the report below still carries the outcome */
  }

  const after = findInstalledSkill(projectRoot, entry.slug, { home });
  return {
    installed: after.installed,
    alreadyInstalled: false,
    skill: entry.slug,
    repo: entry.repo,
    agent: agentId,
    scope: after.scope ?? (global ? 'global' : 'project'),
    path: after.path,
    cli: cliResult,
    detail: r.ok ? undefined : r.detail,
  };
}

/**
 * Load a skill's SKILL.md so it can be injected into a worker prompt.
 *
 * @param {{projectRoot: string, slug: string, home?: string}} opts
 * @returns {{loaded: boolean, path: string|null, scope: string|null, content: string|null, bytes: number, searchedPaths: string[]}}
 */
export function loadSkill(opts) {
  const found = findInstalledSkill(opts.projectRoot, opts.slug, { home: opts.home });
  if (!found.installed || !found.path) {
    return {
      loaded: false,
      path: null,
      scope: null,
      content: null,
      bytes: 0,
      // Where the tool looked — so "not installed" is diagnosable in ONE call
      // instead of two.
      searchedPaths: found.searchedPaths ?? [],
    };
  }
  let content;
  try {
    content = readFileSync(found.path, 'utf8');
  } catch {
    return { loaded: false, path: found.path, scope: found.scope, content: null, bytes: 0, searchedPaths: found.searchedPaths ?? [] };
  }
  return {
    loaded: true,
    path: found.path,
    scope: found.scope,
    content,
    bytes: content.length,
    searchedPaths: found.searchedPaths ?? [],
  };
}

/**
 * List the capability skills that are installed for this project.
 *
 * The registry's ROUTING entry is included. It is installable and loadable
 * like any other skill, but the list iterated only `registry.skills` — so a
 * routing skill that was installed on disk was reported as absent.
 *
 * @param {{projectRoot: string, registry: SkillRegistry, home?: string}} opts
 */
export function listInstalled(opts) {
  const out = [];
  const entries = [...(opts.registry.skills ?? [])];
  if (opts.registry.routing) entries.push(opts.registry.routing);
  for (const entry of entries) {
    const found = findInstalledSkill(opts.projectRoot, entry.slug, { home: opts.home });
    if (found.installed) {
      out.push({ id: entry.id, slug: entry.slug, path: found.path, scope: found.scope });
    }
  }
  return out;
}

/**
 * The ONE wording for "follow this capability skill".
 *
 * The wording used to exist in THREE places with three different texts —
 * the worker contract, this module, and references/mcp-and-skills.md — and
 * the contract's copy shipped the literal `<Domain>` placeholder into every
 * worker prompt. One owner, one sentence, no placeholder.
 *
 * @param {{slug?: string, path?: string|null, domain?: string|null}} entry
 * @returns {string}
 */
export function skillDirective(entry) {
  const slug = entry?.slug ?? 'the skill';
  const path = entry?.path ?? `.agents/skills/${slug}/SKILL.md`;
  const domain = entry?.domain ?? 'Capability';
  return `${domain} work: follow ${path} (installed via FETCH-SKILL) — apply its standards to every relevant decision.`;
}

/**
 * The follow-instruction injected into a worker prompt.
 *
 * Kept as the historical name; it is now a thin alias of `skillDirective`,
 * which is the single owner of the wording.
 */
export function followInstruction(entry) {
  return skillDirective(entry);
}

/**
 * The NORMATIVE rules of a skill — the lines that carry a MUST, SHOULD,
 * NEVER, ALWAYS, REQUIRED or DO NOT.
 *
 * WHY A SEMANTIC FILTER AND NOT A SIZE CAP: a cap is a guess about how much
 * is enough, and a guess cuts a skill's rules in half — the worker then
 * complies with the half it was shown. A rule filter is not a guess: it
 * selects the lines that actually change a decision, and leaves the prose
 * (the "How to use", the intro, the examples) behind, because prose does not
 * change what a worker builds.
 *
 * The result is the skill's real operative content — complete, never
 * truncated. How much of it reaches a given prompt is the AGENT's call: the
 * worker contract carries the rules, and `archgen_skills{action:'load',
 * section}` is the lens for pulling any single section of the skill when the
 * agent decides it needs more.
 *
 * @param {string} text the skill's SKILL.md content
 * @returns {{rules: string, count: number, headings: string[]}}
 */
export function skillRules(text) {
  const lines = String(text ?? '').split('\n');
  const rules = [];
  const headings = [];
  let heading = null;
  let inFence = false;

  for (const raw of lines) {
    const line = raw.trimEnd();
    // A fenced block is code, not a rule.
    if (/^ {0,3}```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (h) {
      heading = h[2];
      headings.push(heading);
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (!bullet) continue;
    const rule = bullet[1].trim();
    if (!/\b(MUST|SHOULD|NEVER|ALWAYS|REQUIRED|DO NOT)\b/.test(rule)) continue;
    rules.push(heading ? `[${heading}] ${rule}` : rule);
  }
  return { rules: rules.join('\n'), count: rules.length, headings };
}

/**
 * The section index of a skill — the lens the agent drives.
 *
 * Same shape as `archgen_docs{action:'digest'}`: a map, not a copy. The
 * agent sees every section of the skill and pulls exactly the one it needs.
 *
 * @param {string} text the skill's SKILL.md content
 * @returns {Array<{slug: string, title: string, level: number, line: number, endLine: number, normative: boolean}>}
 */
export function skillSections(text) {
  const lines = String(text ?? '').split('\n');
  const headings = [];
  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^ {0,3}```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (h) headings.push({ level: h[1].length, text: h[2], line: i + 1 });
  }
  const counts = new Map();
  const out = [];
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i];
    const base = slugifyHeading(h.text);
    if (!base) continue;
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    const slug = n === 0 ? base : `${base}-${n}`;
    let endLine = lines.length;
    for (let j = i + 1; j < headings.length; j++) {
      if (headings[j].level <= h.level) {
        endLine = headings[j].line - 1;
        break;
      }
    }
    const body = lines.slice(h.line - 1, endLine).join('\n');
    out.push({
      slug,
      title: h.text,
      level: h.level,
      line: h.line,
      endLine,
      normative: /\b(MUST|SHOULD|NEVER|ALWAYS|REQUIRED|DO NOT)\b/.test(body),
    });
  }
  return out;
}
