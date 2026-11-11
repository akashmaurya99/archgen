// matrix.mjs — every defect class from the audit, checked against the server.
//
// Usage: node scripts/matrix.mjs [--project <dir>]
// Exit 0 all clear · 1 a class still fails
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;
const MCP = resolve(HERE, '..', 'bin', 'archgen-mcp.mjs');
const root = mkdtempSync(join(tmpdir(), 'ag-matrix-'));
const dot = join(root, '.archgen', 'demo');
mkdirSync(join(dot, 'plans'), { recursive: true });

/** Run one tool through the real binary. A tool error exits non-zero. */
function call(tool, args) {
  try {
    const out = execFileSync('node', [MCP, 'exec', tool, JSON.stringify(args), '--project', root], {
      encoding: 'utf8',
    });
    return JSON.parse(out);
  } catch (e) {
    // The CLI exits 1 when the tool returns a typed error; the envelope is
    // still on stdout.
    return JSON.parse(e.stdout);
  }
}

/** Write a plan and validate it. */
function validate(body) {
  const file = join(dot, 'tasks.yaml');
  writeFileSync(file, body, 'utf8');
  return call('archgen_plan', { action: 'validate', tasksYaml: file });
}

/** The codes a validate report carries. */
function codes(report) {
  return [...report.data.errors.map((e) => e.code), ...report.data.warnings.map((w) => w.code)];
}

const results = [];
function check(name, fn) {
  try {
    const ok = fn();
    results.push([ok, name]);
  } catch (e) {
    results.push([false, `${name} — ${e.message}`]);
  }
}

const OK = `tasks:
  - id: T1
    title: api
    depends_on: []
    file_ownership: ["src/**"]
    acceptance: ["returns the list"]
`;

check('a plain value may contain ": "', () => {
  const r = validate(OK.replace('title: api', 'title: Refactor: the auth module'));
  return r.ok && r.data.valid === true;
});

check('a quoted sequence item is a scalar', () => {
  const r = validate(OK.replace('acceptance: ["returns the list"]', 'acceptance:\n      - "Test: returns 200"'));
  return r.ok && r.data.valid === true;
});

check('an unquoted "key: value" item is reported, with the fix', () => {
  const r = validate(OK.replace('acceptance: ["returns the list"]', 'acceptance:\n      - Test: returns 200'));
  const f = r.data.errors.find((e) => e.code === 'TASK_FIELD_TYPE');
  return Boolean(f && f.fix && f.fix.includes('Test: returns 200'));
});

check('the report names the field and the line', () => {
  const r = validate(OK.replace('acceptance: ["returns the list"]', 'acceptance:\n      - Test: returns 200'));
  const f = r.data.errors[0];
  return f.message.includes('acceptance[0]') && /\(line \d+\)/.test(f.message);
});

check('validate never throws for a broken plan', () => {
  const r = validate('tasks:\n  - id: T1\n\tbad: 2\n');
  return r.ok === true && r.data.valid === false && codes(r).includes('UNPARSEABLE');
});

check('every defect is reported at once', () => {
  const r = validate(`tasks:
  - id: T1
    title: api
    depends_on: ["T9"]
    file_ownership: "src/a.js"
    acceptance: []
    status: nonsense
`);
  const c = codes(r);
  return c.includes('TASK_FIELD_TYPE') && c.includes('DANGLING_DEP')
    && c.includes('NO_ACCEPTANCE') && c.includes('TASK_STATUS_INVALID');
});

check('a dangling dependency is DANGLING_DEP, not CYCLE', () => {
  const r = validate(OK.replace('depends_on: []', 'depends_on: ["T9"]'));
  const c = codes(r);
  return c.includes('DANGLING_DEP') && !c.includes('CYCLE');
});

check('a duplicate id is DUPLICATE_TASK_ID, not CYCLE', () => {
  const r = validate(`${OK}  - id: T1
    title: api2
    depends_on: []
    file_ownership: ["src/b/**"]
    acceptance: ["ok"]
`);
  const c = codes(r);
  return c.includes('DUPLICATE_TASK_ID') && !c.includes('CYCLE');
});

check('a string file_ownership is a defect', () => {
  const r = validate(OK.replace('file_ownership: ["src/**"]', 'file_ownership: src/a.js'));
  return codes(r).includes('TASK_FIELD_TYPE');
});

check('a string file_ownership is never walked as characters', () => {
  // The defect is reported AND the ownership checks skip it: a one-glob plan
  // used to produce a self-conflict on the glob '*'.
  const file = join(dot, 'tasks.yaml');
  writeFileSync(file, OK.replace('file_ownership: ["src/**"]', 'file_ownership: src/a.js'), 'utf8');
  const floor = call('archgen_plan', { action: 'verify', tasksYaml: file, planDir: join(dot, 'plans') });
  const overlap = floor.data.issues.filter((m) => m.startsWith('OWNERSHIP_OVERLAP'));
  return overlap.length === 0;
});

check('the floor agrees with the validator', () => {
  const file = join(dot, 'tasks.yaml');
  writeFileSync(file, OK.replace('depends_on: []', 'depends_on: ["T9"]'), 'utf8');
  const r = call('archgen_plan', { action: 'verify', tasksYaml: file, planDir: join(dot, 'plans') });
  return r.data.issueCodes.DANGLING_DEP === 1;
});

check('set_status survives a plan whose acceptance contains ": "', () => {
  const file = join(dot, 'tasks.yaml');
  writeFileSync(file, OK.replace('acceptance: ["returns the list"]', 'acceptance: ["Test: returns 200"]'), 'utf8');
  const r = call('archgen_tasks', { action: 'set_status', tasksYaml: file, taskId: 'T1', status: 'running' });
  if (!r.ok) return false;
  const after = call('archgen_plan', { action: 'validate', tasksYaml: file });
  return after.data.valid === true;
});

check('the seven throwing tools report the same error for an unparseable file', () => {
  const file = join(dot, 'tasks.yaml');
  writeFileSync(file, 'tasks:\n  - id: T1\n\tbad: 2\n', 'utf8');
  const errors = [
    call('archgen_plan', { action: 'graph', tasksYaml: file }).error?.message,
    call('archgen_plan', { action: 'impact', tasksYaml: file, target: 'T1' }).error?.message,
    call('archgen_tasks', { action: 'next', tasksYaml: file }).error?.message,
    call('archgen_tasks', { action: 'list', tasksYaml: file }).error?.message,
    call('archgen_tasks', { action: 'contract', tasksYaml: file, taskId: 'T1' }).error?.message,
    call('archgen_tasks', { action: 'set_status', tasksYaml: file, taskId: 'T1', status: 'running' }).error?.message,
  ];
  // The path is compared RESOLVED, so a tool that spells it /var/… and one
  // that spells it /private/var/… still agree.
  const unique = new Set(errors.map((m) => String(m).replace(/\/private\/var/, '/var')));
  return unique.size === 1 && [...unique][0].includes('(line 3)');
});

check('a broken architecture.yaml is named, and NOT announced as missing', () => {
  const file = join(dot, 'tasks.yaml');
  writeFileSync(file, OK, 'utf8');
  writeFileSync(join(dot, 'architecture.yaml'), 'toolchain:\n\tsource_root: src\n', 'utf8');
  const floor = call('archgen_plan', { action: 'verify', tasksYaml: file, planDir: join(dot, 'plans') });
  const warned = floor.data.warningCodes;
  return warned.CONFIG_UNPARSEABLE === 1 && !warned.CONFIG_NOT_ENFORCED;
});

check('a title that is not a string is a defect', () => {
  const r = validate(OK.replace('title: api', 'title: 42'));
  return codes(r).includes('TASK_FIELD_TYPE');
});

check('a null status is a defect', () => {
  const r = validate(OK.replace('depends_on: []', 'depends_on: []\n    status:'));
  return codes(r).includes('TASK_STATUS_INVALID');
});

check('a value with a quote and a hash round-trips', () => {
  const file = join(dot, 'tasks.yaml');
  writeFileSync(file, OK.replace('title: api', 'title: "a\\"b #c"'), 'utf8');
  const r = call('archgen_plan', { action: 'validate', tasksYaml: file });
  return r.data.valid === true;
});

check('a mis-indented key is refused, never silently dropped', () => {
  const file = join(dot, 'tasks.yaml');
  writeFileSync(file, 'tasks:\n  - id: T1\n    title: ok\n   file_ownership: ["src/**"]\n', 'utf8');
  const r = call('archgen_plan', { action: 'validate', tasksYaml: file });
  return r.ok && r.data.valid === false && codes(r).includes('UNPARSEABLE');
});

check('the yaml briefing is fetchable on demand', () => {
  const r = call('archgen_help', { topic: 'yaml' });
  return r.ok && r.data.briefing.includes('plain-value-with-colon');
});

check('a continuation call survives a value with an apostrophe', () => {
  // "floor's" occurs in three sections of the orchestration reference, so
  // the search TRUNCATES and publishes a continuation carrying the token.
  const r = call('archgen_refs', { action: 'search', topic: 'orchestration', token: "floor's", limit: 1 });
  const next = r.data?.next ?? r.meta?.next ?? '';
  return next.includes("floor\\'s");
});

rmSync(root, { recursive: true, force: true });

const failed = results.filter(([ok]) => !ok);
for (const [ok, name] of results) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
console.log(`\n${results.length - failed.length}/${results.length} classes clear.`);
process.exit(failed.length ? 1 : 0);
