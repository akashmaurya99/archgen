// Panel restore regression tests (serializer adopt + force-push contract).
//
// After a window reload or full quit+restart, BoardSerializer adopts the
// restored WebviewPanel via ArchgenPanel.restore(); the webview then re-runs
// its `ready` handshake and the host must FORCE-push the model (extension.ts
// onReady/onVisible → pushModel(true)). These tests pin that contract:
// exactly one delivery per handshake, force beating the dedupe fingerprint,
// and dedupe staying armed for un-forced reposts — the regression behind the
// blank-board-after-restart bug.
//
// Same vi.mock('vscode') seam as panel-routing.test.ts: panel.ts hard-imports
// 'vscode' (unavailable under vitest's node env), so a fake WebviewPanel with
// captured postMessage / onDidReceiveMessage / onDidChangeViewState gives the
// same posted[]-inspection style.
import { afterEach, describe, expect, it, vi } from 'vitest';

type Msg = Record<string, unknown>;

// vi.hoisted: the mock factory below runs during import hoisting, before
// module-level consts exist — shared state must be created in the hoisted
// sandbox and referenced through this handle.
const state = vi.hoisted(() => ({
  sent: [] as import('../src/shared/protocol').HostToWebview[],
  onWebviewMessage: null as ((msg: Record<string, unknown>) => void) | null,
  onViewStateChange: null as ((e: { webviewPanel: { visible: boolean } }) => void) | null,
  disposeCallbacks: [] as Array<() => void>,
}));

vi.mock('vscode', () => {
  const disposable = { dispose(): void {} };
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
import type { ExtensionContext, WebviewPanel } from 'vscode';
import type { ArchgenModelMessage } from '../src/shared/protocol';

const MODEL: ArchgenModelMessage = {
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

// Raw shape of the adopted fake panel (kept for visible-flag mutation).
let fakePanel: { visible: boolean } | null = null;

function makeFakePanel(visible: boolean): WebviewPanel {
  const disposable = { dispose(): void {} };
  const panel = {
    webview: {
      html: '',
      cspSource: '',
      options: {},
      asWebviewUri(u: unknown): unknown {
        return u;
      },
      postMessage(msg: unknown): Thenable<boolean> {
        state.sent.push(msg as import('../src/shared/protocol').HostToWebview);
        return Promise.resolve(true);
      },
      onDidReceiveMessage(cb: (msg: Msg) => void, ..._rest: unknown[]): { dispose(): void } {
        state.onWebviewMessage = cb;
        return disposable;
      },
    },
    visible,
    reveal(): void {},
    onDidDispose(cb: () => void, ..._rest: unknown[]): { dispose(): void } {
      state.disposeCallbacks.push(cb);
      return disposable;
    },
    onDidChangeViewState(
      cb: (e: { webviewPanel: { visible: boolean } }) => void,
      ..._rest: unknown[]
    ): { dispose(): void } {
      state.onViewStateChange = cb;
      return disposable;
    },
  };
  fakePanel = panel;
  return panel as unknown as WebviewPanel;
}

/**
 * Adopt a restored panel exactly like extension.ts wires it: both the ready
 * handshake and the visible transition force-push the model (pushModel(true)
 * = invalidateModel() + post).
 */
function restorePanel(opts: { visible: boolean }): ArchgenPanel {
  const panel = makeFakePanel(opts.visible);
  let inst: ArchgenPanel;
  const pushModel = (force: boolean): void => {
    if (force) inst.invalidateModel();
    inst.post(MODEL);
  };
  inst = ArchgenPanel.restore(panel, { extensionUri: {} } as ExtensionContext, {
    onReady: () => pushModel(true),
    onVisible: () => pushModel(true),
  });
  return inst;
}

function receive(msg: Msg): void {
  if (!state.onWebviewMessage) throw new Error('webview message handler was never registered');
  state.onWebviewMessage(msg);
}

/** Flip the fake panel's visibility and deliver the event VS Code would. */
function setViewState(visible: boolean): void {
  if (!fakePanel) throw new Error('no panel adopted');
  fakePanel.visible = visible;
  if (!state.onViewStateChange) throw new Error('onDidChangeViewState was never registered');
  state.onViewStateChange({ webviewPanel: fakePanel });
}

function models(): Array<import('../src/shared/protocol').HostToWebview> {
  return state.sent.filter((m) => m.type === 'model');
}

afterEach(() => {
  // Dispose the singleton so every test starts with a fresh panel.
  for (const d of state.disposeCallbacks.splice(0)) d();
  state.sent.length = 0;
  state.onWebviewMessage = null;
  state.onViewStateChange = null;
  fakePanel = null;
});

describe('panel restore (serializer adopt + force-push contract)', () => {
  it('restored-visible panel receives the model exactly once per ready handshake, forced past a stale fingerprint', () => {
    const panel = restorePanel({ visible: true });
    // A pre-handshake host push seeds the dedupe fingerprint, but the post is
    // lost on the still-unmounted webview — the blank-board setup.
    panel.post(MODEL);
    state.sent.length = 0;
    // Restored webview finishes loading → ready handshake → pushModel(true).
    receive({ type: 'ready' });
    // Exactly one delivery, and it lands DESPITE the matching fingerprint:
    // onReady forces the push.
    expect(state.sent).toEqual([MODEL]);
  });

  it('lost-ready retry: a second ready handshake re-pushes the identical model', () => {
    restorePanel({ visible: true });
    receive({ type: 'ready' });
    expect(models()).toHaveLength(1);
    // The webview's watchdog retries the handshake after a context loss: the
    // host sees a second `ready` and must force the SAME model through again
    // — dedupe would otherwise swallow it and strand a blank board.
    receive({ type: 'ready' });
    expect(models()).toHaveLength(2);
    expect(models()[1]).toEqual(MODEL);
  });

  it('hidden-then-shown panel force-pushes the model on onDidChangeViewState visible', () => {
    restorePanel({ visible: true });
    receive({ type: 'ready' });
    expect(models()).toHaveLength(1);
    // Hidden: the view-state event fires but onVisible must NOT.
    setViewState(false);
    expect(models()).toHaveLength(1);
    // Shown again: onVisible → pushModel(true) re-delivers the identical model.
    setViewState(true);
    expect(models()).toHaveLength(2);
    expect(models()[1]).toEqual(MODEL);
  });

  it('dedupe stays armed: an identical model is NOT re-posted without force', () => {
    const panel = restorePanel({ visible: true });
    receive({ type: 'ready' });
    expect(models()).toHaveLength(1);
    // Un-forced reposts of a byte-identical model are dropped by the
    // fingerprint — force is the ONLY way through after a successful push.
    panel.post({ ...MODEL });
    panel.post({ ...MODEL });
    expect(models()).toHaveLength(1);
  });
});
