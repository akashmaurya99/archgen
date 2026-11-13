// contract.test.mjs — the server really speaks MCP.
//
// These tests drive the server with the OFFICIAL client SDK over an in-memory
// transport, so they prove protocol compliance rather than our own opinion of
// it: tools/list returns the eight tools with valid schemas, tools/call
// returns the envelope, and a bad call fails as a TOOL error (not a protocol
// crash).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createServer, exposedToolNames } from '../../src/server.mjs';
import { resetServerContext } from '../../src/tools/_register.mjs';

/** Connect a client to a fresh server over an in-memory transport. */
async function connect() {
  resetServerContext();
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'archgen-contract-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test('tools/list exposes exactly the published tools', async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  // The PUBLISHED set — the lean profile's data plane. The admin tools are
  // registered but not published, so they cannot be called from a model.
  assert.deepEqual(names, [...exposedToolNames()].sort());
  await client.close();
});

test('every tool has a description and an object input schema', async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  for (const tool of tools) {
    assert.ok(tool.description && tool.description.length > 20, `${tool.name} needs a real description`);
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} input schema must be an object`);
    assert.ok(tool.inputSchema.properties, `${tool.name} needs properties`);
  }
  await client.close();
});

test('every tool declares an action enum with at least two options', async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  for (const tool of tools) {
    const action = tool.inputSchema.properties?.action;
    if (!action) continue; // archgen_help uses `topic` instead
    assert.ok(Array.isArray(action.enum), `${tool.name}.action must be an enum`);
    assert.ok(action.enum.length >= 2, `${tool.name}.action needs at least two options`);
  }
  await client.close();
});

test('tools/call returns the archgen envelope', async () => {
  const { client } = await connect();
  const result = await client.callTool({ name: 'archgen_help', arguments: { topic: 'plan' } });
  assert.equal(result.isError, undefined);
  assert.ok(result.structuredContent, 'structuredContent must be present');
  assert.equal(result.structuredContent.ok, true);
  assert.equal(result.structuredContent.data.topic, 'plan');
  assert.match(result.structuredContent.data.briefing, /archgen_plan/);
  await client.close();
});

test('a tool failure is a tool result, not a protocol error', async () => {
  const { client } = await connect();
  const result = await client.callTool({ name: 'archgen_plan', arguments: { action: 'validate' } });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
  assert.equal(result.structuredContent.error.code, 'INVALID_INPUT');
  await client.close();
});

test('an unknown action is rejected by schema validation', async () => {
  const { client } = await connect();
  // The SDK validates the input against the tool's schema and surfaces the
  // failure as a TOOL error (isError), not a protocol-level crash.
  const result = await client.callTool({ name: 'archgen_plan', arguments: { action: 'not-a-real-action' } });
  assert.equal(result.isError, true);
  const text = result.content.map((c) => c.text).join('\n');
  assert.match(text, /validation|invalid/i);
  await client.close();
});

test('the envelope always carries the meta block', async () => {
  const { client } = await connect();
  const result = await client.callTool({ name: 'archgen_help', arguments: { topic: 'all' } });
  const meta = result.structuredContent.meta;
  assert.ok(meta.serverVersion);
  assert.ok(meta.projectRoot);
  assert.ok(Array.isArray(meta.warnings));
  await client.close();
});
