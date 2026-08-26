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

/**
 * ONE trailing follow-up: every trigger (re)starts the window, so a burst of
 * events yields exactly one fn() call ~delayMs after the LAST trigger. This is
 * the scaffold-race absorber — files written milliseconds after `mkdir -p`
 * chains land inside the window and are still seen by the single re-probe.
 */
export interface SingleFollowup {
  trigger(): void;
  dispose(): void;
}

export function createSingleFollowup(delayMs: number, fn: () => void): SingleFollowup {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    trigger(): void {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn();
      }, delayMs);
    },
    dispose(): void {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

/**
 * Leading-edge throttle: fn runs at most once per minIntervalMs; calls inside
 * the window are dropped (not queued). The focus-reconcile safety net uses it
 * so alt-tab bursts cannot hammer the filesystem probe.
 */
export interface Throttle {
  run(): void;
  dispose(): void;
}

export function createThrottle(minIntervalMs: number, fn: () => void): Throttle {
  let lastRun = Number.NEGATIVE_INFINITY;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    run(): void {
      if (timer !== null) return;
      const elapsed = Date.now() - lastRun;
      if (elapsed >= minIntervalMs) {
        lastRun = Date.now();
        fn();
        return;
      }
      timer = setTimeout(() => {
        timer = null;
        lastRun = Date.now();
        fn();
      }, minIntervalMs - elapsed);
    },
    dispose(): void {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
