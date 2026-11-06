// bridge.test.ts — the UI command channel.
//
// A command file is DATA ON DISK inside a repository, which is a
// supply-chain surface. These tests pin the validation rules: a command from
// a stale queue, a foreign workspace, an unknown action, or a malformed file
// must never execute.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BRIDGE_PROTOCOL,
  MAX_PROCESSED_IDS,
  UI_ACTIONS,
  ackDirFor,
  cmdDirFor,
  createBridgeCore,
  isCommandFile,
  isValidCommandId,
  parseBridgeCommand,
  runtimeDirFor,
  writeAtomic,
  type BridgeAck,
  type BridgeCommand,
} from '../src/host/bridge';

const work = mkdtempSync(join(tmpdir(), 'archgen-bridge-'));
const root = join(work, 'repo');
mkdirSync(root, { recursive: true });

/** Build a valid command file body. */
function command(overrides: Partial<BridgeCommand> = {}): BridgeCommand {
  return {
    id: 'cmd-1',
    action: 'revealTask',
    args: { taskId: 'T-1' },
    protocol: BRIDGE_PROTOCOL,
    workspaceRoot: root,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 5000).toISOString(),
    ...overrides,
  };
}

/** Write a command file into the command queue. */
function writeCommand(id: string, body: unknown): string {
  const dir = cmdDirFor(root);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${id}.json`);
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify(body, null, 2), 'utf8');
  return p;
}

describe('parseBridgeCommand', () => {
  it('accepts a well-formed command', () => {
    const check = parseBridgeCommand(JSON.stringify(command()), { workspaceRoot: root });
    expect(check.ok).toBe(true);
  });

  it('rejects malformed JSON', () => {
    const check = parseBridgeCommand('{not json', { workspaceRoot: root });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/JSON/i);
  });

  it('rejects a protocol mismatch', () => {
    const check = parseBridgeCommand(JSON.stringify(command({ protocol: 99 })), { workspaceRoot: root });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/protocol/i);
  });

  it('rejects an action outside the allowlist', () => {
    const check = parseBridgeCommand(
      JSON.stringify(command({ action: 'rm -rf' as never })),
      { workspaceRoot: root },
    );
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/unsupported action/i);
  });

  it('rejects a command aimed at a different workspace', () => {
    const check = parseBridgeCommand(
      JSON.stringify(command({ workspaceRoot: join(work, 'other') })),
      { workspaceRoot: root },
    );
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/different workspace/i);
  });

  it('rejects an expired command', () => {
    const check = parseBridgeCommand(
      JSON.stringify(command({ expiresAt: new Date(Date.now() - 1000).toISOString() })),
      { workspaceRoot: root },
    );
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/expired/i);
  });

  it('rejects a payload that is not an object', () => {
    const check = parseBridgeCommand(JSON.stringify(['not', 'an', 'object']), { workspaceRoot: root });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/not an object/i);
  });

  it('rejects a command with no id', () => {
    const check = parseBridgeCommand(JSON.stringify(command({ id: '' })), { workspaceRoot: root });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/no id/i);
  });

  // The id becomes the ack FILE NAME, so it must be a safe single segment.
  it.each([
    '../../../../package.json',
    '../escape',
    'a/b',
    'a\\b',
    'cmd 1',
    'cmd.json',
    '',
    'x'.repeat(129),
  ])('refuses id %j — it is never a valid ack file name', (id) => {
    expect(isValidCommandId(id)).toBe(false);
    const check = parseBridgeCommand(JSON.stringify(command({ id })), { workspaceRoot: root });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/file name|no id/i);
  });

  it.each(['cmd-1', 'A_B-9', 'x'.repeat(128)])('accepts the safe id %j', (id) => {
    expect(isValidCommandId(id)).toBe(true);
    const check = parseBridgeCommand(JSON.stringify(command({ id })), { workspaceRoot: root });
    expect(check.ok).toBe(true);
  });

  it('rejects a command with no workspaceRoot', () => {
    const cmd = command();
    delete (cmd as Partial<BridgeCommand>).workspaceRoot;
    const check = parseBridgeCommand(JSON.stringify(cmd), { workspaceRoot: root });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/no workspaceRoot/i);
  });

  it('rejects a command with no createdAt', () => {
    const cmd = command();
    delete (cmd as Partial<BridgeCommand>).createdAt;
    const check = parseBridgeCommand(JSON.stringify(cmd), { workspaceRoot: root });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/no createdAt/i);
  });

  it('defaults missing args and expiresAt instead of failing', () => {
    const cmd = command();
    delete (cmd as Partial<BridgeCommand>).args;
    delete (cmd as Partial<BridgeCommand>).expiresAt;
    const check = parseBridgeCommand(JSON.stringify(cmd), { workspaceRoot: root });
    expect(check.ok).toBe(true);
    if (check.ok) {
      expect(check.command.args).toEqual({});
      expect(check.command.expiresAt).toBe('');
    }
  });

  it('replaces non-object args with an empty object', () => {
    const check = parseBridgeCommand(
      JSON.stringify(command({ args: 'not-an-object' as never })),
      { workspaceRoot: root },
    );
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.command.args).toEqual({});
  });

  it('accepts an unparseable expiresAt rather than treating it as expired', () => {
    const check = parseBridgeCommand(
      JSON.stringify(command({ expiresAt: 'whenever' })),
      { workspaceRoot: root },
    );
    expect(check.ok).toBe(true);
  });
});

describe('createBridgeCore', () => {
  let executed: BridgeCommand[] = [];

  beforeEach(() => {
    executed = [];
  });

  afterEach(() => {
    rmSync(join(root, '.archgen'), { recursive: true, force: true });
  });

  it('executes a valid command and writes an ok ack', () => {
    const core = createBridgeCore({
      workspaceRoot: root,
      execute: (c) => {
        executed.push(c);
        return 'done';
      },
    });
    const p = writeCommand('a1', command({ id: 'a1' }));
    const ack = core.handleCommandFile(p);
    expect(ack?.status).toBe('ok');
    expect(ack?.message).toBe('done');
    expect(executed).toHaveLength(1);
    expect(executed[0]!.action).toBe('revealTask');

    const ackFile = join(ackDirFor(root), 'a1.json');
    expect(existsSync(ackFile)).toBe(true);
    expect(JSON.parse(readFileSync(ackFile, 'utf8')).status).toBe('ok');
  });

  it('never executes a refused command', () => {
    const core = createBridgeCore({
      workspaceRoot: root,
      execute: (c) => {
        executed.push(c);
      },
    });
    const p = writeCommand('a2', command({ id: 'a2', action: 'evil' as never }));
    const ack = core.handleCommandFile(p);
    expect(ack).toBeNull();
    expect(executed).toHaveLength(0);
  });

  it('refuses a traversal id: the command never runs and NO file is written outside the ack dir', () => {
    const core = createBridgeCore({
      workspaceRoot: root,
      execute: (c) => {
        executed.push(c);
      },
    });
    // The victim sits at the workspace root — the ack path would reach it
    // with '../../package.json' from <root>/.archgen/.runtime/ack/.
    const victim = join(root, 'package.json');
    writeFileSync(victim, '{"name":"victim"}', 'utf8');
    const p = writeCommand('evil', command({ id: '../../package.json' }));
    const ack = core.handleCommandFile(p);
    expect(ack).toBeNull();
    expect(executed).toHaveLength(0);
    // The victim file is untouched.
    expect(readFileSync(victim, 'utf8')).toBe('{"name":"victim"}');
    // No stray file next to it (atomic write leftovers) and no ack at all.
    expect(existsSync(join(root, 'package.json.tmp-1-1'))).toBe(false);
    const ackDir = ackDirFor(root);
    const written = existsSync(ackDir) ? readdirSync(ackDir) : [];
    expect(written).toEqual([]);
  });

  it('reports an execution failure as an error ack, not a crash', () => {
    const core = createBridgeCore({
      workspaceRoot: root,
      execute: () => {
        throw new Error('boom');
      },
    });
    const p = writeCommand('a3', command({ id: 'a3' }));
    const ack = core.handleCommandFile(p);
    expect(ack?.status).toBe('error');
    expect(ack?.message).toBe('boom');
  });

  it('is idempotent — a replayed command is ignored, not re-executed', () => {
    const core = createBridgeCore({
      workspaceRoot: root,
      execute: (c) => {
        executed.push(c);
      },
    });
    const p = writeCommand('a4', command({ id: 'a4' }));
    core.handleCommandFile(p);
    const second = core.handleCommandFile(p);
    expect(second?.status).toBe('ignored');
    expect(executed).toHaveLength(1);
  });

  it('writes a heartbeat the agent can read', () => {
    const core = createBridgeCore({
      workspaceRoot: root,
      execute: () => undefined,
      heartbeat: { version: '9.9.9', capabilities: UI_ACTIONS },
    });
    core.writeHeartbeat('9.9.9');
    const p = join(runtimeDirFor(root), 'bridge.json');
    expect(existsSync(p)).toBe(true);
    const beat = JSON.parse(readFileSync(p, 'utf8'));
    expect(beat.protocol).toBe(BRIDGE_PROTOCOL);
    expect(beat.version).toBe('9.9.9');
    expect(beat.workspaceRoot).toBe(root);
    expect(beat.capabilities).toContain('revealTask');
  });

  it('advertises the full action list when no capabilities are configured', () => {
    const core = createBridgeCore({ workspaceRoot: root, execute: () => undefined });
    core.writeHeartbeat('0.0.0');
    const beat = JSON.parse(readFileSync(join(runtimeDirFor(root), 'bridge.json'), 'utf8'));
    expect(beat.capabilities).toEqual([...UI_ACTIONS]);
  });

  it('drops a command file it cannot read, and logs why', () => {
    const lines: string[] = [];
    const core = createBridgeCore({
      workspaceRoot: root,
      execute: () => undefined,
      log: (l) => lines.push(l),
    });
    const ack = core.handleCommandFile(join(cmdDirFor(root), 'ghost.json'));
    expect(ack).toBeNull();
    expect(lines.join('\n')).toMatch(/cannot read/);
  });

  it('never throws from the error path — the original failure survives a broken ack write', () => {
    const lines: string[] = [];
    // A FILE where the ack directory belongs makes every ack write fail.
    mkdirSync(runtimeDirFor(root), { recursive: true });
    writeFileSync(ackDirFor(root), 'not-a-directory', 'utf8');
    const core = createBridgeCore({
      workspaceRoot: root,
      execute: () => {
        throw new Error('boom');
      },
      log: (l) => lines.push(l),
    });
    const p = writeCommand('a6', command({ id: 'a6' }));
    const acks: Array<BridgeAck | null> = [];
    expect(() => {
      acks.push(core.handleCommandFile(p));
    }).not.toThrow();
    expect(acks[0]?.status).toBe('error');
    expect(acks[0]?.message).toBe('boom');
    const log = lines.join('\n');
    expect(log).toMatch(/cannot write ack/);
    // The ORIGINAL failure is still reported.
    expect(log).toMatch(/command a6 failed: boom/);
  });

  it('bounds the processed-id window: recent ids stay idempotent, old ones are forgotten', () => {
    const core = createBridgeCore({ workspaceRoot: root, execute: () => undefined });
    const ids = Array.from({ length: MAX_PROCESSED_IDS + 5 }, (_, i) => `cmd-${i}`);
    for (const id of ids) {
      core.handleCommandFile(writeCommand(id, command({ id })));
    }
    expect(core.processed.size).toBe(MAX_PROCESSED_IDS);
    expect(core.processed.has('cmd-0')).toBe(false);
    const newest = ids[ids.length - 1]!;
    expect(core.processed.has(newest)).toBe(true);
    // The newest id is still idempotent.
    const replay = core.handleCommandFile(writeCommand(newest, command({ id: newest })));
    expect(replay?.status).toBe('ignored');
  });
});

describe('writeAtomic', () => {
  it('writes the file and leaves no temporary behind', () => {
    const p = join(work, 'out.json');
    writeAtomic(p, '{"a":1}\n');
    expect(readFileSync(p, 'utf8')).toBe('{"a":1}\n');
  });

  it('overwrites an existing file', () => {
    const p = join(work, 'out.json');
    writeAtomic(p, 'first');
    writeAtomic(p, 'second');
    expect(readFileSync(p, 'utf8')).toBe('second');
  });

  it('survives a leftover temporary file from a crashed run', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const p = join(work, 'out.json');
      // The temporary name is `<path>.tmp-<pid>-<clock>`; freezing the clock
      // makes the second write collide with the first temporary exactly as a
      // crashed run would leave it.
      writeAtomic(p, 'first');
      expect(() => writeAtomic(p, 'second')).not.toThrow();
      expect(readFileSync(p, 'utf8')).toBe('second');
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the original file when the rename fails', () => {
    const dir = join(work, 'target-is-a-dir');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'inner.txt'), 'kept', 'utf8');
    expect(() => writeAtomic(dir, 'nope')).toThrow();
    // The directory (and its contents) survived; only the temporary is gone.
    expect(readFileSync(join(dir, 'inner.txt'), 'utf8')).toBe('kept');
  });
});

describe('isCommandFile', () => {
  it('accepts a .json command file', () => {
    expect(isCommandFile('/a/b/cmd-1.json')).toBe(true);
  });

  it('rejects the REAL atomic-write temporary shape', () => {
    // writeAtomic writes `<path>.tmp-<pid>-<clock>` — the temporary never
    // ends in `.json`, and the predicate knows that shape explicitly.
    expect(isCommandFile('/a/b/cmd-1.json.tmp-1234-1700000000000')).toBe(false);
  });

  it('rejects a legacy .tmp suffix too', () => {
    expect(isCommandFile('/a/b/cmd-1.json.tmp')).toBe(false);
  });

  it('rejects anything that is not a .json file', () => {
    expect(isCommandFile('/a/b/cmd-1.yaml')).toBe(false);
  });
});
