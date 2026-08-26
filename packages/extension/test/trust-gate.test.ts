// Workspace-trust gate tests (todo 5): spawn/loadWaves dispatch is refused in
// UNTRUSTED workspaces (warning toast, zero processes) while clipboard
// delivery stays allowed. The full activate() runs against a minimal
// vi.mock('vscode') fake — same seam as panel-routing/panel-restore — plus a
// harness-module mock that spies launchHarness/loadWaves so "no spawn" is
// asserted without ever starting a real process.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WARNING = 'ArchGen: workspace is untrusted — enable trust to dispatch agents';

// vi.hoisted: the mock factories below run during import hoisting, before
// module-level consts exist — shared state must be created in the hoisted
// sandbox and referenced through this handle.
const state = vi.hoisted(() => ({
  isTrusted: false,
  workspaceRoot: null as string | null,
  config: {} as Record<string, unknown>,
  warnings: [] as string[],
  errors: [] as string[],
  infos: [] as string[],
  clipboardWrites: [] as string[],
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
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
  const makeWatcher = (): object => ({
    onDidChange: () => disposable,
    onDidCreate: () => disposable,
    onDidDelete: () => disposable,
    dispose(): void {},
  });
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
      registerWebviewPanelSerializer: (): typeof disposable => disposable,
      onDidChangeWindowState: (): typeof disposable => disposable,
      onDidChangeActiveColorTheme: (): typeof disposable => disposable,
      showInformationMessage: (message: string): Thenable<undefined> => {
        state.infos.push(message);
        return Promise.resolve(undefined);
      },
      showWarningMessage: (message: string): Thenable<undefined> => {
        state.warnings.push(message);
        return Promise.resolve(undefined);
      },
      showErrorMessage: (message: string): Thenable<undefined> => {
        state.errors.push(message);
        return Promise.resolve(undefined);
      },
      showInputBox: (): Thenable<undefined> => Promise.resolve(undefined),
    },
    workspace: {
      get isTrusted(): boolean {
        return state.isTrusted;
      },
      get workspaceFolders(): Array<{ uri: { fsPath: string } }> | undefined {
        return state.workspaceRoot === null ? undefined : [{ uri: { fsPath: state.workspaceRoot } }];
      },
      getConfiguration: (): object => ({
        get<T>(section: string, fallback: T): T {
          return section in state.config ? (state.config[section] as T) : fallback;
        },
      }),
      createFileSystemWatcher: (): object => makeWatcher(),
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
        writeText: (text: string): Thenable<void> => {
          state.clipboardWrites.push(text);
          return Promise.resolve();
        },
      },
    },
  };
});

// Spy seam for "no spawn": everything else (probeScriptsPath, templates,
// outfileForTask, interpolation) stays the real module.
vi.mock('../src/host/harness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/host/harness')>();
  return {
    ...actual,
    launchHarness: vi.fn(() => ({ on: vi.fn() })),
    loadWaves: vi.fn(() => Promise.resolve<string[][]>([])),
  };
});

// ModelHub's DEFAULT emitter factory does a CJS require('vscode') that the
// vi.mock registry cannot intercept — hub.ts documents this path as
// "tests inject fakes and never call this". extension.ts constructs the hub
// without a factory, so the hub itself gets a functional fake here
// (same store-latest + fan-out semantics as hub.test.ts's FakeEmitter).
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
import { launchHarness, loadWaves } from '../src/host/harness';
import type { ExtensionContext } from 'vscode';

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'archgen-trust-'));
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

function activateWith(wsRoot: string): void {
  state.workspaceRoot = wsRoot;
  activate(makeContext());
}

/** Workspace with an installed skill so probeScriptsPath resolves at ws level. */
function scratchWithScripts(): string {
  const ws = scratch();
  mkdirSync(join(ws, '.agents', 'skills', 'archgen', 'scripts'), { recursive: true });
  return ws;
}

beforeEach(() => {
  state.isTrusted = false;
  state.workspaceRoot = null;
  state.config = {};
  state.warnings.length = 0;
  state.errors.length = 0;
  state.infos.length = 0;
  state.clipboardWrites.length = 0;
  state.handlers.clear();
  vi.mocked(launchHarness).mockClear();
  vi.mocked(loadWaves).mockClear();
});

describe('workspace trust gate — spawn dispatch (todo 5)', () => {
  it('untrusted + spawn: dispatchBuild warns and never launches the harness', () => {
    state.isTrusted = false;
    state.config['delivery.mode'] = 'spawn';
    activateWith(scratchWithScripts());

    state.handlers.get('archgen.buildTask')?.('T1');

    expect(state.warnings).toEqual([WARNING]);
    expect(launchHarness).not.toHaveBeenCalled();
    // Spawn mode never copies either — the dispatch is refused outright.
    expect(state.clipboardWrites).toEqual([]);
  });

  it('untrusted + spawn: start-work warns and never runs loadWaves or the harness', async () => {
    state.isTrusted = false;
    state.config['delivery.mode'] = 'spawn';
    activateWith(scratchWithScripts());

    state.handlers.get('archgen.startWork')?.();
    await Promise.resolve(); // let the async IIFE pass the gate

    expect(state.warnings).toEqual([WARNING]);
    expect(loadWaves).not.toHaveBeenCalled();
    expect(launchHarness).not.toHaveBeenCalled();
  });

  it('untrusted + clipboard (default): dispatchBuild still copies the prompt', () => {
    state.isTrusted = false;
    // delivery.mode unset → falls back to 'clipboard'
    activateWith(scratch());

    state.handlers.get('archgen.buildTask')?.('T1');

    expect(state.warnings).toEqual([]);
    expect(launchHarness).not.toHaveBeenCalled();
    expect(state.clipboardWrites).toEqual(['Implement task T1 from the .archgen plan.']);
  });

  it('trusted + spawn: dispatchBuild launches the harness with the interpolated command', () => {
    const ws = scratchWithScripts();
    state.isTrusted = true;
    state.config['delivery.mode'] = 'spawn';
    activateWith(ws);

    state.handlers.get('archgen.buildTask')?.('T1');

    expect(state.warnings).toEqual([]);
    expect(launchHarness).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(launchHarness).mock.calls[0]?.[0];
    expect(opts?.command).toMatch(/^claude -p /);
    expect(opts?.cwd).toBe(ws);
  });

  it('trusted + spawn: start-work passes the gate and reaches loadWaves', async () => {
    const ws = scratchWithScripts();
    mkdirSync(join(ws, '.archgen', 'demo'), { recursive: true });
    writeFileSync(
      join(ws, '.archgen', 'demo', 'tasks.yaml'),
      ['tasks:', '  - id: T1', '    title: Demo task', '    status: pending', '    depends_on: []', '    file_ownership:', '      - "src/**"', ''].join('\n'),
    );
    state.isTrusted = true;
    state.config['delivery.mode'] = 'spawn';
    activateWith(ws);

    state.handlers.get('archgen.startWork')?.();
    await vi.waitFor(() => expect(loadWaves).toHaveBeenCalledTimes(1));

    const args = vi.mocked(loadWaves).mock.calls[0] ?? [];
    expect(args[0]).toBe(join(ws, '.agents', 'skills', 'archgen', 'scripts'));
    expect(args[1]).toBe(join(ws, '.archgen', 'demo', 'tasks.yaml'));
    // The stub resolves to zero waves → nothing spawns and an info toast explains.
    expect(launchHarness).not.toHaveBeenCalled();
    expect(state.warnings).toEqual([]);
  });
});
