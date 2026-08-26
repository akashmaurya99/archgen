import { useEffect, useState } from 'react';
import type { SetupStateLike, TaskStatus } from '../shared/protocol';

export const STATUS_ORDER: TaskStatus[] = ['pending', 'ready', 'running', 'blocked', 'done', 'failed'];

/** Install hint CTA target — copyable so users can paste it into a terminal. */
export const INSTALL_COMMAND = 'npx archgen-skill init';

/** Status chip used across list placeholders until the DAG view lands (todo 8). */
export function StatusChip({ status }: { status: TaskStatus }) {
  return (
    <span className={`archgen-chip archgen-chip--${status}`} data-status={status} aria-label={`status ${status}`}>
      {status}
    </span>
  );
}

/** ArchGen brand logo SVG icon used in empty states and branding surfaces. */
export function ArchGenIcon({ className = 'archgen-state-icon', size = 36 }: { className?: string; size?: number }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path fill="currentColor" d="M10.55 2.82 L13.45 4.18 L5.45 21.18 L2.55 19.82 Z" />
      <path fill="currentColor" d="M13.22 7.60 L16.18 6.40 L21.68 19.90 L18.72 21.10 Z" />
      <circle fill="currentColor" cx="12.8" cy="11.4" r="1.6" />
      <path fill="currentColor" d="M11.85 13.8 H13.75 V15.0 L5.60 21.9 H3.70 L11.85 14.95 Z" />
    </svg>
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
  /** Latest host setup snapshot; null/undefined = unknown ⇒ legacy install guidance. */
  setup?: SetupStateLike | null;
  /** Ready-variant kickoff CTA target; opens the board's centered kickoff modal. */
  onOpenKickoffDraft?: () => void;
}

export function EmptyState({ hasArchgenFolder, setup, onOpenKickoffDraft }: EmptyDetails) {
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
      <ArchGenIcon />
      {hasArchgenFolder ? (
        <>
          <h2>No ArchGen plan found</h2>
          <p>This workspace has a <code>.archgen/</code> folder but no readable tasks yet.</p>
        </>
      ) : setup?.skill.installed === true ? (
        <>
          <h2>Ready to build.</h2>
          <p>Tell your coding agent: "generate architecture for &lt;your idea&gt;"</p>
          <button type="button" className="archgen-setup-primary" onClick={() => onOpenKickoffDraft?.()}>
            Copy kickoff prompt
          </button>
        </>
      ) : (
        <>
          <h2>No ArchGen plan found</h2>
          <p>This workspace has no <code>.archgen/</code> folder yet.</p>
          <p>
            Run <code>{INSTALL_COMMAND}</code> once to scaffold the plan, then tell your coding agent: "generate architecture for &lt;your idea&gt;".
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

// Webviews restored from an older build can carry the removed 'SETUP' tab in
// persisted state — sanitize on read so a dead value never blanks the board.
export function initialTab(persisted: unknown): ViewTab {
  return VIEW_TABS.find((t) => t === persisted) ?? 'TASKS';
}

export function useTabState(initial: ViewTab = 'TASKS'): [ViewTab, (t: ViewTab) => void] {
  return useState<ViewTab>(initial);
}
