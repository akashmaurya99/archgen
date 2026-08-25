import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
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
      //  - src/webview/main.tsx: DOM mount entry (createRoot + render App);
      //    App itself is fully jsdom-tested.
      //  - src/webview/vscode.ts: acquireVsCodeApi single-acquisition wrapper;
      //    untestable outside a real webview runtime.
      exclude: [
        'src/host/extension.ts',
        'src/host/panel.ts',
        'src/host/watchers.ts',
        'src/webview/main.tsx',
        'src/webview/vscode.ts',
      ],
    },
  },
});
