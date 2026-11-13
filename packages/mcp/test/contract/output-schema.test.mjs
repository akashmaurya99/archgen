// output-schema.test.mjs — the catalog's OUTPUT contract.
//
// WHY THIS TEST EXISTS.
//
// The result envelope's schema was repeated on every tool — the same ~256
// tokens, N times, in every request's context. It is now published ONCE, as
// the MCP resource `archgen://schema/envelope`, and each tool carries the
// COMPACT `{ok}` shape.
//
// Nothing tested that contract. Reverting `_register.mjs` to the full
// envelope schema per tool would restore the whole permanent tax and every
// gate would stay green — so the saving was one refactor away from being
// spent again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';

import { createServer, exposedToolNames } from '../../src/server.mjs';
import { getToolSpec, resetServerContext } from '../../src/tools/_register.mjs';

/** Connect a client to a fresh server over an in-memory transport. */
async function connect() {
  resetServerContext();
  const server = createServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'archgen-output-schema-test', version: '1.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test('every published tool carries the COMPACT output schema', async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  for (const tool of tools) {
    assert.deepEqual(
      tool.outputSchema?.required,
      ['ok'],
      `${tool.name}: the per-tool output schema must be the compact {ok}`,
    );
    assert.deepEqual(
      tool.outputSchema?.properties,
      { ok: { type: 'boolean' } },
      `${tool.name}: the per-tool output schema must declare only \`ok\``,
    );
    // `additionalProperties: {}` is the JSON Schema for "anything goes" — an
    // empty schema accepts every value. The envelope's data/error/meta ride
    // along untouched.
    const extra = tool.outputSchema?.additionalProperties;
    assert.ok(
      extra === true || (extra && typeof extra === 'object' && Object.keys(extra).length === 0),
      `${tool.name}: nothing may be rejected — the envelope carries data/error/meta too (got ${JSON.stringify(extra)})`,
    );
  }
  await client.close();
});

test('the full envelope schema is published ONCE, as a resource', async () => {
  const { client } = await connect();
  const { resources } = await client.listResources();
  assert.equal(resources.length, 1, 'the envelope schema must be the only resource');
  assert.equal(resources[0].uri, 'archgen://schema/envelope');

  const read = await client.readResource({ uri: 'archgen://schema/envelope' });
  const schema = JSON.parse(read.contents[0].text);
  assert.equal(schema.type, 'object');
  assert.deepEqual(schema.required, ['ok', 'meta'], 'the envelope carries ok and meta');
  assert.ok(schema.properties.error, 'the envelope declares its error shape');
  await client.close();
});

test('every tool description carries the envelope shape where the model reads it', () => {
  resetServerContext();
  createServer();
  for (const name of exposedToolNames()) {
    const spec = getToolSpec(name);
    assert.ok(
      spec.description.endsWith('→ {ok,data,error,meta}'),
      `${name}: the description must say what the tool returns`,
    );
  }
});
