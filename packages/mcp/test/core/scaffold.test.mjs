// scaffold.test.mjs — the depth ladder as tool output.
//
// The scaffold is the agent's answer to "which files does a SMALL plan need?".
// If it is wrong, the agent writes the wrong artifact set — a right-sizing
// defect the verifier cannot catch. So the contract is pinned here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadAsset, TEMPLATES_DIR, serverVersion } from '../../src/context.mjs';
import { buildScaffold } from '../../src/core/scaffold.mjs';
import { parseYaml } from '../../src/core/yaml.mjs';

const ladder = loadAsset('depth-ladder.json');

test('every scope class produces a scaffold', () => {
  for (const scope of ['SMALL', 'MEDIUM', 'LARGE']) {
    const s = buildScaffold(ladder, scope, { slug: 'demo' });
    assert.equal(s.scopeClass, scope);
    assert.ok(s.artifacts.length > 0, `${scope} must declare its artifact set`);
  }
});

test('the generator token carries the RUNNING server version, so nobody types one', () => {
  // The provenance header records which version produced an artifact. The
  // server knows its own version exactly, so it writes it — the agent pastes
  // the header verbatim and never guesses a version.
  //
  // This used to emit a bare "# generator: archgen", which meant every
  // artifact carried no version at all, and pushed the burden onto the agent
  // (whose only guidance was a placeholder it could copy literally).
  const v = serverVersion();
  const s = buildScaffold(ladder, 'LARGE', { slug: 'demo', generator: `archgen v${v}` });
  const header = s.skeletons['tasks.yaml'].split('\n').slice(0, 3);
  assert.equal(header[0], '# schema_version: 1');
  assert.equal(header[1], `# generator: archgen v${v}`);
  assert.match(header[2], /^# generated_at: /);
});

test('every scoped artifact carries the same generator token', () => {
  const s = buildScaffold(ladder, 'LARGE', { slug: 'demo', generator: 'archgen v1.2.3' });
  for (const [name, body] of Object.entries(s.skeletons)) {
    if (typeof body !== 'string' || !body.startsWith('# schema_version:')) continue;
    assert.ok(
      body.includes('# generator: archgen v1.2.3'),
      `${name} carries a different generator token`,
    );
  }
});

test('the scaffold emits EXACTLY ONE provenance header per artifact', () => {
  // The canonical templates used to carry their own header AND scaffold
  // prepended one, so every served tasks.yaml/architecture.yaml opened with
  // two schema_version blocks. One header, one source of truth.
  const s = buildScaffold(ladder, 'LARGE', { slug: 'demo', generator: 'archgen v1.2.3' });
  for (const name of ['tasks.yaml', 'architecture.yaml']) {
    const body = s.skeletons[name];
    const headers = body.match(/^# schema_version:/gm) ?? [];
    assert.equal(headers.length, 1, `${name} must carry exactly one provenance header`);
  }
});

test('an unknown scope class is a typed INVALID_INPUT', () => {
  assert.throws(
    () => buildScaffold(ladder, 'HUGE', { slug: 'demo' }),
    (e) => e.code === 'INVALID_INPUT',
  );
});

test('the artifact paths resolve the slug', () => {
  const s = buildScaffold(ladder, 'MEDIUM', { slug: 'acme-shop' });
  for (const a of s.artifacts) {
    assert.ok(!a.path.includes('<slug>'), `unresolved slug in ${a.path}`);
    assert.ok(a.path.includes('acme-shop'));
  }
});

test('SMALL forbids the heavyweight artifacts', () => {
  const s = buildScaffold(ladder, 'SMALL', { slug: 'demo' });
  assert.ok(s.forbids.includes('docs/prd.md'));
  assert.ok(s.forbids.includes('architecture.yaml'));
  assert.ok(!s.artifacts.some((a) => a.path.includes('prd.md')));
  assert.equal(s.minEdgeCasesPerTask, 0);
});

test('LARGE requires the PRD and the architecture contract', () => {
  const s = buildScaffold(ladder, 'LARGE', { slug: 'demo' });
  const paths = s.artifacts.map((a) => a.path);
  assert.ok(paths.some((p) => p.endsWith('docs/prd.md')));
  assert.ok(paths.some((p) => p.endsWith('architecture.yaml')));
  assert.ok(paths.some((p) => p.endsWith('answers.yaml')));
  assert.ok(s.minEdgeCasesPerTask >= 3);
  assert.ok(s.skeletons['docs/prd.md'], 'LARGE must ship a PRD skeleton');
  assert.ok(s.skeletons['architecture.yaml'], 'LARGE must ship an architecture skeleton');
  assert.ok(s.skeletons['answers.yaml'], 'LARGE must ship an answers skeleton');
});

test('MEDIUM does NOT ship the PRD or architecture skeletons', () => {
  const s = buildScaffold(ladder, 'MEDIUM', { slug: 'demo' });
  assert.equal(s.skeletons['docs/prd.md'], null);
  assert.equal(s.skeletons['architecture.yaml'], null);
});

test('every canonical YAML template PARSES with the real parser', () => {
  // The templates used to live as prose examples and were never validated —
  // three of them carried YAML the parser REJECTS (a `notes: >= 0` block-scalar
  // trigger, an unquoted `enum(a,b,c)` inside a flow mapping, and a plain
  // scalar containing ": "). Now they are served by the tool, so a copy-paste
  // can never be broken.
  for (const file of ['tasks.yaml', 'architecture.yaml']) {
    const text = readFileSync(join(TEMPLATES_DIR, file), 'utf8');
    assert.doesNotThrow(
      () => parseYaml(text, { filename: file }),
      `the ${file} template must parse — agents copy it verbatim`,
    );
  }
});

test('every scaffold ships a tasks.yaml skeleton in the parser-supported subset', () => {
  for (const scope of ['SMALL', 'MEDIUM', 'LARGE']) {
    const s = buildScaffold(ladder, scope, { slug: 'demo', templatesDir: TEMPLATES_DIR });
    const yaml = s.skeletons['tasks.yaml'];
    assert.ok(yaml, `${scope} must ship a tasks.yaml skeleton`);
    assert.ok(yaml.startsWith('# schema_version: 1'), 'the provenance header must lead');
    assert.ok(yaml.includes('tasks:'), 'the tasks sequence must be present');
    // The strict parser rejects BLOCK SCALARS and duplicate keys. (Single-line
    // flow collections are supported — see fixtures/yaml-corpus/tasks-flow.yaml.)
    assert.ok(!/:\s*[|>]\s*$/.test(yaml), 'block scalars are rejected by the parser');
    // The skeleton must actually parse.
    assert.doesNotThrow(() => parseYaml(yaml, { filename: 'tasks.yaml' }));
  }
});

test('the scaffold serves the CANONICAL templates, not a second copy', () => {
  const s = buildScaffold(ladder, 'LARGE', { slug: 'demo', templatesDir: TEMPLATES_DIR });
  const onDisk = readFileSync(join(TEMPLATES_DIR, 'architecture.yaml'), 'utf8').trim();
  // The served copy is the template + the provenance header + slug substitution.
  const served = s.skeletons['architecture.yaml'];
  assert.ok(served.includes('# schema_version: 1'), 'the provenance header is prepended');
  for (const line of onDisk.split('\n').filter((l) => l.trim() && !l.includes('<slug>') && !l.includes('<feature>') && !l.includes('<project name>'))) {
    assert.ok(served.includes(line), `the served template must contain the canonical line: ${line}`);
  }
  assert.ok(s.skeletons['docs/mermaid-snippets.md'].includes('graph TB'), 'the mermaid snippets must be served');
});

test('the scaffold substitutes the slug into the served templates', () => {
  const s = buildScaffold(ladder, 'LARGE', { slug: 'acme-shop', templatesDir: TEMPLATES_DIR });
  assert.ok(!s.skeletons['architecture.yaml'].includes('<slug>'));
  assert.ok(s.skeletons['architecture.yaml'].includes('acme-shop'));
});

test('the plan skeleton carries every required section', () => {
  for (const scope of ['SMALL', 'MEDIUM', 'LARGE']) {
    const s = buildScaffold(ladder, scope, { slug: 'demo' });
    const plan = s.skeletons['plans/<slug>.md'];
    assert.ok(plan, `${scope} must ship a plan skeleton`);
    for (const section of s.planSections) {
      assert.ok(plan.includes(`## ${section}`), `${scope} plan skeleton is missing the '${section}' section`);
    }
  }
});

test('the edge-case matrix lists every coverage class', () => {
  const s = buildScaffold(ladder, 'MEDIUM', { slug: 'demo' });
  for (const cls of ladder.edgeCaseClasses) {
    assert.ok(s.edgeMatrixTemplate.includes(cls), `the matrix must cover '${cls}'`);
  }
  assert.ok(s.edgeMatrixTemplate.includes('Covered by'), 'the matrix must map rows to acceptance bullets');
});

test('the scaffold is deterministic for a fixed timestamp', () => {
  const opts = { slug: 'demo', generatedAt: '2026-01-01T00:00:00.000Z', generator: 'archgen v1.2.3' };
  const a = buildScaffold(ladder, 'LARGE', opts);
  const b = buildScaffold(ladder, 'LARGE', opts);
  assert.deepEqual(a, b, 'the same inputs must produce the same scaffold');
  assert.ok(a.skeletons['tasks.yaml'].includes('# generator: archgen v1.2.3'));
  assert.ok(a.skeletons['tasks.yaml'].includes('# generated_at: 2026-01-01T00:00:00.000Z'));
});

test('the intent defaults map onto the scope classes', () => {
  assert.ok(ladder.classes.LARGE.intentDefaults.includes('GREENFIELD-SYSTEM'));
  assert.ok(ladder.classes.MEDIUM.intentDefaults.includes('BROWNFIELD-FEATURE'));
  assert.ok(ladder.classes.SMALL.intentDefaults.includes('BROWNFIELD-CHANGE'));
});
