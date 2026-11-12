// version-parity.test.mjs — the two version readers must agree.
//
// WHY THIS FILE EXISTS. The skill's capability requirement is read in two
// places: the MCP server's `core/compat.mjs` and the CLI's build script
// `scripts/sync-config.mjs`. They cannot be ONE implementation — the CLI
// package is published and must work when it is copied ALONE, with no
// server beside it — so the duplication is real.
//
// What is NOT acceptable is the DRIFT that duplication invites. They already
// disagreed: the CLI's regex accepted an unquoted requirement and the
// server's reader required the `metadata:` block, so a requirement written
// either way was visible to one gate and invisible to the other.
//
// This test holds them to the same answers, over the same corpus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseSkillFrontmatter, satisfies } from '../../packages/mcp/src/core/protocol/compat.mjs';
import { readRequiresMcp, serverSatisfies } from '../../packages/cli/scripts/sync-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The frontmatter shapes a skill may declare. */
const FRONTMATTERS = [
  ['---', 'metadata:', '  requires:', '    archgen_mcp: ">=1.2.3"', '---'].join('\n'),
  ['---', 'metadata:', '  requires:', "    archgen_mcp: '>=1.2.3'", '---'].join('\n'),
  ['---', 'metadata:', '  requires:', '    archgen_mcp: >=1.2.3', '---'].join('\n'),
  ['---', 'metadata:', '  version: 1.2.3', '---'].join('\n'),
  ['---', 'name: x', '---'].join('\n'),
  'not frontmatter at all',
  '',
];

/** The version pairs the comparison must answer the same way about. */
const VERSIONS = ['0.0.1', '1.2.2', '1.2.3', '1.2.4', '1.3.0', '2.0.0', 'v1.2.3', 'nonsense'];
const SPECS = ['>=1.2.3', '>1.2.3', '<=1.2.3', '<1.2.3', '=1.2.3', '^1.0.0', '~1.2.0', '1.2.3', 'not-a-version'];

test('both readers declare the same requirement', () => {
  for (const fm of FRONTMATTERS) {
    const server = parseSkillFrontmatter(fm).requires.archgen_mcp ?? null;
    const cli = readRequiresMcp(fm);
    assert.equal(cli, server, `the readers disagree on:\n${fm}`);
  }
});

test('both comparators answer the same way', () => {
  for (const version of VERSIONS) {
    for (const spec of SPECS) {
      // The server REFUSES an unparseable requirement; the CLI treats it as
      // not satisfied. Both answers are "no" — only the reporting differs.
      let server;
      try {
        server = satisfies(version, spec);
      } catch {
        server = false;
      }
      assert.equal(
        serverSatisfies(version, spec),
        server,
        `the comparators disagree on ${version} against ${spec}`,
      );
    }
  }
});
