// harness-registry.test.mjs — the registry and the writer must agree.
//
// assets/harness-mcp.json is the single source of truth for every harness's
// config shape. The writer turns a registry entry into a config entry. When
// those two disagree — a registry naming an entry shape the writer does not
// know — the failure is a crash in the middle of wiring every harness, and
// the harnesses after the bad one are never configured at all.
//
// So the agreement is a TEST, not a convention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { loadAsset } from '../../src/context.mjs';
import { buildEntry, wireServer, entryToToml } from '../../src/core/harness/harness-wiring.mjs';

const registry = loadAsset('harness-mcp.json');

/** The entry blocks, paired with the npx fallback for each. */
const BLOCKS = [
  ['entries', 'npxEntries'],
  ['archgenEntries', 'archgenNpxEntries'],
];

test('every config names an entry shape the writer knows', () => {
  for (const [harness, spec] of Object.entries(registry.harnesses)) {
    for (const [loc, cfg] of Object.entries(spec.configs ?? {})) {
      for (const [entriesKey, npxKey] of BLOCKS) {
        const entries = registry[entriesKey];
        assert.ok(
          entries[cfg.entry],
          `${harness}/${loc} names entry '${cfg.entry}', which ${entriesKey} does not define ` +
            `(it has: ${Object.keys(entries).join(', ')})`,
        );
        assert.ok(
          registry[npxKey][cfg.entry],
          `${harness}/${loc} names entry '${cfg.entry}', which ${npxKey} does not define`,
        );
      }
    }
  }
});

test('every config names a format the writer supports', () => {
  const formats = new Set(['json', 'toml']);
  for (const [harness, spec] of Object.entries(registry.harnesses)) {
    for (const [loc, cfg] of Object.entries(spec.configs ?? {})) {
      assert.ok(
        formats.has(cfg.format),
        `${harness}/${loc} names format '${cfg.format}', which the writer does not support`,
      );
      if (cfg.format === 'json') {
        assert.ok(cfg.key, `${harness}/${loc} is JSON but names no top-level key`);
      }
    }
  }
});

test('a TOML config names no key — the writer derives the section from the server id', () => {
  for (const [harness, spec] of Object.entries(registry.harnesses)) {
    for (const [loc, cfg] of Object.entries(spec.configs ?? {})) {
      if (cfg.format !== 'toml') continue;
      assert.ok(
        !cfg.key,
        `${harness}/${loc} pins the TOML section to '${cfg.key}' — the section belongs to the ` +
          'server being written, so a per-server key in the registry is wrong by construction',
      );
    }
  }
});

test('an unknown entry shape is a typed error, not a crash', () => {
  assert.throws(
    () => buildEntry(registry.archgenEntries, registry.archgenNpxEntries, 'nonexistent', '/bin/x', 'archgen-mcp'),
    (e) => e.code === 'INVALID_INPUT' && /entry shape/.test(e.message),
  );
});

test('the npx form is used verbatim — it is a different command, not a swapped executable', () => {
  // The installed form runs the binary; the npx form runs npx with the
  // package. Rewriting the npx form's executable produced
  // `codegraph -y @colbymchenry/codegraph serve --mcp`, which can never start.
  const npx = buildEntry(registry.entries, registry.npxEntries, 'stdio', null, 'codegraph');
  assert.equal(npx.command, 'npx');
  assert.deepEqual(npx.args, ['-y', '@colbymchenry/codegraph', 'serve', '--mcp']);

  const installed = buildEntry(registry.entries, registry.npxEntries, 'stdio', '/usr/local/bin/codegraph', 'codegraph');
  assert.equal(installed.command, '/usr/local/bin/codegraph');
  assert.deepEqual(installed.args, ['serve', '--mcp']);
});

test('the archgen npx form runs npx with the package', () => {
  const npx = buildEntry(registry.archgenEntries, registry.archgenNpxEntries, 'stdio', null, 'archgen-mcp');
  assert.equal(npx.command, 'npx');
  assert.deepEqual(npx.args, ['-y', 'archgen-mcp']);
});

test('the TOML shape renders as a Codex section', () => {
  const entry = buildEntry(registry.archgenEntries, registry.archgenNpxEntries, 'stdioNoType', null, 'archgen-mcp');
  const toml = entryToToml(entry);
  assert.match(toml, /^command = "npx"$/m);
  assert.match(toml, /^args = \["-y", "archgen-mcp"\]$/m);
  assert.doesNotMatch(toml, /^type = /m, 'Codex MCP entries carry no "type" field');
});

test('wiring a Codex config writes the archgen section, and uninstall removes it', () => {
  const root = mkdtempSync(join(tmpdir(), 'ag-codex-'));
  const home = mkdtempSync(join(tmpdir(), 'ag-codex-home-'));
  try {
    mkdirSync(join(home, '.codex'), { recursive: true });
    const result = wireServer({
      serverId: 'archgen',
      registry,
      entries: registry.archgenEntries,
      npxEntries: registry.archgenNpxEntries,
      projectRoot: root,
      home,
      location: 'global',
      approved: true,
      binPath: null,
      fallbackCommand: 'archgen-mcp',
    });
    const codex = result.wired.find((w) => w.harness === 'codex');
    assert.ok(codex, 'the codex harness was not wired');
    assert.equal(codex.status, 'written', codex.detail ?? '');
    const written = readFileSync(join(home, '.codex', 'config.toml'), 'utf8');
    assert.match(written, /\[mcp_servers\.archgen\]/);
    assert.match(written, /command = "npx"/);
    // The recorded key must be the section the writer actually produced —
    // otherwise uninstall searches for the wrong section.
    assert.equal(codex.key, 'mcp_servers.archgen');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test('wiring every detected harness completes — one bad registry entry cannot abort the rest', () => {
  const root = mkdtempSync(join(tmpdir(), 'ag-wire-'));
  const home = mkdtempSync(join(tmpdir(), 'ag-wire-home-'));
  try {
    // One marker per harness, at HOME, exactly as detectHarnesses looks for
    // them: the registry is the source of truth for detection too. A marker
    // is a FILE when its last segment has an extension (".claude.json"); a
    // bare dot-directory (".gemini") is a DIRECTORY.
    for (const h of Object.values(registry.harnesses)) {
      for (const marker of h.detectHome ?? []) {
        const abs = join(home, marker);
        const last = marker.split('/').pop() ?? '';
        if (/^[^.][^/]*\.[^.]+$/.test(last)) {
          mkdirSync(dirname(abs), { recursive: true });
          writeFileSync(abs, '{}');
        } else {
          mkdirSync(abs, { recursive: true });
        }
      }
    }
    const result = wireServer({
      serverId: 'archgen',
      registry,
      entries: registry.archgenEntries,
      npxEntries: registry.archgenNpxEntries,
      projectRoot: root,
      home,
      location: 'global',
      approved: true,
      binPath: null,
      fallbackCommand: 'archgen-mcp',
    });
    const failed = result.wired.filter((w) => w.status === 'error');
    assert.equal(failed.length, 0, 'a harness failed to wire: ' + JSON.stringify(failed));
    assert.ok(result.wired.length >= 5, `expected several harnesses to be wired, got ${result.wired.length}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});
