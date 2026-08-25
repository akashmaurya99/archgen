// cross-mode-check.mjs — CROSS-MODE CHECK (todo 13).
//
// Asserts MODEL-VIEW PARITY for the greenfield-demo fixture: the extension's
// own parser (src/host/readers/archgen.ts, bundled on the fly with esbuild)
// must read fixtures/greenfield-demo/.archgen/demo/tasks.yaml into exactly the
// view model the DAG renders — same node count, same ids, same statuses, same
// dependency edges, same field mapping the host applies in buildModel().
//
// This is the CLI-level fallback from the plan's verification chain; the
// workbench-level drive (open the greenfield-demo workspace in test-electron
// and screenshot the DAG) is documented as deferred in MANUAL-TEST.md §9.
//
// Usage: node scripts/cross-mode-check.mjs   (exit 0 = parity, 1 = drift)
import { build } from 'esbuild';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT_ROOT = join(HERE, '..');
const FIXTURE = process.env['ARCHGEN_FIXTURE_WS']
  ?? join(EXT_ROOT, '..', 'fixtures', 'greenfield-demo');
const TASKS_YAML = join(FIXTURE, '.archgen', 'demo', 'tasks.yaml');

const EXPECTED_IDS = ['SCAFFOLD', 'SHARED', 'API', 'WEB', 'DOCS', 'VERIFY'];

async function loadParser() {
  const outDir = await mkdtemp(join(tmpdir(), 'archgen-crossmode-'));
  const outfile = join(outDir, 'archgen-parser.mjs');
  await build({
    entryPoints: [join(EXT_ROOT, 'src', 'host', 'readers', 'archgen.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile,
    logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(outfile).href);
  return { parseTasks: mod.parseTasks, cleanup: () => rm(outDir, { recursive: true, force: true }) };
}

function fail(msg) {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
}

const { parseTasks, cleanup } = await loadParser();
try {
  const text = await readFile(TASKS_YAML, 'utf8');
  const model = parseTasks(text, 'tasks.yaml');

  // 1. Node count + exact ids (order preserved from the file).
  const ids = model.tasks.map((t) => t.id);
  if (model.tasks.length !== EXPECTED_IDS.length) {
    fail(`expected ${EXPECTED_IDS.length} tasks, parser produced ${model.tasks.length}`);
  }
  if (JSON.stringify(ids) !== JSON.stringify(EXPECTED_IDS)) {
    fail(`id mismatch: [${ids.join(', ')}] ≠ [${EXPECTED_IDS.join(', ')}]`);
  }

  // 2. Statuses: generated file leaves status unset → all default 'pending'.
  const badStatus = model.tasks.filter((t) => t.status !== 'pending');
  if (badStatus.length > 0) {
    fail(`non-pending statuses where file sets none: ${badStatus.map((t) => `${t.id}=${t.status}`).join(', ')}`);
  }

  // 3. Dependency edges match depends_on exactly.
  const expectedDeps = {
    SCAFFOLD: [],
    SHARED: ['SCAFFOLD'],
    API: ['SCAFFOLD', 'SHARED'],
    WEB: ['SCAFFOLD', 'SHARED'],
    DOCS: ['SCAFFOLD'],
    VERIFY: ['API', 'WEB'],
  };
  for (const t of model.tasks) {
    const want = expectedDeps[t.id] ?? [];
    if (JSON.stringify(t.depends_on) !== JSON.stringify(want)) {
      fail(`${t.id}.depends_on = [${t.depends_on.join(', ')}], expected [${want.join(', ')}]`);
    }
  }

  // 4. Field mapping parity with the host's TaskVM projection (extension.ts
  //    buildModel): snake_case file fields → camelCase view-model fields.
  const vm = model.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    dependsOn: t.depends_on,
    fileOwnership: t.file_ownership,
    artifacts: t.artifacts,
    parallelGroup: t.parallel_group,
  }));
  const web = vm.find((t) => t.id === 'WEB');
  if (web?.parallelGroup !== 'wave-ui') fail(`WEB.parallelGroup = ${web?.parallelGroup}, expected 'wave-ui'`);
  const docs = vm.find((t) => t.id === 'DOCS');
  if (!docs || docs.fileOwnership[0] !== 'docs/user-guide.md') fail('DOCS.fileOwnership[0] drifted');
  if (!docs || !docs.artifacts.includes('decisions/0001-postgres-over-mongo.md')) fail('DOCS.artifacts drifted');

  // 5. Parser tolerance ledger: a valid generated file yields zero warnings.
  if (model.warnings.length > 0) {
    fail(`unexpected parse warnings: ${model.warnings.map((w) => w.message).join('; ')}`);
  }

  if (!process.exitCode) {
    console.log(`✓ cross-mode parity: ${vm.length} nodes, ids [${ids.join('/')}], edges ${Object.values(expectedDeps).reduce((a, d) => a + d.length, 0)}, statuses pending×${vm.length}`);
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await cleanup();
}
