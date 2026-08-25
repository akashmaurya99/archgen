// esbuild.mjs — dual-context build for the ArchGen extension.
//
// TWO bundles, two worlds, never mixed:
//   1. HOST   dist/extension.js      — CommonJS / node platform, `vscode` and
//      better-sqlite3 kept EXTERNAL (the extension host provides vscode at
//      runtime; better-sqlite3 ships as a native module per VS Code packaging
//      rules). Removing 'vscode' from external MUST fail the build — that is
//      the guard proving host code never leaks into a browser bundle.
//   2. WEBVIEW media/webview/main.js — IIFE / browser / es2020, everything
//      bundled inline (React, @xyflow/react) because webviews can only load
//      local resources whitelisted via localResourceRoots.
import * as esbuild from 'esbuild';
import { readFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

/** @type {import('esbuild').BuildOptions} */
const host = {
  entryPoints: ['src/host/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  // GUARD: 'vscode' exists only inside the extension host; bundling it would
  // throw "Could not resolve" — exactly what we want if someone tries.
  // better-sqlite3 must stay external so its .node binary is loaded, not inlined.
  external: ['vscode', 'better-sqlite3'],
  sourcemap: true,
  logLevel: 'info',
};

/** @type {import('esbuild').BuildOptions} */
const webview = {
  entryPoints: ['src/webview/main.tsx'],
  bundle: true,
  outfile: 'media/webview/main.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  sourcemap: false,
  logLevel: 'info',
};

if (watch) {
  const ctxHost = await esbuild.context(host);
  const ctxWeb = await esbuild.context(webview);
  await Promise.all([ctxHost.watch(), ctxWeb.watch()]);
  console.log('[archgen] watching host + webview…');
} else {
  await esbuild.build(host);
  await esbuild.build(webview);
  console.log(`[archgen] built ${pkg.version}: dist/extension.js + media/webview/main.js`);
}
