// ui-channel.mjs — the MCP side of the live UI control bridge.
//
// THE TWO PLANES:
//   DATA plane — the MCP writes tasks.yaml / AGENTS.md; the extension's
//     existing file watcher fires and pushes a fresh model to the webview.
//     That already works and needs no new infrastructure.
//   CONTROL plane — "reveal this task", "show that document", "switch
//     feature". An MCP server cannot postMessage into a VS Code webview, so
//     it needs a channel to the extension host.
//
// THE CHANNEL: a filesystem command queue with acknowledgements.
//   <workspace>/.archgen/.runtime/bridge.json   heartbeat + capabilities
//   <workspace>/.archgen/.runtime/cmd/<id>.json  one command
//   <workspace>/.archgen/.runtime/ack/<id>.json  one result
//
// Why files and not a socket: no ports and no firewall prompts, works on
// Windows, survives an extension restart (the queue outlives the process),
// and is debuggable with `cat`. The repo is already watcher-driven end to
// end — this is the same pattern one layer down.
//
// EVERY UI ACTION IS BEST-EFFORT: with no extension running the tool returns
// `{available:false}` and the agent's work continues. UI control never
// blocks a task.
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic } from './fs-safety.mjs';
import { unavailable } from './errors.mjs';

export const BRIDGE_PROTOCOL = 1;
export const RUNTIME_DIR = join('.archgen', '.runtime');
export const CMD_TTL_MS = 5000;
export const DEFAULT_ACK_TIMEOUT_MS = 1500;
export const MAX_ACK_TIMEOUT_MS = 5000;

/** Actions the bridge understands. The extension advertises the same list. */
const UI_ACTIONS = ['selectFeature', 'revealTask', 'openDoc', 'focus', 'refresh'];

/** The action name the wire format uses for each tool action. */
export const ACTION_MAP = {
  select_feature: 'selectFeature',
  reveal_task: 'revealTask',
  open_doc: 'openDoc',
  focus: 'focus',
  refresh: 'refresh',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Read the extension heartbeat.
 * @param {string} projectRoot
 * @returns {{available: boolean, version?: string, capabilities?: string[], workspaceRoot?: string, reason?: string}}
 */
export function readBridgeHeartbeat(projectRoot) {
  const p = join(projectRoot, RUNTIME_DIR, 'bridge.json');
  if (!existsSync(p)) {
    return { available: false, reason: 'the ArchGen VS Code extension is not running in this workspace' };
  }
  let data;
  try {
    data = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    return { available: false, reason: `bridge heartbeat is unreadable: ${e.message}` };
  }
  if (!data || typeof data !== 'object') {
    return { available: false, reason: 'bridge heartbeat is malformed' };
  }
  if (data.protocol !== BRIDGE_PROTOCOL) {
    return { available: false, reason: `bridge protocol mismatch (server ${BRIDGE_PROTOCOL}, extension ${data.protocol})` };
  }
  return {
    available: true,
    version: data.version ?? null,
    capabilities: Array.isArray(data.capabilities) ? data.capabilities : [],
    workspaceRoot: data.workspaceRoot ?? null,
  };
}

/**
 * Send one command to the extension and wait for its acknowledgement.
 *
 * @param {string} projectRoot
 * @param {string} toolAction one of the tool's action names
 * @param {Record<string, unknown>} args the action payload
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{available: boolean, delivered: boolean, acked: boolean, status?: string, message?: string, id?: string, reason?: string}>}
 */
export async function sendUiCommand(projectRoot, toolAction, args = {}, opts = {}) {
  const wireAction = ACTION_MAP[toolAction];
  if (!wireAction) {
    throw unavailable(`unknown UI action '${toolAction}'`, { action: toolAction });
  }

  const heartbeat = readBridgeHeartbeat(projectRoot);
  if (!heartbeat.available) {
    return { available: false, delivered: false, acked: false, reason: heartbeat.reason };
  }
  if (Array.isArray(heartbeat.capabilities) && heartbeat.capabilities.length && !heartbeat.capabilities.includes(wireAction)) {
    return {
      available: true,
      delivered: false,
      acked: false,
      reason: `the running extension does not support '${wireAction}'`,
      capabilities: heartbeat.capabilities,
    };
  }

  const id = randomUUID();
  const runtime = join(projectRoot, RUNTIME_DIR);
  const cmdPath = join(runtime, 'cmd', `${id}.json`);
  const ackPath = join(runtime, 'ack', `${id}.json`);

  const command = {
    id,
    action: wireAction,
    args,
    protocol: BRIDGE_PROTOCOL,
    workspaceRoot: projectRoot,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + CMD_TTL_MS).toISOString(),
  };

  writeFileAtomic(cmdPath, JSON.stringify(command, null, 2) + '\n', { root: projectRoot });
  pruneQueue(runtime);

  const timeoutMs = Math.min(opts.timeoutMs ?? DEFAULT_ACK_TIMEOUT_MS, MAX_ACK_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(ackPath)) {
      try {
        const ack = JSON.parse(readFileSync(ackPath, 'utf8'));
        return {
          available: true,
          delivered: true,
          acked: true,
          status: ack.status ?? 'ok',
          message: ack.message ?? null,
          id,
        };
      } catch {
        /* partially written — the extension writes atomically, so retry */
      }
    }
    await sleep(25);
  }

  return {
    available: true,
    delivered: true,
    acked: false,
    id,
    reason: 'the extension did not acknowledge within the timeout (it may be busy or the panel closed)',
  };
}

/**
 * Prune the command and acknowledgement queues.
 *
 * The queues are a channel, not an archive. Every command the server writes
 * is eventually acknowledged (or expires), and the extension leaves the file
 * in place — so without a prune the directory grows for the life of the
 * project, and every status call reads the whole directory.
 *
 * Entries are removed by AGE (anything older than the command TTL is dead
 * either way) and the newest N are kept, so the queue is bounded by
 * construction rather than by hope.
 *
 * @param {string} runtime the `.archgen/.runtime` directory
 */
export function pruneQueue(runtime, { maxEntries = 200, maxAgeMs = CMD_TTL_MS * 4 } = {}) {
  const cmdDir = join(runtime, 'cmd');
  const ackDir = join(runtime, 'ack');
  const now = Date.now();
  for (const dir of [cmdDir, ackDir]) {
    if (!existsSync(dir)) continue;
    let names;
    try {
      names = readdirSync(dir).filter((n) => n.endsWith('.json'));
    } catch {
      continue;
    }
    const kept = [];
    for (const name of names) {
      const abs = join(dir, name);
      try {
        const age = now - statSync(abs).mtimeMs;
        if (age > maxAgeMs) {
          unlinkSync(abs);
          continue;
        }
        kept.push({ abs, mtime: statSync(abs).mtimeMs });
      } catch {
        /* vanished between the listing and the stat */
      }
    }
    kept.sort((a, b) => b.mtime - a.mtime);
    for (const { abs } of kept.slice(maxEntries)) {
      try {
        unlinkSync(abs);
      } catch {
        /* another process pruned it first */
      }
    }
  }
}

/**
 * List pending (unacknowledged) commands — diagnostics.
 * @param {string} projectRoot
 */
export function pendingUiCommands(projectRoot) {  const dir = join(projectRoot, RUNTIME_DIR, 'cmd');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (existsSync(join(projectRoot, RUNTIME_DIR, 'ack', `${id}.json`))) continue;
    out.push(id);
  }
  return out;
}
