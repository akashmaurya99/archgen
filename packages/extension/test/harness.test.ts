// Harness dispatch tests (todo 9): template interpolation, command splitting,
// scripts-path probing, next-tasks wave parsing, spawn exit-code handling.
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
  loadWaves,
  outfileForTask,
  parseWaves,
  probeScriptsPath,
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
    'Implement task T1: refactor auth.\n\nSteps:\n1. rotate keys "carefully"\n2. run \\tests\\ locally\n3. report via set-status.mjs',
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

describe('probeScriptsPath', () => {
  it('prefers the explicit setting', () => {
    const configured = scratch();
    const home = scratch();
    expect(probeScriptsPath(scratch(), home, configured)).toBe(configured);
  });

  it('falls back to the legacy bare <ws>/skills layout when no dot-dirs exist', () => {
    const ws = scratch();
    const wsScripts = join(ws, 'skills', 'archgen', 'scripts');
    mkdirSync(wsScripts, { recursive: true });
    const home = scratch();
    expect(probeScriptsPath(ws, home)).toBe(wsScripts);

    const homeScripts = join(home, '.claude', 'skills', 'archgen', 'scripts');
    mkdirSync(homeScripts, { recursive: true });
    expect(probeScriptsPath(scratch(), home)).toBe(homeScripts);
  });

  it('probes canonical <ws>/.agents before <ws>/.claude and the legacy bare layout', () => {
    // tiers in ISOLATED workspaces: an existing higher tier always shadows
    const wsAgents = scratch();
    const agents = join(wsAgents, '.agents', 'skills', 'archgen', 'scripts');
    mkdirSync(agents, { recursive: true });
    expect(probeScriptsPath(wsAgents, scratch())).toBe(agents);

    const wsClaude = scratch();
    const claude = join(wsClaude, '.claude', 'skills', 'archgen', 'scripts');
    mkdirSync(claude, { recursive: true });
    expect(probeScriptsPath(wsClaude, scratch())).toBe(claude);

    const wsBare = scratch();
    const bare = join(wsBare, 'skills', 'archgen', 'scripts');
    mkdirSync(bare, { recursive: true });
    expect(probeScriptsPath(wsBare, scratch())).toBe(bare);
  });

  it('prefers workspace-level skill installs over home-level ones', () => {
    const ws = scratch();
    const home = scratch();
    mkdirSync(join(home, '.claude', 'skills', 'archgen', 'scripts'), { recursive: true });
    const homeAgents = join(home, '.agents', 'skills', 'archgen', 'scripts');
    mkdirSync(homeAgents, { recursive: true });
    const wsBare = join(ws, 'skills', 'archgen', 'scripts');
    mkdirSync(wsBare, { recursive: true });
    expect(probeScriptsPath(ws, home)).toBe(wsBare);

    const wsAgents = join(ws, '.agents', 'skills', 'archgen', 'scripts');
    mkdirSync(wsAgents, { recursive: true });
    expect(probeScriptsPath(ws, home)).toBe(wsAgents);
  });

  it('follows a symlinked <ws>/.claude skill install (skipped on win32)', () => {
    const ws = scratch();
    const real = scratch();
    const link = join(ws, '.claude', 'skills', 'archgen', 'scripts');
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(real, link, 'dir');
    expect(probeScriptsPath(ws, scratch())).toBe(link);
  });

  it('throws ScriptsNotFoundError listing probes when nothing exists', () => {
    const ws = scratch();
    const home = scratch();
    try {
      probeScriptsPath(ws, home);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ScriptsNotFoundError);
      expect((e as ScriptsNotFoundError).probed.length).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('parseWaves / loadWaves', () => {
  it('validates the {waves:[[...]]} shape', () => {
    expect(parseWaves('{"waves":[["a","b"],[]]}')).toEqual([['a', 'b'], []]);
    expect(() => parseWaves('{}')).toThrow(/waves/);
    expect(() => parseWaves('{"waves":["a"]}')).toThrow(/not an array/);
    expect(() => parseWaves('not json')).toThrow();
  });

  it('loadWaves spawns next-tasks.mjs WITH the tasks.yaml argv and parses stdout', async () => {
    const dir = scratch();
    const tasksPath = join(dir, 'tasks.yaml');
    writeFileSync(tasksPath, 'tasks: []\n');
    // Real-contract stub: echoes back the argv it received so the test asserts
    // the tasks path is actually forwarded (the old argv-ignoring stub masked
    // a broken integration where the real script exited 4 on missing usage).
    writeFileSync(
      join(dir, 'next-tasks.mjs'),
      `const [, , file] = process.argv;\n` +
        `if (!file) { console.error('usage: next-tasks.mjs <tasks.yaml>'); process.exit(4); }\n` +
        `console.log(JSON.stringify({ waves: [['t1','t2'], ['t3']], argvFile: file }));`,
    );
    await expect(loadWaves(dir, tasksPath)).resolves.toEqual([['t1', 't2'], ['t3']]);
  });

  it('loadWaves rejects when the tasks.yaml path is missing (contract guard)', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'next-tasks.mjs'), `console.log('{}');`);
    await expect(loadWaves(dir, '')).rejects.toThrow(/tasks\.yaml path is required/);
  });

  it('loadWaves rejects with stderr context on non-zero exit', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'next-tasks.mjs'), `console.error('kaput'); process.exit(3);`);
    await expect(loadWaves(dir, join(dir, 'tasks.yaml'))).rejects.toThrow(/kaput|3/);
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
    const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
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
    const code = await new Promise<number | null>((resolve) => child.on('exit', (c) => resolve(c)));
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
    await new Promise((resolve) => child.on('exit', resolve));
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

  it('keeps benign ids intact', () => {
    expect(outfileForTask('T-123')).toBe(join(tmp, 'archgen-T-123.json'));
    expect(outfileForTask('wave_2_task_9')).toBe(join(tmp, 'archgen-wave_2_task_9.json'));
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
    expect(basename(outfileForTask('a/b'))).toBe('archgen-a_b.json');
    expect(basename(outfileForTask('a\0b'))).toBe('archgen-a_b.json');
    expect(basename(outfileForTask('../../etc/cron'))).toBe('archgen-______etc_cron.json');
  });

  it('falls back to a fixed name for an empty id and keeps underscore-only sanitizations', () => {
    expect(basename(outfileForTask(''))).toBe('archgen-task.json');
    expect(basename(outfileForTask('///'))).toBe('archgen-___.json');
  });
});
