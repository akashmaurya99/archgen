import { configDefaults, defineConfig } from 'vitest/config';

// The wall-clock perf budget in parsers.perf.test.ts is measured on an
// UNINSTRUMENTED run: v8 coverage adds ~10-30% overhead to the hot parser,
// which made the 500ms budget flaky under `npm run coverage`. The budget is
// still enforced by the plain `npm test` run (CI "extension" job), where no
// instrumentation is active and timing is valid.
//
// The exclusion therefore applies to the COVERAGE RUN ONLY — it is switched
// on by the `ARCHGEN_COVERAGE=1` env var that `npm run coverage` sets, never
// unconditionally.
//
// The list is built from configDefaults on purpose: a CLI `--exclude`
// REPLACES the default exclude list, which would silently un-exclude
// node_modules from test discovery. Spreading configDefaults.exclude and
// adding our own keeps both.
const coverageRun = process.env['ARCHGEN_COVERAGE'] === '1';
const exclude = coverageRun
  ? [...configDefaults.exclude, '**/parsers.perf.test.ts']
  : configDefaults.exclude;

export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    exclude,
    environment: 'node',
    // NOTE: run this suite on Node 22 (see .github/workflows/ci.yml).
    // better-sqlite3 (native addon) inside vitest worker pools is only
    // stable on Node >= 22; Node 20 exhibits pool teardown/startup
    // crashes regardless of pool type. The shipped extension itself runs
    // inside VS Code's Electron runtime - CI node version is tooling,
    // not product compatibility.
    // jsdom is opted into per-file via @vitest-environment jsdom docblock.
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text', 'lcov'],
      // HARD GATE: every metric must stay >= 90% or `npm run coverage` fails.
      thresholds: { lines: 90, branches: 90, functions: 90, statements: 90 },
      // EXCLUDED FROM THRESHOLDS (explicit list — all VS Code/DOM-coupled
      // thin shells with NO testable pure logic; every pure module counts):
      //  - src/host/extension.ts + src/host/panel.ts: hard-import 'vscode'
      //    (unavailable under vitest's node env); only wire commands,
      //    OutputChannel and toasts to the pure modules below.
      //  - src/host/watchers.ts: hard-imports workspace/FileSystemWatcher;
      //    its entire logic IS debounce.ts (100% covered directly).
      //  - src/host/sidebar/providers.ts + index.ts: hard-import TreeItem/
      //    window/commands; their entire logic IS sidebar/model.ts (covered
      //    directly by test/sidebar-model.test.ts).
      //  - src/host/statusbar.ts: hard-imports window.createStatusBarItem;
      //    trivial inline counting over hub snapshots, no pure core.
      //  - src/webview/main.tsx: DOM mount entry (createRoot + render App);
      //    App itself is fully jsdom-tested.
      //  - src/webview/vscode.ts: acquireVsCodeApi single-acquisition wrapper;
      //    untestable outside a real webview runtime.
      exclude: [
        'src/host/extension.ts',
        'src/host/panel.ts',
        'src/host/watchers.ts',
        'src/host/sidebar/providers.ts',
        'src/host/sidebar/index.ts',
        'src/host/statusbar.ts',
        'src/webview/main.tsx',
        'src/webview/vscode.ts',
      ],
    },
  },
});
