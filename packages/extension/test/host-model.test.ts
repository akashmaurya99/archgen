// host-model.test.ts — host-side model pushes through the full activate().
//
// Covers the host contract the webview depends on:
//   - the model carries the ACTUAL VS Code theme (M1),
//   - a status-only change ships a DIFF, not a full snapshot (M2),
//   - a rejected workspaceState write is surfaced, never swallowed (L4),
//   - the bridge `focus` action targets the requested view (L10).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({
  workspaceRoot: null as string | null,
  themeKind: 1,
  sent: [] as import('../src/shared/protocol').HostToWebview[],
  onWebviewMessage: null as ((msg: Record<string, unknown>) => void) | null,
  onViewStateChange: null as ((e: { webviewPanel: { visible: boolean } }) => void) | null,
  disposeCallbacks: [] as Array<() => void>,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  watchers: [] as Array<{ pattern: string; listeners: Record<string, Array<(u: unknown) => void>> }>,
  errors: [] as string[],
  logs: [] as string[],
  updateReject: false,
  updates: [] as Array<[string, unknown]>,
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
  function makeWatcher(pattern: RelativePattern) {
    const listeners: Record<string, Array<(u: unknown) => void>> = { change: [], create: [], delete: [] };
    const entry = { pattern: pattern.pattern, listeners };
    state.watchers.push(entry);
    return {
      onDidChange(cb: (u: unknown) => void) {
        listeners.change!.push(cb);
        return disposable;
      },
      onDidCreate(cb: (u: unknown) => void) {
        listeners.create!.push(cb);
        return disposable;
      },
      onDidDelete(cb: (u: unknown) => void) {
        listeners.delete!.push(cb);
        return disposable;
      },
      dispose(): void {},
    };
  }
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
      constructor(
        readonly id: string,
        readonly color?: unknown,
      ) {}
    },
    MarkdownString: class {
      value: string;
      constructor(value = '') {
        this.value = value;
      }
      appendMarkdown(v: string): this {
        this.value += v;
        return this;
      }
    },
    Uri: {
      file: (p: string): unknown => ({ fsPath: p }),
      joinPath: (...parts: unknown[]): unknown => ({ fsPath: parts.join('/') }),
      parse: (u: unknown): { fsPath: string } => {
        const raw = typeof u === 'string' ? u : String((u as { fsPath: string }).fsPath);
        return { fsPath: raw.startsWith('file://') ? decodeURIComponent(raw.slice('file://'.length)) : raw };
      },
    },
    ViewColumn: { Active: 1, Beside: 2 },
    window: {
      get activeColorTheme(): { kind: number } {
        return { kind: state.themeKind };
      },
      createOutputChannel: (): object => ({
        appendLine: (line: string): void => {
          state.logs.push(line);
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
      createWebviewPanel(): typeof fakePanel {
        return fakePanel;
      },
      registerWebviewPanelSerializer: (): typeof disposable => disposable,
      onDidChangeWindowState: (): typeof disposable => disposable,
      onDidChangeActiveColorTheme: (): typeof disposable => disposable,
      showInformationMessage: (): Thenable<undefined> => Promise.resolve(undefined),
      showWarningMessage: (): Thenable<undefined> => Promise.resolve(undefined),
      showErrorMessage: (msg: string): Thenable<undefined> => {
        state.errors.push(msg);
        return Promise.resolve(undefined);
      },
      showInputBox: (): Thenable<undefined> => Promise.resolve(undefined),
    },
    workspace: {
      isTrusted: true,
      get workspaceFolders(): Array<{ uri: { fsPath: string } }> | undefined {
        return state.workspaceRoot === null ? undefined : [{ uri: { fsPath: state.workspaceRoot } }];
      },
      getConfiguration: (): object => ({
        get<T>(_section: string, fallback: T): T {
          return fallback;
        },
      }),
      createFileSystemWatcher: (pattern: RelativePattern) => makeWatcher(pattern),
      onDidChangeWorkspaceFolders: (): typeof disposable => disposable,
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
// vi.mock registry cannot intercept — swap in a fake that records the model.
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
import type { ExtensionContext } from 'vscode';
import type { ArchgenModelMessage, HostToWebview } from '../src/shared/protocol';

const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'archgen-hostmodel-'));
  dirs.push(dir);
  return dir;
}

/** Workspace with a one-task plan. */
function workspaceWithPlan(status = 'pending'): string {
  const ws = scratch();
  mkdirSync(join(ws, '.archgen', 'demo'), { recursive: true });
  writeTasks(ws, status);
  return ws;
}

function writeTasks(ws: string, status: string): void {
  writeFileSync(
    join(ws, '.archgen', 'demo', 'tasks.yaml'),
    [
      'tasks:',
      '  - id: T1',
      '    title: Demo task',
      `    status: ${status}`,
      '    depends_on: []',
      '    file_ownership:',
      '      - "src/**"',
      '',
    ].join('\n'),
    'utf8',
  );
}

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
        state.updates.push([key, value]);
        if (state.updateReject) return Promise.reject(new Error('storage offline'));
        store.set(key, value);
        return Promise.resolve();
      },
    },
  } as unknown as ExtensionContext;
}

function postedModels(): ArchgenModelMessage[] {
  return state.sent.filter((m): m is ArchgenModelMessage => m.type === 'model');
}

function ready(): void {
  if (!state.onWebviewMessage) throw new Error('webview message handler was never registered');
  state.onWebviewMessage({ type: 'ready' });
}

function openBoard(): void {
  state.handlers.get('archgen.openPanel')?.();
}

/** Fire a watcher event for the given pattern. */
function fireWatcher(pattern: string, kind: 'change' | 'create', fsPath: string): void {
  const watcher = state.watchers.find((w) => w.pattern === pattern);
  if (!watcher) throw new Error(`no watcher for ${pattern}`);
  const uri = { fsPath, toString: () => `file://${fsPath}` };
  for (const cb of watcher.listeners[kind] ?? []) cb(uri);
}

beforeEach(() => {
  state.workspaceRoot = null;
  state.themeKind = 1;
  state.sent.length = 0;
  state.onWebviewMessage = null;
  state.onViewStateChange = null;
  state.disposeCallbacks.length = 0;
  state.handlers.clear();
  state.watchers.length = 0;
  state.errors.length = 0;
  state.logs.length = 0;
  state.updates.length = 0;
  state.updateReject = false;
});

afterEach(() => {
  for (const d of state.disposeCallbacks.splice(0)) d();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.useRealTimers();
});

describe('model theme (M1)', () => {
  it('carries the ACTUAL VS Code theme — a light workspace does not render dark', () => {
    state.workspaceRoot = workspaceWithPlan();
    state.themeKind = 1; // ColorThemeKind.Light
    activate(makeContext());
    openBoard();
    ready();
    expect(postedModels()[0]?.themeKind).toBe('light');
  });

  it('follows a high-contrast theme too', () => {
    state.workspaceRoot = workspaceWithPlan();
    state.themeKind = 3; // ColorThemeKind.HighContrast
    activate(makeContext());
    openBoard();
    ready();
    expect(postedModels()[0]?.themeKind).toBe('highContrast');
  });
});

describe('status-only diffs (M2)', () => {
  it('ships an update diff — not a full model — when only a task status changed', () => {
    vi.useFakeTimers();
    state.workspaceRoot = workspaceWithPlan('pending');
    activate(makeContext());
    openBoard();
    ready();
    const modelsBefore = postedModels().length;
    expect(modelsBefore).toBe(1);

    // The agent flips the task status on disk; the watcher converges.
    writeTasks(state.workspaceRoot, 'running');
    fireWatcher('.archgen/**/*.{yaml,yml,md}', 'change', join(state.workspaceRoot, '.archgen', 'demo', 'tasks.yaml'));
    vi.advanceTimersByTime(400);

    const updates = state.sent.filter((m: HostToWebview) => m.type === 'update');
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ type: 'update', changed: [{ id: 'T1', status: 'running' }] });
    // No second full snapshot — the diff is the whole point.
    expect(postedModels().length).toBe(modelsBefore);
  });

  it('still ships a full model when the task STRUCTURE changed', () => {
    vi.useFakeTimers();
    state.workspaceRoot = workspaceWithPlan('pending');
    activate(makeContext());
    openBoard();
    ready();
    const modelsBefore = postedModels().length;

    writeFileSync(
      join(state.workspaceRoot, '.archgen', 'demo', 'tasks.yaml'),
      ['tasks:', '  - id: T1', '    title: Renamed task', '    status: pending', '    depends_on: []', ''].join('\n'),
      'utf8',
    );
    fireWatcher('.archgen/**/*.{yaml,yml,md}', 'change', join(state.workspaceRoot, '.archgen', 'demo', 'tasks.yaml'));
    vi.advanceTimersByTime(400);

    expect(state.sent.filter((m: HostToWebview) => m.type === 'update')).toHaveLength(0);
    expect(postedModels().length).toBe(modelsBefore + 1);
  });
});

describe('feature persistence failures (L4)', () => {
  it('surfaces a rejected workspaceState write instead of losing it', async () => {
    state.workspaceRoot = workspaceWithPlan();
    activate(makeContext());
    openBoard();
    ready();
    state.updateReject = true;

    state.handlers.get('archgen.selectFeature')?.('demo');
    await Promise.resolve();
    await Promise.resolve();

    expect(state.updates.length).toBeGreaterThan(0);
    expect(state.errors.join(' ')).toMatch(/cannot switch to 'demo'/);
    expect(state.logs.join('\n')).toMatch(/cannot persist active feature/);
  });
});

describe('bridge focus action (L10)', () => {
  it('honours the requested view — the board lands on DOCS', () => {
    vi.useFakeTimers();
    state.workspaceRoot = workspaceWithPlan();
    activate(makeContext());
    openBoard();
    ready();

    const cmdDir = join(state.workspaceRoot, '.archgen', '.runtime', 'cmd');
    mkdirSync(cmdDir, { recursive: true });
    const cmdPath = join(cmdDir, 'focus-1.json');
    writeFileSync(
      cmdPath,
      JSON.stringify({
        id: 'focus-1',
        action: 'focus',
        args: { view: 'DOCS' },
        protocol: 1,
        workspaceRoot: state.workspaceRoot,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      'utf8',
    );
    fireWatcher('.archgen/.runtime/cmd/**/*.json', 'create', cmdPath);
    vi.advanceTimersByTime(100);
    const focus = state.sent.filter((m: HostToWebview) => m.type === 'focusView');
    expect(focus).toHaveLength(1);
    expect(focus[0]).toEqual({ type: 'focusView', view: 'DOCS' });
  });

  it('falls back to TASKS for an unknown view', () => {
    vi.useFakeTimers();
    state.workspaceRoot = workspaceWithPlan();
    activate(makeContext());
    openBoard();
    ready();

    const cmdDir = join(state.workspaceRoot, '.archgen', '.runtime', 'cmd');
    mkdirSync(cmdDir, { recursive: true });
    const cmdPath = join(cmdDir, 'focus-2.json');
    writeFileSync(
      cmdPath,
      JSON.stringify({
        id: 'focus-2',
        action: 'focus',
        args: { view: 'nonsense' },
        protocol: 1,
        workspaceRoot: state.workspaceRoot,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      'utf8',
    );
    fireWatcher('.archgen/.runtime/cmd/**/*.json', 'create', cmdPath);
    vi.advanceTimersByTime(100);

    const focus = state.sent.filter((m: HostToWebview) => m.type === 'focusView');
    expect(focus).toHaveLength(1);
    expect(focus[0]).toEqual({ type: 'focusView', view: 'TASKS' });
  });

  it.each([
    ['docs', 'DOCS'],
    ['codegraph', 'CODE'],
    ['tasks', 'TASKS'],
    ['board', 'TASKS'],
    ['CODE', 'CODE'],
  ])('maps the advertised view name %j onto the %j tab', (requested, expected) => {
    vi.useFakeTimers();
    state.workspaceRoot = workspaceWithPlan();
    activate(makeContext());
    openBoard();
    ready();

    const cmdDir = join(state.workspaceRoot, '.archgen', '.runtime', 'cmd');
    mkdirSync(cmdDir, { recursive: true });
    const cmdPath = join(cmdDir, `focus-${requested}.json`);
    writeFileSync(
      cmdPath,
      JSON.stringify({
        id: `focus-${requested}`,
        action: 'focus',
        args: { view: requested },
        protocol: 1,
        workspaceRoot: state.workspaceRoot,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      'utf8',
    );
    fireWatcher('.archgen/.runtime/cmd/**/*.json', 'create', cmdPath);
    vi.advanceTimersByTime(100);

    const focus = state.sent.filter((m: HostToWebview) => m.type === 'focusView');
    expect(focus).toHaveLength(1);
    expect(focus[0]).toEqual({ type: 'focusView', view: expected });
  });

  it('refuses an openDoc command that points at a symlink OUTSIDE .archgen (M4)', async () => {
    state.workspaceRoot = workspaceWithPlan();
    const secret = join(state.workspaceRoot, 'secret.txt');
    writeFileSync(secret, 'AWS_SECRET=...', 'utf8');
    symlinkSync(secret, join(state.workspaceRoot, '.archgen', 'leak.md'));
    activate(makeContext());
    openBoard();
    ready();

    const cmdDir = join(state.workspaceRoot, '.archgen', '.runtime', 'cmd');
    mkdirSync(cmdDir, { recursive: true });
    const cmdPath = join(cmdDir, 'open-1.json');
    writeFileSync(
      cmdPath,
      JSON.stringify({
        id: 'open-1',
        action: 'openDoc',
        args: { path: 'leak.md' },
        protocol: 1,
        workspaceRoot: state.workspaceRoot,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
      'utf8',
    );
    fireWatcher('.archgen/.runtime/cmd/**/*.json', 'create', cmdPath);
    // The bridge debounce (50ms) and the async reveal must both settle.
    for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 10));

    // The secret never reaches the webview.
    expect(state.sent.filter((m: HostToWebview) => m.type === 'docContent')).toHaveLength(0);
    const statuses = state.sent.filter((m: HostToWebview) => m.type === 'status');
    expect(statuses.length).toBeGreaterThan(0);
    expect(JSON.stringify(statuses)).toMatch(/outside \.archgen/);
  });
});
