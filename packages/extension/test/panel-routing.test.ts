// Panel host routing + model-dedupe regression tests.
//
// src/host/panel.ts hard-imports 'vscode' (unavailable under vitest's node
// env), so the module is exercised through a minimal vi.mock('vscode') fake:
// a captured WebviewPanel whose postMessage / onDidReceiveMessage give the
// same posted[]-inspection style as the jsdom webview suites.
import { afterEach, describe, expect, it, vi } from 'vitest';

type Msg = Record<string, unknown>;

// vi.hoisted: the mock factory below runs during import hoisting, before
// module-level consts exist — shared state must be created in the hoisted
// sandbox and referenced through this handle.
const state = vi.hoisted(() => ({
  sent: [] as import('../src/shared/protocol').HostToWebview[],
  onWebviewMessage: null as ((msg: Record<string, unknown>) => void) | null,
  disposeCallbacks: [] as Array<() => void>,
}));

vi.mock('vscode', () => {
  const disposable = { dispose(): void {} };
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
    onDidChangeViewState(..._rest: unknown[]): { dispose(): void } {
      return disposable;
    },
  };
  return {
    Uri: {
      joinPath(..._parts: unknown[]): unknown {
        return {};
      },
      file(p: string): unknown {
        return { fsPath: p };
      },
    },
    Range: class {},
    ViewColumn: { Beside: 2 },
    window: {
      createWebviewPanel(): typeof fakePanel {
        return fakePanel;
      },
      onDidChangeActiveColorTheme(..._rest: unknown[]): { dispose(): void } {
        return disposable;
      },
      showErrorMessage(): Thenable<undefined> {
        return Promise.resolve(undefined);
      },
    },
    workspace: {},
  };
});

import { ArchgenPanel } from '../src/host/panel';
import type { ExtensionContext } from 'vscode';
import type { ArchgenModelMessage } from '../src/shared/protocol';

const MODEL_A: ArchgenModelMessage = {
  type: 'model',
  tasks: [
    { id: 'A', title: 'Root', status: 'pending', dependsOn: [], fileOwnership: ['a/**'], artifacts: [], acceptance: ['tests pass'] },
    { id: 'B', title: 'Child', status: 'ready', dependsOn: ['A'], fileOwnership: ['b/**'], artifacts: [] },
  ],
  docs: [{ path: 'plans/demo.md', title: 'demo.md' }],
  codegraph: { product: 'unsupported' },
  themeKind: 'dark',
  warnings: [],
  features: [{ slug: 'demo', tasksPath: '/ws/.archgen/demo/tasks.yaml', updatedAt: 1 }],
  activeSlug: 'demo',
};

function createPanel(opts: Parameters<typeof ArchgenPanel.createOrShow>[1] = {}): ArchgenPanel {
  const ctx = { extensionUri: {} } as ExtensionContext;
  return ArchgenPanel.createOrShow(ctx, opts);
}

const SETUP_SYNC = {
  type: 'setup' as const,
  state: {
    skill: { installed: true, path: '/ws/.agents/skills/archgen/scripts', version: '0.0.4' },
    planInitialized: false,
    upToDate: true,
  },
  actions: ['initPlan'] as import('../src/shared/protocol').SetupAction[],
  extVersion: '0.0.4',
};

function receive(msg: Msg): void {
  if (!state.onWebviewMessage) throw new Error('webview message handler was never registered');
  state.onWebviewMessage(msg);
}

afterEach(() => {
  // Dispose the singleton so every test starts with a fresh panel.
  for (const d of state.disposeCallbacks.splice(0)) d();
  state.sent.length = 0;
  state.onWebviewMessage = null;
});

describe('panel message routing', () => {
  it('routes webview startWork to the onStartWork host callback', () => {
    const onStartWork = vi.fn();
    createPanel({ onStartWork });
    receive({ type: 'startWork' });
    expect(onStartWork).toHaveBeenCalledTimes(1);
  });

  it('keeps routing build/openDoc/selectFeature to their callbacks (host adapter board-open on selectFeature/openDoc: MANUAL coverage)', () => {
    const onBuild = vi.fn();
    const onOpenDoc = vi.fn();
    const onSelectFeature = vi.fn();
    createPanel({ onBuild, onOpenDoc, onSelectFeature });
    receive({ type: 'build', taskId: 'A' });
    receive({ type: 'openDoc', path: 'plans/demo.md' });
    receive({ type: 'selectFeature', slug: 'other' });
    expect(onBuild).toHaveBeenCalledWith('A');
    expect(onOpenDoc).toHaveBeenCalledWith('plans/demo.md');
    expect(onSelectFeature).toHaveBeenCalledWith('other');
  });

  it.each([
    ['copyInstall', 'onCopyInstall'],
    ['copyInitPlan', 'onCopyInitPlan'],
    ['copyUpdate', 'onCopyUpdate'],
  ] as const)('routes webview %s to its host callback exactly once', (wireType, callback) => {
    const callbacks = {
      onCopyInstall: vi.fn(),
      onCopyInitPlan: vi.fn(),
      onCopyUpdate: vi.fn(),
    };
    createPanel(callbacks);
    receive({ type: wireType });
    expect(callbacks[callback]).toHaveBeenCalledTimes(1);
    // The sibling intents stay untouched — one click, one delivery.
    for (const [name, fn] of Object.entries(callbacks)) {
      if (name !== callback) expect(fn).not.toHaveBeenCalled();
    }
  });

  describe('copyInitPlan idea passthrough (board kickoff modal)', () => {
    it('routes the FULL message so the host delivers immediately when the board collected an idea', () => {
      const onCopyInitPlan = vi.fn();
      createPanel({ onCopyInitPlan });
      receive({ type: 'copyInitPlan', idea: 'auth service' });
      expect(onCopyInitPlan).toHaveBeenCalledTimes(1);
      expect(onCopyInitPlan).toHaveBeenCalledWith({ type: 'copyInitPlan', idea: 'auth service' });
    });

    it('routes bare copyInitPlan unchanged — host decides InputBox vs deliver (adapter note: MANUAL coverage)', () => {
      const onCopyInitPlan = vi.fn();
      createPanel({ onCopyInitPlan });
      receive({ type: 'copyInitPlan' });
      expect(onCopyInitPlan).toHaveBeenCalledTimes(1);
      expect(onCopyInitPlan.mock.calls[0]?.[0]).toEqual({ type: 'copyInitPlan' });
    });
  });

  it('posts revealTask over the HostToWebview direction after ready', () => {
    const panel = createPanel();
    receive({ type: 'ready' });
    panel.setPendingReveal('B');
    expect(state.sent.at(-1)).toEqual({ type: 'revealTask', taskId: 'B' });
  });

  it('parks setPendingRevealSetup before ready and flushes revealSetup after the handshake', () => {
    const panel = createPanel();
    panel.setPendingRevealSetup();
    expect(state.sent).toEqual([]); // parked — webview never posted ready
    receive({ type: 'ready' });
    expect(state.sent.at(-1)).toEqual({ type: 'revealSetup' });
  });

  it('delivers setPendingRevealSetup at once on an already-ready board', () => {
    const panel = createPanel();
    receive({ type: 'ready' });
    state.sent.length = 0;
    panel.setPendingRevealSetup();
    expect(state.sent).toEqual([{ type: 'revealSetup' }]);
  });

  it('flushes parked intents in channel order: model → revealTask → revealSetup → revealDoc → docContent → setup', () => {
    let pushedModel = false;
    const panel = createPanel({
      onReady: () => {
        if (!pushedModel) {
          pushedModel = true;
          panel.post(MODEL_A);
        }
      },
      onSetupSync: () => {
        panel.post(SETUP_SYNC);
      },
      // Mirror extension.ts revealDoc: read the file, then post the pair.
      onRevealDoc: (p) => {
        panel.post({ type: 'revealDoc', path: p });
        panel.post({ type: 'docContent', path: p, content: '# demo' });
      },
    });
    panel.setPendingReveal('B');
    panel.setPendingRevealSetup();
    panel.setPendingDoc('plans/demo.md');
    receive({ type: 'ready' });
    expect(state.sent.map((m) => m.type)).toEqual([
      'model',
      'revealTask',
      'revealSetup',
      'revealDoc',
      'docContent',
      'setup',
    ]);
  });

  it('parks setPendingDoc before ready (nothing sent) and flushes via onRevealDoc after the handshake', () => {
    const onRevealDoc = vi.fn();
    const panel = createPanel({ onRevealDoc });
    panel.setPendingDoc('plans/demo.md');
    expect(state.sent).toEqual([]); // parked — webview never posted ready
    receive({ type: 'ready' });
    expect(onRevealDoc).toHaveBeenCalledTimes(1);
    expect(onRevealDoc).toHaveBeenCalledWith('plans/demo.md');
  });

  it('delivers setPendingDoc at once on an already-ready board', () => {
    const onRevealDoc = vi.fn();
    const panel = createPanel({ onRevealDoc });
    receive({ type: 'ready' });
    state.sent.length = 0;
    panel.setPendingDoc('docs/adr-1.md');
    expect(onRevealDoc).toHaveBeenCalledTimes(1);
    expect(onRevealDoc).toHaveBeenCalledWith('docs/adr-1.md');
    // No HostToWebview traffic from the panel itself — the HOST posts the pair.
    expect(state.sent).toEqual([]);
  });

  it('drops a parked doc when the panel disposes before ready (no stale flush)', () => {
    const onRevealDoc = vi.fn();
    const panel = createPanel({ onRevealDoc });
    panel.setPendingDoc('plans/demo.md');
    for (const d of state.disposeCallbacks.splice(0)) d();
    expect(onRevealDoc).not.toHaveBeenCalled();
  });
});

describe('full-payload model fingerprint (dedupe)', () => {
  it('delivers a model whose ONLY change is a warnings/acceptance-like field', () => {
    const panel = createPanel();
    panel.post(MODEL_A);
    expect(state.sent).toEqual([MODEL_A]);

    // identical payload → deduped away
    panel.post({ ...MODEL_A });
    expect(state.sent).toHaveLength(1);

    // warnings-only mutation must NOT be dropped (regression: old fingerprint
    // hashed only [activeSlug, task id/status pairs, doc paths])
    panel.post({ ...MODEL_A, warnings: ['beta: tasks.yaml unreadable'] });
    expect(state.sent).toHaveLength(2);
    expect((state.sent[1] as ArchgenModelMessage).warnings).toEqual(['beta: tasks.yaml unreadable']);

    // acceptance-only mutation must NOT be dropped either
    panel.post({
      ...MODEL_A,
      tasks: MODEL_A.tasks.map((t) => (t.id === 'B' ? { ...t, acceptance: ['docs updated'] } : t)),
    });
    expect(state.sent).toHaveLength(3);
    expect((state.sent[2] as ArchgenModelMessage).tasks.find((t) => t.id === 'B')?.acceptance).toEqual(['docs updated']);
  });

  it('still dedupes byte-identical reposts of the mutated model', () => {
    const panel = createPanel();
    panel.post(MODEL_A);
    const mutated: ArchgenModelMessage = { ...MODEL_A, warnings: ['beta: stale'] };
    panel.post(mutated);
    panel.post({ ...mutated });
    expect(state.sent).toHaveLength(2);
  });

  it('non-model messages bypass the fingerprint entirely', () => {
    const panel = createPanel();
    panel.post({ type: 'status', kind: 'info', message: 'Dispatched.' });
    panel.post({ type: 'status', kind: 'info', message: 'Dispatched.' });
    expect(state.sent).toHaveLength(2);
  });

  it('setup snapshots bypass the fingerprint so the SETUP tab never renders stale cards', () => {
    const panel = createPanel();
    const snapshot = (upToDate: boolean | null) => ({
      type: 'setup' as const,
      state: {
        skill: { installed: true, path: '/ws/.agents/skills/archgen/scripts', version: '0.0.1' },
        planInitialized: true,
        upToDate,
      },
      actions: (upToDate === false ? ['update'] : []) as import('../src/shared/protocol').SetupAction[],
      extVersion: '0.0.4',
    });
    const first = snapshot(false);
    panel.post(first);
    panel.post(first); // byte-identical non-model payload → still delivered
    expect(state.sent).toHaveLength(2);
    expect(state.sent[0]).toEqual(first);
    expect(state.sent[1]).toEqual(first);
  });
});

describe('codegraph digest caching (todo 6: DB-stat gate, no multi-MB re-stringify)', () => {
  // The host reuses ONE codegraph slice object while the DB stat is unchanged
  // (extension.ts stat gate); the panel must hash that slice exactly once and
  // dedupe on identity afterwards — never re-run JSON.stringify over it.
  function bigCodegraph(n: number): ArchgenModelMessage['codegraph'] {
    return {
      product: 'colby',
      hasFts: false,
      nodes: Array.from({ length: n }, (_, i) => ({
        id: `n${i}`, label: `sym${i}`, kind: 'function', file: `f${i % 100}.ts`, line: i,
      })),
      edges: Array.from({ length: n - 1 }, (_, i) => ({ source: `n${i}`, target: `n${i + 1}`, kind: 'calls' })),
    };
  }

  function sliceStringifyCount(
    spy: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } },
    slice: unknown,
  ): number {
    return spy.mock.calls.filter((c) => c[0] === slice).length;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reused slice object: identical re-post is deduped (0 postMessage) and the 50k-node slice is stringified exactly once', () => {
    const panel = createPanel();
    const slice = bigCodegraph(50_000);
    const model: ArchgenModelMessage = { ...MODEL_A, codegraph: slice };
    const stringifySpy = vi.spyOn(JSON, 'stringify');

    panel.post(model);
    expect(state.sent).toHaveLength(1);
    expect(sliceStringifyCount(stringifySpy, slice)).toBe(1);

    // Second push with the SAME slice object (stat unchanged → host reuse):
    // deduped away, and the multi-MB slice is NOT serialized again.
    panel.post({ ...model });
    expect(state.sent).toHaveLength(1);
    expect(sliceStringifyCount(stringifySpy, slice)).toBe(1);
  });

  it('task/status mutation still posts even when the codegraph slice is reused (dedupe stays un-broken)', () => {
    const panel = createPanel();
    const slice = bigCodegraph(50_000);
    const model: ArchgenModelMessage = { ...MODEL_A, codegraph: slice };
    panel.post(model);
    const stringifySpy = vi.spyOn(JSON, 'stringify');

    panel.post({
      ...model,
      tasks: model.tasks.map((t) => (t.id === 'B' ? { ...t, status: 'running' as const } : t)),
    });

    expect(state.sent).toHaveLength(2);
    expect((state.sent[1] as ArchgenModelMessage).tasks.find((t) => t.id === 'B')?.status).toBe('running');
    // The post rode the cached digest — zero re-serialization of the slice.
    expect(sliceStringifyCount(stringifySpy, slice)).toBe(0);
  });

  it('a fresh slice object (DB moved) is re-serialized and reaches the webview', () => {
    const panel = createPanel();
    const model: ArchgenModelMessage = { ...MODEL_A, codegraph: bigCodegraph(50_000) };
    panel.post(model);
    const stringifySpy = vi.spyOn(JSON, 'stringify');

    const refreshed: ArchgenModelMessage = {
      ...model,
      codegraph: { ...model.codegraph, nodes: model.codegraph.nodes?.slice(0, 10) },
    };
    panel.post(refreshed);

    expect(state.sent).toHaveLength(2);
    expect((state.sent[1] as ArchgenModelMessage).codegraph.nodes).toHaveLength(10);
    expect(sliceStringifyCount(stringifySpy, refreshed.codegraph)).toBe(1);
  });
});

describe('onSetupSync replay (snapshot-on-ready)', () => {
  const SETUP_REPLAY = {
    type: 'setup' as const,
    state: {
      skill: { installed: true, path: '/ws/.agents/skills/archgen/scripts', version: '0.0.4' },
      planInitialized: false,
      upToDate: true,
    },
    actions: ['initPlan'] as import('../src/shared/protocol').SetupAction[],
    extVersion: '0.0.4',
  };

  it('fires exactly once per ready handshake AFTER parked reveals flush', () => {
    let pushedModel = false;
    const onSetupSync = vi.fn(() => {
      // Mirror extension.ts: the replay rides the same panel post path.
      panel.post(SETUP_REPLAY);
    });
    const panel = createPanel({
      onReady: () => {
        if (!pushedModel) {
          pushedModel = true;
          panel.post(MODEL_A);
        }
      },
      onSetupSync,
    });
    panel.setPendingReveal('B');
    panel.setPendingRevealSetup();
    receive({ type: 'ready' });
    expect(onSetupSync).toHaveBeenCalledTimes(1);
    expect(state.sent.map((m) => m.type)).toEqual(['model', 'revealTask', 'revealSetup', 'setup']);
    expect(state.sent.at(-1)).toEqual(SETUP_REPLAY);
  });

  it('fires after the model even with no parked intents', () => {
    const onSetupSync = vi.fn(() => {
      panel.post(SETUP_REPLAY);
    });
    const panel = createPanel({
      onReady: () => panel.post(MODEL_A),
      onSetupSync,
    });
    receive({ type: 'ready' });
    expect(onSetupSync).toHaveBeenCalledTimes(1);
    expect(state.sent.map((m) => m.type)).toEqual(['model', 'setup']);
  });

  it('does NOT fire for non-ready messages', () => {
    const onSetupSync = vi.fn();
    createPanel({ onSetupSync });
    receive({ type: 'startWork' });
    receive({ type: 'build', taskId: 'A' });
    receive({ type: 'copyInitPlan' });
    expect(onSetupSync).not.toHaveBeenCalled();
    expect(state.sent).toEqual([]);
  });

  it('fires again on the next handshake of a fresh panel (once per handshake)', () => {
    const onSetupSync = vi.fn();
    createPanel({ onSetupSync });
    receive({ type: 'ready' });
    expect(onSetupSync).toHaveBeenCalledTimes(1);
    // afterEach disposes; a brand-new board gets its own replay.
    createPanel({ onSetupSync });
    receive({ type: 'ready' });
    expect(onSetupSync).toHaveBeenCalledTimes(2);
  });
});
