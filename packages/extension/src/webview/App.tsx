// App.tsx — webview shell (todo 7) + live status intake (todo 10).
// View tabs TASKS | CODE | DOCS, loading/empty/error states, theme attribute.
// The webview performs ZERO direct fs/network IO — everything arrives via
// postMessage from the host; every user intent leaves via postMessage.
//
// LIVE WIRING (todo 10): full snapshots ('model') rebuild the StatusStore;
// watcher diffs ('update') flow through store.applyBatch — an rAF-batched,
// immutable patch application — so TasksView re-renders only changed nodes
// instead of remapping the whole tasks array on every message.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { assertNever } from '../shared/protocol';
import type {
  ArchgenModelMessage,
  ArchgenSetupMessage,
  HostToWebview,
  TaskVM,
  ThemeKind,
} from '../shared/protocol';
import { StatusStore } from '../host/store';
import { getVsCodeApi } from './vscode';
import { EmptyState, ErrorBanner, LoadingState, StaleChip, VIEW_TABS, type ViewTab } from './states';
import { TasksView } from './TasksView';
import { CodeGraphView } from './CodeGraphView';
import { DocsView } from './DocsView';
import { SetupView } from './SetupView';
import { FeaturePicker } from './FeaturePicker';

export interface AppProps {
  /** injected for tests; defaults to the real webview API */
  api?: ReturnType<typeof getVsCodeApi>;
}

interface PersistedState {
  tab?: ViewTab;
}

function applyTheme(themeKind: ThemeKind | undefined): void {
  if (!themeKind) return;
  document.documentElement.dataset['theme'] = themeKind;
}

export function App(props: AppProps) {
  const vscode = useMemo(() => props.api ?? getVsCodeApi(), [props.api]);
  const [model, setModel] = useState<ArchgenModelMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [docContent, setDocContent] = useState<{ path: string; content: string } | null>(null);
  const [setup, setSetup] = useState<ArchgenSetupMessage | null>(null);
  const [lastModelAt, setLastModelAt] = useState<number>(() => Date.now());
  const [, setStoreVersion] = useState(0);
  const storeRef = useRef<StatusStore<TaskVM> | null>(null);
  const [tab, setTab] = useState<ViewTab>(() => {
    const persisted = vscode.getState<PersistedState>();
    return persisted?.tab ?? 'TASKS';
  });
  // REVEAL INTENT: task id to spotlight on the TASKS canvas; null = no reveal.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // Header ⋯ menu: ref lets item clicks close the native <details> directly.
  const menuRef = useRef<HTMLDetailsElement | null>(null);

  const closeMenu = useCallback((): void => {
    const el = menuRef.current;
    if (el) el.open = false;
  }, []);

  // Native <details> never closes on outside clicks — supply that dismissal.
  useEffect(() => {
    const onDocClick = (e: MouseEvent): void => {
      const el = menuRef.current;
      if (!el || !el.open) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      el.open = false;
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, []);

  // Declared ABOVE the intake effect so the revealTask case can reuse this
  // exact persistence path (deps array evaluates during render).
  const selectTab = useCallback(
    (next: ViewTab) => {
      setTab(next);
      vscode.setState<PersistedState>({ tab: next });
    },
    [vscode],
  );

  // Handshake + message intake.
  useEffect(() => {
    // Exhaustive intake over HostToWebview: the default arm's assertNever
    // fails `tsc` when a protocol member lacks a case, so no host message is
    // ever silently dropped here.
    const handler = (event: MessageEvent<HostToWebview>): void => {
      const msg = event.data;
      switch (msg.type) {
        case 'model':
          storeRef.current = new StatusStore<TaskVM>(msg.tasks);
          setStoreVersion((v) => v + 1);
          setModel(msg);
          setLastModelAt(Date.now());
          setError(null);
          applyTheme(msg.themeKind);
          break;
        case 'docContent':
          setDocContent({ path: msg.path, content: msg.content });
          break;
        case 'setup':
          // Latest snapshot wins; the host re-posts on every evaluation so
          // the SETUP tab can never render stale cards.
          setSetup(msg);
          break;
        case 'revealSetup':
          selectTab('SETUP');
          break;
        case 'update':
          // Batched into ONE rAF flush by the store; no setState here —
          // subscribers (TasksView) re-render only what changed.
          storeRef.current?.applyBatch(msg.changed.map((c) => ({ id: c.id, status: c.status })));
          break;
        case 'status':
          if (msg.kind === 'error') setError(msg.message);
          break;
        case 'theme':
          applyTheme(msg.themeKind);
          break;
        case 'revealTask':
          // Same selectTab path as a manual click ⇒ persisted-tab behavior
          // (vscode.setState) stays identical.
          selectTab('TASKS');
          setHighlightId(msg.taskId);
          break;
        default:
          assertNever(msg);
      }
    };
    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', handler);
  }, [vscode, selectTab]);

  const openFile = useCallback(
    (path: string) => {
      vscode.postMessage({ type: 'openFile', path });
    },
    [vscode],
  );

  if (!model) {
    return (
      <main className="archgen-root">
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
        <LoadingState />
      </main>
    );
  }

  const hasArchgenContent = model.tasks.length > 0 || model.docs.length > 0 || model.codegraph.product !== 'unsupported';

  // ERROR STATE (todo 13): the last-good model stays mounted and interactive
  // content is dimmed via CSS while the dismissible top-center banner shows.
  const dimmed = error !== null;

  return (
    <main className={`archgen-root${dimmed ? ' archgen-root--dimmed' : ''}`} data-testid="archgen-root">
      <ErrorBanner message={error} onDismiss={() => setError(null)} />
      <nav className="archgen-tabs" role="tablist" aria-label="ArchGen views">
        {VIEW_TABS.map((t) => (
          <button
            key={t}
            role="tab"
            type="button"
            aria-selected={tab === t}
            className={`archgen-tab${tab === t ? ' is-active' : ''}`}
            onClick={() => selectTab(t)}
          >
            {t}
          </button>
        ))}
        <StaleChip since={lastModelAt} />
        <details className="archgen-menu" ref={menuRef}>
          <summary aria-label="More actions" title="More actions">⋯</summary>
          <div className="archgen-menu-items">
            <button
              type="button"
              className="archgen-menu-item"
              onClick={() => {
                closeMenu();
                selectTab('SETUP');
              }}
            >
              Setup &amp; updates
            </button>
            <button
              type="button"
              className="archgen-menu-item"
              onClick={() => {
                closeMenu();
                vscode.postMessage({ type: 'copyInstall' });
              }}
            >
              Copy install prompt
            </button>
          </div>
        </details>
      </nav>

      {/* Feature picker lives in the TASKS tab header; absent with no
          features so the empty-state UX is untouched. */}
      {tab === 'TASKS' && model.features.length > 0 && (
        <div className="archgen-feature-bar">
          <FeaturePicker
            features={model.features}
            activeSlug={model.activeSlug}
            onSelect={(slug) => {
              // A feature swap replaces the whole DAG — clear any reveal so
              // the spotlight never points at a node from the previous board.
              setHighlightId(null);
              vscode.postMessage({ type: 'selectFeature', slug });
            }}
          />
        </div>
      )}

      {/* GATING ORDER: SETUP is evaluated BEFORE the hasArchgenContent
          fallback — the empty-state branch used to short-circuit every tab,
          so in an empty workspace (where setup matters most) selecting or
          revealing SETUP re-rendered the "No ArchGen plan found" state and
          read as a dead button. */}
      {tab === 'SETUP' ? (
        setup !== null ? (
          <SetupView
            state={setup.state}
            actions={setup.actions}
            extVersion={setup.extVersion}
            post={(msg) => vscode.postMessage(msg)}
          />
        ) : (
          <p className="archgen-hint">Setup status arrives with the next evaluation…</p>
        )
      ) : !hasArchgenContent ? (
        <EmptyState
          hasArchgenFolder={model.warnings.some((w) => w.includes('.archgen'))}
          onSelectSetup={() => selectTab('SETUP')}
          setup={setup?.state ?? null}
          post={(msg) => vscode.postMessage(msg)}
        />
      ) : tab === 'TASKS' ? (
        model.tasks.length > 0 && storeRef.current ? (
          <TasksView
            tasks={model.tasks}
            store={storeRef.current}
            highlightId={highlightId}
            onBuild={(taskId) => vscode.postMessage({ type: 'build', taskId })}
            onStartWork={() => vscode.postMessage({ type: 'startWork' })}
          />
        ) : (
          <EmptyState
            hasArchgenFolder
            onSelectSetup={() => selectTab('SETUP')}
            setup={setup?.state ?? null}
            post={(msg) => vscode.postMessage(msg)}
          />
        )
      ) : tab === 'CODE' ? (
        <CodeGraphView vm={model.codegraph} />
      ) : (
        <DocsView
          docs={model.docs}
          active={docContent}
          onSelect={(path) => vscode.postMessage({ type: 'openDoc', path })}
          onOpenInEditor={openFile}
        />
      )}
    </main>
  );
}
