// Watcher pipeline core: URI-coalescing trailing debounce (fake timers) +
// pipeline hygiene (todo 8): watcher-error containment, dispose teardown, and
// multi-root folder-change handling driven through the full activate() seam
// (same vi.mock('vscode') pattern as trust-gate/model-push-perf).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createUriDebouncer } from '../src/host/debounce';

function uri(s: string): { toString(): string } {
  return { toString: () => s };
}

describe('createUriDebouncer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces a burst of writes to ONE flush after 300ms', () => {
    const flushes: Array<Set<string>> = [];
    const d = createUriDebouncer(300, (uris) => flushes.push(uris));
    d.push(uri('file:///ws/.archgen/demo/tasks.yaml'));
    d.push(uri('file:///ws/.archgen/demo/tasks.yaml'));
    d.push(uri('file:///ws/.archgen/demo/tasks.yaml'));
    expect(d.pending).toBe(true);
    vi.advanceTimersByTime(299);
    expect(flushes).toHaveLength(0); // trailing: nothing before the window closes
    vi.advanceTimersByTime(1);
    expect(flushes).toHaveLength(1);
    expect([...flushes[0]!]).toHaveLength(1); // same URI coalesced
    d.dispose();
  });

  it('coalesces by URI: distinct files arrive together in one batch', () => {
    const flushes: Array<Set<string>> = [];
    const d = createUriDebouncer(300, (uris) => flushes.push(uris));
    d.push(uri('file:///ws/.archgen/a/tasks.yaml'));
    d.push(uri('file:///ws/.archgen/a/architecture.yaml'));
    d.push(uri('file:///ws/.codegraph/codegraph.db'));
    vi.advanceTimersByTime(300);
    expect(flushes).toHaveLength(1);
    expect(flushes[0]!.size).toBe(3);
    d.dispose();
  });

  it('a write inside the window RESTARTS the timer (trailing semantics)', () => {
    const flushes: Array<Set<string>> = [];
    const d = createUriDebouncer(300, (uris) => flushes.push(uris));
    d.push(uri('file:///x/1.yaml'));
    vi.advanceTimersByTime(250);
    d.push(uri('file:///x/2.yaml')); // restarts window
    vi.advanceTimersByTime(250);
    expect(flushes).toHaveLength(0);
    vi.advanceTimersByTime(50);
    expect(flushes).toHaveLength(1);
    expect(flushes[0]!.size).toBe(2);
    d.dispose();
  });

  it('rapid bursts separated by >delay produce one flush per burst', () => {
    const flushes: Array<Set<string>> = [];
    const d = createUriDebouncer(300, (uris) => flushes.push(uris));
    for (let i = 0; i < 5; i++) d.push(uri('file:///burst1.yaml'));
    vi.advanceTimersByTime(300);
    for (let i = 0; i < 5; i++) d.push(uri('file:///burst2.yaml'));
    vi.advanceTimersByTime(300);
    expect(flushes).toHaveLength(2);
    d.dispose();
  });

  it('dispose cancels pending flush without firing', () => {
    const flushes: Array<Set<string>> = [];
    const d = createUriDebouncer(300, (uris) => flushes.push(uris));
    d.push(uri('file:///x.yaml'));
    d.dispose();
    vi.advanceTimersByTime(1000);
    expect(flushes).toHaveLength(0);
    expect(d.pending).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// vscode seam for createWatchPipeline + the full activate() folder-change path
// ---------------------------------------------------------------------------

interface FakeWatcher {
  base: { uri: { fsPath: string } };
  pattern: string;
  disposed: boolean;
  dispose(): void;
  onDidChange(cb: (u: unknown) => void): { dispose(): void };
  onDidCreate(cb: (u: unknown) => void): { dispose(): void };
  onDidDelete(cb: (u: unknown) => void): { dispose(): void };
  fire(kind: 'change' | 'create' | 'delete', uri: unknown): void;
}

// vi.hoisted: the mock factories below run during import hoisting, before
// module-level consts exist — shared state must be created in the hoisted
// sandbox and referenced through this handle.
const state = vi.hoisted(() => ({
  folders: undefined as Array<{ uri: { fsPath: string }; name: string; index: number }> | undefined,
  watchers: [] as FakeWatcher[],
  folderListeners: [] as Array<() => void>,
  logLines: [] as string[],
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  lastHubModel: null as import('../src/shared/protocol').ArchgenModelMessage | null,
}));

vi.mock('vscode', () => {
  const disposable = { dispose(): void {} };
  class Disposable {
    constructor(private readonly fn?: () => void) {}
    dispose(): void {
      this.fn?.();
    }
  }
  class EventEmitter<T> {
    event = (_listener: unknown): typeof disposable => disposable;
    fire(_e?: T): void {}
    dispose(): void {}
  }
  class RelativePattern {
    constructor(
      readonly base: unknown,
      readonly pattern: string,
    ) {}
  }
  function makeWatcher(pattern: RelativePattern): FakeWatcher {
    const listeners = {
      change: [] as Array<(u: unknown) => void>,
      create: [] as Array<(u: unknown) => void>,
      delete: [] as Array<(u: unknown) => void>,
    };
    const w: FakeWatcher = {
      base: pattern.base as { uri: { fsPath: string } },
      pattern: pattern.pattern,
      disposed: false,
      dispose(): void {
        w.disposed = true;
      },
      onDidChange(cb): { dispose(): void } {
        listeners.change.push(cb);
        return { dispose(): void {} };
      },
      onDidCreate(cb): { dispose(): void } {
        listeners.create.push(cb);
        return { dispose(): void {} };
      },
      onDidDelete(cb): { dispose(): void } {
        listeners.delete.push(cb);
        return { dispose(): void {} };
      },
      fire(kind, u): void {
        for (const cb of listeners[kind]) cb(u);
      },
    };
    state.watchers.push(w);
    return w;
  }
  return {
    Disposable,
    EventEmitter,
    RelativePattern,
    Range: class {},
    StatusBarAlignment: { Left: 1, Right: 2 },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    TreeItem: class {
      constructor(readonly label?: unknown) {}
    },
    ThemeIcon: class {
      constructor(
        readonly id: string,
        readonly color?: unknown,
      ) {}
    },
    ThemeColor: class {
      constructor(readonly id: string) {}
    },
    MarkdownString: class {
      value: string;
      constructor(value = '') {
        this.value = value;
      }
      appendMarkdown(s: string): this {
        this.value += s;
        return this;
      }
    },
    Uri: {
      file: (p: string): unknown => ({ fsPath: p }),
      joinPath: (...parts: unknown[]): unknown => ({ fsPath: parts.join('/') }),
    },
    ViewColumn: { Active: 1, Beside: 2 },
    window: {
      createOutputChannel: (): object => ({
        appendLine: (line: string): void => {
          state.logLines.push(line);
        },
        dispose(): void {},
      }),
      createStatusBarItem: (): object => ({
        name: '',
        text: '',
        tooltip: '',
        command: '',
        show(): void {},
        hide(): void {},
        dispose(): void {},
      }),
      createTreeView: (): object => ({ badge: undefined, dispose(): void {} }),
      registerWebviewPanelSerializer: (): typeof disposable => disposable,
      onDidChangeWindowState: (): typeof disposable => disposable,
      onDidChangeActiveColorTheme: (): typeof disposable => disposable,
      showInformationMessage: (): Thenable<undefined> => Promise.resolve(undefined),
      showWarningMessage: (): Thenable<undefined> => Promise.resolve(undefined),
      showErrorMessage: (): Thenable<undefined> => Promise.resolve(undefined),
      showInputBox: (): Thenable<undefined> => Promise.resolve(undefined),
    },
    workspace: {
      isTrusted: false,
      get workspaceFolders(): Array<{ uri: { fsPath: string }; name: string; index: number }> | undefined {
        return state.folders;
      },
      getConfiguration: (): object => ({
        get<T>(_section: string, fallback: T): T {
          return fallback;
        },
      }),
      createFileSystemWatcher: (pattern: RelativePattern): FakeWatcher => makeWatcher(pattern),
      onDidChangeWorkspaceFolders: (listener: () => void): { dispose(): void } => {
        state.folderListeners.push(listener);
        return { dispose(): void {} };
      },
    },
    commands: {
      registerCommand: (id: string, cb: (...args: unknown[]) => unknown): typeof disposable => {
        state.handlers.set(id, cb);
        return disposable;
      },
      executeCommand: (): Thenable<undefined> => Promise.resolve(undefined),
    },
    env: {
      clipboard: {
        writeText: (): Thenable<void> => Promise.resolve(),
      },
    },
  };
});

// ModelHub's DEFAULT emitter factory does a CJS require('vscode') that the
// vi.mock registry cannot intercept (same gotcha as trust-gate.test.ts); the
// fake also captures the last fired model so the folder-change re-convergence
// is directly observable.
vi.mock('../src/host/hub', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/hub')>();
  type Model = import('../src/shared/protocol').ArchgenModelMessage;
  class FakeModelHub {
    private latest: Model | null = null;
    private readonly listeners = new Set<(m: Model) => void>();
    fire(m: Model): void {
      this.latest = m;
      state.lastHubModel = m;
      for (const l of [...this.listeners]) l(m);
    }
    snapshot(): Model | null {
      return this.latest;
    }
    get onModel(): (listener: (m: Model) => void) => { dispose(): void } {
      return (listener: (m: Model) => void) => {
        this.listeners.add(listener);
        return { dispose: () => this.listeners.delete(listener) };
      };
    }
    dispose(): void {
      this.listeners.clear();
    }
  }
  return { ...actual, ModelHub: FakeModelHub };
});

import { createWatchPipeline, ROOT_ENTRIES_PATTERN } from '../src/host/watchers';
import { activate } from '../src/host/extension';
import type { ExtensionContext, WorkspaceFolder } from 'vscode';
import type { ArchgenModelMessage } from '../src/shared/protocol';

function folderAt(fsPath: string): WorkspaceFolder {
  return { uri: { fsPath }, name: fsPath, index: 0 } as unknown as WorkspaceFolder;
}

function fileUri(fsPath: string): { fsPath: string; toString(): string } {
  return { fsPath, toString: () => `file://${fsPath}` };
}

function liveWatchers(): FakeWatcher[] {
  return state.watchers.filter((w) => !w.disposed);
}

describe('createWatchPipeline hygiene (todo 8)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.watchers.length = 0;
  });
  afterEach(() => vi.useRealTimers());

  it('wires five watchers and keeps the 300ms trailing debounce + isVisible gating', () => {
    let visible = true;
    const refreshes: Array<Set<string>> = [];
    let setupReevals = 0;
    createWatchPipeline(folderAt('/wsA'), {
      isVisible: () => visible,
      onRefresh: (uris) => refreshes.push(uris),
      onSetupReeval: () => {
        setupReevals += 1;
      },
    });
    expect(state.watchers).toHaveLength(5);
    const archgen = state.watchers.find((w) => w.pattern.startsWith('.archgen/**'));
    expect(archgen).toBeDefined();

    archgen!.fire('change', fileUri('/wsA/.archgen/demo/tasks.yaml'));
    vi.advanceTimersByTime(299);
    expect(refreshes).toHaveLength(0); // trailing: nothing before the window closes
    vi.advanceTimersByTime(1);
    expect(refreshes).toHaveLength(1);
    expect(setupReevals).toBe(1);

    visible = false;
    archgen!.fire('change', fileUri('/wsA/.archgen/demo/architecture.yaml'));
    vi.advanceTimersByTime(300);
    expect(refreshes).toHaveLength(1); // hidden panel: refresh stays gated…
    expect(setupReevals).toBe(2); // …setup re-eval still rides every batch
  });

  it('contains a throwing refresh: logged, never thrown, setup re-eval still runs', () => {
    const logged: string[] = [];
    let setupReevals = 0;
    createWatchPipeline(folderAt('/wsA'), {
      isVisible: () => true,
      onRefresh: (): never => {
        throw new Error('boom-refresh');
      },
      onSetupReeval: () => {
        setupReevals += 1;
      },
      log: (line) => logged.push(line),
    });
    const archgen = state.watchers.find((w) => w.pattern.startsWith('.archgen/**'));

    expect(() => {
      archgen!.fire('change', fileUri('/wsA/.archgen/demo/tasks.yaml'));
      vi.advanceTimersByTime(300); // an uncontained throw would escape right here
    }).not.toThrow();

    expect(setupReevals).toBe(1); // guarded separately from the refresh
    expect(logged.some((l) => l.includes('[watch]') && l.includes('boom-refresh'))).toBe(true);
  });

  it('contains a throwing onRootEvent without dropping the debounced convergence path', () => {
    const logged: string[] = [];
    let setupReevals = 0;
    const refreshes: Array<Set<string>> = [];
    createWatchPipeline(folderAt('/wsA'), {
      isVisible: () => true,
      onRefresh: (uris) => refreshes.push(uris),
      onSetupReeval: () => {
        setupReevals += 1;
      },
      onRootEvent: (): never => {
        throw new Error('boom-root');
      },
      log: (line) => logged.push(line),
    });
    const rootEntries = state.watchers.find((w) => w.pattern === ROOT_ENTRIES_PATTERN);
    expect(rootEntries).toBeDefined();

    expect(() => {
      rootEntries!.fire('create', fileUri('/wsA/.archgen'));
      vi.advanceTimersByTime(300);
    }).not.toThrow();

    expect(logged.some((l) => l.includes('[watch]') && l.includes('boom-root'))).toBe(true);
    expect(setupReevals).toBe(1); // debouncer.push survived the onRootEvent throw
    expect(refreshes).toHaveLength(1);
  });

  it('dispose tears down every watcher and cancels the pending flush', () => {
    let refreshes = 0;
    const pipeline = createWatchPipeline(folderAt('/wsA'), {
      isVisible: () => true,
      onRefresh: () => {
        refreshes += 1;
      },
    });
    expect(state.watchers).toHaveLength(5);
    state.watchers.find((w) => w.pattern.startsWith('.archgen/**'))!.fire('change', fileUri('/wsA/.archgen/x.yaml'));
    expect(pipeline.debouncer.pending).toBe(true);

    pipeline.dispose();

    expect(state.watchers.every((w) => w.disposed)).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(refreshes).toBe(0);
  });
});

describe('workspace folder change — pipeline tear-down/re-create (todo 8)', () => {
  const dirs: string[] = [];
  function scratch(): string {
    const d = mkdtempSync(join(tmpdir(), 'archgen-watch-'));
    dirs.push(d);
    return d;
  }
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  function makeContext(): ExtensionContext {
    const store = new Map<string, unknown>();
    return {
      subscriptions: [],
      extensionUri: { fsPath: '/ext' },
      extension: { packageJSON: { version: '0.0.4' } },
      workspaceState: {
        get<T>(key: string, fallback?: T): T | undefined {
          return store.has(key) ? (store.get(key) as T) : fallback;
        },
        update(key: string, value: unknown): Thenable<void> {
          store.set(key, value);
          return Promise.resolve();
        },
      },
    } as unknown as ExtensionContext;
  }

  function setFolders(...paths: string[]): void {
    state.folders = paths.map((p, i) => ({ uri: { fsPath: p }, name: `root${i}`, index: i }));
  }

  function fireFoldersChanged(): void {
    for (const l of [...state.folderListeners]) l();
  }

  beforeEach(() => {
    state.folders = undefined;
    state.watchers.length = 0;
    state.folderListeners.length = 0;
    state.logLines.length = 0;
    state.handlers.clear();
    state.lastHubModel = null;
  });

  it('folder change tears down the old pipeline and re-creates it for the new root — subscriptions stay bounded', () => {
    const wsA = scratch();
    const wsB = scratch();
    setFolders(wsA);
    const ctx = makeContext();
    activate(ctx);

    expect(state.folderListeners).toHaveLength(1); // registered exactly once
    expect(liveWatchers()).toHaveLength(5); // one pipeline for root A
    expect(liveWatchers().every((w) => w.base.uri.fsPath === wsA)).toBe(true);
    const subscriptionsAfterActivate = ctx.subscriptions.length;

    setFolders(wsB);
    fireFoldersChanged();

    expect(liveWatchers()).toHaveLength(5); // exactly ONE live pipeline…
    expect(liveWatchers().every((w) => w.base.uri.fsPath === wsB)).toBe(true); // …watching root B
    expect(state.watchers.filter((w) => w.disposed)).toHaveLength(5); // root A's fully torn down
    expect(ctx.subscriptions.length).toBe(subscriptionsAfterActivate); // no disposable leak
  });

  it('removing the last folder tears the pipeline down and re-creates nothing', () => {
    setFolders(scratch());
    const ctx = makeContext();
    activate(ctx);
    const subscriptionsAfterActivate = ctx.subscriptions.length;
    expect(liveWatchers()).toHaveLength(5);

    state.folders = undefined;
    fireFoldersChanged();

    expect(liveWatchers()).toHaveLength(0);
    expect(state.watchers).toHaveLength(5); // nothing new created
    expect(ctx.subscriptions.length).toBe(subscriptionsAfterActivate);
  });

  it('repeated root swaps keep exactly one live pipeline; disposing subscriptions disposes the current one', () => {
    setFolders(scratch());
    const ctx = makeContext();
    activate(ctx);
    const baseline = ctx.subscriptions.length;

    for (let i = 0; i < 3; i++) {
      setFolders(scratch());
      fireFoldersChanged();
    }

    expect(ctx.subscriptions.length).toBe(baseline); // bounded across N swaps
    expect(liveWatchers()).toHaveLength(5);
    expect(state.watchers).toHaveLength(20); // 5 initial + 3 swaps × 5

    // Deactivation path: the single holder disposable disposes the CURRENT pipeline.
    for (const d of ctx.subscriptions) (d as { dispose?: () => void }).dispose?.();
    expect(liveWatchers()).toHaveLength(0);
  });

  it('re-converges the model for the new root immediately after the swap', () => {
    const wsA = scratch(); // empty — no plan
    const wsB = scratch();
    mkdirSync(join(wsB, '.archgen', 'demo'), { recursive: true });
    writeFileSync(
      join(wsB, '.archgen', 'demo', 'tasks.yaml'),
      ['tasks:', '  - id: T1', '    title: Demo task', '    status: pending', '    depends_on: []', '    file_ownership:', '      - "src/**"', ''].join('\n'),
    );
    setFolders(wsA);
    activate(makeContext());
    expect(state.lastHubModel?.tasks).toHaveLength(0);

    setFolders(wsB);
    fireFoldersChanged();

    const model = state.lastHubModel as ArchgenModelMessage;
    expect(model.tasks.map((t) => t.id)).toEqual(['T1']);
    expect(model.activeSlug).toBe('demo');
  });
});
