// Pure URI-coalescing trailing debounce — vscode-free so vitest can exercise
// it directly (watchers.ts wires vscode FileSystemWatcher events into it).
export interface UriLike {
  toString(): string;
}

export interface Debouncer {
  /** Record an event for `uri`; schedules the trailing flush. */
  push(uri: UriLike): void;
  /** True while a trailing flush is pending. */
  readonly pending: boolean;
  dispose(): void;
}

/**
 * Trailing debounce coalescing by URI string: every push within the window
 * restarts the timer; when it finally expires, ALL accumulated URIs flush
 * once as a Set. A multi-fire save burst therefore produces ONE refresh.
 */
export function createUriDebouncer(delayMs: number, flush: (uris: Set<string>) => void): Debouncer {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pendingUris = new Set<string>();
  return {
    push(uri: UriLike): void {
      pendingUris.add(uri.toString());
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        const batch = new Set(pendingUris);
        pendingUris.clear();
        if (batch.size > 0) flush(batch);
      }, delayMs);
    },
    get pending(): boolean {
      return timer !== null;
    },
    dispose(): void {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      pendingUris.clear();
    },
  };
}
