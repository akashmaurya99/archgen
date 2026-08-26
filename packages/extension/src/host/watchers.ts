// watchers.ts — live watch pipeline (todo 6).
//
// FileSystemWatcher on `.archgen/**/*.{yaml,yml,md}` + `.codegraph/**` +
// the installed-skill trees (`.agents/skills/archgen/**`,
// `.claude/skills/archgen/**` best-effort); events coalesce into a Set<uri>
// behind a 300ms TRAILING debounce (pure core in debounce.ts) so a multi-fire
// save burst produces exactly ONE refresh; hidden panels skip refreshes and
// catch up via onDidChangeViewState. Setup re-evaluation rides the SAME
// coalesced flush but IGNORES visibility — the status item must stay live
// even with no panel open.
//
// ROOT-ENTRY WATCHERS (dropped-event race): deep globs like
// `.agents/skills/archgen/**` are created BEFORE their directories exist —
// activation runs via onStartupFinished even in empty workspaces — and VS
// Code's watcher service only re-parents into newly-created directories while
// events for files written milliseconds after `mkdir -p` chains are routinely
// dropped entirely. So `npx archgen-skill init` in an external terminal could
// leave every panel stale until reload. Watching the three TOP-LEVEL entries
// (`.archgen`, `.agents`, `.claude`) always works because their parent — the
// workspace root — exists when the watcher is created; creation/deletion of
// those entries ALWAYS fires. The host answers each root event with an
// immediate direct filesystem re-probe plus one trailing follow-up, so no
// deeper watch event ever needs to be delivered for setup truth to converge.
import { Disposable, FileSystemWatcher, RelativePattern, Uri, WorkspaceFolder, workspace } from 'vscode';
import { createUriDebouncer, type Debouncer } from './debounce';

export const DEBOUNCE_MS = 300;

/** Brace alternation of the three scaffold roots `npx archgen-skill init` creates. */
export const ROOT_ENTRIES_PATTERN = '{.archgen,.agents,.claude}';

export type { Debouncer };

export interface WatchPipelineOptions {
  /** Should refreshes happen right now? (panel visible?) */
  isVisible: () => boolean;
  /** Debounced refresh with the coalesced URIs. */
  onRefresh: (changedUris: Set<string>) => void;
  /** Debounced setup re-evaluation — fires on EVERY coalesced batch, visible or not. */
  onSetupReeval?: () => void;
  /**
   * A scaffold root (.archgen|.agents|.claude) was created or deleted at the
   * workspace root. Fires IMMEDIATELY (not debounced) so the host can re-probe
   * the filesystem directly instead of trusting deeper watch events.
   */
  onRootEvent?: (entry: string) => void;
  /**
   * Diagnostic sink for watcher errors (host OutputChannel). Defaults to
   * console.error. Errors are LOGGED, never rethrown — a throw escaping into
   * VS Code's event emitter would crash the extension host (todo 8).
   */
  log?: (line: string) => void;
}

export interface WatchPipeline extends Disposable {
  readonly debouncer: Debouncer;
}

function entryName(uri: Uri): string {
  const parts = uri.fsPath.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

/** Wire the five FileSystemWatchers + visibility gating. */
export function createWatchPipeline(folder: WorkspaceFolder, opts: WatchPipelineOptions): WatchPipeline {
  const disposables: Disposable[] = [];
  const log = opts.log ?? ((line: string) => console.error(line));

  // ERROR CONTAINMENT (todo 8): these callbacks run inside VS Code's event
  // emitter and inside setTimeout — a throw escaping either would crash the
  // extension host. Contain every failure to a log line; the pipeline stays
  // alive and the next event still converges truth.
  function guard(what: string, fn: () => void): void {
    try {
      fn();
    } catch (e) {
      log(`[watch] ${what} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const debouncer = createUriDebouncer(DEBOUNCE_MS, (uris) => {
    // Setup truth must resolve even while every panel is hidden: a skill
    // install landing on disk flips the status item without any board open.
    // Guarded SEPARATELY from the refresh so a failing refresh cannot starve
    // the setup re-evaluation (and vice versa).
    guard('setup re-evaluation', () => opts.onSetupReeval?.());
    // Hidden panels skip refreshes; becoming visible again force-pushes the
    // fresh model through the panel's onDidChangeViewState → onVisible hook
    // (extension.ts wires it to pushModel(true)), so no catch-up state is
    // tracked here.
    guard('refresh', () => {
      if (!opts.isVisible()) return;
      opts.onRefresh(uris);
    });
  });
  disposables.push(debouncer);

  // A symlinked `.archgen` root needs no special casing: RelativePattern
  // globs and the readers' readdirSync/statSync all resolve symlinks during
  // path traversal (features.ts Dirent.isDirectory then applies to the
  // entries INSIDE the resolved directory).
  const archgenWatcher: FileSystemWatcher = workspace.createFileSystemWatcher(
    new RelativePattern(folder, '.archgen/**/*.{yaml,yml,md}'),
  );
  const codegraphWatcher: FileSystemWatcher = workspace.createFileSystemWatcher(
    new RelativePattern(folder, '.codegraph/**'),
  );
  const skillWatcher: FileSystemWatcher = workspace.createFileSystemWatcher(
    new RelativePattern(folder, '.agents/skills/archgen/**'),
  );
  const skillClaudeWatcher: FileSystemWatcher = workspace.createFileSystemWatcher(
    new RelativePattern(folder, '.claude/skills/archgen/**'),
  );
  const rootEntriesWatcher: FileSystemWatcher = workspace.createFileSystemWatcher(
    new RelativePattern(folder, ROOT_ENTRIES_PATTERN),
  );

  for (const w of [archgenWatcher, codegraphWatcher, skillWatcher, skillClaudeWatcher]) {
    const push = (u: Uri): void => guard('watcher event', () => debouncer.push(u));
    disposables.push(w.onDidChange(push));
    disposables.push(w.onDidCreate(push));
    disposables.push(w.onDidDelete(push));
    disposables.push(w);
  }

  // Root events ride BOTH channels: immediate onRootEvent (direct re-probe,
  // immune to dropped descendant events) AND the coalescing debouncer (so a
  // plan appearing under a fresh .archgen/ still reaches the board model).
  // Guarded separately: a failing onRootEvent must not drop the debounced
  // convergence path.
  disposables.push(
    rootEntriesWatcher.onDidCreate((u: Uri) => {
      guard('root event', () => opts.onRootEvent?.(entryName(u)));
      guard('root debounce', () => debouncer.push(u));
    }),
    rootEntriesWatcher.onDidDelete((u: Uri) => {
      guard('root event', () => opts.onRootEvent?.(entryName(u)));
      guard('root debounce', () => debouncer.push(u));
    }),
    rootEntriesWatcher.onDidChange((u: Uri) => guard('watcher event', () => debouncer.push(u))),
    rootEntriesWatcher,
  );

  return { debouncer, dispose: () => { for (const d of disposables.splice(0)) d.dispose(); } };
}
