// ui-channel.test.mjs — the agent side of the UI command channel.
//
// The contract that matters: UI control is BEST-EFFORT. With no extension
// running, or with a slow one, the tool must report the truth and NEVER
// turn into an error that blocks the agent's real work.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { sendUiCommand, readBridgeHeartbeat, pendingUiCommands, BRIDGE_PROTOCOL, RUNTIME_DIR } from '../../src/core/ui-channel.mjs';

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'archgen-ui-'));
  return root;
}

/** Pretend the extension is running: write the heartbeat. */
function writeHeartbeat(root, capabilities = ['selectFeature', 'revealTask', 'openDoc', 'focus', 'refresh']) {
  const dir = join(root, RUNTIME_DIR);
  mkdirSync(join(dir, 'cmd'), { recursive: true });
  mkdirSync(join(dir, 'ack'), { recursive: true });
  writeFileSync(
    join(dir, 'bridge.json'),
    JSON.stringify({ protocol: BRIDGE_PROTOCOL, pid: 1, version: '0.0.6', workspaceRoot: root, capabilities, updatedAt: new Date().toISOString() }),
    'utf8',
  );
}

/** Pretend the extension: read the command and write an ack. */
function installFakeExtension(root, status = 'ok') {
  const cmdDir = join(root, RUNTIME_DIR, 'cmd');
  const ackDir = join(root, RUNTIME_DIR, 'ack');
  const timer = setInterval(() => {
    let files = [];
    try {
      files = readdirSync(cmdDir);
    } catch {
      return;
    }
    for (const name of files) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -5);
      const ackPath = join(ackDir, `${id}.json`);
      if (existsSync(ackPath)) continue;
      try {
        const cmd = JSON.parse(readFileSync(join(cmdDir, name), 'utf8'));
        writeFileSync(ackPath, JSON.stringify({ id, status, message: `did ${cmd.action}`, at: new Date().toISOString() }), 'utf8');
      } catch {
        /* a half-written command — the next tick retries */
      }
    }
  }, 20);
  return () => clearInterval(timer);
}

test('with no extension running the result is available:false, not an error', async () => {
  const root = sandbox();
  const res = await sendUiCommand(root, 'reveal_task', { taskId: 'T-1' });
  assert.equal(res.available, false);
  assert.equal(res.delivered, false);
  assert.equal(res.acked, false);
  assert.match(res.reason, /extension/i);
});

test('a heartbeat with the wrong protocol is treated as unavailable', () => {
  const root = sandbox();
  mkdirSync(join(root, RUNTIME_DIR), { recursive: true });
  writeFileSync(join(root, RUNTIME_DIR, 'bridge.json'), JSON.stringify({ protocol: 99 }), 'utf8');
  const beat = readBridgeHeartbeat(root);
  assert.equal(beat.available, false);
  assert.match(beat.reason, /protocol/i);
});

test('a supported command is delivered and acknowledged', async () => {
  const root = sandbox();
  writeHeartbeat(root);
  const stop = installFakeExtension(root);
  try {
    const res = await sendUiCommand(root, 'reveal_task', { taskId: 'T-7' }, { timeoutMs: 3000 });
    assert.equal(res.available, true);
    assert.equal(res.delivered, true);
    assert.equal(res.acked, true);
    assert.equal(res.status, 'ok');
    assert.match(res.message, /revealTask/);
  } finally {
    stop();
  }
});

test('the command file lands inside the project runtime directory', async () => {
  const root = sandbox();
  writeHeartbeat(root);
  const stop = installFakeExtension(root);
  try {
    const res = await sendUiCommand(root, 'focus', { view: 'board' }, { timeoutMs: 3000 });
    assert.equal(res.acked, true);
    const cmdDir = join(root, RUNTIME_DIR, 'cmd');
    const files = readdirSync(cmdDir).filter((f) => f.endsWith('.json'));
    assert.equal(files.length, 1);
    const cmd = JSON.parse(readFileSync(join(cmdDir, files[0]), 'utf8'));
    assert.equal(cmd.action, 'focus');
    assert.equal(cmd.workspaceRoot, root);
    assert.equal(cmd.protocol, BRIDGE_PROTOCOL);
  } finally {
    stop();
  }
});

test('a command the extension does not support is not delivered', async () => {
  const root = sandbox();
  writeHeartbeat(root, ['refresh']);
  const res = await sendUiCommand(root, 'reveal_task', { taskId: 'T-1' });
  assert.equal(res.available, true);
  assert.equal(res.delivered, false);
  assert.match(res.reason, /does not support/i);
});

test('a slow extension yields delivered:true, acked:false — never an error', async () => {
  const root = sandbox();
  writeHeartbeat(root);
  // No fake extension: nothing will ever ack.
  const res = await sendUiCommand(root, 'refresh', {}, { timeoutMs: 120 });
  assert.equal(res.available, true);
  assert.equal(res.delivered, true);
  assert.equal(res.acked, false);
  assert.match(res.reason, /acknowledge/i);
});

test('an unknown action is a typed failure', async () => {
  const root = sandbox();
  await assert.rejects(
    () => sendUiCommand(root, 'not_an_action', {}),
    (e) => e.code === 'UNAVAILABLE',
  );
});

test('pendingUiCommands lists unacknowledged commands only', async () => {
  const root = sandbox();
  writeHeartbeat(root);
  const stop = installFakeExtension(root);
  try {
    await sendUiCommand(root, 'refresh', {}, { timeoutMs: 3000 });
    assert.deepEqual(pendingUiCommands(root), []);
  } finally {
    stop();
  }
});
