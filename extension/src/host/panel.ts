// panel.ts — webview host shell (todo 7).
// Panel lifecycle, nonce'd CSP html, message router, theme observer,
// view-state persistence via registerWebviewPanelSerializer.
import {
  ExtensionContext,
  Range,
  Uri,
  ViewColumn,
  Webview,
  WebviewPanel,
  WebviewPanelSerializer,
  window,
  workspace,
} from 'vscode';
import type { HostToWebview, ThemeKind, WebviewToHost } from '../shared/protocol';

export const VIEW_TYPE = 'archgen.taskBoard';

function nonce(): string {
  let out = '';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const buf = new Uint32Array(24);
  globalThis.crypto.getRandomValues(buf);
  for (const v of buf) out += alphabet[v % alphabet.length];
  return out;
}

/** Map VS Code color theme kinds onto the shared ThemeKind union. */
export function themeKindOf(kind: number): ThemeKind {
  switch (kind) {
    case 1: return 'light';
    case 2: return 'dark';
    case 3: return 'highContrast';
    case 4: return 'highContrastLight';
    default: return 'dark';
  }
}

export interface PanelHostOptions {
  /** Called when the panel becomes visible after being hidden (watcher refresh). */
  onVisible?: () => void;
  /** Called when the webview posts `ready` — host should push the model. */
  onReady?: () => void;
  /** Build intent from the ▶ button (wired to harness spawn in todo 9). */
  onBuild?: (taskId: string) => void;
}

export class ArchgenPanel {
  private static current: ArchgenPanel | null = null;
  private panel: WebviewPanel | undefined;
  private disposables: Array<{ dispose(): void }> = [];
  private lastSentModel: string | null = null;
  private forceNext = false;

  private constructor(
    private readonly context: ExtensionContext,
    private readonly opts: PanelHostOptions,
  ) {}

  /** Create or reveal the singleton board panel. */
  static createOrShow(context: ExtensionContext, opts: PanelHostOptions = {}): ArchgenPanel {
    if (ArchgenPanel.current) {
      ArchgenPanel.current.panel?.reveal(ViewColumn.Beside);
      return ArchgenPanel.current;
    }
    const inst = new ArchgenPanel(context, opts);
    const webviewRoot = Uri.joinPath(context.extensionUri, 'media', 'webview');
    const panel = window.createWebviewPanel(VIEW_TYPE, 'ArchGen Task Board', ViewColumn.Beside, {
      enableScripts: true,
      localResourceRoots: [webviewRoot],
      retainContextWhenHidden: false,
    });
    inst.adopt(panel);
    ArchgenPanel.current = inst;
    return inst;
  }

  /** Adopt a panel restored by the serializer after a window reload. */
  static restore(panel: WebviewPanel, context: ExtensionContext, opts: PanelHostOptions = {}): ArchgenPanel {
    if (ArchgenPanel.current) {
      // Only one board may exist; drop the restored shell and reveal ours.
      void panel.dispose();
      ArchgenPanel.current.panel?.reveal();
      return ArchgenPanel.current;
    }
    const inst = new ArchgenPanel(context, opts);
    panel.webview.options = { enableScripts: true, localResourceRoots: [Uri.joinPath(context.extensionUri, 'media', 'webview')] };
    inst.adopt(panel);
    ArchgenPanel.current = inst;
    return inst;
  }

  static get active(): ArchgenPanel | null {
    return ArchgenPanel.current;
  }

  get visible(): boolean {
    return this.panel?.visible ?? false;
  }

  // Shared wiring for both fresh + restored panels.
  private adopt(panel: WebviewPanel): void {
    this.panel = panel;
    panel.webview.html = this.renderHtml(panel.webview);

    panel.onDidDispose(() => this.dispose(), null, this.disposables);

    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.visible) this.opts.onVisible?.();
    }, null, this.disposables);

    panel.webview.onDidReceiveMessage((msg: WebviewToHost) => this.route(msg), null, this.disposables);

    // Theme observer: any editor theme change is forwarded so the webview can
    // flip its data-theme attribute (tokens.css resolves --vscode-* vars live;
    // the attribute exists for explicit CSS branching and tests).
    this.disposables.push(
      window.onDidChangeActiveColorTheme((theme) => {
        this.post({ type: 'theme', themeKind: themeKindOf(theme.kind) });
      }),
    );
  }

  /** Message router: exactly one switch over the shared protocol union. */
  private route(msg: WebviewToHost): void {
    switch (msg.type) {
      case 'ready':
        this.forceNext = true;
        this.opts.onReady?.();
        break;
      case 'openFile': {
        void (async () => {
          try {
            const root = workspace.workspaceFolders?.[0]?.uri ?? this.context.extensionUri;
            const abs = msg.path.startsWith('/') ? Uri.file(msg.path) : Uri.joinPath(root, msg.path);
            const doc = await workspace.openTextDocument(abs);
            const selection = msg.line
              ? new Range(Math.max(0, msg.line - 1), 0, Math.max(0, msg.line - 1), 0)
              : undefined;
            await window.showTextDocument(doc, { preview: true, selection });
          } catch (e) {
            void window.showErrorMessage(`ArchGen: cannot open ${msg.path}: ${e instanceof Error ? e.message : String(e)}`);
          }
        })();
        break;
      }
      case 'build':
        this.opts.onBuild?.(msg.taskId);
        break;
    }
  }

  /** Post typed message; dedupes identical models unless invalidated. */
  post(message: HostToWebview): void {
    if (!this.panel) return;
    if (message.type === 'model') {
      const fingerprint = JSON.stringify([message.tasks.map((t) => [t.id, t.status]), message.docs.map((d) => d.path)]);
      if (!this.forceNext && fingerprint === this.lastSentModel) return;
      this.lastSentModel = fingerprint;
      this.forceNext = false;
    }
    void this.panel.webview.postMessage(message);
  }

  /** Force the next model post even if the fingerprint matches. */
  invalidateModel(): void {
    this.forceNext = true;
  }

  private renderHtml(webview: Webview): string {
    const scriptUri = Uri.joinPath(this.context.extensionUri, 'media', 'webview', 'main.js');
    const cssMain = Uri.joinPath(this.context.extensionUri, 'media', 'webview', 'tokens.css');
    // Bundled by esbuild from the webview entry's css imports
    // (@xyflow/react style + dag.css canvas styles).
    const cssBundle = Uri.joinPath(this.context.extensionUri, 'media', 'webview', 'main.css');
    const n = nonce();
    // CSP: scripts ONLY via nonce; styles allow the webview's own origin
    // ('unsafe-inline' required by mermaid's injected <style> in later waves);
    // images limited to webview resources + data URIs.
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${n}'`,
    ].join('; ');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${webview.asWebviewUri(cssMain)}">
  <link rel="stylesheet" href="${webview.asWebviewUri(cssBundle)}">
  <title>ArchGen</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${n}" src="${webview.asWebviewUri(scriptUri)}"></script>
</body>
</html>`;
  }

  private dispose(): void {
    for (const d of this.disposables.splice(0)) d.dispose();
    this.panel = undefined;
    if (ArchgenPanel.current === this) ArchgenPanel.current = null;
  }
}

/** Serializer restores the board across window reloads. */
class BoardSerializer implements WebviewPanelSerializer {
  constructor(
    private readonly context: ExtensionContext,
    private readonly opts: PanelHostOptions,
  ) {}

  deserializeWebviewPanel(panel: WebviewPanel, _state: unknown): Thenable<void> {
    ArchgenPanel.restore(panel, this.context, this.opts);
    return Promise.resolve();
  }
}

export function registerBoard(context: ExtensionContext, opts: PanelHostOptions = {}): void {
  context.subscriptions.push(window.registerWebviewPanelSerializer(VIEW_TYPE, new BoardSerializer(context, opts)));
}
