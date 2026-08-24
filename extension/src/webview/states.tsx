import { useState } from 'react';
import type { TaskStatus } from '../shared/protocol';

export const STATUS_ORDER: TaskStatus[] = ['pending', 'ready', 'running', 'blocked', 'done', 'failed'];

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
    <div className="archgen-state" role="status" aria-live="polite">
      <p>{label}</p>
    </div>
  );
}

export interface EmptyDetails {
  hasArchgenFolder: boolean;
}

export function EmptyState({ hasArchgenFolder }: EmptyDetails) {
  return (
    <div className="archgen-state" role="status">
      <h2>No ArchGen plan found</h2>
      {hasArchgenFolder ? (
        <p>This workspace has a <code>.archgen/</code> folder but no readable tasks yet.</p>
      ) : (
        <>
          <p>This workspace has no <code>.archgen/</code> folder yet.</p>
          <p>Scaffold one with the archgen skill, e.g.:</p>
          <pre><code>npx archgen init</code></pre>
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

/** Tab definition shared by App shell. */
export type ViewTab = 'TASKS' | 'CODE' | 'DOCS';
export const VIEW_TABS: ViewTab[] = ['TASKS', 'CODE', 'DOCS'];

export function useTabState(initial: ViewTab = 'TASKS'): [ViewTab, (t: ViewTab) => void] {
  return useState<ViewTab>(initial);
}
