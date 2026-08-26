// Model-push perf tests (todo 6): the codegraph slice is gated by DB stat
// (mtimeMs+size), NOT re-read per push. Same stat → openCodegraph runs once
// and the SAME slice object rides every subsequent model (which is what lets
// panel.post skip the multi-MB JSON.stringify via its identity-cached digest);
// an mtime/size bump re-reads the index and the fresh codegraph reaches the
// webview. Drives the FULL activate() through the trust-gate vi.mock('vscode')
// seam plus a mocked codegraph module (controllable stat + snapshot seams).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type CgNode = { id: string; label: string; kind: string; file: string; line: number };
type CgEdge = { source: string; target: string; kind: string };

// vi.hoisted: mock factories run during import hoisting, before module-level
// consts exist — fixtures AND shared state live in ONE hoisted sandbox (two
// sibling vi.hoisted blocks would hit each other's TDZ) and are referenced
// through these handles.
const hoisted = vi.hoisted(() => {
  const NODES_A = [
    { id: 'n0', label: 'alpha', kind: 'function', file: 'a.ts', line: 1 },
    { id: 'n1', label: 'beta', kind: 'function', file: 'b.ts', line: 2 },
  ];
  const EDGES_A = [{ source: 'n0', target: 'n1', kind: 'calls' }];
  const NODES_B = [...NODES_A, { id: 'n2', label: 'gamma', kind: 'class', file: 'c.ts', line: 3 }];
  const state = {
    workspaceRoot: null as string | null,
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
    sent: [] as import('../src/shared/protocol').HostToWebview[],
    onWebviewMessage: null as ((msg: Record<string, unknown>) => void) | null,
    onViewStateChange: null as ((e: { webviewPanel: { visible: boolean } }) => void) | null,
    disposeCallbacks: [] as Array<() => void>,
    // Controllable codegraph seams.
    detectedDbPath: null as string | null,
    dbStat: { exists: true, size: 100, mtimeMs: 1 },
    openThrows: false,
    snapshotNodes: NODES_A,
    snapshotEdges: EDGES_A,
  };
  return { state, NODES_A, EDGES_A, NODES_B };
});
const state = hoisted.state;
const { NODES_A, EDGES_A, NODES_B } = hoisted;

vi.mock('vscode', () => {
  const disposable = { dispose(): void {} };
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
  const makeWatcher = (): object => ({
    onDidChange: () => disposable,
    onDidCreate: () => disposable,
    onDidDelete: () => disposable,
    dispose(): void {},
  });
  const fakePanel = {
    webview: {
      html: '',
      cspSource: '',
      asWebviewUri(u: unknown): unknown {
        return u;
      },
      postMessage(msg: unknown): Thenable<boolean> {
        state.sent.push(msg as import('../src/shared/protocol').HostToWebview);
        return Promise.resolve(true);
      },
      onDidReceiveMessage(cb: (msg: Record<string, unknown>) => void, ..._rest: unknown[]): { dispose(): void } {
        state.onWebviewMessage = cb;
        return disposable;
      },
    },
    visible: true,
    reveal(): void {},
    onDidDispose(cb: () => void, ..._rest: unknown[]): { dispose(): void } {
      state.disposeCallbacks.push(cb);
      return disposable;
    },
    onDidChangeViewState(cb: (e: { webviewPanel: { visible: boolean } }) => void, ..._rest: unknown[]): { dispose(): void } {
      state.onViewStateChange = cb;
      return disposable;
    },
  };
  return {
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
      createOutputChannel: (): object => ({ appendLine: () => {}, dispose(): void {} }),
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
      createWebviewPanel(): typeof fakePanel {
        return fakePanel;
      },
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
      get workspaceFolders(): Array<{ uri: { fsPath: string } }> | undefined {
        return state.workspaceRoot === null ? undefined : [{ uri: { fsPath: state.workspaceRoot } }];
      },
      getConfiguration: (): object => ({
        get<T>(_section: string, fallback: T): T {
          return fallback;
        },
      }),
      createFileSystemWatcher: (): object => makeWatcher(),
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

// Controllable codegraph seams: detectCodegraph/codegraphDbStat are plain
// functions over hoisted state; openCodegraph is a spy so "re-read count" is
// directly observable.
vi.mock('../src/host/codegraph', () => ({
  detectCodegraph: (_workspaceRoot: string): { product: string; dbPath: string | null; reason?: string } =>
    state.detectedDbPath === null
      ? { product: 'unsupported', dbPath: null, reason: 'No .codegraph/ index found in this workspace.' }
      : { product: 'colby', dbPath: state.detectedDbPath },
  codegraphDbStat: (_dbPath: string): { exists: boolean; size: number; mtimeMs: number } => ({ ...state.dbStat }),
  openCodegraph: vi.fn((_workspaceRoot: string) => {
    if (state.detectedDbPath === null || state.openThrows) {
      throw new Error('codegraph index not found');
    }
    return {
      reader: {
        product: 'colby' as const,
        snapshot: (): { nodes: CgNode[]; edges: CgEdge[]; hasFts: boolean } => ({
          nodes: state.snapshotNodes,
          edges: state.snapshotEdges,
          hasFts: false,
        }),
        fileRollup: (): never => {
          throw new Error('rollup unavailable in this test');
        },
        topHubs: (): never => {
          throw new Error('hubs unavailable in this test');
        },
        close: (): void => {},
      },
      detected: { product: 'colby', dbPath: state.detectedDbPath },
    };
  }),
}));

// ModelHub's DEFAULT emitter factory does a CJS require('vscode') that the
// vi.mock registry cannot intercept (same gotcha as trust-gate.test.ts).
vi.mock('../src/host/hub', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/hub')>();
  type Model = import('../src/shared/protocol').ArchgenModelMessage;
  class FakeModelHub {
    private latest: Model | null = null;
    private readonly listeners = new Set<(m: Model) => void>();
    fire(m: Model): void {
      this.latest = m;
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

import { activate } from '../src/host/extension';
import { openCodegraph } from '../src/host/codegraph';
import type { ExtensionContext } from 'vscode';
import type { ArchgenModelMessage } from '../src/shared/protocol';

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'archgen-pushperf-'));
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

/** Workspace with a one-task plan so buildScopedModel yields real tasks. */
function scratchWithPlan(): string {
  const ws = scratch();
  mkdirSync(join(ws, '.archgen', 'demo'), { recursive: true });
  writeFileSync(
    join(ws, '.archgen', 'demo', 'tasks.yaml'),
    ['tasks:', '  - id: T1', '    title: Demo task', '    status: pending', '    depends_on: []', '    file_ownership:', '      - "src/**"', ''].join('\n'),
  );
  return ws;
}

/** activate() with a detected local index, then open the board panel. */
function activateWithPanel(): string {
  const ws = scratchWithPlan();
  state.workspaceRoot = ws;
  state.detectedDbPath = join(ws, '.codegraph', 'codegraph.db');
  activate(makeContext());
  state.handlers.get('archgen.openPanel')?.();
  return ws;
}

function ready(): void {
  if (!state.onWebviewMessage) throw new Error('webview message handler was never registered');
  state.onWebviewMessage({ type: 'ready' });
}

function visibleTransition(): void {
  if (!state.onViewStateChange) throw new Error('view-state handler was never registered');
  state.onViewStateChange({ webviewPanel: { visible: true } });
}

function postedModels(): ArchgenModelMessage[] {
  return state.sent.filter((m): m is ArchgenModelMessage => m.type === 'model');
}

beforeEach(() => {
  state.workspaceRoot = null;
  state.handlers.clear();
  state.sent.length = 0;
  state.onWebviewMessage = null;
  state.onViewStateChange = null;
  state.disposeCallbacks.length = 0;
  state.detectedDbPath = null;
  state.dbStat = { exists: true, size: 100, mtimeMs: 1 };
  state.openThrows = false;
  state.snapshotNodes = NODES_A;
  state.snapshotEdges = EDGES_A;
  vi.mocked(openCodegraph).mockClear();
});

afterEach(() => {
  // Dispose the panel singleton so every test starts with a fresh board.
  for (const d of state.disposeCallbacks.splice(0)) d();
});

describe('codegraph DB-stat gate on pushModel (todo 6)', () => {
  it('same DB stat across pushes: openCodegraph runs ONCE and the same slice object is reused', () => {
    activateWithPanel();
    ready();

    expect(openCodegraph).toHaveBeenCalledTimes(1);
    expect(postedModels()).toHaveLength(1);
    const first = postedModels()[0] as ArchgenModelMessage;
    expect(first.codegraph.product).toBe('colby');
    expect(first.codegraph.nodes).toEqual(NODES_A);
    expect(first.tasks.map((t) => t.id)).toEqual(['T1']);

    // Hidden→visible transition re-pushes (forced), but the stat is unchanged:
    // zero re-snapshot work and the IDENTICAL slice object rides the post —
    // the identity panel.post digests to skip the multi-MB JSON.stringify.
    visibleTransition();
    expect(openCodegraph).toHaveBeenCalledTimes(1);
    const models = postedModels();
    expect(models).toHaveLength(2);
    expect(models[1]?.codegraph).toBe(first.codegraph);
  });

  it('DB mtime+size bump: next push re-reads the index and posts the fresh codegraph', () => {
    activateWithPanel();
    ready();
    const first = postedModels()[0] as ArchgenModelMessage;

    state.dbStat = { exists: true, size: 140, mtimeMs: 2 };
    state.snapshotNodes = NODES_B;
    visibleTransition();

    expect(openCodegraph).toHaveBeenCalledTimes(2);
    const models = postedModels();
    expect(models).toHaveLength(2);
    const second = models[1] as ArchgenModelMessage;
    expect(second.codegraph).not.toBe(first.codegraph);
    expect(second.codegraph.nodes).toEqual(NODES_B);
    // Single model message — codegraph still rides inside it, never split.
    expect(second.type).toBe('model');
    expect(second.tasks.map((t) => t.id)).toEqual(['T1']);
  });

  it('a failed re-read clears the cache (no stale slice) and recovers on the next push', () => {
    activateWithPanel();
    ready();
    expect(postedModels()[0]?.codegraph.product).toBe('colby');

    // DB moved AND the read now fails → unsupported banner, cache dropped.
    state.dbStat = { exists: true, size: 200, mtimeMs: 3 };
    state.openThrows = true;
    visibleTransition();
    const failed = postedModels().at(-1) as ArchgenModelMessage;
    expect(failed.codegraph.product).toBe('unsupported');

    // Same stat, reader recovered: must re-read (the stale slice is gone)…
    state.openThrows = false;
    visibleTransition();
    expect(openCodegraph).toHaveBeenCalledTimes(3);
    expect(postedModels().at(-1)?.codegraph.product).toBe('colby');
    // …and then reuse again on the following unchanged-stat push.
    visibleTransition();
    expect(openCodegraph).toHaveBeenCalledTimes(3);
  });

  it('no detected index: unsupported banner without touching the stat gate', () => {
    const ws = scratchWithPlan();
    state.workspaceRoot = ws;
    state.detectedDbPath = null; // detectCodegraph → unsupported
    activate(makeContext());
    state.handlers.get('archgen.openPanel')?.();
    ready();

    // Once for the activation prime, once for the ready push — a failed read
    // is never cached, so each push retries the (cheap) open attempt until an
    // index appears. The stat gate itself never engages (dbPath is null).
    expect(openCodegraph).toHaveBeenCalledTimes(2);
    const model = postedModels()[0] as ArchgenModelMessage;
    expect(model.codegraph.product).toBe('unsupported');
    expect(model.codegraph.unsupportedReason).toContain('codegraph index not found');
  });
});
