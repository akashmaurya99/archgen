// codes.mjs — the ONE registry of the codes a plan finding can carry.
//
// WHY THIS FILE EXISTS. The codes lived in two tables: the audit's own
// (plan-audit.mjs) and a regex list that classified the older checks
// (verifier.mjs). The validator carried none at all — it reported prose, so
// the same defect surfaced under a different name depending on which tool the
// agent called, and the skill's "fix them grouped by code" could not be
// obeyed.
//
// One table now. Every code names the rule it enforces. A finding carries
// the code, the specific message, and the fix; this table is what the
// reference document, the floor and the tests read, so a code can never be
// documented in one place and emitted from another.

/**
 * Every code that BLOCKS, with the rule it enforces.
 * @type {Record<string, string>}
 */
export const ISSUE_CODES = {
  PROFILE_CREATE_MISSING: 'the profile says create, but the artifact is not on disk',
  PROFILE_OMIT_PRESENT: 'the profile says do not create it (omit/reuse), but the artifact exists',
  PROFILE_REUSE_MISSING: 'the profile says reuse, but the cited host file does not exist',
  PROFILE_UNRECORDED: 'an artifact exists that the profile does not record a decision for',
  PROFILE_DECISION_INVALID: 'the profile records a decision the floor cannot interpret',
  MIRROR_MISSING: 'a source-owning task has no mirrored test path',
  MATRIX_UNKNOWN_TASK: 'a matrix row cites a task that does not exist',
  MATRIX_INDEX_OUT_OF_RANGE: 'a matrix row cites an acceptance that does not exist',
  MATRIX_CLAIM_MISMATCH: 'a matrix row and the acceptance it cites disagree',
  MATRIX_DANGLING_CLAIM: 'an acceptance claims an edge row that does not exist',
  MATRIX_CITATION_UNRESOLVED: 'a matrix row still carries a template placeholder instead of a real citation',
  MATRIX_CLAIMS_UNDECLARED: 'the plan has edge-case rows but no acceptance declares which row it covers',
  REQ_UNCITED: 'a PRD requirement is not cited by any acceptance',
  REQ_UNKNOWN: 'an acceptance cites a requirement the PRD does not define',
  DECISION_MISSING: 'a declared decision has no file',
  PATH_UNOWNED: 'a declared path has no owning task',
  WAVE_LABEL_DRIFT: 'a wave label disagrees with the dependency graph',
  WAVE_GROUP_SPANS: 'one parallel group spans several dependency waves',
  WAIVER_INVALID: 'a waiver is missing the fields that make it an approval',
  TASK_FIELD_MISSING: 'a task is missing a field the contract requires',
  TASK_FIELD_EMPTY: 'a task field the contract requires carries no value',
  TASK_FIELD_TYPE: 'a task field has a type the contract does not allow',
  TASK_FIELD_DUPLICATE: 'a task field repeats an entry the contract declares unique',
  TASK_ID_INVALID: 'a task id does not match the contract pattern',
  TASK_STATUS_INVALID: 'a task status is not one of the six the contract defines',
  UNPARSEABLE: 'the task file cannot be parsed',
  NO_TASKS: 'the task file carries no tasks',
  CYCLE: 'the tasks form a dependency cycle',
  DANGLING_DEP: 'a task depends on a task that does not exist',
  DUPLICATE_TASK_ID: 'two tasks share one id',
  NO_ACCEPTANCE: 'a task carries no acceptance criteria to verify',
  EMPTY_OWNERSHIP: 'a task owns no files',
  OWNERSHIP_OVERLAP: 'two tasks in one wave claim the same path',
  PLAN_TASK_COVERAGE: 'a task is not mentioned in any plan file',
  UNKNOWN_TASK_ID: 'a plan file cites a task that does not exist',
  NO_PLAN_DIR: 'the plan has no plans directory',
  IO_ERROR: 'a file of the plan could not be read',
  INTERNAL: 'the floor could not complete a check',
  PLAN_ISSUE: 'a finding the floor could not classify',
};

/**
 * Every code that WARNS — reported, never blocking.
 * @type {Record<string, string>}
 */
export const WARNING_CODES = {
  PROFILE_NOT_RECORDED: 'the plan records no profile — artifact necessity cannot be checked',
  CONFIG_NOT_ENFORCED: 'a rule could not run because the plan does not declare what it needs',
  OWNERSHIP_CONTAINED: "one task's paths contain another's",
  WAIVER_COUNT_MISMATCH: 'the recorded waived count disagrees with the ledger',
  GATE_IDENTITY_MISSING: 'the gate block records no verifier',
  TASK_FIELD_UNKNOWN: 'a task carries a key the contract does not define',
  ARTIFACT_NOT_OWNED: 'a task declares an artifact its file ownership does not cover',
  CONFIG_UNPARSEABLE: 'a plan artifact is present but does not parse',
  PROFILE_UNPARSEABLE: 'the recorded plan profile is present but does not parse',
};

/**
 * Classifiers for the checks that predate the code table: a finding whose
 * message has no code of its own is classified by its shape.
 *
 * Every entry names a code in ISSUE_CODES, WARNING_CODES, or the legacy set
 * below, so a classified finding always lands on a documented code.
 * @type {Array<[RegExp, string]>}
 */
export const BASE_CODES = [
  [/^unparseable tasks\.yaml/, 'UNPARSEABLE'],
  [/^missing tasks: sequence/, 'NO_TASKS'],
  [/^dependency cycle:/, 'CYCLE'],
  [/^dangling depends_on reference:/, 'DANGLING_DEP'],
  [/duplicate task id:/, 'DUPLICATE_TASK_ID'],
  [/has no acceptance criteria/, 'NO_ACCEPTANCE'],
  [/has empty or whitespace-only acceptance/, 'NO_ACCEPTANCE'],
  [/has empty file_ownership/, 'EMPTY_OWNERSHIP'],
  [/^same-wave ownership overlap:/, 'OWNERSHIP_OVERLAP'],
  [/is not mentioned in any plan file/, 'PLAN_TASK_COVERAGE'],
  [/^plan references unknown task id/, 'UNKNOWN_TASK_ID'],
  [/^plans dir not found/, 'NO_PLAN_DIR'],
  [/^cannot read/, 'IO_ERROR'],
  [/^internal check failure/, 'INTERNAL'],
];

/**
 * Every code the floor can report, from either table.
 *
 * The reference document lists exactly these, and the drift test holds the
 * two in step — so a code can never be emitted without being documented.
 *
 * @type {Set<string>}
 */
export const KNOWN_CODES = new Set([
  ...Object.keys(ISSUE_CODES),
  ...Object.keys(WARNING_CODES),
]);

/**
 * The stable code for a finding.
 *
 * A finding that carries its own code (`CODE: message`) keeps it; anything
 * else is classified by its message shape. A message that matches nothing
 * gets `PLAN_ISSUE` — never a silent pass.
 *
 * @param {string} message
 * @returns {string}
 */
export function issueCode(message) {
  const text = String(message ?? '');
  const explicit = /^([A-Z][A-Z0-9_]{2,}):\s/.exec(text);
  if (explicit) return explicit[1];
  for (const [pattern, code] of BASE_CODES) if (pattern.test(text)) return code;
  return 'PLAN_ISSUE';
}

/**
 * The code for a graph defect.
 *
 * The graph reports four different defects — a cycle, a dangling reference,
 * a duplicate id and a malformed entry — and they were all reported as
 * `CYCLE`. An agent that groups its fixes by code then cannot tell a cycle
 * from a typo, and the documented `DANGLING_DEP` / `DUPLICATE_TASK_ID` codes
 * were unreachable.
 *
 * @param {string} message
 * @returns {string}
 */
export function graphIssueCode(message) {
  const text = String(message ?? '');
  if (/^dangling depends_on reference:/.test(text)) return 'DANGLING_DEP';
  if (/^duplicate task id:/.test(text)) return 'DUPLICATE_TASK_ID';
  if (/^tasks\[\d+\]: not a mapping/.test(text)) return 'TASK_FIELD_TYPE';
  if (/^tasks\[\d+\]: missing string 'id'/.test(text)) return 'TASK_ID_INVALID';
  return 'CYCLE';
}
