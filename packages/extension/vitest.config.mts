import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'node',
    // WHY threads (not the default forks): codegraph tests load
    // better-sqlite3, a native addon. Under the forks pool on Node 20,
    // worker teardown after native-module use crashes with
    // "Worker exited unexpectedly" AFTER tests have passed - a known
    // vitest/tinypool + native-addon interaction. Worker threads tear
    // native handles down cleanly, eliminating the false failure while
    // keeping identical isolation semantics for our suites.
    pool: 'threads',
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
