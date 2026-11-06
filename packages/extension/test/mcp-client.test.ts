// mcp-client.test.ts — the extension's client for the archgen MCP server.
//
// The extension used to run the skill's scripts/next-tasks.mjs. Those scripts
// are gone: every deterministic capability now lives in the archgen MCP
// server, so the extension CALLS THAT. These tests pin the four things that
// can silently break that call:
//
//   1. BINARY RESOLUTION — the override, the local install, PATH and the npx
//      fallback must be tried in that order, and each must actually work.
//   2. THE TRANSPORT — a good envelope, a failed envelope and garbage stdout
//      must produce three DIFFERENT, diagnosable outcomes.
//   3. THE WAVE SHAPE — loadWaves is the only consumer of the envelope, and a
//      malformed wave must fail loudly rather than render an empty board.
//   4. THE WINDOWS RULES — CI runs Linux, so the Windows-only branches are
//      exercised through an injected platform rather than left unverified.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MCP_PACKAGE,
  callMcpTool,
  loadWaves,
  resolveMcpBinary,
  shouldUseShell,
  whichOnPath,
  type McpBinary,
} from '../src/host/mcp-client';

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'archgen-mcp-client-'));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/**
 * Write an executable script that prints `body` and exits with `code`.
 * It stands in for the archgen-mcp server: same contract (argv in, one JSON
 * envelope out), no dependency on the real package.
 */
function fakeServer(body: string, code = 0): string {
  const p = join(work, 'fake-mcp.sh');
  writeFileSync(p, `#!/bin/sh\nprintf '%s' '${body.replace(/'/g, `'\\''`)}'\nexit ${code}\n`, 'utf8');
  chmodSync(p, 0o755);
  return p;
}

/** A binary descriptor that runs the given script. */
function binFor(script: string): McpBinary {
  return { bin: script, source: 'override', command: script, args: [] };
}

// These tests exercise a real SUBPROCESS transport, so their runtime measures
// process startup, not the code under test. Vitest's default 5s timeout is
// not enough on a contended CI runner (the first spawn in a worker pays the
// whole child_process warm-up), so every spawning test gets an explicit,
// generous timeout. A hang in the transport should still fail — just not at
// an arbitrary 5 seconds.
const SPAWN_TIMEOUT_MS = 30_000;

describe('whichOnPath', () => {
  it('finds an executable on PATH', () => {
    const dir = join(work, 'bin');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'archgen-mcp');
    writeFileSync(p, '#!/bin/sh\n', 'utf8');
    expect(whichOnPath('archgen-mcp', { PATH: dir })).toBe(p);
  });

  it('returns null when nothing matches', () => {
    expect(whichOnPath('archgen-mcp', { PATH: join(work, 'empty') })).toBeNull();
  });

  it('returns null when PATH is unset', () => {
    expect(whichOnPath('archgen-mcp', {})).toBeNull();
  });

  it('honours PATHEXT on Windows', () => {
    const dir = join(work, 'winbin');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'archgen-mcp.CMD');
    writeFileSync(p, '@echo off\n', 'utf8');
    const found = whichOnPath('archgen-mcp', { PATH: dir, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, 'win32');
    expect(found).toBe(p);
  });

  it('falls back to the default PATHEXT on Windows', () => {
    const dir = join(work, 'winbin2');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'archgen-mcp.BAT');
    writeFileSync(p, '@echo off\n', 'utf8');
    expect(whichOnPath('archgen-mcp', { PATH: dir }, 'win32')).toBe(p);
  });

  it('splits PATH with the Windows separator', () => {
    const dir = join(work, 'winbin3');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'archgen-mcp.EXE');
    writeFileSync(p, 'MZ\n', 'utf8');
    const env = { PATH: `${join(work, 'nope')};${dir}`, PATHEXT: '.EXE' };
    expect(whichOnPath('archgen-mcp', env, 'win32')).toBe(p);
  });
});

describe('shouldUseShell', () => {
  it('is true for a Windows .cmd shim', () => {
    expect(shouldUseShell('C:\\npm\\archgen-mcp.cmd', 'win32')).toBe(true);
  });

  it('is true for a Windows .bat shim, case-insensitively', () => {
    expect(shouldUseShell('C:\\npm\\archgen-mcp.BAT', 'win32')).toBe(true);
  });

  it('is false for a Windows .exe', () => {
    expect(shouldUseShell('C:\\npm\\archgen-mcp.exe', 'win32')).toBe(false);
  });

  it('is false everywhere else — a shell is never spawned on POSIX', () => {
    expect(shouldUseShell('/usr/local/bin/archgen-mcp', 'linux')).toBe(false);
    expect(shouldUseShell('/usr/local/bin/archgen-mcp.cmd', 'linux')).toBe(false);
  });
});

describe('resolveMcpBinary', () => {
  it('prefers the ARCHGEN_MCP_BIN override', () => {
    const p = join(work, 'override');
    writeFileSync(p, '#!/bin/sh\n', 'utf8');
    const r = resolveMcpBinary(null, { ARCHGEN_MCP_BIN: p });
    expect(r).toMatchObject({ bin: p, source: 'override', command: p, args: [] });
  });

  it('ignores an override that does not exist', () => {
    const r = resolveMcpBinary(null, { ARCHGEN_MCP_BIN: join(work, 'ghost'), PATH: '' });
    expect(r.source).toBe('npx');
  });

  it('falls back to the workspace-local install', () => {
    const binDir = join(work, 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    const p = join(binDir, 'archgen-mcp');
    writeFileSync(p, '#!/bin/sh\n', 'utf8');
    const r = resolveMcpBinary(work, { PATH: '' });
    expect(r).toMatchObject({ bin: p, source: 'local', command: p, args: [] });
  });

  it('looks for the .cmd shim in a Windows workspace', () => {
    const binDir = join(work, 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    const p = join(binDir, 'archgen-mcp.cmd');
    writeFileSync(p, '@echo off\n', 'utf8');
    const r = resolveMcpBinary(work, { PATH: '' }, 'win32');
    expect(r).toMatchObject({ bin: p, source: 'local' });
  });

  it('falls back to PATH', () => {
    const dir = join(work, 'pathbin');
    mkdirSync(dir, { recursive: true });
    const p = join(dir, 'archgen-mcp');
    writeFileSync(p, '#!/bin/sh\n', 'utf8');
    const r = resolveMcpBinary(null, { PATH: dir });
    expect(r).toMatchObject({ bin: p, source: 'path', command: p, args: [] });
  });

  it('falls back to npx as the last resort', () => {
    const r = resolveMcpBinary(null, { PATH: '' });
    expect(r).toEqual({ bin: null, source: 'npx', command: 'npx', args: ['-y', MCP_PACKAGE] });
  });
});

describe('callMcpTool', () => {
  it('returns the envelope of a successful call', async () => {
    const script = fakeServer(JSON.stringify({ ok: true, data: { waves: [[{ id: 'T-1' }]] } }));
    const env = await callMcpTool('archgen_tasks', { action: 'next' }, {
      projectRoot: work,
      binary: binFor(script),
    });
    expect(env.ok).toBe(true);
    expect(env.data).toEqual({ waves: [[{ id: 'T-1' }]] });
  }, SPAWN_TIMEOUT_MS);

  it('rejects with the server error message', async () => {
    const script = fakeServer(
      JSON.stringify({ ok: false, error: { code: 'E_NOT_FOUND', message: 'no tasks.yaml' } }),
    );
    await expect(
      callMcpTool('archgen_tasks', {}, { projectRoot: work, binary: binFor(script) }),
    ).rejects.toThrow(/no tasks\.yaml/);
  }, SPAWN_TIMEOUT_MS);

  it('rejects with a generic message when the error carries none', async () => {
    const script = fakeServer(JSON.stringify({ ok: false }));
    await expect(
      callMcpTool('archgen_tasks', {}, { projectRoot: work, binary: binFor(script) }),
    ).rejects.toThrow(/unknown error/);
  }, SPAWN_TIMEOUT_MS);

  it('rejects when the server prints something that is not JSON', async () => {
    const script = fakeServer('not json at all', 3);
    await expect(
      callMcpTool('archgen_tasks', {}, { projectRoot: work, binary: binFor(script) }),
    ).rejects.toThrow(/produced no JSON \(exit 3\)/);
  }, SPAWN_TIMEOUT_MS);

  it('rejects when the server prints nothing at all', async () => {
    const script = fakeServer('', 1);
    await expect(
      callMcpTool('archgen_tasks', {}, { projectRoot: work, binary: binFor(script) }),
    ).rejects.toThrow(/produced no JSON \(exit 1\)/);
  }, SPAWN_TIMEOUT_MS);

  it('rejects when the binary does not exist', async () => {
    await expect(
      callMcpTool(
        'archgen_tasks',
        {},
        { projectRoot: work, binary: { bin: join(work, 'ghost'), source: 'override', command: join(work, 'ghost'), args: [] } },
      ),
    ).rejects.toThrow();
  }, SPAWN_TIMEOUT_MS);
});

describe('loadWaves', () => {
  // The real server answers with task objects, not bare ids:
  //   { waves: [[{ id, title, status, file_ownership }]] }
  const good = {
    ok: true,
    data: {
      waves: [
        [
          { id: 'T-1', title: 'first', status: 'todo', file_ownership: [] },
          { id: 'T-2', title: 'second', status: 'todo', file_ownership: [] },
        ],
        [{ id: 'T-3', title: 'third', status: 'todo', file_ownership: [] }],
      ],
    },
  };

  it('returns the wave ids', async () => {
    const script = fakeServer(JSON.stringify(good));
    const waves = await loadWaves(work, join(work, 'tasks.yaml'), binFor(script));
    expect(waves).toEqual([['T-1', 'T-2'], ['T-3']]);
  }, SPAWN_TIMEOUT_MS);

  it('requires a tasks.yaml path', async () => {
    const script = fakeServer(JSON.stringify(good));
    await expect(loadWaves(work, '', binFor(script))).rejects.toThrow(/tasks\.yaml path is required/);
  }, SPAWN_TIMEOUT_MS);

  it('rejects an envelope with no waves array', async () => {
    const script = fakeServer(JSON.stringify({ ok: true, data: {} }));
    await expect(
      loadWaves(work, join(work, 'tasks.yaml'), binFor(script)),
    ).rejects.toThrow(/returned no waves array/);
  }, SPAWN_TIMEOUT_MS);

  it('rejects a wave that is not an array', async () => {
    const script = fakeServer(JSON.stringify({ ok: true, data: { waves: ['nope'] } }));
    await expect(
      loadWaves(work, join(work, 'tasks.yaml'), binFor(script)),
    ).rejects.toThrow(/waves\[0\] is not an array/);
  }, SPAWN_TIMEOUT_MS);

  it('rejects a task without a string id', async () => {
    const script = fakeServer(JSON.stringify({ ok: true, data: { waves: [[{ title: 'no id' }]] } }));
    await expect(
      loadWaves(work, join(work, 'tasks.yaml'), binFor(script)),
    ).rejects.toThrow(/waves\[0\]\[0\] has no string id/);
  }, SPAWN_TIMEOUT_MS);
});
