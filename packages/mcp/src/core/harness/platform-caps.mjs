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
export function detectHarness(registry, opts) {
  const { projectRoot, home } = opts;

  // The per-harness detect markers are the authoritative signal.
  const found = [];
  for (const [id, h] of Object.entries(registry.harnesses ?? {})) {
    const atHome = (h.detectHome ?? []).some((m) => existsAt(home, m));
    const atProject = (h.detectProject ?? []).some((m) => existsAt(projectRoot, m));
    if (atHome || atProject) found.push({ id, label: h.label, atHome, atProject });
  }
  if (found.length === 0) {
    throw invalidInput(
      `no known harness detected in ${projectRoot} — follow the unknown-platform procedure (web-search the official docs, propose, get approval)`, { ...hint({ action: toolCall('archgen_setup', { action: 'harness_info' }), reason: "the harness registry names every harness the server detects." }), projectRoot });
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
  const keys = Object.keys(order);
  const i = keys.findIndex((k) => {
    const clean = k.replace(/^\./, '').replace(/\/$/, '').replace(/\.json$/, '');
    return clean === id;
  });
  return i === -1 ? keys.length : i;
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
