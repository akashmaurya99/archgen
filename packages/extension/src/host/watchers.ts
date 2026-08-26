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
  /** Called when the panel becomes visible again and missed changes exist. */
  onCatchUp: () => void;
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
}

export interface WatchPipeline extends Disposable {
  readonly debouncer: Debouncer;
}

function entryName(uri: Uri): string {
  const parts = uri.fsPath.split(/[\\/]/);
  return parts[parts.length - 1] ?? '';
}

/** Wire the four FileSystemWatchers + visibility gating. */
export function createWatchPipeline(folder: WorkspaceFolder, opts: WatchPipelineOptions): WatchPipeline {
  const disposables: Disposable[] = [];
  let missedWhileHidden = false;

  const debouncer = createUriDebouncer(DEBOUNCE_MS, (uris) => {
    // Setup truth must resolve even while every panel is hidden: a skill
    // install landing on disk flips the status item without any board open.
    opts.onSetupReeval?.();
    if (!opts.isVisible()) {
      missedWhileHidden = true;
      return;
    }
    opts.onRefresh(uris);
  });

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
    disposables.push(w.onDidChange((u: Uri) => debouncer.push(u)));
    disposables.push(w.onDidCreate((u: Uri) => debouncer.push(u)));
    disposables.push(w.onDidDelete((u: Uri) => debouncer.push(u)));
    disposables.push(w);
  }

  // Root events ride BOTH channels: immediate onRootEvent (direct re-probe,
  // immune to dropped descendant events) AND the coalescing debouncer (so a
  // plan appearing under a fresh .archgen/ still reaches the board model).
  disposables.push(
    rootEntriesWatcher.onDidCreate((u: Uri) => {
      opts.onRootEvent?.(entryName(u));
      debouncer.push(u);
    }),
    rootEntriesWatcher.onDidDelete((u: Uri) => {
      opts.onRootEvent?.(entryName(u));
      debouncer.push(u);
    }),
    rootEntriesWatcher.onDidChange((u: Uri) => debouncer.push(u)),
    rootEntriesWatcher,
  );

  // Hidden panels skip refreshes; becoming visible again triggers one full catch-up.
  const visibilityGate = {
    onVisible(): void {
      if (missedWhileHidden) {
        missedWhileHidden = false;
        opts.onCatchUp();
      }
    },
    dispose(): void {
      debouncer.dispose();
    },
  };
  disposables.push(visibilityGate);
  return { debouncer, dispose: () => { for (const d of disposables.splice(0)) d.dispose(); } };
}
