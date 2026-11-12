// init.js — single-store project installer + AGENTS.md/CLAUDE.md context files.
//
// `archgen init` makes a repository SELF-CONTAINED with ONE real copy of the
// skill: the canonical store at .agents/skills/archgen (committed to git,
// team-shared). .claude/skills/archgen becomes a RELATIVE symlink to the
// store — skipped gracefully where symlinks are unavailable, never a second
// copy. AGENTS.md carries a managed pointer block with an embedded features
// registry; CLAUDE.md carries a one-line `@AGENTS.md` bridge. Every created
// artifact is recorded in .archgen/.install-manifest.json.
//
// Verified-surgical safety semantics:
// - existing paths are fingerprinted (stable-order sha256 over relpaths +
//   contents) BEFORE any mutation;
// - an identical store is refreshed in place; a divergent one is moved to
//   .archgen/.backup/<timestamp>/ FIRST, then reinstalled fresh;
// - a real-directory claude copy identical to the vendor skill is migrated
//   to a symlink; a customized one is left untouched with a warning;
// - installs are atomic: built in a temp sibling dir, then renamed.

import { cpSync, existsSync, mkdirSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { importsAgents, hasManagedBlock, renderBlock, START, END, upsertManagedFile } from './block.js';
import { CLAUDE_LINK_REL, STORE_REL, VERSION_FILE, appendEntry, assertNotSymlink, assertWithinRoot, cliVersion, hashDir, moveToBackup, pruneDevOnly } from './store.js';
import { writeStamp } from './version-stamp.js';
import { bootstrapServers } from './bootstrap.js';
import { lstatSafe, relJoin } from './fs-paths.js';

const CONTEXT_FILES = ['AGENTS.md', 'CLAUDE.md'];

/** Resolve the bundled skill directory (works from npm package and repo checkout). */
export function resolveSkillSource(packageRoot) {
  const candidates = [
    join(packageRoot, 'vendor', 'skills', 'archgen'),
    join(packageRoot, '..', '..', 'skill'), // dev: running from packages/cli inside the monorepo
  ];
  for (const c of candidates) if (existsSync(join(c, 'SKILL.md'))) return c;
  throw new Error('bundled archgen skill not found (expected vendor/skills/archgen)');
}

/**
 * Create the claude adapter: `<project>/.claude/skills/archgen` as a RELATIVE
 * symlink into the canonical store. Never copies. Migration/keep semantics:
 * - ours already -> 'existing'
 * - real dir identical to vendor -> replaced with symlink ('migrated')
 * - real dir modified / foreign live symlink / stray file -> hands off + warn
 * - dangling symlink -> recreated
 * - symlink creation fails (privileges/FS) -> skipped + warning
 */
function installClaudeAdapter(root, source, warnings) {
  const claudeAbs = join(root, relJoin(CLAUDE_LINK_REL));
  const storeAbs = join(root, relJoin(STORE_REL));

  // Escape check FIRST — before anything is removed or created: a symlinked
  // .claude/.claude/skills parent must not redirect the adapter (nor the
  // removal of a legacy copy) outside the project root.
  assertWithinRoot(root, dirname(claudeAbs));

  const st = lstatSafe(claudeAbs);
  let migrating = false;

  if (st && st.isSymbolicLink()) {
    const resolvedTarget = resolve(dirname(claudeAbs), readlinkSync(claudeAbs));
    if (resolvedTarget === storeAbs && existsSync(claudeAbs)) return 'existing';
    if (existsSync(claudeAbs)) {
      warnings.push('.claude/skills/archgen is a foreign symlink - left untouched');
      return 'kept-divergent';
    }
    unlinkSync(claudeAbs); // dangling: recreate ours below
  } else if (st && st.isDirectory()) {
    if (hashDir(claudeAbs) === hashDir(source)) {
      rmSync(claudeAbs, { recursive: true }); // legacy dual copy -> migrate
      migrating = true;
    } else {
      warnings.push('user-customized claude copy kept at .claude/skills/archgen (not managed)');
      return 'kept-divergent';
    }
  } else if (st) {
    warnings.push('.claude/skills/archgen exists and is not a directory - left untouched');
    return 'kept-divergent';
  }

  try {
    mkdirSync(dirname(claudeAbs), { recursive: true });
    symlinkSync('../../.agents/skills/archgen', claudeAbs);
    appendEntry(root, 'link', CLAUDE_LINK_REL);
    return migrating ? 'migrated' : 'created';
  } catch (e) {
    warnings.push('claude adapter skipped: symlink unavailable (' + e.message + ')');
    return 'skipped';
  }
}

/**
 * Initialize a project: install the single canonical skill store, wire the
 * claude adapter, and write context pointers.
 * @param {string} projectDir target repo root
 * @param {string} packageRoot dir containing this CLI package
 * @param {{force?: boolean, codegraph?: boolean, mcp?: boolean, log?: (s: string) => void, env?: NodeJS.ProcessEnv}} opts
 *   --force proceeds automatically; divergent copies are always auto-backed-up
 *   (never refused, never destroyed). opts.codegraph === false opts OUT of the
 *   automatic CodeGraph bootstrap (install + MCP wiring + index build);
 *   opts.mcp === false opts OUT of the archgen MCP wiring.
 * @returns {{storePath: string, claudeLink: 'created'|'existing'|'migrated'|'skipped'|'kept-divergent',
 *            backups: string[], contextFiles: string[], createdContextFiles: string[], warnings: string[]}}
 */
export function initProject(projectDir, packageRoot, opts = {}) {
  // --force is accepted for explicitness: this installer never refuses and
  // never destroys data — divergent copies are backed up automatically, so
  // both plain and --force runs take the same safe path.
  const force = opts.force === true;
  void force;
  const codegraphAllowed = opts.codegraph !== false;
  const mcpAllowed = opts.mcp !== false;
  const log = opts.log ?? console.log;

  const root = resolve(projectDir);
  const source = resolveSkillSource(packageRoot);
  const version = cliVersion(packageRoot);
  const warnings = [];
  const backups = [];

  const storeAbs = join(root, relJoin(STORE_REL));

  // Supply-chain guards BEFORE any mutation: a symlinked store (a malicious
  // clone can ship .agents/skills/archgen as a link to an unrelated dir) is
  // refused, and the resolved real path must stay inside the project root.
  assertNotSymlink(storeAbs);
  assertWithinRoot(root, storeAbs);

  // 1. Canonical store — fingerprint before mutating (ownership check).
  const prev = lstatSafe(storeAbs);
  const identical = !!(prev && prev.isDirectory() && !prev.isSymbolicLink()
    && hashDir(storeAbs, { ignore: [VERSION_FILE] }) === hashDir(source));

  // Atomic install: build in a temp sibling dir, then swap it into place.
  // The current store is renamed aside (identical) or moved into the backup
  // vault (divergent) so the swap can be undone: a failed swap puts the old
  // store back, and a failed copy never leaves an orphan temp directory.
  const skillsParent = dirname(storeAbs);
  mkdirSync(skillsParent, { recursive: true });
  const tmp = join(skillsParent, '.archgen-tmp-' + randomBytes(6).toString('hex'));
  const aside = join(skillsParent, '.archgen-old-' + randomBytes(6).toString('hex'));
  let asideUsed = false;
  try {
    cpSync(source, tmp, { recursive: true });
    pruneDevOnly(tmp); // dev-only artifacts (scripts/test) never reach the installed store
    writeStamp(tmp, version);
    if (lstatSafe(storeAbs)) {
      if (identical) {
        renameSync(storeAbs, aside);
        asideUsed = true;
      } else {
        backups.push(moveToBackup(root, STORE_REL));
      }
    }
    renameSync(tmp, storeAbs);
  } catch (e) {
    if (asideUsed) {
      // Put the previous store back: a failed swap must never leave the
      // project without a store.
      try {
        renameSync(aside, storeAbs);
        asideUsed = false;
      } catch { /* keep it aside rather than deleting the user's data */ }
    }
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  if (asideUsed) rmSync(aside, { recursive: true, force: true });
  appendEntry(root, 'dir', STORE_REL);

  // 2. Claude adapter — relative symlink, never a second copy.
  const claudeLink = installClaudeAdapter(root, source, warnings);

  // 3. Context files — managed blocks, user content preserved.
  const contextFiles = [];
  const createdContextFiles = [];
  for (const name of CONTEXT_FILES) {
    const abs = join(root, name);
    // A hand-written `@AGENTS.md` import is the user's — leave it alone. A
    // managed block is ours: refresh it so its provenance stamp tracks the
    // running CLI instead of freezing at the first-ever install.
    if (name === 'CLAUDE.md' && !hasManagedBlock(abs) && importsAgents(abs)) {
      warnings.push('CLAUDE.md already imports @AGENTS.md - skipped (already-imports)');
      continue;
    }
    const existed = upsertManagedFile(
      abs,
      name === 'AGENTS.md' ? renderBlock(STORE_REL).split('\n') : [START, '@AGENTS.md', END],
    );
    contextFiles.push(name);
    if (!existed) createdContextFiles.push(name);
    appendEntry(root, 'block', name);
  }

  // 4. Server bootstrap — wire the archgen MCP server into every detected
  //    harness AND ensure CodeGraph (its CLI, its MCP entry, the project
  //    index). Non-fatal by design: an offline machine still gets the skill
  //    installed.
  //
  //    The wiring is GLOBAL by default: the server is one binary for every
  //    harness, and the harness configs live in the user's home. A project
  //    that carries its own `.mcp.json`, `.codex/` and `.gemini/` is a
  //    project that has to be re-wired in every clone. `--location project`
  //    opts into the per-project wiring.
  if (codegraphAllowed || mcpAllowed) {
    const r = bootstrapServers({
      projectDir: root,
      packageRoot: packageRoot,
      location: opts.location ?? 'global',
      log,
      env: opts.env,
      noCodegraph: !codegraphAllowed,
      noMcp: !mcpAllowed,
    });
    if (!r.ok) {
      warnings.push(`server bootstrap incomplete${r.detail ? ': ' + r.detail : ''} — install later with: npx archgen-mcp bootstrap --project . --yes`);
    } else if (r.skipped) {
      warnings.push(`server bootstrap skipped (${r.skipped})`);
    }
  } else {
    warnings.push('server bootstrap skipped (--no-codegraph --no-mcp)');
  }

  return { storePath: storeAbs, claudeLink, backups, contextFiles, createdContextFiles, warnings };
}
