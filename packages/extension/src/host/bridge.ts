// bridge.ts — the VS Code side of the archgen MCP UI bridge.
//
// THE CHANNEL (see packages/mcp/src/core/ui-channel.mjs for the other end):
//   <workspace>/.archgen/.runtime/bridge.json   heartbeat + capabilities
//   <workspace>/.archgen/.runtime/cmd/<id>.json  one command from the agent
//   <workspace>/.archgen/.runtime/ack/<id>.json  one result back to the agent
//
// WHY THIS EXISTS: the MCP server owns all deterministic capability, but it
// cannot postMessage into a webview. This module is the control plane that
// lets an agent say "show the user this task" and have the board do it.
//
// SECURITY: a command file is DATA ON DISK, and a repo is a supply-chain
// surface. So every command is validated before it runs:
//   - protocol version must match
//   - action must be on the allowlist (no arbitrary code, ever)
//   - workspaceRoot must equal ours (no cross-workspace commands)
//   - expiresAt must be in the future (a stale queue must not fire on restart)
//   - the id must not have been processed already (idempotency)
//
// The core below is vscode-free so vitest can exercise it directly; the
// vscode wiring lives in extension.ts.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const BRIDGE_PROTOCOL = 1;
export const RUNTIME_DIR = join('.archgen', '.runtime');
export const CMD_DIR = 'cmd';
export const ACK_DIR = 'ack';
export const BRIDGE_FILE = 'bridge.json';

/** The actions the bridge understands. The MCP server advertises the same list. */
export const UI_ACTIONS = ['selectFeature', 'revealTask', 'openDoc', 'focus', 'refresh'] as const;
export type UiAction = (typeof UI_ACTIONS)[number];

/** One command, as it arrives from the agent. */
export interface BridgeCommand {
  id: string;
  action: UiAction;
  args: Record<string, unknown>;
  protocol: number;
  workspaceRoot: string;
  createdAt: string;
  expiresAt: string;
}

/** The result of validating a command. */
export type CommandCheck =
  | { ok: true; command: BridgeCommand }
  | { ok: false; reason: string };

/**
 * Validate a raw command file's contents.
 *
 * Every rejection reason is explicit — the ack tells the agent (and the
 * extension's log) exactly why a command did nothing.
 *
 * @param text the raw file contents
 * @param opts.workspaceRoot our workspace root — a command for another workspace is refused
 * @param opts.now injectable clock (tests)
 */
export function parseBridgeCommand(
  text: string,
  opts: { workspaceRoot: string; now?: number },
): CommandCheck {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { ok: false, reason: `not valid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'command is not an object' };
  }
  const cmd = data as Partial<BridgeCommand>;

  if (typeof cmd.id !== 'string' || cmd.id.length === 0) {
    return { ok: false, reason: 'command has no id' };
  }
  if (cmd.protocol !== BRIDGE_PROTOCOL) {
    return { ok: false, reason: `protocol mismatch (expected ${BRIDGE_PROTOCOL}, got ${String(cmd.protocol)})` };
  }
  if (typeof cmd.action !== 'string' || !UI_ACTIONS.includes(cmd.action as UiAction)) {
    return { ok: false, reason: `unsupported action '${String(cmd.action)}'` };
  }
  if (typeof cmd.workspaceRoot !== 'string') {
    return { ok: false, reason: 'command has no workspaceRoot' };
  }
  if (resolve(cmd.workspaceRoot) !== resolve(opts.workspaceRoot)) {
    return { ok: false, reason: 'command targets a different workspace' };
  }
  const now = opts.now ?? Date.now();
  if (typeof cmd.expiresAt === 'string') {
    const expiry = Date.parse(cmd.expiresAt);
    if (Number.isFinite(expiry) && expiry < now) {
      return { ok: false, reason: 'command expired before it was processed' };
    }
  }
  if (typeof cmd.createdAt !== 'string') {
    return { ok: false, reason: 'command has no createdAt' };
  }

  return {
    ok: true,
    command: {
      id: cmd.id,
      action: cmd.action as UiAction,
      args: cmd.args && typeof cmd.args === 'object' ? (cmd.args as Record<string, unknown>) : {},
      protocol: cmd.protocol as number,
      workspaceRoot: cmd.workspaceRoot,
      createdAt: cmd.createdAt,
      expiresAt: cmd.expiresAt ?? '',
    },
  };
}

/** The acknowledgement written back to the agent. */
export interface BridgeAck {
  id: string;
  status: 'ok' | 'error' | 'ignored';
  message?: string;
  at: string;
}

/** Absolute path of the runtime directory for a workspace root. */
export function runtimeDirFor(workspaceRoot: string): string {
  return join(workspaceRoot, RUNTIME_DIR);
}

/** Absolute path of the command directory. */
export function cmdDirFor(workspaceRoot: string): string {
  return join(runtimeDirFor(workspaceRoot), CMD_DIR);
}

/** Absolute path of the ack directory. */
export function ackDirFor(workspaceRoot: string): string {
  return join(runtimeDirFor(workspaceRoot), ACK_DIR);
}

/**
 * Write a file atomically (tmp + rename), so a reader never sees a partial
 * JSON document. Mirrors the MCP server's own atomic-write helper.
 */
export function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, contents, { flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e;
    writeFileSync(tmp, contents, 'utf8');
  }
  try {
    renameSync(tmp, path);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* original intact; leftover tmp is harmless */
    }
    throw e;
  }
}

/**
 * The bridge core: validate commands, execute them, write acknowledgements.
 *
 * `execute` is injected so the core never depends on the vscode runtime — the
 * extension supplies the real side effects, the tests supply a recorder.
 */
export interface BridgeCore {
  /** Process one command file; returns the ack that was written. */
  handleCommandFile(path: string): BridgeAck | null;
  /** Write the heartbeat the agent polls. */
  writeHeartbeat(version: string): void;
  /** Ids already processed (idempotency). */
  readonly processed: ReadonlySet<string>;
}

export interface BridgeCoreOptions {
  workspaceRoot: string;
  /** Perform the action. Return a message on success, or throw to report an error. */
  execute: (command: BridgeCommand) => string | void;
  /** Write the heartbeat payload. */
  heartbeat?: { version: string; capabilities: readonly string[] };
  log?: (line: string) => void;
  now?: () => number;
}

/**
 * Create the bridge core.
 */
export function createBridgeCore(opts: BridgeCoreOptions): BridgeCore {
  const { workspaceRoot, execute, log = () => {}, now = () => Date.now() } = opts;
  const processed = new Set<string>();

  const writeAck = (ack: BridgeAck): void => {
    const dir = ackDirFor(workspaceRoot);
    mkdirSync(dir, { recursive: true });
    writeAtomic(join(dir, `${ack.id}.json`), JSON.stringify(ack, null, 2) + '\n');
  };

  return {
    processed,

    handleCommandFile(path: string): BridgeAck | null {
      let text: string;
      try {
        text = readFileSync(path, 'utf8');
      } catch (e) {
        log(`[bridge] cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
      const check = parseBridgeCommand(text, { workspaceRoot, now: now() });
      if (!check.ok) {
        // A malformed command has no usable id, so it cannot be acknowledged —
        // it is logged and dropped.
        log(`[bridge] refused a command: ${check.reason}`);
        return null;
      }
      const { command } = check;
      if (processed.has(command.id)) {
        const ack: BridgeAck = { id: command.id, status: 'ignored', message: 'already processed', at: new Date(now()).toISOString() };
        writeAck(ack);
        return ack;
      }
      processed.add(command.id);
      try {
        const message = execute(command);
        const ack: BridgeAck = {
          id: command.id,
          status: 'ok',
          message: message || undefined,
          at: new Date(now()).toISOString(),
        };
        writeAck(ack);
        return ack;
      } catch (e) {
        const ack: BridgeAck = {
          id: command.id,
          status: 'error',
          message: e instanceof Error ? e.message : String(e),
          at: new Date(now()).toISOString(),
        };
        writeAck(ack);
        log(`[bridge] command ${command.id} failed: ${ack.message}`);
        return ack;
      }
    },

    writeHeartbeat(version: string): void {
      const payload = {
        protocol: BRIDGE_PROTOCOL,
        pid: process.pid,
        version,
        workspaceRoot,
        capabilities: opts.heartbeat?.capabilities ?? UI_ACTIONS,
        updatedAt: new Date(now()).toISOString(),
      };
      const dir = runtimeDirFor(workspaceRoot);
      mkdirSync(join(dir, CMD_DIR), { recursive: true });
      mkdirSync(join(dir, ACK_DIR), { recursive: true });
      writeAtomic(join(dir, BRIDGE_FILE), JSON.stringify(payload, null, 2) + '\n');
    },
  };
}

/** True when a path is a command file inside the command directory. */
export function isCommandFile(path: string): boolean {
  return path.endsWith('.json') && !path.endsWith('.tmp');
}

