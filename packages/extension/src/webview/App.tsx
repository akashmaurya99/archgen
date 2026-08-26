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
import { EmptyState, ErrorBanner, LoadingState, StaleChip, VIEW_TABS, initialTab, type ViewTab } from './states';
import { TasksView } from './TasksView';
import { CodeGraphView } from './CodeGraphView';
import { DocsView } from './DocsView';
import { SetupDialog } from './SetupDialog';
import { FeaturePicker } from './FeaturePicker';
import { KickoffModal } from './KickoffModal';

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

// READY WATCHDOG (todo 2): on restart-restore the webview's first `ready` can
// land before the host's message listener exists, leaving a blank shell. Re-post
// `ready` until the first `model` arrives — 750ms for the first 10 re-posts,
// then 5s — capping at 2 minutes with an inline Retry UI so a dead host is
// never spammed forever (the host force-pushes a model on every ready, so the
// backoff also bounds host work).
const WATCHDOG_FAST_MS = 750;
const WATCHDOG_FAST_POSTS = 10;
const WATCHDOG_SLOW_MS = 5_000;
const WATCHDOG_CAP_MS = 120_000;
const WAITING_FOR_HOST_ERROR = 'ArchGen: waiting for host — click Retry';

export function App(props: AppProps) {
  const vscode = useMemo(() => props.api ?? getVsCodeApi(), [props.api]);
  const [model, setModel] = useState<ArchgenModelMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [docContent, setDocContent] = useState<{ path: string; content: string } | null>(null);
  const [setup, setSetup] = useState<ArchgenSetupMessage | null>(null);
  const [lastModelAt, setLastModelAt] = useState<number>(() => Date.now());
  const [, setStoreVersion] = useState(0);
  const storeRef = useRef<StatusStore<TaskVM> | null>(null);
  const [tab, setTab] = useState<ViewTab>(() => initialTab(vscode.getState<PersistedState>()?.tab));
  // REVEAL INTENT: task id to spotlight on the TASKS canvas; null = no reveal.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  // Kickoff modal: owned here so every in-board entry point (TASKS empty
  // state) shares one centered prompt instance.
  const [kickoffOpen, setKickoffOpen] = useState(false);
  // Centered setup dialog (⚙ button / ⋯ menu / parked revealSetup intent).
  const [setupOpen, setSetupOpen] = useState(false);
  // Header ⋯ menu: ref lets item clicks close the native <details> directly.
  const menuRef = useRef<HTMLDetailsElement | null>(null);

  // READY WATCHDOG (todo 2): refs (not state) so the timer chain never causes
  // re-renders; the message handler, visibility/focus listeners and the Retry
  // button all share them across render boundaries.
  const hasReceivedModelRef = useRef(false);
  const watchdogTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const watchdogPostsRef = useRef(0);
  const watchdogStartedAtRef = useRef(0);
  const watchdogCappedRef = useRef(false);

  const stopWatchdog = useCallback((): void => {
    if (watchdogTimerRef.current !== null) {
      clearTimeout(watchdogTimerRef.current);
      watchdogTimerRef.current = null;
    }
  }, []);

  const armWatchdog = useCallback((): void => {
    stopWatchdog();
    watchdogCappedRef.current = false;
    watchdogPostsRef.current = 0;
    watchdogStartedAtRef.current = Date.now();
    const tick = (): void => {
      if (hasReceivedModelRef.current) return;
      if (Date.now() - watchdogStartedAtRef.current >= WATCHDOG_CAP_MS) {
        watchdogCappedRef.current = true;
        watchdogTimerRef.current = null;
        setError(WAITING_FOR_HOST_ERROR);
        return;
      }
      watchdogPostsRef.current += 1;
      vscode.postMessage({ type: 'ready' });
      const delay = watchdogPostsRef.current < WATCHDOG_FAST_POSTS ? WATCHDOG_FAST_MS : WATCHDOG_SLOW_MS;
      watchdogTimerRef.current = setTimeout(tick, delay);
    };
    watchdogTimerRef.current = setTimeout(tick, WATCHDOG_FAST_MS);
  }, [vscode, stopWatchdog]);

  const retryHandshake = useCallback((): void => {
    setError(null);
    vscode.postMessage({ type: 'ready' });
    armWatchdog();
  }, [vscode, armWatchdog]);

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

  // Handshake + message intake + ready watchdog (todo 2).
  useEffect(() => {
    // Exhaustive intake over HostToWebview: the default arm's assertNever
    // fails `tsc` when a protocol member lacks a case, so no host message is
    // ever silently dropped here.
    const handler = (event: MessageEvent<HostToWebview>): void => {
      const msg = event.data;
      switch (msg.type) {
        case 'model':
          hasReceivedModelRef.current = true;
          stopWatchdog();
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
          // the setup dialog can never render stale cards.
          setSetup(msg);
          break;
        case 'revealSetup':
          setSetupOpen(true);
          break;
        case 'revealDoc':
          selectTab('DOCS');
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
    // Restart-restore can lose the first `ready` (posted before the host's
    // listener exists); visibility/focus are safe moments to re-post at once.
    const repostIfWaiting = (): void => {
      if (!hasReceivedModelRef.current && !watchdogCappedRef.current) {
        vscode.postMessage({ type: 'ready' });
      }
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') repostIfWaiting();
    };
    const onFocus = (): void => repostIfWaiting();

    window.addEventListener('message', handler);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('focus', onFocus);
    hasReceivedModelRef.current = false;
    vscode.postMessage({ type: 'ready' });
    armWatchdog();
    return () => {
      window.removeEventListener('message', handler);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('focus', onFocus);
      stopWatchdog();
    };
  }, [vscode, selectTab, armWatchdog, stopWatchdog]);

  const openFile = useCallback(
    (path: string) => {
      vscode.postMessage({ type: 'openFile', path });
    },
    [vscode],
  );

  const openKickoffDraft = useCallback((): void => setKickoffOpen(true), []);
  const cancelKickoff = useCallback((): void => setKickoffOpen(false), []);
  const submitKickoff = useCallback(
    (idea: string) => {
      vscode.postMessage({ type: 'copyInitPlan', idea });
      setKickoffOpen(false);
    },
    [vscode],
  );

  if (!model) {
    // Watchdog cap (todo 2): 2 minutes of `ready` re-posts went unanswered —
    // stop spinning and offer an explicit Retry instead of an endless loader.
    if (error === WAITING_FOR_HOST_ERROR) {
      return (
        <main className="archgen-root">
          <div className="archgen-state archgen-state--waiting" role="alert">
            <p>{error}</p>
            <button type="button" onClick={retryHandshake}>
              Retry
            </button>
          </div>
        </main>
      );
    }
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
        {/* Gear sits hard beside ⋯ so settings stay one click from the tab strip. */}
        <button
          type="button"
          className="archgen-gear-btn"
          aria-label="Open ArchGen settings"
          title="Open ArchGen settings"
          onClick={() => setSetupOpen(true)}
        >
          ⚙
        </button>
        <details className="archgen-menu" ref={menuRef}>
          <summary aria-label="More actions" title="More actions">⋯</summary>
          <div className="archgen-menu-items">
            <button
              type="button"
              className="archgen-menu-item"
              onClick={() => {
                closeMenu();
                setSetupOpen(true);
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

      {!hasArchgenContent ? (
        <EmptyState
          hasArchgenFolder={model.warnings.some((w) => w.includes('.archgen'))}
          setup={setup?.state ?? null}
          onOpenKickoffDraft={openKickoffDraft}
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
            setup={setup?.state ?? null}
            onOpenKickoffDraft={openKickoffDraft}
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

      {kickoffOpen && <KickoffModal onSubmit={submitKickoff} onCancel={cancelKickoff} />}
      {setupOpen && setup !== null && (
        <SetupDialog
          state={setup.state}
          actions={setup.actions}
          extVersion={setup.extVersion}
          post={(msg) => vscode.postMessage(msg)}
          onClose={() => setSetupOpen(false)}
        />
      )}
    </main>
  );
}
