// watchers.ts — live watch pipeline (todo 6).
//
// FileSystemWatcher on `.archgen/**/*.{yaml,yml,md}` + `.codegraph/**`;
// events coalesce into a Set<uri> behind a 300ms TRAILING debounce (pure core
// in debounce.ts) so a multi-fire save burst produces exactly ONE refresh;
// hidden panels skip refreshes and catch up via onDidChangeViewState.
import { Disposable, FileSystemWatcher, RelativePattern, Uri, WorkspaceFolder, workspace } from 'vscode';
import { createUriDebouncer, type Debouncer } from './debounce';

export const DEBOUNCE_MS = 300;

export type { Debouncer };

export interface WatchPipelineOptions {
  /** Should refreshes happen right now? (panel visible?) */
  isVisible: () => boolean;
  /** Called when the panel becomes visible again and missed changes exist. */
  onCatchUp: () => void;
  /** Debounced refresh with the coalesced URIs. */
  onRefresh: (changedUris: Set<string>) => void;
}

export interface WatchPipeline extends Disposable {
  readonly debouncer: Debouncer;
}

/** Wire the two FileSystemWatchers + visibility gating. */
export function createWatchPipeline(folder: WorkspaceFolder, opts: WatchPipelineOptions): WatchPipeline {
  const disposables: Disposable[] = [];
  let missedWhileHidden = false;

  const debouncer = createUriDebouncer(DEBOUNCE_MS, (uris) => {
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

  for (const w of [archgenWatcher, codegraphWatcher]) {
    disposables.push(w.onDidChange((u: Uri) => debouncer.push(u)));
    disposables.push(w.onDidCreate((u: Uri) => debouncer.push(u)));
    disposables.push(w.onDidDelete((u: Uri) => debouncer.push(u)));
    disposables.push(w);
  }

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
