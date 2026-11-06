// panel-open-file.test.ts — the webview's "Open in editor" route.
//
// The DOCS list publishes paths RELATIVE TO <wsRoot>/.archgen, so the panel
// must resolve them against that base (joining the workspace root opened a
// non-existent path). Absolute paths are accepted only inside the workspace.
import { afterEach, describe, expect, it, vi } from 'vitest';

type Msg = Record<string, unknown>;

const state = vi.hoisted(() => ({
  sent: [] as import('../src/shared/protocol').HostToWebview[],
  onWebviewMessage: null as ((msg: Record<string, unknown>) => void) | null,
  disposeCallbacks: [] as Array<() => void>,
  opened: [] as string[],
  shown: [] as string[],
  errors: [] as string[],
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
      joinPath(...parts: unknown[]): unknown {
        return { fsPath: parts.join('/') };
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
      showErrorMessage(msg: string): Thenable<undefined> {
        state.errors.push(msg);
        return Promise.resolve(undefined);
      },
      showTextDocument(doc: { fsPath: string }): Thenable<undefined> {
        state.shown.push(doc.fsPath);
        return Promise.resolve(undefined);
      },
    },
    workspace: {
      get workspaceFolders(): Array<{ uri: { fsPath: string } }> {
        return [{ uri: { fsPath: '/ws' } }];
      },
      openTextDocument(uri: { fsPath: string }): Thenable<{ fsPath: string }> {
        state.opened.push(uri.fsPath);
        return Promise.resolve(uri);
      },
    },
  };
});

import { ArchgenPanel } from '../src/host/panel';
import type { ExtensionContext } from 'vscode';

function createPanel(): ArchgenPanel {
  const ctx = { extensionUri: {} } as ExtensionContext;
  return ArchgenPanel.createOrShow(ctx, {});
}

function receive(msg: Msg): void {
  if (!state.onWebviewMessage) throw new Error('webview message handler was never registered');
  state.onWebviewMessage(msg);
}

/** Let the panel's async openFile handler settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

afterEach(() => {
  for (const d of state.disposeCallbacks.splice(0)) d();
  state.sent.length = 0;
  state.onWebviewMessage = null;
  state.opened.length = 0;
  state.shown.length = 0;
  state.errors.length = 0;
});

describe('panel openFile routing', () => {
  it('resolves a relative doc path against <wsRoot>/.archgen — the base the producer uses', async () => {
    createPanel();
    receive({ type: 'openFile', path: 'plans/demo.md' });
    await flush();
    expect(state.opened).toEqual(['/ws/.archgen/plans/demo.md']);
    expect(state.shown).toEqual(['/ws/.archgen/plans/demo.md']);
    expect(state.errors).toEqual([]);
  });

  it('opens an absolute path that stays inside the workspace', async () => {
    createPanel();
    receive({ type: 'openFile', path: '/ws/src/app.ts' });
    await flush();
    expect(state.opened).toEqual(['/ws/src/app.ts']);
    expect(state.errors).toEqual([]);
  });

  it('refuses an absolute path OUTSIDE the workspace', async () => {
    createPanel();
    receive({ type: 'openFile', path: '/etc/passwd' });
    await flush();
    expect(state.opened).toEqual([]);
    expect(state.shown).toEqual([]);
    expect(state.errors.join(' ')).toMatch(/refusing to open/);
  });

  it('refuses a relative path that escapes .archgen', async () => {
    createPanel();
    receive({ type: 'openFile', path: '../../etc/passwd' });
    await flush();
    expect(state.opened).toEqual([]);
    expect(state.errors.join(' ')).toMatch(/refusing to open/);
  });
});
