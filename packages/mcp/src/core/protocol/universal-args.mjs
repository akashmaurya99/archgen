// universal-args.mjs — the arguments every action of every tool takes, and
// the words their descriptions share.
//
// WHY A SEPARATE FILE: three things need the SAME list.
//
//   1. The routing map must leave these out — they belong to nearly every
//      action, so listing them once per action repeats them for nothing.
//   2. The catalog must say them ONCE, in the same words everywhere, so the
//      published tools cannot drift apart on a phrase they share.
//   3. The schema contract must know which arguments are universal, so it
//      can pin the routing without pinning the boilerplate.
//
// Two copies of a list is a list that drifts, so there is one.
import { z } from 'zod/v4';

/**
 * The arguments that are not specific to one action.
 *
 * `projectRoot` is here because every tool declares it and no action owns
 * it — the server reads it before the handler runs.
 */
export const UNIVERSAL_ARGS = new Set(['limit', 'offset', 'projectRoot']);

// Shared schema words. The catalog is injected into every request, so a
// description that repeats across the published tools is paid for again and
// again. One definition keeps the wording identical everywhere and impossible
// to drift.
export const LIMIT_DESC = 'Max items to return. Default 50.';
export const OFFSET_DESC = 'Skip this many items.';
const PROJECT_ROOT_DESC = 'Absolute project root; defaults to the server cwd.';
export const LOCATION_DESC = 'project | global | both. Default both.';
export const APPROVE_DESC = 'Required to write; without it returns the plan.';

/** The universal project-root argument, shared by every tool. */
export const projectRootArg = z
  .string()
  .optional()
  .describe(PROJECT_ROOT_DESC);
