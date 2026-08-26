// Config single-source-of-truth tests: dual-layout loading (monorepo root +
// published vendor copy), precedence, actionable failure, sync-config
// propagation + idempotency, frontmatter/package.json/vendor agreement with
// the canonical version, and the repo itself never drifting again.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHash,
} from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configCandidates, loadConfig, loadConfigFrom, parseConfig } from '../lib/config.js';
import { START, END, FEATURES_START, FEATURES_END, renderManagedBlockText, renderClaudeBridgeText } from '../lib/block.js';
import { VERSION_FILE, MANIFEST_REL, BACKUP_ROOT_REL } from '../lib/store.js';
import { MANIFEST_NAME } from '../lib/install.js';
import { syncConfig, setFrontmatterVersion, setPackageVersion } from '../scripts/sync-config.mjs';
import { syncVendor } from '../scripts/sync-vendor.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const CANONICAL_PATH = join(REPO, 'archgen.config.json');
const CANONICAL = JSON.parse(readFileSync(CANONICAL_PATH, 'utf8'));
const VERSION = CANONICAL.version;

function sha(p) {
  return createHash('sha256').update(readFileSync(p)).digest('hex');
}

let fx;

beforeEach(() => {
  fx = mkdtempSync(join(tmpdir(), 'ag-cfg-'));
});

afterEach(() => {
  rmSync(fx, { recursive: true, force: true });
});

/** Minimal fake checkout: <fx>/archgen.config.json + skill/ + packages/cli/. */
function fixtureRepo({ canonical = CANONICAL, skillMd, pkgVersion, extVersion } = {}) {
  const cfgText = JSON.stringify(canonical, null, 2) + '\n';
  writeFileSync(join(fx, 'archgen.config.json'), cfgText);
  mkdirSync(join(fx, 'skill'), { recursive: true });
  writeFileSync(join(fx, 'skill', 'archgen.config.json'), cfgText);
  writeFileSync(
    join(fx, 'skill', 'SKILL.md'),
    skillMd ??
      [
        '---',
        'name: archgen',
        'description: test skill',
        'metadata:',
        '  version: 0.0.0',
        '  repo: https://example.test/archgen',
        '---',
        '',
        '# body line one',
        '# body line two',
        '',
      ].join('\n'),
  );
  const libDir = join(fx, 'packages', 'cli', 'lib');
  mkdirSync(libDir, { recursive: true });
  writeFileSync(
    join(fx, 'packages', 'cli', 'package.json'),
    JSON.stringify({ name: 'archgen-skill', version: pkgVersion ?? '0.0.0' }, null, 2) + '\n',
  );
  if (extVersion !== undefined) {
    mkdirSync(join(fx, 'packages', 'extension'), { recursive: true });
    writeFileSync(
      join(fx, 'packages', 'extension', 'package.json'),
      JSON.stringify({ name: 'archgen-extension', version: extVersion }, null, 2) + '\n',
    );
  }
  return libDir;
}

test('loadConfig resolves the monorepo layout and matches the exact literals hardcoded in consumers', () => {
  const cfg = loadConfig();
  assert.equal(cfg.version, VERSION);
  assert.equal(cfg.skillName, 'archgen');
  assert.equal(cfg.markers.start, START);
  assert.equal(cfg.markers.end, END);
  assert.equal(cfg.markers.featuresStart, FEATURES_START);
  assert.equal(cfg.markers.featuresEnd, FEATURES_END);
  assert.equal(cfg.files.stamp, VERSION_FILE);
  assert.equal(cfg.files.projectManifest, MANIFEST_REL.split('/').pop());
  assert.equal(cfg.files.globalManifest, MANIFEST_NAME);
  assert.equal(cfg.files.backupDir, BACKUP_ROOT_REL.split('/').pop());
});

test('published layout: vendored copy resolves when no repo-root config exists', () => {
  const libDir = join(fx, 'packages', 'cli', 'lib');
  mkdirSync(libDir, { recursive: true });
  const vendored = join(fx, 'packages', 'cli', 'vendor', 'skills', 'archgen', 'archgen.config.json');
  mkdirSync(dirname(vendored), { recursive: true });
  writeFileSync(vendored, JSON.stringify({ ...CANONICAL, version: '7.7.7' }, null, 2) + '\n');
  assert.deepEqual(configCandidates(libDir), [
    join(fx, 'archgen.config.json'),
    vendored,
  ]);
  assert.equal(loadConfigFrom(libDir).version, '7.7.7');
});

test('precedence: repo-root config wins over the vendored copy', () => {
  const libDir = join(fx, 'packages', 'cli', 'lib');
  mkdirSync(libDir, { recursive: true });
  writeFileSync(join(fx, 'archgen.config.json'), JSON.stringify({ ...CANONICAL, version: '9.9.9' }));
  mkdirSync(join(fx, 'vendor', 'skills', 'archgen'), { recursive: true });
  writeFileSync(
    join(fx, 'vendor', 'skills', 'archgen', 'archgen.config.json'),
    JSON.stringify({ ...CANONICAL, version: '1.1.1' }),
  );
  assert.equal(loadConfigFrom(libDir).version, '9.9.9');
});

test('missing everywhere fails with an actionable error listing both candidate paths', () => {
  const libDir = join(fx, 'packages', 'cli', 'lib');
  mkdirSync(libDir, { recursive: true });
  assert.throws(() => loadConfigFrom(libDir), (e) => {
    assert.match(e.message, /archgen config not found/);
    assert.ok(e.message.includes(join(fx, 'archgen.config.json')));
    assert.ok(e.message.includes(join(fx, 'packages', 'cli', 'vendor', 'skills', 'archgen', 'archgen.config.json')));
    assert.match(e.message, /sync:config/);
    return true;
  });
});

test('a corrupt canonical config fails loudly instead of silently falling back to a stale vendored copy', () => {
  const libDir = join(fx, 'packages', 'cli', 'lib');
  mkdirSync(libDir, { recursive: true });
  writeFileSync(join(fx, 'archgen.config.json'), '{ not json');
  mkdirSync(join(fx, 'vendor', 'skills', 'archgen'), { recursive: true });
  writeFileSync(join(fx, 'vendor', 'skills', 'archgen', 'archgen.config.json'), '{"version":"1.1.1"}');
  assert.throws(() => loadConfigFrom(libDir), /invalid JSON/);
});

test('parseConfig validates required fields and semver shape', () => {
  const ok = parseConfig(JSON.stringify(CANONICAL), 'x');
  assert.equal(ok.version, VERSION);
  assert.throws(() => parseConfig('{"version":"1.2","skillName":"a"}', 'x'), /MAJOR\.MINOR\.PATCH/);
  assert.throws(() => parseConfig('{"version":"1.2.3"}', 'x'), /skillName/);
  assert.throws(() => parseConfig('{"version":"1.2.3","skillName":"a"}', 'x'), /markers/);
  assert.throws(
    () => parseConfig(JSON.stringify({ ...CANONICAL, markers: { ...CANONICAL.markers, end: '' } }), 'x'),
    /markers\.end/,
  );
  assert.throws(() => parseConfig(JSON.stringify({ ...CANONICAL, files: {} }), 'x'), /files\.stamp/);
});

test('sync-config propagates the canonical version into SKILL.md, package.json and the derived skill copy', () => {
  fixtureRepo();
  const changed = syncConfig({ root: fx });

  const md = readFileSync(join(fx, 'skill', 'SKILL.md'), 'utf8');
  assert.match(md, new RegExp(`^  version: ${VERSION.replaceAll('.', '\\.')}$`, 'm'));
  assert.ok(changed.some((c) => c.startsWith('skill/SKILL.md')));

  const pkg = JSON.parse(readFileSync(join(fx, 'packages', 'cli', 'package.json'), 'utf8'));
  assert.equal(pkg.version, VERSION);

  const derived = readFileSync(join(fx, 'skill', 'archgen.config.json'), 'utf8');
  assert.equal(derived, JSON.stringify(CANONICAL, null, 2) + '\n');

  // Only the version line moved; every other byte of SKILL.md is untouched.
  const expected = [
    '---',
    'name: archgen',
    'description: test skill',
    'metadata:',
    `  version: ${VERSION}`,
    '  repo: https://example.test/archgen',
    '---',
    '',
    '# body line one',
    '# body line two',
    '',
  ].join('\n');
  assert.equal(md, expected);
});

test('sync-config is idempotent: a second run rewrites nothing', () => {
  fixtureRepo();
  syncConfig({ root: fx });
  const before = {
    cfg: readFileSync(join(fx, 'skill', 'archgen.config.json'), 'utf8'),
    md: readFileSync(join(fx, 'skill', 'SKILL.md'), 'utf8'),
    pkg: readFileSync(join(fx, 'packages', 'cli', 'package.json'), 'utf8'),
  };
  const changed = syncConfig({ root: fx });
  assert.deepEqual(changed, []);
  assert.equal(readFileSync(join(fx, 'skill', 'archgen.config.json'), 'utf8'), before.cfg);
  assert.equal(readFileSync(join(fx, 'skill', 'SKILL.md'), 'utf8'), before.md);
  assert.equal(readFileSync(join(fx, 'packages', 'cli', 'package.json'), 'utf8'), before.pkg);
});

test('sync-config propagates the canonical version into the extension package.json when present', () => {
  fixtureRepo({ extVersion: '0.0.0' });
  const changed = syncConfig({ root: fx });
  assert.ok(changed.some((c) => c.startsWith('packages/extension/package.json')));
  const ext = JSON.parse(readFileSync(join(fx, 'packages', 'extension', 'package.json'), 'utf8'));
  assert.equal(ext.version, VERSION);
  // Second run is a no-op for the extension target too.
  assert.deepEqual(syncConfig({ root: fx }), []);
});

test('setPackageVersion edits only the version line: hand-formatted manifests are never reflowed', () => {
  // Mirrors the real packages/extension/package.json style: compact one-line
  // objects that a JSON.stringify round-trip would explode into many lines.
  const raw = [
    '{',
    '  "name": "archgen-extension",',
    '  "version": "0.0.0",',
    '  "contributes": {',
    '    "views": {',
    '      "archgen": [',
    '        { "id": "archgen.tasks", "name": "Tasks", "icon": "media/icons/tasks.svg" }',
    '      ]',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n');
  const out = setPackageVersion(raw, VERSION);
  assert.ok(out.includes(`"version": "${VERSION}"`));
  // Exactly one line moved; every other byte untouched.
  const diff = raw.split('\n').filter((l, i) => l !== out.split('\n')[i]);
  assert.deepEqual(diff, ['  "version": "0.0.0",']);
  // Nested keys named version at deeper indent are never touched.
  const nested = '{\n  "name": "x",\n  "version": "1.1.1",\n  "deep": {\n    "version": "2.2.2"\n  }\n}\n';
  assert.ok(setPackageVersion(nested, '9.9.9').includes('"version": "9.9.9"'));
  assert.ok(setPackageVersion(nested, '9.9.9').includes('"version": "2.2.2"'));
  // CRLF files survive too.
  const crlf = '{\r\n  "name": "x",\r\n  "version": "0.0.1"\r\n}\r\n';
  assert.ok(setPackageVersion(crlf, VERSION).includes(`"version": "${VERSION}"\r\n`));
});

test('sync-config check mode reports drift without writing anything', () => {
  fixtureRepo({ extVersion: '0.0.1' });
  const beforeMd = readFileSync(join(fx, 'skill', 'SKILL.md'), 'utf8');
  const drift = syncConfig({ root: fx, check: true });
  assert.ok(drift.some((c) => c.startsWith('skill/SKILL.md')), 'frontmatter drift reported');
  assert.ok(drift.some((c) => c.startsWith('packages/cli/package.json')), 'cli version drift reported');
  assert.ok(drift.some((c) => c.startsWith('packages/extension/package.json')), 'extension version drift reported');
  // Nothing was written.
  assert.equal(readFileSync(join(fx, 'skill', 'SKILL.md'), 'utf8'), beforeMd);
  assert.equal(JSON.parse(readFileSync(join(fx, 'packages', 'extension', 'package.json'), 'utf8')).version, '0.0.1');
  // After a real sync, check mode is clean.
  syncConfig({ root: fx });
  assert.deepEqual(syncConfig({ root: fx, check: true }), []);
});

test('setFrontmatterVersion preserves BOM and CRLF conventions around the edited line', () => {
  const crlf = '---\r\nname: archgen\r\nmetadata:\r\n  version: 0.0.0\r\n---\r\n\r\nbody\r\n';
  const out = setFrontmatterVersion(crlf, VERSION);
  assert.ok(out.includes(`  version: ${VERSION}\r\n`));
  assert.equal(out.split('\r\n').length, crlf.split('\r\n').length);

  const bom = '\uFEFF---\nmetadata:\n  version: 0.0.0\n---\nbody\n';
  const outBom = setFrontmatterVersion(bom, VERSION);
  assert.equal(outBom.charCodeAt(0), 0xfeff);
  assert.match(outBom, new RegExp(`^\\uFEFF---\\n[\\s\\S]*  version: ${VERSION}\\n`));
});

test('sync-vendor copies the derived config into vendor and the post-sync hash assertion holds', () => {
  fixtureRepo();
  syncConfig({ root: fx });
  const { dest } = syncVendor({ root: fx });

  const vCfg = join(dest, 'archgen.config.json');
  assert.ok(existsSync(vCfg));
  assert.equal(sha(vCfg), sha(join(fx, 'skill', 'archgen.config.json')));
  assert.equal(sha(vCfg), sha(join(fx, 'archgen.config.json')));

  const vMd = readFileSync(join(dest, 'SKILL.md'), 'utf8');
  assert.match(vMd, new RegExp(`^  version: ${VERSION}$`, 'm'));
});

test('sync-vendor refuses to run when the derived skill config is missing (stale sync order)', () => {
  fixtureRepo();
  rmSync(join(fx, 'skill', 'archgen.config.json'));
  assert.throws(() => syncVendor({ root: fx }), /sync:config/);
});

test('repo consistency guard: canonical == SKILL.md frontmatter == package.json == vendored copy', () => {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(join(REPO, 'skill', 'SKILL.md'), 'utf8'));
  assert.ok(fm, 'repo SKILL.md has frontmatter');
  const mdVersion = /^  version: (\S+)$/m.exec(fm[1]);
  assert.ok(mdVersion, 'frontmatter carries metadata.version');

  const pkg = JSON.parse(readFileSync(join(REPO, 'packages', 'cli', 'package.json'), 'utf8'));
  const extPkg = JSON.parse(readFileSync(join(REPO, 'packages', 'extension', 'package.json'), 'utf8'));
  const vendorCfg = JSON.parse(readFileSync(join(REPO, 'packages', 'cli', 'vendor', 'skills', 'archgen', 'archgen.config.json'), 'utf8'));

  assert.equal(mdVersion[1], VERSION, 'SKILL.md frontmatter must equal archgen.config.json version');
  assert.equal(pkg.version, VERSION, 'packages/cli/package.json must equal archgen.config.json version');
  assert.equal(extPkg.version, VERSION, 'packages/extension/package.json must equal archgen.config.json version');
  assert.equal(vendorCfg.version, VERSION, 'vendored config must equal archgen.config.json version');
});

// ---- install.sh managed-block parity ---------------------------------------
// install.sh's --init heredocs are generated from lib/block.js's integrator
// exports. This section fails CI the moment the two drift.

const INSTALL_SH = readFileSync(join(REPO, 'install.sh'), 'utf8');

/** Extract the n-th `cat <<'BLOCK'` heredoc body (including its final newline). */
function heredocBody(n) {
  const seg = INSTALL_SH.split("cat <<'BLOCK'")[n];
  assert.ok(seg !== undefined, `install.sh heredoc #${n} exists`);
  const end = seg.indexOf('\nBLOCK\n');
  assert.ok(end !== -1, `install.sh heredoc #${n} is terminated`);
  return seg.slice(1, end + 1);
}

test('install.sh parity: write_block heredoc equals renderManagedBlockText() byte-for-byte', () => {
  assert.ok(INSTALL_SH.includes('# Content mirrors packages/cli lib/block.js renderManagedBlockText()'), 'provenance comment present above the block heredoc');
  assert.equal(heredocBody(1), renderManagedBlockText() + '\n');
});

test('install.sh parity: write_bridge heredoc equals renderClaudeBridgeText() byte-for-byte', () => {
  assert.ok(INSTALL_SH.includes('# Content mirrors packages/cli lib/block.js renderClaudeBridgeText()'), 'provenance comment present above the bridge heredoc');
  assert.equal(heredocBody(2), renderClaudeBridgeText() + '\n');
});
