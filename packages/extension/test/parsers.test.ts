// Typed model tests: parseTasks / parseArchitecture.
import { describe, expect, it } from 'vitest';
import { ArchgenParseError, parseArchitecture, parseTasks } from '../src/host/readers/archgen';
import { TASK_STATUSES } from '../src/shared/protocol';

const BLOCK = `tasks:
  - id: C
    title: Root
    status: done
    depends_on: []
    file_ownership: ["src/root/**"]
  - id: B
    title: Mid
    depends_on: [C]
    file_ownership:
      - "src/mid/**"
    artifacts: ["docs/mid.md"]
`;

describe('parseTasks', () => {
  it('maps block-shape tasks into typed models with defaults', () => {
    const m = parseTasks(BLOCK);
    expect(m.tasks).toHaveLength(2);
    expect(m.tasks[0]).toMatchObject({ id: 'C', status: 'done', depends_on: [], parallel_group: null });
    expect(m.tasks[1]?.status).toBe('pending'); // default
    expect(m.tasks[1]?.artifacts).toEqual(['docs/mid.md']);
    expect(m.warnings).toEqual([]);
  });

  it('accepts flat flow-map shape', () => {
    const m = parseTasks(`tasks:\n  - {id: R, title: Root, file_ownership: ["a/**"], depends_on: []}\n`);
    expect(m.tasks[0]?.id).toBe('R');
    expect(m.tasks[0]?.file_ownership).toEqual(['a/**']);
  });

  it('warns on invalid status instead of throwing; enum stays canonical', () => {
    const m = parseTasks(`tasks:\n  - id: X\n    title: t\n    status: cancelled\n    file_ownership: ["a/**"]\n`);
    expect(m.tasks[0]?.status).toBe('pending');
    expect(m.warnings.some((w) => w.message.includes('invalid status') && w.message.includes('cancelled'))).toBe(true);
    expect(TASK_STATUSES).not.toContain('cancelled');
  });

  it('warns on duplicate ids and dangling depends_on', () => {
    const m = parseTasks(`tasks:\n  - id: A\n    title: t\n    file_ownership: ["a/**"]\n  - id: A\n    title: t2\n    file_ownership: ["b/**"]\n  - id: Z\n    title: t3\n    depends_on: [GHOST]\n    file_ownership: ["c/**"]\n`);
    expect(m.warnings.some((w) => w.message.includes("duplicate task id 'A'"))).toBe(true);
    expect(m.warnings.some((w) => w.message.includes("unknown task 'GHOST'"))).toBe(true);
  });

  it('skips non-mapping entries with a warning', () => {
    const m = parseTasks(`tasks:\n  - just a scalar\n`);
    expect(m.tasks).toHaveLength(0);
    expect(m.warnings[0]?.message).toContain('not a mapping');
  });

  it('surfaces yaml errors as ArchgenParseError with line numbers', () => {
    try {
      parseTasks('good: 1\n\tbad: 2\n', 'tasks.yaml');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ArchgenParseError);
      expect((e as ArchgenParseError).line).toBe(2);
      expect((e as ArchgenParseError).message).not.toContain('tasks.yaml'); // location split into .line
    }
  });

  it('extracts meta block', () => {
    const m = parseTasks(`${BLOCK}meta:\n  slug: demo\n`);
    expect(m.meta).toEqual({ slug: 'demo' });
  });
});

// Todo 9 (enterprise hardening): readers must be TOLERANT — every malformed-but-
// readable input degrades to warnings/defaults, never a throw. These cases lock
// the warn-don't-throw contract for the inputs an enterprise repo actually hits.
describe('parseTasks robustness (todo 9)', () => {
  it('empty tasks.yaml (zero bytes) yields an empty model — no throw, no warnings', () => {
    const m = parseTasks('');
    expect(m.tasks).toEqual([]);
    expect(m.meta).toEqual({});
    expect(m.warnings).toEqual([]);
  });

  it('whitespace-only and newline-only documents degrade the same way', () => {
    for (const text of ['\n', '   \n\n  \n', '\n\n\n']) {
      const m = parseTasks(text);
      expect(m.tasks).toEqual([]);
      expect(m.warnings).toEqual([]);
    }
  });

  it('missing status key defaults to pending WITHOUT a warning', () => {
    const m = parseTasks('tasks:\n  - id: A\n    title: No status given\n    file_ownership: ["a/**"]\n');
    expect(m.tasks[0]?.status).toBe('pending');
    expect(m.warnings).toEqual([]);
  });

  it('duplicate ids warn but BOTH entries stay in the model (board never loses tasks)', () => {
    const m = parseTasks(
      'tasks:\n  - id: A\n    title: first\n  - id: A\n    title: second\n  - id: B\n    title: third\n',
    );
    expect(m.tasks.map((t) => t.id)).toEqual(['A', 'A', 'B']);
    expect(m.tasks[1]?.title).toBe('second');
    const dupes = m.warnings.filter((w) => w.message.includes("duplicate task id 'A'"));
    expect(dupes).toHaveLength(1);
    // a third occurrence warns again — one warning per duplicate, not per id
    const m3 = parseTasks('tasks:\n  - id: A\n  - id: A\n  - id: A\n');
    expect(m3.warnings.filter((w) => w.message.includes("duplicate task id 'A'"))).toHaveLength(2);
  });

  it('CRLF line endings parse identically to LF through the typed model', () => {
    const lf = 'tasks:\n  - id: C\n    title: Root\n    status: done\n    depends_on: []\n    file_ownership: ["src/**"]\n  - id: B\n    title: Mid\n    depends_on: [C]\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    const a = parseTasks(lf);
    const b = parseTasks(crlf);
    expect(b.tasks).toEqual(a.tasks);
    expect(b.meta).toEqual(a.meta);
    expect(b.warnings).toEqual([]);
    expect(b.tasks[0]).toMatchObject({ id: 'C', status: 'done' });
    expect(b.tasks[1]?.depends_on).toEqual(['C']);
  });

  it('unicode / CJK titles and acceptance criteria survive byte-exact with zero warnings', () => {
    const m = parseTasks(
      [
        'tasks:',
        '  - id: T-1',
        '    title: 实现用户认证模块',
        '    status: running',
        '    acceptance: ["登录接口返回令牌", "エラー時に再試行", "emoji 🚀 and accents éàü stay intact"]',
        '  - id: T-2',
        '    title: "한국어 제목: 따옴표 필요"',
        '    depends_on: [T-1]',
        '',
      ].join('\n'),
    );
    expect(m.warnings).toEqual([]);
    expect(m.tasks[0]?.title).toBe('实现用户认证模块');
    expect(m.tasks[0]?.acceptance).toEqual(['登录接口返回令牌', 'エラー時に再試行', 'emoji 🚀 and accents éàü stay intact']);
    // quoted CJK value containing ': ' is legal; unquoted would be rejected
    expect(m.tasks[1]?.title).toBe('한국어 제목: 따옴표 필요');
    expect(m.tasks[1]?.depends_on).toEqual(['T-1']);
  });

  it('parses a 10,000-task file within the 500ms budget (generated, not committed)', () => {
    const N = 10_000;
    const lines: string[] = ['tasks:'];
    for (let i = 0; i < N; i++) {
      const id = `T-${String(i).padStart(5, '0')}`;
      lines.push(`  - id: ${id}`);
      lines.push(`    title: Enterprise task number ${i} with a realistic description`);
      lines.push(`    status: ${i % 7 === 0 ? 'done' : i % 7 === 1 ? 'running' : 'pending'}`);
      lines.push(`    depends_on: [${i > 0 ? `T-${String(i - 1).padStart(5, '0')}` : ''}]`);
      lines.push(`    file_ownership: ["src/mod${i % 50}/**"]`);
    }
    const text = lines.join('\n') + '\n';

    parseTasks(text); // warm-up: JIT-compile the hot path before timing
    const runs: number[] = [];
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now();
      const m = parseTasks(text);
      runs.push(performance.now() - t0);
      if (r === 0) {
        expect(m.tasks).toHaveLength(N);
        expect(m.warnings).toEqual([]); // chain deps all resolve; no false positives at scale
        expect(m.tasks[N - 1]).toMatchObject({ id: 'T-09999', status: 'pending', depends_on: ['T-09998'] });
      }
    }
    // min-of-3 shields the budget from CI scheduling noise; budget is 500ms
    expect(Math.min(...runs), `runs: ${runs.map((x) => x.toFixed(1)).join(', ')}ms`).toBeLessThan(500);
  });
});

const ARCH = `name: Acme Shop
slug: acme-shop
stack:
  - typescript
  - postgres
structure: "src/ features/"
modules:
  - name: catalog
    responsibility: Browsing.
    owns:
      - src/features/catalog/**
decisions:
  - id: ADR-001
    title: Use Postgres
    context: transactions
    decision: Postgres 16
    consequences:
      - migrations per release
`;

describe('parseArchitecture', () => {
  it('maps modules and decisions', () => {
    const m = parseArchitecture(ARCH);
    expect(m.name).toBe('Acme Shop');
    expect(m.slug).toBe('acme-shop');
    expect(m.stack).toEqual(['typescript', 'postgres']);
    expect(m.modules[0]).toMatchObject({ name: 'catalog', owns: ['src/features/catalog/**'] });
    expect(m.decisions[0]?.consequences).toEqual(['migrations per release']);
    expect(m.warnings).toEqual([]);
  });

  it('tolerates missing structure (block scalars are outside the subset)', () => {
    const m = parseArchitecture(`name: N\nslug: n\nmodules:\n  - name: m\n    owns: []\n`);
    expect(m.structure).toBeNull();
    expect(m.warnings.some((w) => w.message.includes('structure'))).toBe(true);
  });

  it('warns on bad slug format', () => {
    const m = parseArchitecture(`name: N\nslug: Bad_Slug\nmodules: []\n`);
    expect(m.warnings.some((w) => w.message.includes('lowercase-hyphen'))).toBe(true);
  });
});
