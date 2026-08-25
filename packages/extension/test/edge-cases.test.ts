// Enterprise edge-case suite: yaml subset, archgen readers, harness dispatch,
// status store, debouncer, codegraph reader. Complements parsers.test.ts /
// coverage-enhancements.test.ts — every case here was an UNCOVERED branch or
// an undocumented behavior contract before this suite existed.
import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

import { parseYaml, stringifyYaml, type YamlComment } from '../src/host/readers/yaml.js';
import { parseTasks, parseArchitecture } from '../src/host/readers/archgen.js';
import {
  ScriptsNotFoundError,
  TemplateNotFoundError,
  describeExit,
  interpolateTemplate,
  launchHarness,
  loadWaves,
  probeScriptsPath,
} from '../src/host/harness.js';
import { StatusStore } from '../src/host/store.js';
import { createUriDebouncer } from '../src/host/debounce.js';
import {
  CodegraphReader,
  UnsupportedProductError,
  codegraphDbStat,
  detectCodegraph,
} from '../src/host/codegraph.js';

const SCRATCH: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'archgen-edge-'));
  SCRATCH.push(d);
  return d;
}
afterAll(() => {
  for (const d of SCRATCH) rmSync(d, { recursive: true, force: true });
});

// CJS require (as codegraph.ts does) — ESM named import fails to interop here.
const req = createRequire(import.meta.url);
const Database = req('better-sqlite3') as typeof import('better-sqlite3');

// ---------------------------------------------------------------------------
// yaml.ts
// ---------------------------------------------------------------------------
describe('yaml edge cases', () => {
  it('round-trips 3-level-deep nesting', () => {
    const src = 'l1:\n  l2:\n    l3:\n      leaf: v\n      n: 2\n';
    const { data } = parseYaml(src);
    expect(data).toEqual({ l1: { l2: { l3: { leaf: 'v', n: 2 } } } });
    expect(parseYaml(stringifyYaml(data)).data).toEqual(data);
  });

  it('parses flow maps with quoted keys', () => {
    const { data } = parseYaml('meta: { "display name": X, \'single-key\': 2 }\n');
    const meta = (data as Record<string, Record<string, unknown>>)['meta']!;
    expect(meta['display name']).toBe('X');
    expect(meta['single-key']).toBe(2);
  });

  it('comment-only document: data is null-ish; ACTUAL — comments are dropped, not preserved', () => {
    const { data, comments } = parseYaml('# only a comment\n# and another\n');
    // ACTUAL: an empty document block parses to null (not {}), and because no
    // mapping/sequence ever anchors them, comment-only docs yield an EMPTY
    // ledger. Documented subset behavior — not weakened.
    expect(data).toBeNull();
    expect(comments).toEqual([]);
  });

  it('CRLF line endings parse identically to LF', () => {
    const lf = 'tasks:\n  - id: a\n    title: T\n';
    const crlf = 'tasks:\r\n  - id: a\r\n    title: T\r\n';
    expect(parseYaml(crlf).data).toEqual(parseYaml(lf).data);
    expect(parseYaml(crlf).data).toEqual({ tasks: [{ id: 'a', title: 'T' }] });
  });

  it('tolerates trailing whitespace on values and keys', () => {
    const { data } = parseYaml('a: 1   \nb:\n  c: 2  \n');
    expect(data).toEqual({ a: 1, b: { c: 2 } });
  });

  it('single-line values with quotes/backslashes round-trip; multi-line values are OUT of subset', () => {
    const tricky = 'say "hi" \\ path';
    expect(parseYaml(stringifyYaml({ k: tricky })).data).toEqual({ k: tricky });
    const single = "it's";
    expect(parseYaml(stringifyYaml({ k: single })).data).toEqual({ k: single });
    const preQuoted = '"already quoted"';
    expect(parseYaml(stringifyYaml({ k: preQuoted })).data).toEqual({ k: preQuoted });
    // ACTUAL: the subset has no block scalars, so embedded newlines are emitted
    // raw and the result is (correctly) rejected on re-parse.
    const multiline = 'line1\nline2';
    expect(() => parseYaml(stringifyYaml({ k: multiline }))).toThrow(/expected 'key:' mapping entry/);
  });

  it('sequence at deeper indent under a key (incl. nested list inside a seq-of-map item)', () => {
    const { data } = parseYaml('fruits:\n  - apple\n  - banana\n');
    expect(data).toEqual({ fruits: ['apple', 'banana'] });
    const { data: deep } = parseYaml('items:\n  - name: a\n    extra:\n      - x\n      - y\n');
    expect(deep).toEqual({ items: [{ name: 'a', extra: ['x', 'y'] }] });
  });

  it('rejects structural violations loudly (file:line errors)', () => {
    expect(() => parseYaml('a:\n\tb: 1\n')).toThrow(/tab characters/);
    expect(() => parseYaml('- a\nb: 1\n')).toThrow(/unexpected content outside the document block/);
    expect(() => parseYaml('a: [1, 2\n')).toThrow(/unterminated flow sequence/);
    expect(() => parseYaml('a: {x: 1\n')).toThrow(/unterminated flow mapping/);
    expect(() => parseYaml('a: {x: {y: 1}}\n')).toThrow(/nested flow mappings are not supported/);
    expect(() => parseYaml('a: |\n  block\n')).toThrow(/block scalars are not supported/);
    expect(() => parseYaml('a: &anchor 1\n')).toThrow(/anchors\/tags are not supported/);
    expect(() => parseYaml('a: b: c\n')).toThrow(/plain values cannot contain/);
    expect(() => parseYaml('a: "abc\n')).toThrow(/unterminated quoted string/);
    expect(() => parseYaml('a:\n   b: 1\n  c: 2\n')).toThrow(/inconsistent indentation inside mapping/);
    expect(() => parseYaml('list:\n  - - x\n')).toThrow(/nested sequence items are not supported/);
    expect(() => parseYaml('{a: 1}: v\n')).toThrow(/flow collections cannot be keys/);
    expect(() => parseYaml('"abc: v\n')).toThrow(/unterminated double-quoted key/);
  });

  it('stringifies empty containers compactly', () => {
    expect(stringifyYaml({ a: {}, b: [] })).toBe('a: {}\nb: []\n');
    expect(stringifyYaml([{}])).toBe('- {}\n');
  });

  it('bare "-" sequence items: null when empty, nested block when deeper content follows', () => {
    expect(parseYaml('k:\n  -\n').data).toEqual({ k: [null] });
    expect(parseYaml('k:\n  -\n    x: 1\n').data).toEqual({ k: [{ x: 1 }] });
  });

  it('key without value followed by same-indent mapping yields null (not a child)', () => {
    expect(parseYaml('a:\nb: 2\n').data).toEqual({ a: null, b: 2 });
    expect(parseYaml('lonely:\n').data).toEqual({ lonely: null });
  });

  it('inline comments attach to their exact key path through nesting', () => {
    const src = 'outer:\n  inner: 1 # keep me\n';
    const { data, comments } = parseYaml(src);
    expect(comments).toContainEqual({ path: ['outer', 'inner'], inline: true, text: '# keep me' });
    const out = stringifyYaml(data, comments as YamlComment[]);
    expect(out).toContain('inner: 1 # keep me');
  });
});

// ---------------------------------------------------------------------------
// readers/archgen.ts
// ---------------------------------------------------------------------------
describe('archgen reader edge cases', () => {
  it('missing required fields produce warnings, not crashes', () => {
    const model = parseTasks('tasks:\n  - title: No Id Here\n', 't.yaml');
    expect(model.tasks).toHaveLength(0);
    expect(model.warnings.some((w) => /no string id/.test(w.message))).toBe(true);

    const arch = parseArchitecture('slug: not-there-name\nmodules: []\n', 'a.yaml');
    expect(arch.name).toBe('');
    expect(arch.warnings.some((w) => /missing required key: name/.test(w.message))).toBe(true);
    expect(arch.warnings.some((w) => /structure omitted/.test(w.message))).toBe(true);
  });

  it('empty tasks sequence yields an empty model with zero warnings', () => {
    const model = parseTasks('tasks: []\n');
    expect(model.tasks).toEqual([]);
    expect(model.warnings).toEqual([]);
  });

  it('depends_on as a bare string is TOLERANTLY COERCED to a one-element array', () => {
    // ACTUAL BEHAVIOR (asStringArray): a scalar string becomes [string], not a warning.
    const model = parseTasks('tasks:\n  - id: a\n    depends_on: b\n');
    expect(model.tasks[0]!.depends_on).toEqual(['b']);
    // ...and the coerced reference is still validated against known ids.
    expect(model.warnings.some((w) => /depends on unknown task 'b'/.test(w.message))).toBe(true);
  });

  it('artifacts as a bare string is TOLERANTLY COERCED the same way', () => {
    // ACTUAL BEHAVIOR: same asStringArray coercion — documented, not weakened.
    const model = parseTasks('tasks:\n  - id: a\n    artifacts: out.txt\n');
    expect(model.tasks[0]!.artifacts).toEqual(['out.txt']);
  });

  it('non-mapping modules/decisions entries are skipped with warnings', () => {
    const arch = parseArchitecture(
      'name: N\nslug: n\nstack: []\nmodules:\n  - 42\ndecisions:\n  - "nope"\n',
      'a.yaml',
    );
    expect(arch.modules).toHaveLength(0);
    expect(arch.decisions).toHaveLength(0);
    expect(arch.warnings.some((w) => /modules\[0\] is not a mapping/.test(w.message))).toBe(true);
    expect(arch.warnings.some((w) => /decisions\[0\] is not a mapping/.test(w.message))).toBe(true);
  });

  it('absent modules key warns that modules is required', () => {
    const arch = parseArchitecture('name: N\nslug: n\nstack: []\n', 'a.yaml');
    expect(arch.warnings.some((w) => /missing required key: modules/.test(w.message))).toBe(true);
  });

  it('non-string depends_on/artifacts values coerce to empty arrays (ACTUAL)', () => {
    // ACTUAL (asStringArray): numbers/booleans/objects → [], never a crash.
    const model = parseTasks('tasks:\n  - id: a\n    depends_on: 42\n    artifacts: true\n');
    expect(model.tasks[0]!.depends_on).toEqual([]);
    expect(model.tasks[0]!.artifacts).toEqual([]);
  });

  it('scalar meta and non-string structure degrade to safe defaults with warnings', () => {
    const model = parseTasks('meta: 5\ntasks: []\n');
    expect(model.meta).toEqual({});
    const arch = parseArchitecture('name: N\nslug: n\nstructure: 42\nmodules: []\n', 'a.yaml');
    expect(arch.structure).toBeNull();
    expect(arch.warnings.some((w) => /structure omitted/.test(w.message))).toBe(true);
  });

  it('comment-only / null-ish documents degrade to empty models', () => {
    const model = parseTasks('# nothing here\n', 't.yaml');
    expect(model.tasks).toEqual([]);
    expect(model.meta).toEqual({});
  });

  it('missing title falls back to the task id; non-string name/slug coerce to empty + warn', () => {
    const model = parseTasks('tasks:\n  - id: only-id\n    status: done\n');
    expect(model.tasks[0]!.title).toBe('only-id');

    const arch = parseArchitecture('name: 42\nslug: 7\nmodules:\n  - responsibility: r\ndecisions:\n  - context: c\n', 'a.yaml');
    expect(arch.name).toBe('');
    expect(arch.slug).toBe('');
    expect(arch.modules[0]!.name).toBe('module-0');
    expect(arch.decisions[0]!.id).toBe('ADR-001');
    expect(arch.decisions[0]!.title).toBe('');
  });

  it('decision entries without ids get deterministic ADR fallback ids', () => {
    const arch = parseArchitecture(
      'name: N\nslug: n\nmodules: []\ndecisions:\n  - title: first\n  - id: custom\n    title: second\n',
      'a.yaml',
    );
    expect(arch.decisions[0]!.id).toBe('ADR-001');
    expect(arch.decisions[1]!.id).toBe('custom');
  });
});

// ---------------------------------------------------------------------------
// harness.ts
// ---------------------------------------------------------------------------
describe('harness edge cases', () => {
  it('describeExit maps exit 0 vs non-zero vs signal vs unknown correctly', () => {
    expect(describeExit('T1', 0, null)).toEqual({
      kind: 'info',
      message: "ArchGen: task 'T1' finished successfully.",
    });
    expect(describeExit('T1', 3, null).kind).toBe('error');
    expect(describeExit('T1', 3, null).message).toContain('exited with code 3');
    expect(describeExit('T1', null, 'SIGTERM')).toEqual({
      kind: 'error',
      message: "ArchGen: task 'T1' harness was killed by signal SIGTERM.",
    });
    // ACTUAL: code=null AND signal=null renders the literal 'unknown' (never NaN).
    expect(describeExit('T1', null, null).message).toContain('exited with code unknown');
  });

  it('TemplateNotFoundError carries harness id + kind marker', () => {
    // ACTUAL: no src module currently THROWS this — extension.ts guards via
    // interpolateTemplate; the class is the typed contract for host wiring.
    const e = new TemplateNotFoundError('custom');
    expect(e.harness).toBe('custom');
    expect(e.kind).toBe('template-not-found');
    expect(e.name).toBe('TemplateNotFoundError');
    expect(e.message).toContain('"custom"');
    expect(e.message).toContain('archgen.harness.templates.custom');
  });

  it('ScriptsNotFoundError message contains ALL probed candidate paths', () => {
    const ws = scratch();
    const home = scratch();
    try {
      probeScriptsPath(ws, home, join(ws, 'cfg-scripts'));
      expect.unreachable();
    } catch (e) {
      const err = e as ScriptsNotFoundError;
      expect(err.probed).toHaveLength(4); // configured + ws + ~/.claude + ~/.agents
      for (const p of err.probed) expect(err.message).toContain(p);
      expect(err.kind).toBe('scripts-not-found');
      expect(err.message).toContain('Set "archgen.scriptsPath"');
    }
  });

  it('loadWaves rejects via the child error path when scriptsPath does not exist', async () => {
    await expect(loadWaves(join(tmpdir(), 'definitely-missing-dir'), 'tasks.yaml')).rejects.toThrow();
  });

  it('loadWaves surfaces parse failures from exit-0 stdout and silent non-zero exits', async () => {
    const dirA = scratch();
    writeFileSync(join(dirA, 'next-tasks.mjs'), `console.log('not json');`);
    await expect(loadWaves(dirA, join(dirA, 't.yaml'))).rejects.toThrow();

    const dirB = scratch();
    writeFileSync(join(dirB, 'next-tasks.mjs'), `process.exit(7);`);
    await expect(loadWaves(dirB, join(dirB, 't.yaml'))).rejects.toThrow(/exited 7/);
  });

  it('launchHarness rejects an empty command and logs signal terminations', async () => {
    expect(() => launchHarness({ command: '   ', cwd: tmpdir(), log: () => {} })).toThrow(/Empty harness command/);

    const lines: string[] = [];
    const child = launchHarness({
      command: `${process.execPath} -e "setInterval(() => {}, 1000)"`,
      cwd: tmpdir(),
      log: (l) => lines.push(l),
    });
    const signal = await new Promise<string | null>((resolve) => {
      child.on('exit', (_c, s) => resolve(s));
      setTimeout(() => child.kill('SIGKILL'), 50);
    });
    expect(signal).toBe('SIGKILL');
    expect(lines.some((l) => l.includes('signal=SIGKILL'))).toBe(true);
  });

  it('interpolateTemplate: ACTUAL behavior — known-but-missing placeholders THROW; malformed ones stay untouched', () => {
    // ACTUAL: valid {{identifier}} with no value raises (config error), it is
    // NOT left in place. Only placeholders outside the identifier grammar are
    // passed through verbatim.
    expect(() => interpolateTemplate('{{unknownvar}}', {})).toThrow(/Missing template value for placeholder \{\{unknownvar\}\}/);
    expect(interpolateTemplate('{{not-a-var}}', {})).toBe('{{not-a-var}}');
    expect(interpolateTemplate('{{9lives}}', {})).toBe('{{9lives}}');
    expect(interpolateTemplate('plain text', {})).toBe('plain text');
  });
});

// ---------------------------------------------------------------------------
// store.ts
// ---------------------------------------------------------------------------
interface Item { id: string; status: string }

describe('store edge cases', () => {
  function manualScheduler() {
    const cbs: Array<() => void> = [];
    return {
      schedule: (cb: () => void) => { cbs.push(cb); return cb; },
      fireAll: () => { for (const cb of cbs.splice(0)) cb(); },
      get count() { return cbs.length; },
    };
  }

  it('getById on absent id returns undefined without throwing', () => {
    const store = new StatusStore<Item>([{ id: 'a', status: 'pending' }]);
    expect(store.getById('ghost')).toBeUndefined();
    expect(store.ids()).toEqual(['a']);
    expect(store.size).toBe(1);
  });

  it('subscribeIndex fires EXACTLY once per flush even after N mutations', () => {
    const sched = manualScheduler();
    const items: Item[] = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, status: 'pending' }));
    const store = new StatusStore<Item>(items, { scheduler: sched.schedule });
    let calls = 0;
    store.subscribeIndex(
      (m) => {
        let running = 0;
        for (const it of m.values()) if (it.status === 'running') running++;
        return running;
      },
      () => calls++,
    );
    expect(calls).toBe(1); // prime
    for (let i = 0; i < 50; i++) store.updateById(`t${i % 10}`, { status: 'running' });
    sched.fireAll();
    expect(calls).toBe(2); // one notify for the whole burst
    sched.fireAll();
    expect(calls).toBe(2); // unchanged slice → silent
  });

  it('unsubscribe stops INDEX notifications', () => {
    const sched = manualScheduler();
    const store = new StatusStore<Item>([{ id: 'a', status: 'pending' }], { scheduler: sched.schedule });
    const seen: number[] = [];
    const unsub = store.subscribeIndex((m) => m.size, (n) => seen.push(n));
    unsub();
    store.updateById('a', { status: 'done' });
    sched.fireAll();
    expect(seen).toEqual([1]); // prime only
  });

  it('subscribeItem on an ABSENT id never primes and never notifies', () => {
    const sched = manualScheduler();
    const store = new StatusStore<Item>([{ id: 'a', status: 'pending' }], { scheduler: sched.schedule });
    let calls = 0;
    store.subscribeItem('ghost', (it) => it.status, () => calls++);
    expect(calls).toBe(0);
    expect(store.updateById('ghost', { status: 'done' })).toBe(false);
    sched.fireAll();
    expect(calls).toBe(0);
  });

  it('manual flush() consumes the scheduled callback without double-notifying', () => {
    const sched = manualScheduler();
    const store = new StatusStore<Item>([{ id: 'a', status: 'pending' }], { scheduler: sched.schedule });
    let calls = 0;
    store.subscribeItem('a', (it) => it.status, () => calls++);
    expect(calls).toBe(1);
    store.updateById('a', { status: 'done' });
    expect(sched.count).toBe(1);
    store.flush(); // UI never calls this; tests may force it
    expect(calls).toBe(2);
    expect(store.isFlushPending).toBe(false);
    // The captured scheduler callback is now a no-op re-flush (already drained).
    sched.fireAll();
    expect(calls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// debounce.ts
// ---------------------------------------------------------------------------
describe('debouncer edge cases', () => {
  it('rapid push → dispose → pending flush NEVER fires the callback', () => {
    const flushes: Array<Set<string>> = [];
    vi.useFakeTimers();
    try {
      const d = createUriDebouncer(100, (uris) => flushes.push(uris));
      d.push({ toString: () => 'file:///a' });
      d.push({ toString: () => 'file:///b' });
      expect(d.pending).toBe(true);
      d.dispose();
      expect(d.pending).toBe(false);
      vi.advanceTimersByTime(1000);
      expect(flushes).toHaveLength(0); // disposed batch dropped, not flushed
      // Post-dispose pushes start a fresh window cleanly.
      d.push({ toString: () => 'file:///c' });
      vi.advanceTimersByTime(100);
      expect(flushes).toHaveLength(1);
      expect([...flushes[0]!]).toEqual(['file:///c']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('alternating uri sets coalesce into ONE flush with the UNIQUE union set', () => {
    const flushes: Array<Set<string>> = [];
    vi.useFakeTimers();
    try {
      const d = createUriDebouncer(50, (uris) => flushes.push(uris));
      const u = (s: string) => ({ toString: () => s });
      d.push(u('file:///a'));
      d.push(u('file:///b'));
      vi.advanceTimersByTime(25); // mid-window restart
      d.push(u('file:///a')); // duplicate re-push
      d.push(u('file:///c'));
      vi.advanceTimersByTime(50);
      expect(flushes).toHaveLength(1);
      expect([...flushes[0]!].sort()).toEqual(['file:///a', 'file:///b', 'file:///c']);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// codegraph.ts (fixture DBs + synthetic temp DBs)
// ---------------------------------------------------------------------------
describe('codegraph edge cases', () => {
  const FIXTURES = join(__dirname, 'fixtures');

  it('detectCodegraph with fake-home reports unsupported global-index variant', () => {
    const d = detectCodegraph(join(FIXTURES, 'empty-ws'), join(FIXTURES, 'fake-home'));
    expect(d.product).toBe('unsupported');
    expect(d.dbPath).toBeNull();
    expect(d.reason).toContain(join(FIXTURES, 'fake-home', '.codegraph', 'graph.db'));
    expect(d.reason).toContain('workspace-local');
  });

  it('reader.close() then reuse: listNodes throws typed error, hasFts degrades safely', () => {
    // ACTUAL: queries after close() throw UnsupportedProductError('reader closed');
    // boolean probes (hasFts/tableExists) degrade to safe negatives instead.
    const reader = CodegraphReader.open(join(FIXTURES, 'ws-colby', '.codegraph', 'codegraph.db'), 'colby');
    reader.close();
    expect(() => reader.listNodes()).toThrowError(new UnsupportedProductError('reader closed'));
    expect(() => reader.listEdges()).toThrowError(/reader closed/);
    expect(reader.hasFts()).toBe(false);
    reader.close(); // idempotent
  });

  it('codegraphDbStat reports size/mtime for real files and clean zeros for missing ones', () => {
    const live = codegraphDbStat(join(FIXTURES, 'ws-colby', '.codegraph', 'codegraph.db'));
    expect(live.exists).toBe(true);
    expect(live.size).toBeGreaterThan(0);
    expect(live.mtimeMs).toBeGreaterThan(0);
    const ghost = codegraphDbStat(join(FIXTURES, 'ws-colby', '.codegraph', 'nope.db'));
    expect(ghost).toEqual({ exists: false, size: 0, mtimeMs: 0 });
  });

  it('searchNodes falls back to LIKE scan (with escaping) when nodes_fts is absent', () => {
    const dir = scratch();
    const dbPath = join(dir, 'graph.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT, kind TEXT, file_path TEXT, start_line INTEGER)');
    db.exec("INSERT INTO nodes VALUES ('n1','alpha_fn','function','a.ts',1),('n2','beta_fn','function','b.ts',2)");
    db.exec('CREATE TABLE edges (source TEXT, target TEXT, kind TEXT)');
    db.exec("INSERT INTO edges VALUES ('n1','n2','calls')");
    db.close();

    const reader = CodegraphReader.open(dbPath, 'optave');
    try {
      expect(reader.hasFts()).toBe(false);
      const hits = reader.searchNodes('alpha');
      expect(hits.map((h) => h.id)).toEqual(['n1']);
      // LIKE wildcards in user input are escaped via ESCAPE '!'.
      expect(reader.searchNodes('%')).toEqual([]);
      expect(reader.searchNodes('_fn')).toHaveLength(2);
      expect(reader.searchNodes('   ')).toEqual([]); // blank query short-circuits
    } finally {
      reader.close();
    }
  });

  it('schema validation: missing nodes table / missing edge column raise typed errors', () => {
    const dir = scratch();
    const noNodes = join(dir, 'no-nodes.db');
    const dbA = new Database(noNodes);
    dbA.exec('CREATE TABLE edges (source TEXT, target TEXT, kind TEXT)');
    dbA.close();

    const badEdges = join(dir, 'bad-edges.db');
    const dbB = new Database(badEdges);
    dbB.exec('CREATE TABLE nodes (id TEXT, name TEXT, kind TEXT, file_path TEXT, start_line INTEGER)');
    dbB.exec('CREATE TABLE edges (source TEXT, target TEXT)'); // 'kind' column missing
    dbB.close();

    const rA = CodegraphReader.open(noNodes, 'optave');
    try {
      expect(() => rA.listNodes()).toThrowError(/no readable 'nodes' table/);
    } finally {
      rA.close();
    }
    const rB = CodegraphReader.open(badEdges, 'optave');
    try {
      expect(() => rB.listEdges()).toThrowError(/edges table is missing required column 'kind'/);
    } finally {
      rB.close();
    }
  });

  it('NULL node/edge columns fall back to safe defaults in view models', () => {
    const dir = scratch();
    const dbPath = join(dir, 'nulls.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE nodes (id TEXT PRIMARY KEY, name TEXT, kind TEXT, file_path TEXT, start_line INTEGER)');
    db.exec("INSERT INTO nodes VALUES ('n1', NULL, NULL, NULL, NULL)");
    db.exec('CREATE TABLE edges (source TEXT, target TEXT, kind TEXT)');
    db.exec("INSERT INTO edges VALUES ('n1', 'n1', NULL)");
    db.close();
    const reader = CodegraphReader.open(dbPath, 'optave');
    try {
      expect(reader.listNodes().nodes[0]).toEqual({ id: 'n1', label: 'n1', kind: 'unknown', file: '', line: 0 });
      expect(reader.listEdges().edges[0]).toEqual({ source: 'n1', target: 'n1', kind: 'references' });
      // ACTUAL: LIKE scans match on the label column — NULL labels never match.
      expect(reader.searchNodes('n1')).toEqual([]);
    } finally {
      reader.close();
    }
  });

  it('opening a DIRECTORY as db surfaces UnsupportedProductError from openReadOnly catch', () => {
    expect(() => CodegraphReader.open(join(FIXTURES, 'ws-colby'), 'colby')).toThrowError(/Cannot open codegraph database/);
  });

  it('nodes table lacking every known label/file column falls back and fails loudly', () => {
    // pickColumn exhausts candidates → SQL references the fallback column name
    // which does not exist → driver raises (no silent wrong data).
    const dir = scratch();
    const dbPath = join(dir, 'odd-schema.db');
    const db = new Database(dbPath);
    db.exec('CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT, start_line INTEGER)');
    db.exec("INSERT INTO nodes VALUES ('n1','function',1)");
    db.close();
    const reader = CodegraphReader.open(dbPath, 'optave');
    try {
      expect(() => reader.listNodes()).toThrowError();
      expect(() => reader.searchNodes('x')).toThrowError();
    } finally {
      reader.close();
    }
  });

  it('opening a non-SQLite file: ACTUAL — open succeeds lazily, first schema probe raises the typed error', () => {
    // better-sqlite3 defers header validation to the first statement; the
    // reader's PRAGMA probe then fails → 'no readable nodes table' typed path.
    const dir = scratch();
    const junk = join(dir, 'junk.db');
    writeFileSync(junk, 'this is not sqlite');
    const reader = CodegraphReader.open(junk, 'colby');
    try {
      expect(() => reader.listNodes()).toThrowError(UnsupportedProductError);
    } finally {
      reader.close();
    }
  });
});
