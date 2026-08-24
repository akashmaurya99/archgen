// Harness dispatch tests (todo 9): template interpolation, command splitting,
// scripts-path probing, next-tasks wave parsing, spawn exit-code handling.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_TEMPLATES,
  ScriptsNotFoundError,
  describeExit,
  interpolateTemplate,
  launchHarness,
  loadWaves,
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
});

describe('splitCommand', () => {
  it('splits on whitespace and honors double quotes', () => {
    expect(splitCommand('claude -p "a b  c" --json')).toEqual(['claude', '-p', 'a b  c', '--json']);
  });

  it('honors single quotes and empty results', () => {
    expect(splitCommand("bin 'x y'")).toEqual(['bin', 'x y']);
    expect(splitCommand('   ')).toEqual([]);
  });
});

describe('probeScriptsPath', () => {
  it('prefers the explicit setting', () => {
    const configured = scratch();
    const home = scratch();
    expect(probeScriptsPath(scratch(), home, configured)).toBe(configured);
  });

  it('falls back to <ws>/skills/archgen/scripts then ~/.claude/…', () => {
    const ws = scratch();
    const wsScripts = join(ws, 'skills', 'archgen', 'scripts');
    mkdirSync(wsScripts, { recursive: true });
    const home = scratch();
    expect(probeScriptsPath(ws, home)).toBe(wsScripts);

    const homeScripts = join(home, '.claude', 'skills', 'archgen', 'scripts');
    mkdirSync(homeScripts, { recursive: true });
    expect(probeScriptsPath(scratch(), home)).toBe(homeScripts);
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

  it('loadWaves spawns scriptsPath/next-tasks.mjs and parses stdout', async () => {
    const dir = scratch();
    writeFileSync(
      join(dir, 'next-tasks.mjs'),
      `console.log(JSON.stringify({ waves: [['t1','t2'], ['t3']] }));`,
    );
    await expect(loadWaves(dir)).resolves.toEqual([['t1', 't2'], ['t3']]);
  });

  it('loadWaves rejects with stderr context on non-zero exit', async () => {
    const dir = scratch();
    writeFileSync(join(dir, 'next-tasks.mjs'), `console.error('kaput'); process.exit(3);`);
    await expect(loadWaves(dir)).rejects.toThrow(/kaput|3/);
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
