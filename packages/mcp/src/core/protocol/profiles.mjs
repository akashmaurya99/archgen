// profiles.mjs — WHICH tools a session exposes.
//
// WHY THIS FILE EXISTS.
//
// ArchGen had ONE surface: every tool — the deterministic planning tools AND
// the machine-admin tools that install packages, rewrite harness configs and
// change global settings — was registered on the MCP server, so every client
// injected every schema into the model's context on every request.
//
// That is a privilege problem before it is a token problem. `archgen_setup`
// and `archgen_codegraph` can install software and write `$HOME`; a model
// that can call them is a model that can be talked into doing so by a
// repository it is reading. The approval flag they take is an ARGUMENT —
// the model supplies it — so it is not an authorization boundary.
//
// The fix is a PROFILE: a named set of tools a session may see.
//
//   lean  (default) — the DATA PLANE. Planning, execution, documents,
//                     capabilities, references, help and the runtime platform
//                     facts. Nothing here can install software or touch a
//                     user's global configuration.
//   full            — the CONTROL PLANE as well. The admin tools stay
//                     reachable for a personal workstation or a trusted
//                     automation run.
//
// The admin tools are NEVER deleted: their handlers stay registered in the
// spec registry, so the CLI facade (`archgen-mcp exec archgen_setup …`) and
// the admin commands keep working. A profile decides what the MODEL can
// call, not what the system can do.
//
// RESOLUTION ORDER (first hit wins):
//   1. an explicit profile argument (the CLI's `--tool-profile`)
//   2. $ARCHGEN_TOOL_PROFILE
//   3. the default profile
//
// An unknown value is REFUSED, never silently ignored: a typo that fell back
// to the default would give an enterprise deployment the wrong surface
// without saying so.
import { invalidInput } from './errors.mjs';
import { hint } from './guidance.mjs';
import { toolCall } from './call.mjs';

/**
 * The tools each profile exposes, in catalog order.
 *
 * The list is the PROFILE, not a filter over a bigger list: a tool that is
 * not named here is not registered on the server in that profile, so it never
 * appears in `tools/list` and never reaches the model's context.
 */
export const PROFILE_TOOLS = {
  lean: [
    'archgen_plan',
    'archgen_tasks',
    'archgen_docs',
    'archgen_registry',
    'archgen_skills',
    'archgen_refs',
    'archgen_help',
    'archgen_platform',
  ],
  full: [
    'archgen_plan',
    'archgen_tasks',
    'archgen_docs',
    'archgen_registry',
    'archgen_skills',
    'archgen_refs',
    'archgen_help',
    'archgen_platform',
    'archgen_setup',
    'archgen_codegraph',
  ],
};

/** The profile a session gets when nothing says otherwise. */
export const DEFAULT_PROFILE = 'lean';

/** Every profile name. */
export const PROFILE_NAMES = Object.keys(PROFILE_TOOLS);

/**
 * The tools the admin surface owns. They are never in the lean profile.
 *
 * Named here so anything that has to explain the split can point at the
 * command that replaces the tool.
 */
export const ADMIN_TOOLS = {
  archgen_setup: 'archgen-skill mcp add|remove|list · archgen-skill doctor',
  archgen_codegraph: 'archgen-skill codegraph status|ensure|wire',
};

/** The profile this process is serving. */
let active = DEFAULT_PROFILE;

/**
 * Resolve the profile from an explicit value or the environment.
 *
 * @param {string|null|undefined} explicit
 * @param {Record<string, string|undefined>} [env]
 * @returns {string}
 */
export function resolveProfile(explicit = null, env = process.env) {
  const raw = explicit ?? env.ARCHGEN_TOOL_PROFILE ?? null;
  if (raw === null || raw === undefined || String(raw).trim() === '') return DEFAULT_PROFILE;
  const name = String(raw).trim().toLowerCase();
  if (!PROFILE_NAMES.includes(name)) {
    throw invalidInput(
      `unknown tool profile '${raw}'`,
      {
        ...hint({ action: toolCall('archgen_help', { topic: 'setup' }), reason: 'the profiles are lean (default) and full.' }),
        profile: raw,
        available: PROFILE_NAMES,
      },
    );
  }
  return name;
}

/**
 * Set the profile this process serves.
 *
 * @param {string} name
 * @returns {string} the profile that is now active
 */
export function setActiveProfile(name) {
  active = PROFILE_NAMES.includes(name) ? name : DEFAULT_PROFILE;
  return active;
}

/** The profile this process is serving. */
export function activeProfile() {
  return active;
}

/**
 * The tools a profile exposes.
 *
 * @param {string} [profile]
 * @returns {string[]}
 */
export function toolNames(profile = active) {
  return [...(PROFILE_TOOLS[profile] ?? PROFILE_TOOLS[DEFAULT_PROFILE])];
}

/**
 * May this session see the tool?
 *
 * @param {string} name
 * @param {string} [profile]
 * @returns {boolean}
 */
export function isExposed(name, profile = active) {
  return toolNames(profile).includes(name);
}
