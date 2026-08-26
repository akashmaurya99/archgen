// setup.ts — proactive setup state machine (host side).
//
// SAFETY CONTRACT: this module NEVER spawns a process and NEVER touches the
// filesystem. It turns probe results into a SetupState, resolves the single
// highest-precedence action, and composes the prompt text handed to the
// delivery controller. Everything is vscode-free so vitest (node env) can
// exercise it directly; extension.ts owns probe/fs/notification wiring.
//
// VERSION STAMP CONTRACT: `npx archgen-skill init` / `update` (packages/cli)
// writes ONE line — semver digits.digits.digits plus newline — into
// <skill root>/.archgen-version next to SKILL.md. The extension only READS
// that file; it never writes or executes anything. A missing or malformed
// stamp means an install that predates the CLI's stamping, so it is reported
// as version null ("unknown legacy") and treated as outdated-unknown: the
// skill works, but the extension cannot prove it matches this build.

/** Resolved skill presence + parsed version stamp. Nulls are meaningful: path null = not found, version null = unknown legacy install. */
export interface SkillInfo {
  installed: boolean;
  path: string | null;
  version: string | null;
}

/** Full setup snapshot for one workspace. */
export interface SetupState {
  skill: SkillInfo;
  planInitialized: boolean;
  /**
   * Tri-state up-to-dateness of the installed skill vs THIS extension build:
   * true = stamp >= extension version, false = stamp < extension version,
   * null = unknown (no skill, or legacy install without a readable stamp).
   */
  upToDate: boolean | null;
}

/** The one thing setup UX should nudge about; precedence install > initPlan > update > none. */
export type SetupAction = 'install' | 'initPlan' | 'update' | 'none';

export interface EvaluateSetupInput {
  /** False when the probe threw (ScriptsNotFoundError) — no skill anywhere. */
  probed: boolean;
  /** Resolved scripts dir from probeScriptsPath, or null when absent. */
  skillPath: string | null;
  /** Raw .archgen-version file contents (utf8), or null when unreadable/missing. */
  stampRaw: string | null;
  /** This extension's own package.json version. */
  extVersion: string;
  planInitialized: boolean;
}

/**
 * Apply the cross-package stamp rule: trim whitespace (the CLI writes a
 * trailing newline), then accept ONLY strict digits.digits.digits. Anything
 * else — garbage, partial versions, four segments — collapses to null so a
 * corrupt stamp can never masquerade as a known version.
 */
export function parseVersionStamp(raw: string | null): string | null {
  if (raw === null) return null;
  const trimmed = raw.trim();
  return /^\d+\.\d+\.\d+$/.test(trimmed) ? trimmed : null;
}

/**
 * Numeric per-segment semver comparison; missing segments pad as 0, so
 * '1.2' equals '1.2.0'. Inputs are assumed pre-validated by
 * parseVersionStamp's shape (or intentionally padded shorthand).
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.').map((s) => Number.parseInt(s, 10));
  const pb = b.split('.').map((s) => Number.parseInt(s, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = Number.isNaN(pa[i]) ? 0 : pa[i] ?? 0;
    const y = Number.isNaN(pb[i]) ? 0 : pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

/**
 * Pure core of evaluateSetupNow(): fold probe outcome + raw stamp + plan
 * presence into a SetupState. Never throws — every input is already the
 * caught/null-safe form produced by the host.
 */
export function evaluateSetup(input: EvaluateSetupInput): SetupState {
  const installed = input.probed && input.skillPath !== null;
  const version = installed ? parseVersionStamp(input.stampRaw) : null;
  let upToDate: boolean | null = null;
  if (installed && version !== null) upToDate = compareSemver(version, input.extVersion) >= 0;
  return {
    skill: { installed, path: installed ? input.skillPath : null, version },
    planInitialized: input.planInitialized,
    upToDate,
  };
}

/**
 * Highest-precedence pending action. Productivity first: without the skill
 * nothing else matters; with it, an absent plan beats an old version — and
 * update NEVER blocks (an outdated skill still runs every flow).
 */
export function resolveSetupAction(state: SetupState): SetupAction {
  if (!state.skill.installed) return 'install';
  if (!state.planInitialized) return 'initPlan';
  if (state.upToDate !== true) return 'update';
  return 'none';
}

/**
 * Every action worth an action card in the setup panel, in display order.
 * Unlike resolveSetupAction this shows the FULL truth (initPlan + update can
 * legitimately coexist); status bar and notifications stay top-precedence-only.
 */
export function pendingActions(state: SetupState): SetupAction[] {
  const cards: SetupAction[] = [];
  if (!state.skill.installed) cards.push('install');
  else {
    if (!state.planInitialized) cards.push('initPlan');
    if (state.upToDate !== true) cards.push('update');
  }
  return cards;
}

/** Install kickoff prompt: hands any agent the full context to set archgen up, then continue into generation. */
export function composeInstallPrompt(): string {
  return [
    'The ArchGen VS Code extension could not find the archgen agent skill in this workspace.',
    '',
    '1. Run: npx archgen-skill init',
    '2. Verify that .agents/skills/archgen/SKILL.md now exists.',
    '3. Then ask me what to build, and generate the architecture following GENERATE mode, including both the verifier gate and the user approval gate.',
  ].join('\n');
}

/**
 * Plan kickoff prompt routed at an installed skill. Empty idea (user cancelled
 * typing or wants a generic run) degrades to an open interview request.
 */
export function composeInitPlanPrompt(idea: string): string {
  const trimmed = idea.trim();
  const goal =
    trimmed !== ''
      ? `Then interview me briefly and generate the architecture for: ${trimmed}.`
      : 'Then interview me briefly about what to build, and generate the architecture for it.';
  return [
    'Read .agents/skills/archgen/SKILL.md first.',
    goal,
    'Follow GENERATE mode including verifier and approval gates.',
  ].join('\n');
}

/**
 * Update prompt: refresh the vendored skill copy, then verify the stamp moved.
 * currentVersion null renders the explicit legacy-install wording instead of
 * pretending we know what is on disk.
 */
export function composeUpdatePrompt(currentVersion: string | null, targetVersion: string): string {
  const found =
    currentVersion === null
      ? 'The ArchGen skill in this workspace does not report a version (a legacy install), while the extension ships ' +
        targetVersion +
        '.'
      : 'The ArchGen skill in this workspace reports version ' +
        currentVersion +
        ', but the extension ships ' +
        targetVersion +
        '.';
  return [
    found,
    '',
    '1. Run: npx archgen-skill update',
    '2. Confirm that .archgen-version now reports a version >= ' + targetVersion + '.',
  ].join('\n');
}
