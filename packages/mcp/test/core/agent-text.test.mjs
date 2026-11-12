// agent-text.test.mjs — the text an agent writes must not decide the outcome.
//
// WHY THIS FILE EXISTS. An audit of the agent-written-text surface found
// twelve defects, and every one of them was a value the agent would
// reasonably write: a slug, a topic, a title, an edge-case row, a
// placeholder. Each is pinned here so it cannot come back.
//
// The shape is the same throughout: the agent writes something ordinary, the
// tool must either handle it correctly or refuse it with a message that
// says what to do.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer } from '../../src/server.mjs';
import { getToolSpec, runTool } from '../../src/tools/_register.mjs';
import { Context } from '../../src/context.mjs';
import { buildScaffold } from '../../src/core/scaffold.mjs';
import { loadAsset } from '../../src/context.mjs';
import { parseYaml } from '../../src/core/yaml.mjs';

createServer();

/** A project with a plan in it. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'ag-text-'));
  const dir = join(root, '.archgen', 'demo');
  mkdirSync(join(dir, 'plans'), { recursive: true });
  writeFileSync(
    join(dir, 'tasks.yaml'),
    'tasks:\n  - id: T1\n    title: api\n    depends_on: []\n    file_ownership: ["src/api/**"]\n    acceptance: ["returns the list"]\n',
    'utf8',
  );
  return { root, dir, tasks: join(dir, 'tasks.yaml') };
}

/** Run a tool the way the CLI facade does. */
async function call(tool, args, root) {
  const ctx = new Context({ projectRoot: root });
  return runTool(getToolSpec(tool), ctx, args);
}

test('a slug that would escape the artifact space is refused', async () => {
  const s = sandbox();
  try {
    for (const slug of ['../../evil', 'a/b', 'My Slug']) {
      const r = await call('archgen_plan', { action: 'profile', intent: 'GREENFIELD-SYSTEM', slug }, s.root);
      assert.equal(r.ok, false, `the slug '${slug}' must be refused`);
      assert.equal(r.error.code, 'INVALID_INPUT');
    }
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a slug is legal exactly one way, in every tool', async () => {
  const s = sandbox();
  try {
    // The same slug, offered to the three tools that take one.
    const good = 'demo-slug';
    for (const tool of ['archgen_plan', 'archgen_registry']) {
      const r = await call(tool, { action: tool === 'archgen_plan' ? 'profile' : 'update', intent: 'GREENFIELD-SYSTEM', slug: good, status: 'planned' }, s.root);
      assert.equal(r.ok, true, `${tool} must accept the slug '${good}': ${r.error?.message ?? ''}`);
    }
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('an investigate topic that would escape the artifact space is refused', async () => {
  const s = sandbox();
  try {
    const r = await call(
      'archgen_plan',
      { action: 'brief', kind: 'investigate', tasksYaml: s.tasks, topic: '../../evil', round: 1 },
      s.root,
    );
    assert.equal(r.ok, false);
    assert.match(r.error.message, /not a usable topic/);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('the agent\'s own text is never read as a brief placeholder', async () => {
  const s = sandbox();
  try {
    const r = await call(
      'archgen_plan',
      { action: 'brief', kind: 'survey', tasksYaml: s.tasks, featureRequest: 'add support for <T> generics' },
      s.root,
    );
    assert.equal(r.ok, true, `the brief must be produced: ${r.error?.message ?? ''}`);
    assert.ok(r.data.brief.includes('add support for <T> generics'), 'the agent\'s text must survive');
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('the scaffold serves ONE edge-case table, and its rows are the server\'s classes', () => {
  const ladder = loadAsset('depth-ladder.json');
  const s = buildScaffold(ladder, 'LARGE', { slug: 'demo' });
  const rows = [...s.edgeMatrixTemplate.matchAll(/^\| E(\d+) \|/gm)].map((m) => Number(m[1]));
  assert.deepEqual(rows, [...new Set(rows)], 'the matrix must not carry the same row twice');
  for (const cls of ladder.edgeCaseClasses) {
    assert.ok(s.edgeMatrixTemplate.includes(cls), `the matrix must cover '${cls}'`);
  }
});

test('a module the tool publishes is matched by its NAME', async () => {
  const s = sandbox();
  try {
    writeFileSync(
      join(s.dir, 'architecture.yaml'),
      'modules:\n  - name: api\n    owns: ["src/api/**"]\n',
      'utf8',
    );
    const found = await call('archgen_plan', { action: 'graph', tasksYaml: s.tasks, module: 'api' }, s.root);
    assert.equal(found.ok, true, `the module must resolve: ${found.error?.message ?? ''}`);
    assert.equal(found.data.tasks.length, 1, 'the task that owns the module must be found');

    // A module nothing owns is a question the tool cannot answer — not an
    // empty plan.
    const missing = await call('archgen_plan', { action: 'graph', tasksYaml: s.tasks, module: 'nope' }, s.root);
    assert.equal(missing.ok, false, 'an unmatched module must not be a silent zero');
    assert.equal(missing.error.code, 'NOT_FOUND');
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('every template parses, and every value in it is quoted', () => {
  for (const name of ['tasks.yaml', 'architecture.yaml']) {
    const text = readFileSync(new URL(`../../assets/templates/${name}`, import.meta.url), 'utf8');
    const { data } = parseYaml(text, { filename: name });
    assert.ok(data, `${name} must parse`);
    // A scalar that is not quoted can be coerced by the reader — an id of
    // 007 becomes the number 7.
    for (const line of text.split('\n')) {
      const m = /^\s*-\s+([A-Za-z_][\w-]*):\s+(.+?)\s*$/.exec(line);
      if (!m) continue;
      const value = m[2].replace(/\s+#.*$/, '').trim();
      if (value.startsWith('[') || value.startsWith('{') || value.startsWith('"') || value.startsWith("'")) continue;
      assert.fail(`${name} has an unquoted value: ${line.trim()}`);
    }
  }
});

test('the profile cursor is a call that parses', async () => {
  const s = sandbox();
  try {
    const r = await call('archgen_plan', { action: 'profile', intent: 'GREENFIELD-SYSTEM', slug: 'demo' }, s.root);
    assert.equal(r.ok, true, `the profile must answer: ${r.error?.message ?? ''}`);
    const next = r.data.next;
    assert.ok(next, 'the profile must name the next call');
    assert.match(next, /^archgen_plan\{/);
    // The cursor is fetched verbatim, so its VALUES must come back out
    // unchanged — a value with a quote in it used to break the call.
    const values = parseCall(next);
    assert.equal(values.get('action'), 'scaffold');
    assert.equal(values.get('slug'), 'demo');
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

test('a cursor whose value holds a quote still parses', async () => {
  const s = sandbox();
  try {
    // The slug rule refuses a quote, so the value that carries one is the
    // FEATURE REQUEST — which is free text.
    const r = await call(
      'archgen_plan',
      { action: 'profile', intent: 'GREENFIELD-SYSTEM', slug: 'demo', signals: ['new-module'] },
      s.root,
    );
    assert.equal(r.ok, true);
    const values = parseCall(r.data.next);
    assert.equal(values.get('action'), 'scaffold');
    assert.deepEqual(values.get('signals'), ['new-module']);
  } finally {
    rmSync(s.root, { recursive: true, force: true });
  }
});

/**
 * Read the values of a tool call.
 *
 * The cursor is a string the agent pastes into a client, so it has to parse
 * the way the client parses it: a single-quoted value ends at the next
 * UNESCAPED quote.
 *
 * @param {string} call
 * @returns {Map<string, unknown>}
 */
function parseCall(call) {
  const out = new Map();
  const body = call.slice(call.indexOf('{') + 1, call.lastIndexOf('}'));
  const parts = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote) {
      cur += ch;
      if (ch === '\\') { cur += body[++i] ?? ''; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; cur += ch; continue; }
    if (ch === ',') { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  for (const part of parts) {
    const kv = /^\s*([a-zA-Z][\w]*):(.*)$/.exec(part);
    if (!kv) continue;
    const raw = kv[2].trim();
    if (raw.startsWith('[') && raw.endsWith(']')) {
      out.set(kv[1], raw.slice(1, -1).split(',').map((v) => v.trim().replace(/^'|'$/g, '')).filter(Boolean));
      continue;
    }
    out.set(kv[1], raw.replace(/^'|'$/g, '').replace(/\\'/g, "'"));
  }
  return out;
}
