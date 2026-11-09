// plan-profile.mjs — the deterministic scope + artifact classifier.
//
// WHY THIS EXISTS.
//
// The skill used to infer a scope class from the intent alone and then treat
// every artifact in that class as mandatory. In practice that made "a new
// system" mean LARGE, and LARGE meant a PRD, an architecture contract,
// decisions, diagrams, a plan and tasks — even when the request was a
// prototype, an internal tool, or a single-module feature. The expensive
// answer was the default.
//
// This module makes scope an EVIDENCE decision:
//   intent baseline + explicit signals + module count -> score -> scope
//
// and turns each artifact into a separate create / reuse / omit decision with
// a reason. It is read-only and deterministic: same inputs, same profile.
//
// The rules live in assets/depth-ladder.json (`profile`), so the data and the
// behavior cannot drift: a drift test pins the two together.
import { invalidInput } from './errors.mjs';

/** The four intents the classifier accepts. */
export const INTENTS = [
  'GREENFIELD-SYSTEM',
  'GREENFIELD-MODULE',
  'BROWNFIELD-FEATURE',
  'BROWNFIELD-CHANGE',
];

/** Every signal the classifier understands. Kept exported for the tool schema. */
export const SCOPE_SIGNALS = [
  'new-module',
  'multi-module',
  'public-contract',
  'data-migration',
  'security-sensitive',
  'multi-service',
  'external-integration',
  'cross-team',
  'regulated',
  'irreversible',
  'product-facing',
  'production',
  'prototype',
  'existing-prd',
  'existing-architecture',
  'existing-adr',
];

/** A short, high-value question when the evidence is not enough. */
function calibrationQuestion(intent) {
  if (intent.startsWith('GREENFIELD')) {
    return 'Is this production-bound and product-facing, or an internal prototype?';
  }
  return 'Does this touch a public contract, a data migration, or a security-sensitive surface?';
}

/** Deduplicate while preserving order. */
function unique(values) {
  return [...new Set(values)];
}

/** Does a rule's condition match the current profile? */
function ruleMatches(rule, { scope, intent, signals }) {
  if (rule.scopeIn && !rule.scopeIn.includes(scope)) return false;
  if (rule.intentIn && !rule.intentIn.includes(intent)) return false;
  if (rule.signalSome && !rule.signalSome.some((s) => signals.includes(s))) return false;
  if (rule.signalAll && !rule.signalAll.every((s) => signals.includes(s))) return false;
  if (rule.signalNone && rule.signalNone.some((s) => signals.includes(s))) return false;
  return true;
}

/** Why a conditional rule did not fire, in one clause. */
function omitReason(rule, scope, intent) {
  if (rule.scopeIn && !rule.scopeIn.includes(scope)) return `not needed at ${scope} scope`;
  if (rule.intentIn && !rule.intentIn.includes(intent)) return `not applicable to ${intent}`;
  if (rule.signalSome) return `no trigger (${rule.signalSome.join(' | ')})`;
  return 'not required by the profile';
}

/**
 * Build the scope + artifact profile.
 *
 * @param {object} ladder the parsed depth-ladder.json
 * @param {{
 *   intent: string,
 *   signals?: string[],
 *   modules?: number,
 *   tasks?: number,
 *   slug?: string|null,
 * }} input
 */
export function buildPlanProfile(ladder, input = {}) {
  const spec = ladder?.profile;
  if (!spec) throw invalidInput('depth-ladder.json has no profile rules', { asset: 'depth-ladder.json' });

  const intent = String(input.intent ?? '').toUpperCase();
  if (!INTENTS.includes(intent)) {
    throw invalidInput(`unknown intent '${input.intent}' (allowed: ${INTENTS.join('|')})`, {
      intent: input.intent,
      allowed: INTENTS,
    });
  }

  const signals = unique((Array.isArray(input.signals) ? input.signals : []).map((s) => String(s).toLowerCase()));
  const known = new Set(spec.signals ?? SCOPE_SIGNALS);
  const unknown = signals.filter((s) => !known.has(s));
  if (unknown.length) {
    throw invalidInput(`unknown scope signal(s): ${unknown.join(', ')}`, {
      signals: unknown,
      allowed: [...known],
    });
  }

  const base = spec.intentBase?.[intent] ?? 0;
  let score = base;
  const rationale = [`${intent} baseline ${base}`];

  for (const signal of signals) {
    const weight = spec.signalWeights?.[signal] ?? 0;
    if (weight === 0) continue;
    score += weight;
    rationale.push(`${signal} ${weight > 0 ? '+' : ''}${weight}`);
  }

  const modules = Number.isInteger(input.modules) && input.modules > 0 ? input.modules : null;
  if (modules !== null) {
    let moduleAdd = 0;
    for (const step of spec.moduleWeights ?? []) {
      if (modules >= step.min) moduleAdd = step.add;
    }
    if (moduleAdd) {
      score += moduleAdd;
      rationale.push(`${modules} modules +${moduleAdd}`);
    }
  }

  const thresholds = spec.thresholds ?? { medium: 2, large: 5 };
  const bounded = Math.max(0, score);
  const scopeClass =
    bounded >= thresholds.large ? 'LARGE' : bounded >= thresholds.medium ? 'MEDIUM' : 'SMALL';

  // Confidence is about EVIDENCE, not about the answer. A confidently small
  // change is still small; a greenfield with no signals is a guess and must
  // say so.
  let confidence;
  if (signals.length === 0) {
    confidence = intent === 'BROWNFIELD-CHANGE' ? 'medium' : 'low';
  } else if (signals.length === 1) {
    confidence = 'medium';
  } else {
    confidence = 'high';
  }

  const suggestions = intent.startsWith('GREENFIELD')
    ? ['product-facing', 'production']
    : ['multi-module', 'public-contract', 'data-migration'];
  const missingSignals =
    confidence === 'high' ? [] : suggestions.filter((s) => !signals.includes(s)).slice(0, 2);
  const question = confidence === 'low' ? calibrationQuestion(intent) : null;

  // What would move this profile UP? Only signals that exist, carry positive
  // weight, and are strong enough to cross the next threshold.
  const nextThreshold = scopeClass === 'SMALL' ? thresholds.medium : scopeClass === 'MEDIUM' ? thresholds.large : null;
  const gap = nextThreshold === null ? 0 : Math.max(1, nextThreshold - bounded);
  const escalateIf =
    nextThreshold === null
      ? []
      : Object.entries(spec.signalWeights ?? {})
          .filter(([signal, weight]) => weight >= gap && !signals.includes(signal))
          .map(([signal]) => signal)
          .slice(0, 4);

  const slug = input.slug ? String(input.slug) : null;
  const resolvePath = (p) => (slug ? p.replaceAll('<slug>', slug) : p);

  const artifacts = [];
  for (const rule of spec.artifactRules ?? []) {
    const artifact = {
      path: resolvePath(rule.path),
      purpose: rule.purpose ?? null,
    };

    // A host source of truth always wins over a generated copy.
    if (rule.reuseSignal && signals.includes(rule.reuseSignal)) {
      artifacts.push({
        ...artifact,
        decision: 'reuse',
        reason: `${rule.reuseSignal} is present — cite the existing source instead of regenerating it`,
        recordPath: true,
      });
      continue;
    }

    if (ruleMustCreate(rule) || ruleMatches(rule, { scope: scopeClass, intent, signals })) {
      artifacts.push({
        ...artifact,
        decision: 'create',
        reason: ruleMustCreate(rule) ? (rule.purpose ?? 'required for every plan') : 'profile trigger is present',
      });
      continue;
    }

    artifacts.push({
      ...artifact,
      decision: 'omit',
      reason: omitReason(rule, scopeClass, intent),
    });
  }

  // Mermaid snippets exist only to support diagrams. Do not ship an empty
  // snippets file when no module diagram was created.
  const diagram = artifacts.find((a) => a.path.includes('/docs/<module>.md'));
  const snippets = artifacts.find((a) => a.path.endsWith('/docs/mermaid-snippets.md'));
  if (snippets && diagram && diagram.decision !== 'create') {
    snippets.decision = 'omit';
    snippets.reason = 'no diagrams were created';
  }

  const depth = spec.depthBudgets?.[scopeClass] ?? null;

  return {
    scopeClass,
    confidence,
    intentClass: intent,
    score: bounded,
    signals,
    rationale: [
      ...rationale,
      `${bounded} -> ${scopeClass} (MEDIUM >= ${thresholds.medium}, LARGE >= ${thresholds.large})`,
    ],
    missingSignals,
    question,
    escalateIf,
    artifacts,
    depth,
    writes: false,
    next: `archgen_plan{action:'scaffold',scope:'${scopeClass}',slug:'${slug ?? '<slug>'}'}`,
  };
}

/** A rule with no conditions is required for every profile. */
function ruleMustCreate(rule) {
  return (
    !rule.scopeIn &&
    !rule.intentIn &&
    !rule.signalSome &&
    !rule.signalAll &&
    !rule.signalNone
  );
}
