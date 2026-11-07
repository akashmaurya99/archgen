// transport.test.mjs — the REAL stdio transport works.
//
// The contract tests use an in-memory transport, which proves protocol
// compliance but not the process boundary. This test spawns the actual
// binary and drives it over stdio, which is exactly how a harness talks to
// it — so a broken shebang, a stray stdout write, or a startup crash is
// caught here rather than in production.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, '..', '..', 'bin', 'archgen-mcp.mjs');

/**
 * Spawn the server and speak raw JSON-RPC over its stdio.
 * @returns {Promise<{call: (method: string, params?: any) => Promise<any>, stderr: () => string, close: () => void}>}
 */
function spawnServer() {
  const child = spawn(process.execPath, [BIN], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  let buffer = '';
  const pending = new Map();
  let nextId = 1;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // not a JSON-RPC line — recorded in stdout for the assertions
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method} (stderr: ${stderr})`));
      }, 10000);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });

  const notify = (method, params) => {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  };

  return {
    call,
    notify,
    stdout: () => stdout,
    stderr: () => stderr,
    close: () => child.kill(),
  };
}

test('the binary speaks MCP over stdio', async (t) => {
  const server = spawnServer();
  t.after(() => server.close());

  // The 2026-07-28 spec retires the mandatory handshake, but every stdio
  // client still sends it — the server must tolerate it.
  const init = await server.call('initialize', {
    protocolVersion: '2026-07-28',
    capabilities: {},
    clientInfo: { name: 'transport-test', version: '1.0.0' },
  });
  assert.equal(init.jsonrpc, '2.0');
  assert.ok(init.result, `initialize failed: ${JSON.stringify(init)}`);
  assert.equal(init.result.serverInfo.name, 'archgen');
  server.notify('notifications/initialized', {});

  const tools = await server.call('tools/list', {});
  assert.ok(tools.result, `tools/list failed: ${JSON.stringify(tools)}`);
  const names = tools.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    'archgen_codegraph',
    'archgen_docs',
    'archgen_help',
    'archgen_plan',
    'archgen_refs',
    'archgen_registry',
    'archgen_setup',
    'archgen_skills',
    'archgen_tasks',
  ]);

  const call = await server.call('tools/call', { name: 'archgen_help', arguments: { topic: 'tasks' } });
  assert.ok(call.result, `tools/call failed: ${JSON.stringify(call)}`);
  assert.equal(call.result.structuredContent.ok, true);
  assert.match(call.result.structuredContent.data.briefing, /archgen_tasks/);
});

test('nothing but JSON-RPC ever reaches stdout', async (t) => {
  const server = spawnServer();
  t.after(() => server.close());

  await server.call('initialize', {
    protocolVersion: '2026-07-28',
    capabilities: {},
    clientInfo: { name: 'transport-test', version: '1.0.0' },
  });
  await server.call('tools/list', {});

  // Every stdout line must parse as JSON — a stray console.log would break the
  // protocol stream and is the single most common way an MCP server dies.
  for (const line of server.stdout().split('\n').filter((l) => l.trim())) {
    assert.doesNotThrow(() => JSON.parse(line), `non-JSON on stdout: ${line}`);
  }
  assert.match(server.stderr(), /server running on stdio/);
});

test('an unknown method returns a JSON-RPC error, not a crash', async (t) => {
  const server = spawnServer();
  t.after(() => server.close());

  await server.call('initialize', {
    protocolVersion: '2026-07-28',
    capabilities: {},
    clientInfo: { name: 'transport-test', version: '1.0.0' },
  });
  const res = await server.call('tools/definitely-not-a-method', {});
  assert.ok(res.error, `expected an error, got: ${JSON.stringify(res)}`);
  assert.equal(res.error.code, -32601);
});
