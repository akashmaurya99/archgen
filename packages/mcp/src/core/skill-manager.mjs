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
 * @returns {{installed: boolean, path: string|null, scope: 'project'|'global'|null}}
 */
export function findInstalledSkill(projectRoot, slug, opts = {}) {
  const project = skillInstallPaths(projectRoot, slug, { global: false }).skillFile;
  if (existsSync(project)) return { installed: true, path: project, scope: 'project' };
  const global = skillInstallPaths(projectRoot, slug, { global: true, home: opts.home }).skillFile;
  if (existsSync(global)) return { installed: true, path: global, scope: 'global' };
  return { installed: false, path: null, scope: null };
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
export function runSkillsCli(args, opts) {
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
  const agentId = HARNESS_AGENT_IDS[harness] ?? 'universal';

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
 * @returns {{loaded: boolean, path: string|null, scope: string|null, content: string|null, bytes: number}}
 */
export function loadSkill(opts) {
  const found = findInstalledSkill(opts.projectRoot, opts.slug, { home: opts.home });
  if (!found.installed || !found.path) {
    return { loaded: false, path: null, scope: null, content: null, bytes: 0 };
  }
  let content;
  try {
    content = readFileSync(found.path, 'utf8');
  } catch {
    return { loaded: false, path: found.path, scope: found.scope, content: null, bytes: 0 };
  }
  return { loaded: true, path: found.path, scope: found.scope, content, bytes: content.length };
}

/**
 * List the capability skills that are installed for this project.
 * @param {{projectRoot: string, registry: SkillRegistry, home?: string}} opts
 */
export function listInstalled(opts) {
  const out = [];
  for (const entry of opts.registry.skills) {
    const found = findInstalledSkill(opts.projectRoot, entry.slug, { home: opts.home });
    if (found.installed) {
      out.push({ id: entry.id, slug: entry.slug, path: found.path, scope: found.scope });
    }
  }
  return out;
}

/**
 * The follow-instruction injected into a worker prompt (the registry's
 * canonical wording, so every worker gets the same contract).
 */
export function followInstruction(entry) {
  return `Follow ${entry.path ?? `.agents/skills/${entry.slug}/SKILL.md`} for this work — apply its standards to every relevant decision.`;
}
