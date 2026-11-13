#!/usr/bin/env node
// archgen-mcp — the archgen MCP server (stdio transport).
//
// CRITICAL: stdout is reserved for JSON-RPC. Every diagnostic goes to stderr.
// A stray console.log on stdout corrupts the protocol stream and the client
// drops the connection.
//
// Usage:
//   archgen-mcp                             serve MCP over stdio (default)
//   archgen-mcp exec <tool> '<json>'       run one tool, print JSON
//   archgen-mcp bootstrap                   wire the archgen MCP + CodeGraph
//   archgen-mcp doctor                      health report
//   archgen-mcp uninstall-mcp               remove what was wired
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { createServer } from '../src/server.mjs';
import { runCli } from '../src/cli.mjs';

const argv = process.argv.slice(2);
const first = argv[0];
// The stdio server is the DEFAULT, and only for no argument at all or the
// explicit word 'serve'. Anything else is the command-line facade — a known
// command, a flag, or an unknown word, which must say "unknown command"
// rather than silently start a server and block on stdin (which is what it
// used to do, making the mistake look like a hang).
const wantsCli = !(first === undefined || first === 'serve');

if (wantsCli) {
  try {
    const code = await runCli(argv);
    process.exit(code ?? 0);
  } catch (e) {
    process.stderr.write(`archgen-mcp: ${e?.message ?? e}\n`);
    if (e?.details?.nextAction) process.stderr.write(`  Next: ${e.details.nextAction}\n`);
    process.exit(2);
  }
}

try {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('archgen-mcp: server running on stdio\n');
} catch (e) {
  // A refused configuration (an unknown tool profile, a broken asset) must
  // not crash the client with a stack trace: the harness would report "the
  // server failed to start" and the reader would never see the cause. The
  // message and the next step go to stderr — stdout is the protocol stream.
  process.stderr.write(`archgen-mcp: ${e?.message ?? e}\n`);
  if (e?.details?.nextAction) process.stderr.write(`  Next: ${e.details.nextAction}\n`);
  process.exit(2);
}
