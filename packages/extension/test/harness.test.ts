// Harness dispatch tests (todo 9): template interpolation, command splitting,
// skill-path probing, spawn exit-code handling.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import {
  DEFAULT_TEMPLATES,
  ScriptsNotFoundError,
  describeExit,
  interpolateTemplate,
  launchHarness,
  outfileForTask,
  probeSkillPath,
  splitCommand,
} from '../src/host/harness';

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'archgen-harness-'));
  dirs.push(d);
  return d;
}

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe('interpolateTemplate', () => {
  it('substitutes {{prompt}} and {{task}} placeholders', () => {
    expect(interpolateTemplate('run -p "{{prompt}}" --id {{task}}', { prompt: 'do it', task: 'T1' })).toBe(
      'run -p "do it" --id T1',
    );
  });

  it('tolerates whitespace inside braces', () => {
    expect(interpolateTemplate('{{ prompt }}!', { prompt: 'x' })).toBe('x!');
  });

  it('throws on missing placeholder values', () => {
    expect(() => interpolateTemplate('{{outfile}}', {})).toThrow(/outfile/);
  });

  it('escapes substituted values for double-quoted regions (backslash first)', () => {
    expect(interpolateTemplate('"{{p}}"', { p: 'a\\b"c' })).toBe('"a\\\\b\\"c"');
  });
});

describe('splitCommand', () => {
  it('splits on whitespace and honors double quotes', () => {
    expect(splitCommand('claude -p "a b  c" --json')).toEqual(['claude', '-p', 'a b  c', '--json']);
  });

  it('honors single quotes and empty results', () => {
    expect(splitCommand("bin 'x y'")).toEqual(['bin', 'x y']);
    expect(splitCommand('   ')).toEqual([]);
  });

  it('preserves newlines inside double-quoted segments', () => {
    expect(splitCommand('bin "line1\nline2" --flag')).toEqual(['bin', 'line1\nline2', '--flag']);
  });

  it('keeps backslashes literal outside quotes (legacy behavior)', () => {
    expect(splitCommand('bin C:\\tools\\run.exe')).toEqual(['bin', 'C:\\tools\\run.exe']);
  });

  it('takes single-quoted segments verbatim without escape decoding', () => {
    expect(splitCommand("bin 'a\\\"b'")).toEqual(['bin', 'a\\"b']);
  });

  it('merges adjacent quoted segments into one token (legacy behavior)', () => {
    expect(splitCommand('bin "a""b" c')).toEqual(['bin', 'ab', 'c']);
  });

  it('yields an empty argv element for an empty quoted value', () => {
    expect(splitCommand('bin -p "" --json')).toEqual(['bin', '-p', '', '--json']);
  });
});

describe('interpolateTemplate + splitCommand injection-safety invariant', () => {
  // For ANY v: interpolate into a double-quoted {{p}} region, then split, must
  // yield v VERBATIM as ONE argv element — repository-controlled task titles
  // must never corrupt argv or smuggle text out of the prompt argument.
  const adversarial: string[] = [
    'Fix "quoted" parts',
    'back\\slash \\ path',
    '"leading and trailing"',
    '',
    'pre \\" post',
    'Implement task T1: refactor auth.\n\nSteps:\n1. rotate keys "carefully"\n2. run \\tests\\ locally\n3. report via the archgen_tasks tool',
    'ends with \\',
  ];

  it.each(adversarial)('round-trips %j verbatim through a quoted placeholder', (v) => {
    expect(splitCommand(interpolateTemplate('bin -p "{{p}}" --json', { p: v }))).toEqual([
      'bin',
      '-p',
      v,
      '--json',
    ]);
  });

  it.each(adversarial)('round-trips %j verbatim through the real claude template', (v) => {
    const argv = splitCommand(interpolateTemplate(DEFAULT_TEMPLATES.claude, { prompt: v }));
    expect(argv[0]).toBe('claude');
    expect(argv[1]).toBe('-p');
    expect(argv[2]).toBe(v);
    expect(argv.slice(3)).toEqual(['--output-format', 'json', '--permission-mode', 'acceptEdits']);
  });
});

describe('probeSkillPath', () => {
  it('prefers the explicit setting', () => {
    const configured = scratch();
    const home = scratch();
    expect(probeSkillPath(scratch(), home, configured)).toBe(configured);
  });

  it('falls back to the legacy bare <ws>/skills layout when no dot-dirs exist', () => {
    const ws = scratch();
    const wsSkill = join(ws, 'skills', 'archgen');
    mkdirSync(wsSkill, { recursive: true });
    const home = scratch();
    expect(probeSkillPath(ws, home)).toBe(wsSkill);

    const homeSkill = join(home, '.claude', 'skills', 'archgen');
    mkdirSync(homeSkill, { recursive: true });
    expect(probeSkillPath(scratch(), home)).toBe(homeSkill);
  });

  it('probes canonical <ws>/.agents before <ws>/.claude and the legacy bare layout', () => {
    // tiers in ISOLATED workspaces: an existing higher tier always shadows
    const wsAgents = scratch();
    const agents = join(wsAgents, '.agents', 'skills', 'archgen');
    mkdirSync(agents, { recursive: true });
    expect(probeSkillPath(wsAgents, scratch())).toBe(agents);

    const wsClaude = scratch();
    const claude = join(wsClaude, '.claude', 'skills', 'archgen');
    mkdirSync(claude, { recursive: true });
    expect(probeSkillPath(wsClaude, scratch())).toBe(claude);

    const wsBare = scratch();
    const bare = join(wsBare, 'skills', 'archgen');
    mkdirSync(bare, { recursive: true });
    expect(probeSkillPath(wsBare, scratch())).toBe(bare);
  });

  it('prefers workspace-level skill installs over home-level ones', () => {
    const ws = scratch();
    const home = scratch();
    mkdirSync(join(home, '.claude', 'skills', 'archgen'), { recursive: true });
    const homeAgents = join(home, '.agents', 'skills', 'archgen');
    mkdirSync(homeAgents, { recursive: true });
    const wsBare = join(ws, 'skills', 'archgen');
    mkdirSync(wsBare, { recursive: true });
    expect(probeSkillPath(ws, home)).toBe(wsBare);

    const wsAgents = join(ws, '.agents', 'skills', 'archgen');
    mkdirSync(wsAgents, { recursive: true });
    expect(probeSkillPath(ws, home)).toBe(wsAgents);
  });

  it('follows a symlinked <ws>/.claude skill install (skipped on win32)', () => {
    const ws = scratch();
    const real = scratch();
    const link = join(ws, '.claude', 'skills', 'archgen');
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(real, link, 'dir');
    expect(probeSkillPath(ws, scratch())).toBe(link);
  });

  it('throws ScriptsNotFoundError listing probes when nothing exists', () => {
    const ws = scratch();
    const home = scratch();
    try {
      probeSkillPath(ws, home);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ScriptsNotFoundError);
      expect((e as ScriptsNotFoundError).probed.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('launchHarness + describeExit (fake harness stub)', () => {
  it('streams stdout lines to the log sink and reports exit 0 → info toast', async () => {
    const lines: string[] = [];
    const child = launchHarness({
      command: `${process.execPath} -e "console.log('hello'); process.exit(0)"`,
      cwd: tmpdir(),
      log: (l) => lines.push(l),
    });
    // 'close', not 'exit': the harness logs its exit summary on 'close', so
    // that the tail it prints is the COMPLETE output (see launchHarness).
    const code = await new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)));
    expect(code).toBe(0);
    expect(lines.some((l) => l.includes('hello'))).toBe(true);
    expect(describeExit('T9', code, null)).toMatchObject({ kind: 'info' });
  });

  it('reports non-zero exit codes → error toast path', async () => {
    const child = launchHarness({
      command: `${process.execPath} -e "process.exit(3)"`,
      cwd: tmpdir(),
      log: () => {},
    });
    const code = await new Promise<number | null>((resolve) => child.on('close', (c) => resolve(c)));
    expect(code).toBe(3);
    expect(describeExit('T9', code, null)).toMatchObject({ kind: 'error', message: /code 3/ });
  });

  it('keeps a bounded stdout tail in the exit summary', async () => {
    const lines: string[] = [];
    const child = launchHarness({
      command: `${process.execPath} -e "for(let i=0;i<60;i++) console.log('L'+i); process.exit(0)"`,
      cwd: tmpdir(),
      log: (l) => lines.push(l),
      tailLines: 10,
    });
    // The tail is printed on 'close' — after the output has been flushed —
    // so the test must wait for the same event.
    await new Promise((resolve) => child.on('close', resolve));
    const tailIdx = lines.findIndex((l) => l.includes('[harness] tail'));
    const tail = lines.slice(tailIdx + 1, tailIdx + 11);
    expect(tail).toHaveLength(10);
    expect(tail[0]).toContain('L50');
  });
});

describe('DEFAULT_TEMPLATES coverage', () => {
  it('carries every built-in harness invocation', () => {
    expect(DEFAULT_TEMPLATES.claude).toContain('--permission-mode acceptEdits');
    expect(DEFAULT_TEMPLATES.opencode).toContain('--auto --format json');
    expect(DEFAULT_TEMPLATES.codex).toContain('--sandbox workspace-write');
    expect(DEFAULT_TEMPLATES.gemini).toContain('--output-format json');
    for (const t of Object.values(DEFAULT_TEMPLATES)) {
      if (t !== '') expect(t).toContain('{{prompt}}');
    }
  });
});

describe('outfileForTask (path-traversal hardening, todo 4)', () => {
  const tmp = resolve(tmpdir());

  it('keeps benign ids recognizable and pins them inside tmpdir', () => {
    expect(basename(outfileForTask('T-123'))).toMatch(/^archgen-T-123-[0-9a-f]{8}\.json$/);
    expect(basename(outfileForTask('wave_2_task_9'))).toMatch(/^archgen-wave_2_task_9-[0-9a-f]{8}\.json$/);
    expect(dirname(resolve(outfileForTask('T-123')))).toBe(tmp);
  });

  // tasks.yaml is repository-controlled input (supply-chain surface): hostile
  // ids must never produce an outfile outside os.tmpdir().
  it.each(['../../etc/cron', '../../etc/passwd', 'a/b', 'a\0b', 'a\\b', '..', '.', 'a/../../b'])(
    'pins hostile id %j inside tmpdir with no traversal',
    (id) => {
      const outfile = outfileForTask(id);
      expect(resolve(outfile).startsWith(tmp + sep)).toBe(true);
      expect(dirname(resolve(outfile))).toBe(tmp);
      expect(basename(outfile)).not.toContain('..');
      expect(basename(outfile)).toMatch(/^archgen-[a-zA-Z0-9_-]+\.json$/);
    },
  );

  it('replaces every character outside [a-zA-Z0-9_-] with an underscore', () => {
    expect(basename(outfileForTask('a/b'))).toMatch(/^archgen-a_b-[0-9a-f]{8}\.json$/);
    expect(basename(outfileForTask('a\0b'))).toMatch(/^archgen-a_b-[0-9a-f]{8}\.json$/);
    expect(basename(outfileForTask('../../etc/cron'))).toMatch(/^archgen-______etc_cron-[0-9a-f]{8}\.json$/);
  });

  it('falls back to a fixed prefix for an empty id and keeps underscore-only sanitizations', () => {
    expect(basename(outfileForTask(''))).toMatch(/^archgen-task-[0-9a-f]{8}\.json$/);
    expect(basename(outfileForTask('///'))).toMatch(/^archgen-___-[0-9a-f]{8}\.json$/);
  });

  it('never maps two different task ids onto the same transcript file', () => {
    // 'a/b' and 'a_b' sanitize to the same prefix — the hash of the ORIGINAL
    // id keeps their transcripts apart.
    expect(outfileForTask('a/b')).not.toBe(outfileForTask('a_b'));
    expect(outfileForTask('a/b')).not.toBe(outfileForTask('a.b'));
    expect(outfileForTask('T-1')).toBe(outfileForTask('T-1'));
  });
});
