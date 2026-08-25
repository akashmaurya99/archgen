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

// Root-level attribution removal: xyflow's Attribution component is neutered at
// source-load time, so the badge cannot render under ANY prop combination. The
// post-build assertion fails the build if the class string ever reappears.
const stripReactFlowAttribution = {
  name: 'strip-react-flow-attribution',
  setup(build) {
    build.onLoad({ filter: /@xyflow[\\/]react[\\/]dist[\\/]esm[\\/]index(\.m?js)$/ }, (args) => {
      let src = readFileSync(args.path, 'utf8');
      if (src.includes('react-flow__attribution')) {
        // Dist ships the Attribution return as ONE physical line; replace it wholesale.
        src = src
          .split('\n')
          .map((l) => (l.includes('react-flow__attribution') && l.includes('return (jsx(Panel') ? 'return null;' : l))
          .join('\n');
      }
      return { contents: src, loader: 'js' };
    });
  },
};

function assertAttributionGone(outfile) {
  const out = readFileSync(outfile, 'utf8');
  if (out.includes('react-flow__attribution')) {
    throw new Error(`[archgen] attribution leak: '${outfile}' still contains react-flow__attribution — update stripReactFlowAttribution`);
  }
}

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
  plugins: [stripReactFlowAttribution],
};

if (watch) {
  const ctxHost = await esbuild.context(host);
  const ctxWeb = await esbuild.context(webview);
  await Promise.all([ctxHost.watch(), ctxWeb.watch()]);
  console.log('[archgen] watching host + webview…');
} else {
  await esbuild.build(host);
  await esbuild.build(webview);
  assertAttributionGone('media/webview/main.js');
  console.log(`[archgen] built ${pkg.version}: dist/extension.js + media/webview/main.js (attribution stripped)`);
}
