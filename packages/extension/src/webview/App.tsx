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
import type {
  ArchgenModelMessage,
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
  const [lastModelAt, setLastModelAt] = useState<number>(() => Date.now());
  const [, setStoreVersion] = useState(0);
  const storeRef = useRef<StatusStore<TaskVM> | null>(null);
  const [tab, setTab] = useState<ViewTab>(() => {
    const persisted = vscode.getState<PersistedState>();
    return persisted?.tab ?? 'TASKS';
  });

  // Handshake + message intake.
  useEffect(() => {
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
      }
    };
    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'ready' });
    return () => window.removeEventListener('message', handler);
  }, [vscode]);

  const selectTab = useCallback(
    (next: ViewTab) => {
      setTab(next);
      vscode.setState<PersistedState>({ tab: next });
    },
    [vscode],
  );

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
      </nav>

      {/* Feature picker lives in the TASKS tab header; absent with no
          features so the empty-state UX is untouched. */}
      {tab === 'TASKS' && model.features.length > 0 && (
        <div className="archgen-feature-bar">
          <FeaturePicker
            features={model.features}
            activeSlug={model.activeSlug}
            onSelect={(slug) => vscode.postMessage({ type: 'selectFeature', slug })}
          />
        </div>
      )}

      {!hasArchgenContent ? (
        <EmptyState hasArchgenFolder={model.warnings.some((w) => w.includes('.archgen'))} />
      ) : tab === 'TASKS' ? (
        model.tasks.length > 0 && storeRef.current ? (
          <TasksView
            tasks={model.tasks}
            store={storeRef.current}
            onBuild={(taskId) => vscode.postMessage({ type: 'build', taskId })}
            onStartWork={() => vscode.postMessage({ type: 'startWork' })}
          />
        ) : (
          <EmptyState hasArchgenFolder />
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
