// platform-caps.mjs — the harness capability registry, served as tool output.
//
// The capability tables lived in references/platforms.md and the orchestrator had
// to read a markdown table to learn three things: where skills go, how the MCP
// config is shaped, and whether this harness can dispatch sub-agents. That is
// DATA, and a markdown table is a bad place for data a tool reads.
//
// This module serves the JSON registry. The reference keeps the narrative
// (detection order, the unknown-platform procedure, the CodeGraph indexing
// scope); the data lives in assets/platform-capabilities.json.
import { existsSync } from 'node:fs';
import { detectHarnesses } from './harness-wiring.mjs';
import { invalidInput, notFound } from '../protocol/errors.mjs';
import { hint } from '../protocol/guidance.mjs';
import { toolCall } from '../protocol/call.mjs';

/**
 * The capability row for one harness (or every harness).
 *
 * @param {object} registry the platform-capabilities.json content
 * @param {string|null} harness the harness id, or null for all
 */
export function platformCapabilities(registry, harness = null) {
  if (!harness) {
    return {
      detectionOrder: registry.detectionOrder ?? [],
      harnesses: Object.entries(registry.harnesses ?? {}).map(([id, h]) => ({ id, ...h })),
      universal: registry.universal ?? null,
    };
  }
  const key = String(harness).toLowerCase();
  const entry = registry.harnesses?.[key];
  if (!entry) {
    throw notFound(`unknown harness '${harness}'`, {
      ...hint({
        action: toolCall('archgen_help', { topic: 'platform' }),
        reason: 'the briefing names the harness the server can detect, and the procedure for one it cannot.',
      }),
      harness,
      known: Object.keys(registry.harnesses ?? {}),
    });
  }
  return { id: key, ...entry };
}

/**
 * Detect which harness this project is running under.
 *
 * The detection order is the registry's — it is the SAME order the skill's
 * Step 0 used, so the tool and the prose can never disagree.
 *
 * @param {object} registry
 * @param {{projectRoot: string, home: string}} opts
 */
export function detectHarness(registry, opts, wiringRegistry = null) {
  const { projectRoot, home } = opts;

  if (wiringRegistry) {
    const order = registry.detectionOrder ?? [];
    const found = detectHarnesses(wiringRegistry, projectRoot, home, opts.env).map((detected) => {
      const id = detected.id === 'vscode' ? 'copilot' : detected.id;
      return { id, wiringId: detected.id, label: registry.harnesses?.[id]?.label ?? detected.spec.label, atHome: detected.atHome, atProject: detected.atProject };
    });
    if (!found.length) {
      throw invalidInput(
        `no known harness detected in ${projectRoot} — follow the unknown-platform procedure (web-search the official docs, propose, get approval)`,
        { ...hint({ action: toolCall('archgen_platform', {}), reason: 'the harness registry names every harness the server detects.' }), projectRoot },
      );
    }
    found.sort((a, b) => rank(a.id, order) - rank(b.id, order));
    return { detected: found, primary: found[0], capabilities: platformCapabilities(registry, found[0].id) };
  }

  // Backward-compatible direct registry probing for library consumers.
  const found = [];
  for (const [id, h] of Object.entries(registry.harnesses ?? {})) {
    const atHome = (h.detectHome ?? []).some((m) => existsAt(home, m));
    const atProject = (h.detectProject ?? []).some((m) => existsAt(projectRoot, m));
    if (atHome || atProject) found.push({ id, label: h.label, atHome, atProject });
  }
  if (found.length === 0) {
    throw invalidInput(
      `no known harness detected in ${projectRoot} — follow the unknown-platform procedure (web-search the official docs, propose, get approval)`, { ...hint({ action: toolCall('archgen_platform', {}), reason: "the harness registry names every harness the server detects." }), projectRoot });
  }
  // The registry's detection order breaks ties.
  const order = registry.detectionOrder ?? [];
  found.sort((a, b) => rank(a.id, order) - rank(b.id, order));
  return { detected: found, primary: found[0], capabilities: platformCapabilities(registry, found[0].id) };
}

/**
 * The rank of a harness in the detection order (unknown → last).
 *
 * The match is EXACT. A prefix match ranked `code` against `codex` — two
 * different harnesses — and whichever came first in the registry won, so
 * the detected platform depended on the registry's ordering rather than on
 * what is actually installed.
 */
function rank(id, order) {
  const i = order.findIndex((marker) => {
    const clean = marker
      .replace(/^~\//, '')
      .replace(/^\./, '')
      .replace(/\/$/, '')
      .replace(/\.jsonc?$/, '')
      .split('/')[0];
    if (clean === id) return true;
    // VS Code is exposed as `copilot`; OpenCode has both file and directory
    // markers; Codex's marker is a home directory rather than a project one.
    return (id === 'copilot' && (marker.includes('copilot') || marker.includes('vscode')))
      || (id === 'opencode' && clean === 'opencode')
      || (id === 'codex' && clean === 'codex');
  });
  return i === -1 ? order.length : i;
}

/** Does a marker path exist under `base`? */
function existsAt(base, marker) {
  const path = marker.startsWith('~/') ? marker.slice(2) : marker;
  try {
    return existsSync(`${base}/${path}`);
  } catch {
    return false;
  }
}
