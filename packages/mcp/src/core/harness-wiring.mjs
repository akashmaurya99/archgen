// harness-wiring.mjs — the ONE writer for MCP server entries.
//
// WHY THIS IS GENERIC: archgen has to wire TWO MCP servers into the SAME set
// of harnesses — its own (`archgen-mcp`) and CodeGraph's. The original
// skill/scripts/codegraph.mjs hard-coded `bucket.codegraph` in its writer, so
// a second server would have meant a second copy of the detection logic, the
// per-platform key/shape table, the approval gate, the symlink guards and the
// idempotency check. Four hundred lines of near-duplicate code, free to drift.
//
// This module is that logic ONCE, parameterised by `serverId`.
//
// SAFETY (unchanged from the original):
//   - MCP configs are written ONLY with approval; otherwise the PLAN is
//     reported and nothing is written.
//   - A config file that cannot be parsed is reported, NEVER rewritten.
//   - Only DETECTED harnesses are touched.
//   - The per-platform file path + top-level key live in assets/harness-mcp.json
//     — one source of truth, shared by the tool, the CLI and the docs.
//   - Writes are atomic and refuse to go through a symlink.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { assertNotSymlink, assertWithinRoot, writeFileAtomic } from './fs-safety.mjs';
import { invalidInput } from './errors.mjs';

/**
 * Detect which harnesses are present in this environment.
 * @param {any} registry the harness-mcp.json content
 * @param {string} projectRoot
 * @param {string} [home]
 * @returns {Array<{id: string, label: string, atHome: boolean, atProject: boolean, spec: any}>}
 */
export function detectHarnesses(registry, projectRoot, home = homedir()) {
  const found = [];
  for (const [id, h] of Object.entries(registry.harnesses ?? {})) {
    const atHome = (h.detectHome ?? []).some((m) => existsSync(join(home, m)));
    const atProject = (h.detectProject ?? []).some((m) => existsSync(join(projectRoot, m)));
    if (atHome || atProject) found.push({ id, label: h.label, atHome, atProject, spec: h });
  }
  return found;
}

/** Expand a leading `~/` to the home directory. */
export function expandHome(p, home = homedir()) {
  return p.startsWith('~/') ? join(home, p.slice(2)) : p;
}

/**
 * True when `abs` resolves inside `root`.
 *
 * The path is compared lexically after normalization, and symlinks are
 * resolved on both sides when they exist — a symlink pointing out of the
 * root must not pass as "inside".
 */
export function pathIsWithin(abs, root) {
  if (!abs || !root) return false;
  const resolvedRoot = resolve(root);
  const resolved = resolve(abs);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + sep)) return false;
  try {
    const realRoot = realpathSync(resolvedRoot);
    const real = realpathSync(resolved);
    return real === realRoot || real.startsWith(realRoot + sep);
  } catch {
    // The path does not exist yet: the lexical check above stands.
    return true;
  }
}

/**
 * Build the server entry for a harness, substituting the resolved binary path.
 *
 * When no binary was resolved the npx form is used instead, so the MCP config
 * still works on a machine where the CLI was never installed.
 *
 * @param {any} entries the entries block (entries / archgenEntries)
 * @param {any} npxEntries the npx fallback block (npxEntries / archgenNpxEntries)
 * @param {string} entryKey 'stdio' | 'stdioNoType' | 'opencodeLocal'
 * @param {string|null} binPath the resolved absolute binary path, or null for the npx form
 * @param {string} fallbackCommand the command used when binPath is null
 */
/**
 * Build the entry for one harness config.
 *
 * THE TWO FORMS ARE DIFFERENT COMMANDS, NOT ONE COMMAND WITH A SWAPPED
 * EXECUTABLE.
 *
 *   installed  the server's own binary:  `codegraph serve --mcp`
 *   npx        the same server, fetched:  `npx -y @colbymchenry/codegraph serve --mcp`
 *
 * When the binary was resolved, the installed form is used and its
 * executable is replaced with the resolved absolute path. When it was NOT,
 * the npx form is used VERBATIM — its executable is already `npx`, and
 * rewriting it to the server's own name produced the nonsense command
 * `codegraph -y @colbymchenry/codegraph serve --mcp`, which can never start.
 *
 * @param {any} entries the entries block (entries / archgenEntries)
 * @param {any} npxEntries the npx fallback block (npxEntries / archgenNpxEntries)
 * @param {string} entryKey the entry shape ('stdio' | 'stdioNoType' | …)
 * @param {string|null} binPath the resolved absolute binary path, or null for the npx form
 * @param {string} fallbackCommand the command used when no npx form exists
 * @returns {any} a fresh entry object (the source is never mutated)
 */
export function buildEntry(entries, npxEntries, entryKey, binPath, fallbackCommand) {
  const installed = entries?.[entryKey];
  const npx = npxEntries?.[entryKey];
  const useNpx = !binPath && Boolean(npx);
  const source = useNpx ? npx : installed;

  if (!source || typeof source !== 'object') {
    // A registry entry naming a shape the writer does not know is a REGISTRY
    // bug, not a user error. Say so plainly instead of crashing with a
    // SyntaxError from JSON.parse(undefined).
    throw invalidInput(
      `unknown MCP entry shape '${entryKey}' — the harness registry and the writer disagree`,
      { entryKey, available: Object.keys(entries ?? {}) },
    );
  }

  const entry = structuredClone(source);
  if (binPath) {
    if (Array.isArray(entry.command)) entry.command = [binPath, ...entry.command.slice(1)];
    else entry.command = binPath;
  } else if (!useNpx) {
    // No npx form for this shape: fall back to the server's own name.
    if (Array.isArray(entry.command)) entry.command = [fallbackCommand, ...entry.command.slice(1)];
    else entry.command = fallbackCommand;
  }
  return entry;
}

/** Read + parse a JSON config; null when absent, {error} when unparseable. */
export function readJsonConfig(abs) {
  if (!existsSync(abs)) return { data: null, existed: false };
  try {
    return { data: JSON.parse(readFileSync(abs, 'utf8')), existed: true };
  } catch (e) {
    return { data: null, existed: true, error: e.message };
  }
}

/**
 * Merge a server entry into a JSON MCP config.
 *
 * @param {string} abs absolute config path
 * @param {string} key the top-level key ('mcpServers' | 'servers' | 'mcp' | 'context_servers')
 * @param {string} serverId the entry name inside the bucket ('codegraph' | 'archgen')
 * @param {any} entry the server entry
 * @param {{approved: boolean, dryRun?: boolean, root?: string}} opts
 * @returns {{status:'written'|'unchanged'|'skipped'|'planned'|'error', detail?:string, path?:string}}
 */
export function writeJsonConfig(abs, key, serverId, entry, opts) {
  const { approved, dryRun = false, root } = opts;
  const { data, existed, error } = readJsonConfig(abs);
  if (error) {
    // A file we cannot parse is never rewritten.
    return { status: 'skipped', detail: `not valid JSON (${error}) — left untouched`, path: abs };
  }
  const obj = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const bucket = obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key]) ? obj[key] : {};
  const existing = bucket[serverId];
  if (existing && JSON.stringify(existing) === JSON.stringify(entry)) {
    return { status: 'unchanged', path: abs };
  }
  // Approval gate: without approval nothing is written.
  if (dryRun || !approved) {
    return { status: 'planned', detail: dryRun ? 'would write (dry-run)' : 'would write (needs approval)', path: abs };
  }
  bucket[serverId] = entry;
  obj[key] = bucket;
  try {
    if (root) assertWithinRoot(root, abs);
    assertNotSymlink(abs);
    writeFileAtomic(abs, JSON.stringify(obj, null, 2) + '\n');
  } catch (e) {
    return { status: 'error', detail: e.message, path: abs };
  }
  return { status: 'written', path: abs, detail: existed ? 'updated' : 'created' };
}

/** Quote a TOML basic string. */
function tomlString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Render a server entry as TOML key/value lines. */
export function entryToToml(entry) {
  const lines = [];
  for (const [k, v] of Object.entries(entry)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      lines.push(`${k} = [${v.map((x) => tomlString(x)).join(', ')}]`);
    } else if (typeof v === 'object') {
      lines.push(`[${k}]`);
      for (const [ik, iv] of Object.entries(v)) {
        if (iv === undefined || iv === null) continue;
        lines.push(`${ik} = ${tomlString(iv)}`);
      }
    } else if (typeof v === 'boolean') {
      lines.push(`${k} = ${v ? 'true' : 'false'}`);
    } else {
      lines.push(`${k} = ${tomlString(v)}`);
    }
  }
  return lines.join('\n');
}

/**
 * Merge a server entry into a TOML MCP config (Codex CLI shape).
 *
 * Only the target `[mcp_servers.<id>]` section is touched; every other byte
 * of the file survives verbatim.
 *
 * @param {string} abs absolute config path
 * @param {string} serverId
 * @param {any} entry
 * @param {{approved: boolean, dryRun?: boolean, root?: string}} opts
 */
export function writeTomlConfig(abs, serverId, entry, opts) {
  const { approved, dryRun = false, root } = opts;
  const existed = existsSync(abs);
  let raw = '';
  if (existed) {
    try {
      raw = readFileSync(abs, 'utf8');
    } catch (e) {
      return { status: 'error', detail: e.message, path: abs };
    }
  }
  const sectionHeader = `[mcp_servers.${serverId}]`;
  const body = entryToToml(entry);
  const section = `${sectionHeader}\n${body}\n`;

  // Locate an existing section (exact header match) and replace only its body.
  const lines = raw.split('\n');
  const start = lines.findIndex((l) => l.trim() === sectionHeader);
  let next;
  if (start !== -1) {
    next = start + 1;
    while (next < lines.length && !/^\s*\[/.test(lines[next])) next++;
    const current = lines.slice(start, next).join('\n');
    if (current.trim() === section.trim()) return { status: 'unchanged', path: abs };
  }

  if (dryRun || !approved) {
    return { status: 'planned', detail: dryRun ? 'would write (dry-run)' : 'would write (needs approval)', path: abs };
  }

  let out;
  if (start === -1) {
    const prefix = raw && !raw.endsWith('\n') ? raw + '\n\n' : raw;
    out = prefix + section;
  } else {
    const before = lines.slice(0, start);
    const after = lines.slice(next);
    out = [...before, ...section.split('\n').slice(0, -1), ...after].join('\n');
  }

  try {
    if (root) assertWithinRoot(root, abs);
    assertNotSymlink(abs);
    writeFileAtomic(abs, out);
  } catch (e) {
    return { status: 'error', detail: e.message, path: abs };
  }
  return { status: 'written', path: abs, detail: existed ? 'updated' : 'created' };
}

/**
 * Wire one MCP server into the detected harnesses.
 *
 * @param {{
 *   serverId: string,
 *   registry: any,
 *   entries: any,
 *   npxEntries?: any,
 *   projectRoot: string,
 *   home?: string,
 *   location?: 'project'|'global'|'both',
 *   approved?: boolean,
 *   dryRun?: boolean,
 *   binPath?: string|null,
 *   fallbackCommand?: string,
 *   skipHarnesses?: string[],
 *   targets?: string[]|null,
 * }} opts
 * @returns {{detected: string[], wired: Array<Record<string, unknown>>, skipped: Array<Record<string, unknown>>, planned: boolean}}
 */
export function wireServer(opts) {
  const {
    serverId,
    registry,
    entries,
    npxEntries = null,
    projectRoot,
    home = homedir(),
    location = 'both',
    approved = false,
    dryRun = false,
    binPath = null,
    fallbackCommand = serverId,
    skipHarnesses = [],
    targets = null,
  } = opts;

  const detected = detectHarnesses(registry, projectRoot, home);
  // A caller that narrowed the set of harnesses must get exactly that set.
  // The native path honoured the filter and this one did not, so a request
  // for two harnesses wired ten.
  const selected = targets ? detected.filter((d) => targets.includes(d.id)) : detected;
  const wantedLocations = location === 'both' ? ['global', 'project'] : [location];
  const wired = [];
  const skipped = [];

  for (const d of selected) {
    if (skipHarnesses.includes(d.id)) {
      skipped.push({ harness: d.id, reason: 'skipped by request' });
      continue;
    }
    const configs = d.spec.configs ?? {};
    for (const loc of wantedLocations) {
      const cfg = configs[loc];
      if (!cfg) continue;
      if (loc === 'global' && !d.atHome) continue;
      if (loc === 'project' && !d.atProject) continue;
      const absPath = cfg.path.startsWith('~') ? expandHome(cfg.path, home) : join(projectRoot, cfg.path);
      const entry = buildEntry(entries, npxEntries, cfg.entry, binPath, fallbackCommand);
      const root = loc === 'global' ? home : projectRoot;
      const res =
        cfg.format === 'toml'
          ? writeTomlConfig(absPath, serverId, entry, { approved, dryRun, root })
          : writeJsonConfig(absPath, cfg.key, serverId, entry, { approved, dryRun, root });
      // The key recorded here is the one the writer ACTUALLY used. A JSON
      // config uses the registry's top-level key; a TOML config's section is
      // derived from the server id. Recording the registry's key instead made
      // uninstall search for the wrong section and leave the real one behind.
      const writtenKey = cfg.format === 'toml' ? `mcp_servers.${serverId}` : cfg.key;
      wired.push({ harness: d.id, location: loc, path: absPath, key: writtenKey, ...res });
    }
  }

  return {
    detected: selected.map((d) => d.id),
    wired,
    skipped,
    planned: !approved && !dryRun && wired.some((w) => w.status === 'planned'),
  };
}

/**
 * Record what this server wrote, so uninstall removes exactly those entries.
 * @param {string} projectRoot
 * @param {string} serverId
 * @param {Array<{harness: string, location: string, path: string, key: string}>} entries
 */
export function recordWiring(projectRoot, serverId, entries) {
  const p = join(projectRoot, '.archgen', '.mcp-wiring.json');
  let existing = { version: 1, servers: {} };
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.servers) existing = parsed;
  } catch {
    /* absent or corrupt — start fresh */
  }
  existing.servers[serverId] = { writtenAt: new Date().toISOString(), entries };
  try {
    writeFileAtomic(p, JSON.stringify(existing, null, 2) + '\n');
  } catch {
    /* the manifest is a convenience, never a blocker */
  }
}

/**
 * Remove the entries this server wrote (and nothing else).
 * @param {string} projectRoot
 * @param {string} serverId
 * @param {string} [home]
 * @param {'project'|'global'|'both'} [location] which scope to remove
 * @returns {{removed: string[], skipped: string[]}}
 */
export function removeWiring(projectRoot, serverId, home = homedir(), location = 'both') {
  const p = join(projectRoot, '.archgen', '.mcp-wiring.json');
  let manifest = null;
  try {
    manifest = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return { removed: [], skipped: ['no wiring manifest'] };
  }
  const record = manifest?.servers?.[serverId];
  if (!record?.entries?.length) return { removed: [], skipped: ['nothing recorded for this server'] };

  const removed = [];
  const skipped = [];
  for (const entry of record.entries) {
    try {
      const abs = entry.path;
      // The scope is honoured: a request to remove the global wiring leaves
      // the project's wiring in place.
      if (location !== 'both' && entry.location && entry.location !== location) {
        skipped.push(`${abs} (${entry.location} scope)`);
        continue;
      }
      // The manifest is a file ON DISK in the project — repository content.
      // Its paths are therefore untrusted: a clone could ship a manifest
      // naming any file on the machine. A recorded path must resolve inside
      // the project root or the user's home, or it is refused.
      if (!pathIsWithin(abs, projectRoot) && !pathIsWithin(abs, home)) {
        skipped.push(`${abs} (outside the project and home directories)`);
        continue;
      }
      if (!existsSync(abs)) {
        skipped.push(`${entry.path} (absent)`);
        continue;
      }
      if (entry.key?.startsWith('mcp_servers.')) {
        // TOML section removal.
        const raw = readFileSync(abs, 'utf8');
        const header = `[${entry.key}]`;
        const lines = raw.split('\n');
        const start = lines.findIndex((l) => l.trim() === header);
        if (start === -1) {
          skipped.push(`${abs} (section not found)`);
          continue;
        }
        let next = start + 1;
        while (next < lines.length && !/^\s*\[/.test(lines[next])) next++;
        writeFileAtomic(abs, [...lines.slice(0, start), ...lines.slice(next)].join('\n'));
        removed.push(abs);
      } else {
        const { data } = readJsonConfig(abs);
        if (!data || typeof data !== 'object') {
          skipped.push(`${abs} (unreadable)`);
          continue;
        }
        const bucket = data[entry.key];
        if (!bucket || typeof bucket !== 'object' || !(serverId in bucket)) {
          skipped.push(`${abs} (entry not found)`);
          continue;
        }
        delete bucket[serverId];
        writeFileAtomic(abs, JSON.stringify(data, null, 2) + '\n');
        removed.push(abs);
      }
    } catch (e) {
      skipped.push(`${entry.path} (${e.message})`);
    }
  }
  return { removed, skipped };
}


