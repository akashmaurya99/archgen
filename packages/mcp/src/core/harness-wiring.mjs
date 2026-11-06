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
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assertNotSymlink, assertWithinRoot, writeFileAtomic } from './fs-safety.mjs';
 './errors.mjs';

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
export function buildEntry(entries, npxEntries, entryKey, binPath, fallbackCommand) {
  const source = binPath ? entries[entryKey] : (npxEntries?.[entryKey] ?? entries[entryKey]);
  const entry = JSON.parse(JSON.stringify(source));
  const command = binPath ?? fallbackCommand;
  if (Array.isArray(entry.command)) entry.command = [command, ...entry.command.slice(1)];
  else entry.command = command;
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
  } = opts;

  const detected = detectHarnesses(registry, projectRoot, home);
  const wantedLocations = location === 'both' ? ['global', 'project'] : [location];
  const wired = [];
  const skipped = [];

  for (const d of detected) {
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
      wired.push({ harness: d.id, location: loc, path: absPath, key: cfg.key ?? `mcp_servers.${serverId}`, ...res });
    }
  }

  return {
    detected: detected.map((d) => d.id),
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
 * @returns {{removed: string[], skipped: string[]}}
 */
export function removeWiring(projectRoot, serverId, home = homedir()) {
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


