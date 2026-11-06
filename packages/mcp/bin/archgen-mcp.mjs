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
const CLI_COMMANDS = new Set(['exec', 'bootstrap', 'doctor', 'uninstall-mcp', 'help']);
const first = argv[0];
// 'serve' is the default, but any explicit CLI command OR any flag means the
// caller wants the command-line facade, not the JSON-RPC stream.
const wantsCli = first === 'serve' ? false : CLI_COMMANDS.has(first) || (first !== undefined && first.startsWith('-'));

if (wantsCli) {
  const code = await runCli(argv);
  process.exit(code ?? 0);
}

const server = createServer();
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('archgen-mcp: server running on stdio\n');
