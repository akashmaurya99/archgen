#!/usr/bin/env node
// release-prepare.mjs — prepare a release, end to end, in ONE command.
//
// THE PROBLEM THIS SOLVES.
//
// A release touches a version in several places, and each one has a
// different owner:
//
//   archgen.config.json        the canonical value — you edit this
//   skill/SKILL.md             metadata.requires — a HUMAN decision
//   skill/archgen.config.json  derived, rewritten by `npm run sync`
//   skill/SKILL.md version     derived, rewritten by `npm run sync`
//   packages/*/package.json    derived, rewritten by `npm run sync`
//   packages/*/package-lock    npm-owned, rewritten by npm
//   vendor/skills/archgen      build output, rewritten by `npm run sync`
//
// Remembering all of that is how releases go half-done. The CLI lockfile
// drifted to 0.0.6 while the project was at 0.0.7 and NOTHING FAILED,
// because the version gate had a hand-written list of surfaces and the lockfile
// was not on it.
//
// So the bump is a command, not a checklist.
//
//   node internal/tools/release-prepare.mjs <version> [--requires <version>]
//
// It bumps the canonical version, propagates it to every derived surface,
// regenerates the lockfiles, and then runs EVERY gate. If any gate fails, the
// release is not ready and this says so. It never publishes and never tags —
// publishing stays a deliberate, human, one-tag-at-a-time action.
//
// Usage: node internal/tools/release-prepare.mjs <version> [--requires <version>] [--dry-run]
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(HERE, '..', '..');

const SEMVER = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
};

function die(msg) {
  console.error(c.red(`release-prepare: ${msg}`));
  process.exit(1);
}

function step(n, total, label) {
  console.log(`\n${c.bold(`[${n}/${total}]`)} ${label}`);
}

/** Run a command in the repo root; throw with its output when it fails. */
function run(cmd, args, opts = {}) {
  const res = execFileSync(cmd, args, {
    cwd: opts.cwd ?? DEFAULT_ROOT,
    encoding: 'utf8',
    stdio: opts.quiet ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  return res;
}

function parseArgs(argv) {
  const out = { version: null, requires: null, dryRun: false };
  // An INDEX loop, not `for...of`: `--requires <version>` needs to CONSUME
  // the next argument, and `for...of` hands out a snapshot — the consumed
  // value would be read as the version too.
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--requires') {
      const value = argv[++i];
      if (!value) die('--requires needs a version');
      out.requires = value;
    } else if (a.startsWith('--')) die(`unknown option ${a}`);
    else if (!out.version) out.version = a;
    else die(`unexpected argument ${a}`);
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = DEFAULT_ROOT;

  if (!args.version) {
    console.error('usage: node internal/tools/release-prepare.mjs <version> [--requires <version>] [--dry-run]');
    process.exit(2);
  }
  if (!SEMVER.test(args.version)) {
    die(`'${args.version}' is not a semantic version (MAJOR.MINOR.PATCH)`);
  }

  const cfgPath = join(root, 'archgen.config.json');
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
  const from = cfg.version;
  if (from === args.version) {
    console.log(c.dim(`already at ${args.version} — nothing to bump; running the gates only`));
  }

  // ── the capability contract is a HUMAN decision ────────────────────────
  // The skill's declared minimum is raised by hand, on purpose: it says
  // "this skill needs a server that has these capabilities". If the skill
  // starts calling something new in this release, the human raises it. This
  // tool can apply the decision, but it will not INFER it.
  const skillPath = join(root, 'skill', 'SKILL.md');
  const currentRequires = /archgen_mcp:\s*"([^"]+)"/.exec(readFileSync(skillPath, 'utf8'))?.[1] ?? '';
  // `--requires <version>` and `--requires '>=<version>'` mean the same
  // thing: the declaration is a RANGE, so a bare version is normalised
  // into one. (The version is never written down here — the version
  // belongs in exactly one place, and this file is not it.)
  const rawWanted = args.requires ?? `>=${args.version}`;
  const wanted = /^[<>=^~]/.test(rawWanted) ? rawWanted : `>=${rawWanted}`;
  if (args.requires === undefined && currentRequires && currentRequires !== wanted) {
    console.log(
      c.yellow(
        `  note: skill/SKILL.md requires archgen_mcp '${currentRequires}', but the release is ${args.version}.`,
      ),
    );
    console.log(
      c.yellow(
        '         Raise it if the skill now calls a capability that only this server has:',
      ),
    );
    console.log(c.yellow(`           node internal/tools/release-prepare.mjs ${args.version} --requires '${wanted}'`));
  }

  const TOTAL = 7;

  // ── 1. the canonical version ────────────────────────────────────────────
  step(1, TOTAL, `the canonical version → ${args.version}`);
  if (args.dryRun) {
    console.log(c.dim(`  would write ${args.version} into ${cfgPath}`));
  } else {
    cfg.version = args.version;
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    console.log(c.green(`  ${from} → ${args.version}`));
  }

  // ── 2. the capability contract ──────────────────────────────────────────
  step(2, TOTAL, 'the capability contract (the human decision)');
  if (args.dryRun) {
    console.log(c.dim(`  would set metadata.requires.archgen_mcp to '${wanted}'`));
  } else if (currentRequires !== wanted) {
    const text = readFileSync(skillPath, 'utf8').replace(
      /archgen_mcp:\s*"[^"]+"/,
      `archgen_mcp: "${wanted}"`,
    );
    writeFileSync(skillPath, text, 'utf8');
    console.log(c.green(`  metadata.requires.archgen_mcp → '${wanted}'`));
  } else {
    console.log(c.dim(`  already '${wanted}'`));
  }

  // ── 3. propagate to every derived surface ───────────────────────────────
  step(3, TOTAL, 'propagate to every derived surface (npm run sync)');
  if (args.dryRun) console.log(c.dim('  would run: npm run sync'));
  else run('npm', ['run', 'sync']);

  // ── 4. the lockfiles ─────────────────────────────────────────────────────
  step(4, TOTAL, 'regenerate the lockfiles (npm owns them)');
  for (const pkg of ['packages/mcp', 'packages/cli']) {
    if (!existsSync(join(root, pkg, 'package-lock.json'))) continue;
    if (args.dryRun) {
      console.log(c.dim(`  would regenerate ${pkg}/package-lock.json`));
      continue;
    }
    run('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund'], { cwd: join(root, pkg), quiet: true });
    console.log(c.green(`  ${pkg}/package-lock.json`));
  }

  // ── 5. every gate ───────────────────────────────────────────────────────
  step(5, TOTAL, 'every gate');
  const gates = [
    ['version surfaces', ['run', 'test:versions']],
    ['derived files in sync', ['run', 'sync:check']],
    ['capability contract', ['run', 'test:contract']],
    ['always-on context budget', ['run', 'test:budget']],
    ['the suites', ['test']],
    ['the end-to-end fixtures', ['run', 'test:fixtures']],
  ];
  const failed = [];
  for (const [label, cmdArgs] of gates) {
    if (args.dryRun) {
      console.log(c.dim(`  would run: npm ${cmdArgs.join(' ')}`));
      continue;
    }
    try {
      run('npm', cmdArgs, { quiet: true });
      console.log(c.green(`  ok    ${label}`));
    } catch (e) {
      const detail = [e.stdout, e.stderr].filter(Boolean).join('\n').trim().split('\n').slice(-6).join('\n');
      console.log(c.red(`  FAIL  ${label}`));
      failed.push(label);
      if (detail) console.log(c.dim(detail.split('\n').map((l) => `        ${l}`).join('\n')));
    }
  }

  // ── 6. the immutable check ──────────────────────────────────────────────
  step(6, TOTAL, 'the suites did not mutate the repository');
  if (args.dryRun) {
    console.log(c.dim('  would run: npm run test:immutable'));
  } else {
    try {
      run('npm', ['run', 'test:immutable'], { quiet: true });
      console.log(c.green('  ok    the repository is unchanged'));
    } catch {
      console.log(c.red('  FAIL  the suites mutated the repository'));
      failed.push('immutable');
    }
  }

  // ── 7. what to do next ──────────────────────────────────────────────────
  step(7, TOTAL, 'next');
  if (args.dryRun) {
    console.log(c.yellow('\nDRY RUN — nothing was written and no gate was run.'));
    console.log('Re-run without --dry-run to prepare the release for real.');
    return;
  }
  if (failed.length) {
    console.log(c.red(`\n${failed.length} gate(s) failed: ${failed.join(', ')}`));
    console.log(c.red('The release is NOT ready. Fix the failures and run this command again.'));
    process.exit(1);
  }
  console.log(c.green('Every gate passed. The release is ready.'));
  console.log(`
The release is prepared. Nothing has been published and nothing has been
tagged — that stays a deliberate, one-tag-at-a-time action.

  git add -A && git commit -m "chore(release): ${args.version}"
  git tag -a vmcp-${args.version} -m "archgen-mcp ${args.version} — the MCP server that owns every archgen capability"
  git push origin vmcp-${args.version}          # → npm publish archgen-mcp  (FIRST)
  git tag -a vcli-${args.version} -m "archgen-skill ${args.version} — the installer; wires the MCP server into every detected harness"
  git push origin vcli-${args.version}          # → npm publish archgen-skill

PUBLISH ORDER — the MCP server FIRST: the CLI's installer resolves
archgen-mcp from the registry, so advertising the server before it exists
hands every user a broken bootstrap. Push one tag, wait for its run, then
push the next.

Do not forget the CHANGELOG entry: add a "## [${args.version}]" section to
CHANGELOG.md before committing.
`);
}

main();
