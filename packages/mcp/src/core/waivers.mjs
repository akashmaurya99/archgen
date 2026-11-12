// waivers.mjs — the waiver ledger: the approved deviations.
//
// WHY THIS FILE EXISTS. A waiver is an APPROVAL RECORD — who approved it,
// when, why, and which finding it covers. It is read, matched and counted;
// it is not an audit rule. Keeping it beside the rules made the ledger's
// shape a detail of the audit, and the ledger is what a reviewer reads first
// when it asks whether a finding was already accepted.
import { matchesFamily, readYaml } from './artifact-space.mjs';

/**
 * The waiver ledger: the approved deviations, with who and why.
 *
 * A waived finding is an AUDIT EVENT, not a conversation. The file is the
 * record; the floor reports its size, and the gate brief shows it so the next
 * reviewer knows the deviation exists.
 */
export function readWaivers(path) {
  const data = readYaml(path).data;
  const list = Array.isArray(data?.waivers) ? data.waivers : [];
  return list
    .filter((w) => w && typeof w === 'object')
    .map((w) => ({
      id: String(w.id ?? ''),
      scope: Array.isArray(w.scope) ? w.scope.map(String) : [],
      finding: String(w.finding ?? ''),
      reason: String(w.reason ?? ''),
      approvedBy: String(w.approved_by ?? ''),
      approvedAt: String(w.approved_at ?? ''),
    }));
}

/**
 * Does a waiver cover this finding?
 *
 * A waiver's `scope` names WHAT it covers, in one of two forms:
 *
 *   - a CODE (`MIRROR_MISSING`) — every finding of that class is approved;
 *   - a SUBJECT (`T19#2`, `src/features/catalog/**`) — that one instance is.
 *
 * A subject is matched on token boundaries, so `T1` never swallows `T19`.
 *
 * @param {{scope: string[]}} waiver
 * @param {string} issue the finding text (CODE: message)
 */
/**
 * Does a waiver cover this finding?
 *
 * A waiver's `scope` names WHAT it covers, in one of two forms:
 *
 *   - a CODE (`MIRROR_MISSING`) — every finding of that class is approved;
 *   - a SUBJECT (`T19#2`, `src/features/catalog/**`) — that one instance is.
 *
 * A subject is matched on token boundaries, so `T1` never swallows `T19`.
 *
 * @param {{scope: string[]}} waiver
 * @param {string} issue the finding text (CODE: message)
 */
export function waiverCovers(waiver, issue) {
  const text = String(issue ?? '');
  const code = text.split(':')[0];
  for (const raw of waiver?.scope ?? []) {
    const s = String(raw ?? '').trim();
    if (!s) continue;
    if (s === code) return true;
    // A SUBJECT covers ONE instance — so it is matched against the
    // finding's SUBJECTS (the quoted paths and the task#acceptance refs),
    // never against its prose. Matching the prose meant a scope of "test"
    // suppressed a MIRROR_MISSING, because the message said "mirrored test
    // path" — and a scope of "T19#2" suppressed a finding about "T19#20".
    const subjects = findingSubjects(text);
    if (s.includes('#')) {
      if (subjects.some((subject) => subject === s)) return true;
      continue;
    }
    if (s.includes('/') || s.includes('*')) {
      // A BARE WILDCARD is not a scope — it is a blanket. `scope: ["*"]`
      // matched every subject of every finding.
      if (/^\*+$/.test(s)) continue;
      if (subjects.some((subject) => matchesFamily(s, subject))) return true;
      continue;
    }
    // A BARE TOKEN names a TASK or an ID — not a fragment of a path. It
    // matches a subject that is itself a bare token and equals it: `T1`
    // matches the quoted 'T1'. `src` and `core` match nothing, because a
    // waiver must name the thing it approves, not a piece of a path.
    if (subjects.some((subject) => subject === s)) return true;
  }
  return false;
}

/**
 * The SUBJECTS a finding names — the things a waiver can scope.
 *
 *   - the paths it quotes:  owns 'src/core/**'
 *   - the task#acceptance refs it is ABOUT:  cites T19#1
 *
 * The prose between them is NOT a subject: a waiver scoped to a word that
 * happens to appear in a sentence must not approve the finding.
 *
 * The DETAIL CLAUSE is excluded too. A finding reads "… cites T19#1, but
 * that acceptance does not claim 'E1' — the acceptance that claims it is
 * T1#1." The finding is about T19#1; T1#1 is the detail. A waiver scoped to
 * T1#1 must not silence it.
 *
 * @param {string} text the finding text
 * @returns {string[]}
 */
/**
 * The SUBJECTS a finding names — the things a waiver can scope.
 *
 *   - the paths it quotes:  owns 'src/core/**'
 *   - the task#acceptance refs it is ABOUT:  cites T19#1
 *
 * The prose between them is NOT a subject: a waiver scoped to a word that
 * happens to appear in a sentence must not approve the finding.
 *
 * The DETAIL CLAUSE is excluded too. A finding reads "… cites T19#1, but
 * that acceptance does not claim 'E1' — the acceptance that claims it is
 * T1#1." The finding is about T19#1; T1#1 is the detail. A waiver scoped to
 * T1#1 must not silence it.
 *
 * @param {string} text the finding text
 * @returns {string[]}
 */
export function findingSubjects(text) {
  const raw = String(text);
  // The DETAIL clause — everything from the em dash on — explains, it does
  // not identify.
  const subject = raw.split(/\s+—\s+/)[0];
  const quoted = [...subject.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  const refs = [...subject.matchAll(/(?<![A-Za-z0-9_.-])([A-Za-z][A-Za-z0-9._-]*#\d+)(?![0-9])/g)].map(
    (m) => m[1],
  );
  return [...new Set([...quoted, ...refs])];
}

/** The plan markdown of an artifact space (every plans/*.md, concatenated). */
