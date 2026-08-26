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
import { assertNever } from '../shared/protocol';
import type { HostToWebview, ThemeKind, WebviewCopyInitPlanMessage, WebviewToHost } from '../shared/protocol';

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

/** FNV-1a hex digest — stable, dependency-free fingerprint of a payload string. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export interface PanelHostOptions {
  /** Called when the panel becomes visible after being hidden (watcher refresh). */
  onVisible?: () => void;
  /** Called when the webview posts `ready` — host should push the model. */
  onReady?: () => void;
  /** Build intent from the ▶ button (wired to harness spawn in todo 9). */
  onBuild?: (taskId: string) => void;
  /** Header "Start Work" — dispatches wave-1 of next-tasks.mjs via the harness. */
  onStartWork?: () => void;
  /** DOCS sidebar click — host parks it so the board lands on that document. */
  onOpenDoc?: (path: string) => void;
  /** Parked-doc flush — host reads .archgen/<path> (traversal-guarded) then posts revealDoc + docContent. */
  onRevealDoc?: (path: string) => void;
  /** TASKS-tab feature picker — host persists + re-posts the scoped model. */
  onSelectFeature?: (slug: string) => void;
  /** Setup-dialog install card — host composes + delivers the install prompt. */
  onCopyInstall?: () => void;
  /** Setup-dialog plan intent — host delivers at once when the board collected an idea, else asks via native InputBox. */
  onCopyInitPlan?: (msg: WebviewCopyInitPlanMessage) => void;
  /** Setup-dialog update card — host composes + delivers the update prompt. */
  onCopyUpdate?: () => void;
  /** Ready handshake — host replays its latest setup snapshot for late-opened boards. */
  onSetupSync?: () => void;
}

export class ArchgenPanel {
  private static current: ArchgenPanel | null = null;
  private panel: WebviewPanel | undefined;
  private disposables: Array<{ dispose(): void }> = [];
  private lastSentModel: string | null = null;
  private forceNext = false;
  // Reveal-to-task intent (sidebar "Show in Task Board") parked while the
  // webview is still loading; flushed right after the model push in the
  // `ready` branch so ordering stays model-before-reveal.
  private pendingReveal: string | null = null;
  // SETUP-dialog navigation intent (status bar / notifications / command)
  // parked the same way; flushed after the revealTask slot so a combined
  // reveal+setup request opens the dialog deterministically.
  private pendingRevealSetup = false;
  // DOCS-navigation intent parked like the reveals; flushed AFTER them so a
  // cold-open lands model → reveals → revealDoc+docContent in channel order
  // (the webview must hold the model before the DOCS tab can render a doc).
  private pendingDoc: string | null = null;
  // Flips true once this webview completed its `ready` handshake.
  private readySeen = false;

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
      case 'ready': {
        this.forceNext = true;
        this.readySeen = true;
        // onReady pushes the model synchronously BEFORE the flushes below, so
        // the webview always receives model → revealTask → revealSetup →
        // revealDoc/docContent → setupSync in channel order: by the time paint
        // settles it holds both the full model AND current setup truth, never
        // either alone.
        this.opts.onReady?.();
        const taskId = this.pendingReveal;
        this.pendingReveal = null;
        if (taskId !== null) this.post({ type: 'revealTask', taskId });
        if (this.pendingRevealSetup) {
          this.pendingRevealSetup = false;
          this.post({ type: 'revealSetup' });
        }
        const docPath = this.pendingDoc;
        this.pendingDoc = null;
        if (docPath !== null) this.opts.onRevealDoc?.(docPath);
        this.opts.onSetupSync?.();
        break;
      }
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
      case 'startWork':
        this.opts.onStartWork?.();
        break;
      case 'openDoc':
        this.opts.onOpenDoc?.(msg.path);
        break;
      case 'selectFeature':
        this.opts.onSelectFeature?.(msg.slug);
        break;
      case 'copyInstall':
        this.opts.onCopyInstall?.();
        break;
      case 'copyInitPlan':
        this.opts.onCopyInitPlan?.(msg);
        break;
      case 'copyUpdate':
        this.opts.onCopyUpdate?.();
        break;
      default:
        // Exhaustiveness guard: a new WebviewToHost member without a case
        // fails `tsc` here instead of silently dropping its traffic.
        assertNever(msg);
    }
  }

  /** Post typed message; dedupes identical models unless invalidated. */
  post(message: HostToWebview): void {
    if (!this.panel) return;
    if (message.type === 'model') {
      // FULL-PAYLOAD fingerprint: the hashed object carries every model field
      // (activeSlug, tasks incl. acceptance, docs, warnings, codegraph, …), so
      // ANY mutation reaches the webview — not just id/status/doc deltas.
      const fingerprint = fnv1a(JSON.stringify(message));
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

  /**
   * Schedule a reveal-to-task on this board. A freshly created webview has not
   * posted `ready` yet, so the intent parks here until the handshake completes
   * (flushed after the model push); an already-loaded board gets it at once.
   */
  setPendingReveal(taskId: string): void {
    if (this.readySeen) {
      this.post({ type: 'revealTask', taskId });
      return;
    }
    this.pendingReveal = taskId;
  }

  /**
   * Schedule a SETUP-tab reveal on this board — same parking contract as
   * setPendingReveal: parks until the `ready` handshake on a freshly created
   * webview, fires at once on an already-loaded board.
   */
  setPendingRevealSetup(): void {
    if (this.readySeen) {
      this.post({ type: 'revealSetup' });
      return;
    }
    this.pendingRevealSetup = true;
  }

  /**
   * Schedule a DOCS reveal on this board — same parking contract as
   * setPendingReveal: parks until the `ready` handshake on a freshly created
   * webview, flushes at once on an already-loaded board.
   */
  setPendingDoc(path: string): void {
    if (this.readySeen) {
      this.opts.onRevealDoc?.(path);
      return;
    }
    this.pendingDoc = path;
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
    this.pendingReveal = null;
    this.pendingRevealSetup = false;
    this.pendingDoc = null;
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
