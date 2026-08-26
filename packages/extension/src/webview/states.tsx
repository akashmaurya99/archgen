import { useEffect, useState } from 'react';
import type { TaskStatus } from '../shared/protocol';

export const STATUS_ORDER: TaskStatus[] = ['pending', 'ready', 'running', 'blocked', 'done', 'failed'];

/** Install hint CTA target — copyable so users can paste it into a terminal. */
export const INSTALL_COMMAND = 'npx archgen-skill generate';

/** Status chip used across list placeholders until the DAG view lands (todo 8). */
export function StatusChip({ status }: { status: TaskStatus }) {
  return (
    <span className={`archgen-chip archgen-chip--${status}`} data-status={status} aria-label={`status ${status}`}>
      {status}
    </span>
  );
}

export function LoadingState({ label = 'Loading ArchGen model…' }: { label?: string }) {
  return (
    <div className="archgen-state archgen-state--loading" role="status" aria-live="polite">
      <div className="archgen-spinner" aria-hidden="true" />
      <p>{label}</p>
      <div className="archgen-skeleton-track" aria-hidden="true">
        <div className="archgen-skeleton-bar" />
      </div>
    </div>
  );
}

export interface EmptyDetails {
  hasArchgenFolder: boolean;
}

export function EmptyState({ hasArchgenFolder }: EmptyDetails) {
  const [copied, setCopied] = useState(false);

  const copyInstall = async (): Promise<void> => {
    try {
      await navigator.clipboard?.writeText(INSTALL_COMMAND);
    } catch {
      /* clipboard unavailable (tests / permissions) — feedback still shows */
    }
    setCopied(true);
  };

  return (
    <div className="archgen-state archgen-state--empty" role="status">
      <div className="archgen-state-icon" aria-hidden="true">◇</div>
      <h2>No ArchGen plan found</h2>
      {hasArchgenFolder ? (
        <p>This workspace has a <code>.archgen/</code> folder but no readable tasks yet.</p>
      ) : (
        <>
          <p>This workspace has no <code>.archgen/</code> folder yet.</p>
          <p>
            Run <code>archgen generate</code> in your repo to scaffold the plan, then reopen this board.
          </p>
          <div className="archgen-install-cta">
            <code className="archgen-install-cmd">{INSTALL_COMMAND}</code>
            <button type="button" className="archgen-copy-btn" aria-label="Copy install command" onClick={() => void copyInstall()}>
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

export function ErrorBanner({ message, onDismiss }: { message: string | null; onDismiss?: () => void }) {
  if (!message) return null;
  return (
    <div className="archgen-error-banner" role="alert">
      <span>{message}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} aria-label="Dismiss error">×</button>
      )}
    </div>
  );
}

/** "updated Ns ago" under a minute, then minutes — pure for tests. */
export function formatDataAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `updated ${s}s ago`;
  return `updated ${Math.floor(s / 60)}m ago`;
}

/** STALE-DATA CHIP (todo 13): seconds since the last full model snapshot. */
export function StaleChip({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return (
    <span className="archgen-stale-chip" role="timer" aria-label={formatDataAge(now - since)}>
      {formatDataAge(now - since)}
    </span>
  );
}

/** Tab definition shared by App shell. */
export type ViewTab = 'TASKS' | 'CODE' | 'DOCS';
export const VIEW_TABS: ViewTab[] = ['TASKS', 'CODE', 'DOCS'];

export function useTabState(initial: ViewTab = 'TASKS'): [ViewTab, (t: ViewTab) => void] {
  return useState<ViewTab>(initial);
}
