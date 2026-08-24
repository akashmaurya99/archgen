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
