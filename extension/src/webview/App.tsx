// App.tsx — webview shell (todo 7): view tabs TASKS | CODE | DOCS,
// loading/empty/error states, theme attribute, message intake.
// The webview performs ZERO direct fs/network IO — everything arrives via
// postMessage from the host; every user intent leaves via postMessage.
import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  ArchgenModelMessage,
  HostToWebview,
  TaskVM,
  ThemeKind,
} from '../shared/protocol';
import { getVsCodeApi } from './vscode';
import { EmptyState, ErrorBanner, LoadingState, StatusChip, VIEW_TABS, type ViewTab } from './states';

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
          setModel(msg);
          setError(null);
          applyTheme(msg.themeKind);
          break;
        case 'update':
          setModel((prev) =>
            prev
              ? {
                  ...prev,
                  tasks: prev.tasks.map((t) => {
                    const change = msg.changed.find((c) => c.id === t.id);
                    return change ? { ...t, status: change.status } : t;
                  }),
                }
              : prev,
          );
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

  return (
    <main className="archgen-root" data-testid="archgen-root">
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
      </nav>

      {!hasArchgenContent ? (
        <EmptyState hasArchgenFolder={model.warnings.some((w) => w.includes('.archgen'))} />
      ) : tab === 'TASKS' ? (
        <TasksPlaceholder tasks={model.tasks} />
      ) : tab === 'CODE' ? (
        <CodePlaceholder product={model.codegraph.product} reason={model.codegraph.unsupportedReason} nodeCount={model.codegraph.nodes?.length ?? 0} edgeCount={model.codegraph.edges?.length ?? 0} />
      ) : (
        <DocsPlaceholder docs={model.docs} onOpen={openFile} />
      )}
    </main>
  );
}

function TasksPlaceholder({ tasks }: { tasks: TaskVM[] }) {
  if (tasks.length === 0) {
    return <EmptyState hasArchgenFolder />;
  }
  return (
    <section aria-label="Task list">
      <ul className="archgen-task-list">
        {tasks.map((t) => (
          <li key={t.id} className={`archgen-task-row archgen-node--${t.status}`} data-task-id={t.id}>
            <code className="archgen-task-id">{t.id}</code>
            <span className="archgen-task-title">{t.title}</span>
            <StatusChip status={t.status} />
          </li>
        ))}
      </ul>
      <p className="archgen-hint">Dependency canvas lands in the DAG milestone.</p>
    </section>
  );
}

function CodePlaceholder({ product, reason, nodeCount, edgeCount }: { product: string; reason?: string; nodeCount: number; edgeCount: number }) {
  if (product === 'unsupported') {
    return (
      <div className="archgen-state archgen-banner-unsupported" role="status">
        <h2>Codegraph unavailable</h2>
        <p>{reason ?? 'No supported codegraph index found in this workspace.'}</p>
      </div>
    );
  }
  return (
    <section aria-label="Code graph summary">
      <p>
        Index <strong>{product}</strong>: {nodeCount} nodes, {edgeCount} edges loaded.
      </p>
      <p className="archgen-hint">Interactive dependency graph lands in the code-graph milestone.</p>
    </section>
  );
}

function DocsPlaceholder({ docs, onOpen }: { docs: Array<{ path: string; title: string }>; onOpen: (path: string) => void }) {
  if (docs.length === 0) {
    return <EmptyState hasArchgenFolder />;
  }
  return (
    <section aria-label="Docs">
      <ul className="archgen-doc-list">
        {docs.map((d) => (
          <li key={d.path}>
            <button type="button" className="archgen-doc-link" onClick={() => onOpen(d.path)}>
              {d.title}
            </button>
          </li>
        ))}
      </ul>
      <p className="archgen-hint">Rendered markdown + mermaid lands in the docs milestone.</p>
    </section>
  );
}
