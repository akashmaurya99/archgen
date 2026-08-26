// SetupDialog.tsx — centered setup dialog (the SETUP tab, folded out of the
// tab strip). Renders inside the same fixed-overlay pattern as KickoffModal:
// backdrop click / Escape / ✕ dismiss it. Every dynamic value arrives via
// postMessage and renders at textContent level — probe-derived paths can
// never inject markup. User intents leave as exact protocol messages
// (copyInstall/copyUpdate); kickoff lives solely in the TASKS empty state and
// the notification action, so no init-plan card exists here.
import { useState } from 'react';
import type { SetupAction, SetupStateLike } from '../shared/protocol';

export interface SetupDialogProps {
  state: SetupStateLike;
  /** Derived pending-action list from the host (pendingActions(state)). */
  actions: SetupAction[];
  extVersion: string;
  /** Post one WebviewToHost message to the host. */
  post: (msg: { type: 'copyInstall' } | { type: 'copyUpdate' }) => void;
  /** Dismiss via Escape, backdrop click, or the ✕ affordance. */
  onClose: () => void;
}

/** Manual terminal route per action card. */
const MANUAL_ROUTES: Record<'install' | 'update', string> = {
  install: 'npx archgen-skill init',
  update: 'npx archgen-skill update',
};

function glyph(ok: boolean | null): { char: string; cls: string } {
  if (ok === true) return { char: '✓', cls: 'archgen-setup-glyph--ok' };
  if (ok === false) return { char: '⚠', cls: 'archgen-setup-glyph--warn' };
  return { char: '—', cls: 'archgen-setup-glyph--unknown' };
}

function SummaryRow({ label, ok, detail }: { label: string; ok: boolean | null; detail: string }) {
  const g = glyph(ok);
  return (
    <div className="archgen-setup-row">
      <span className={`archgen-setup-glyph ${g.cls}`} aria-hidden="true">{g.char}</span>
      <span className="archgen-setup-label">{label}</span>
      <span className="archgen-setup-detail">{detail}</span>
    </div>
  );
}

/** Copy pill for a card's manual route — same clipboard pattern as EmptyState. */
function RouteCopyPill({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard?.writeText(text);
    } catch {
      /* clipboard unavailable (tests / permissions) — feedback still shows */
    }
    setCopied(true);
  };
  return (
    <button type="button" className="archgen-copy-btn" aria-label={`Copy ${text}`} onClick={() => void copy()}>
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

interface ActionCardProps {
  action: 'install' | 'update';
  state: SetupStateLike;
  extVersion: string;
  post: SetupDialogProps['post'];
}

function ActionCard({ action, state, extVersion, post }: ActionCardProps) {
  const heading = action === 'install' ? 'Install the ArchGen skill' : 'Update the ArchGen skill';
  const body =
    action === 'install'
      ? 'No archgen skill was found in this workspace or your home directory. The prompt below gives your agent everything it needs to install archgen and generate your first architecture.'
      : state.skill.version === null
        ? `The installed skill predates version stamping (this extension ships v${extVersion}).`
        : `Installed skill v${state.skill.version} is older than this extension (v${extVersion}).`;
  const wireMessage = action === 'install' ? ({ type: 'copyInstall' } as const) : ({ type: 'copyUpdate' } as const);
  return (
    <div className="archgen-setup-card" data-setup-action={action}>
      <h3 className="archgen-setup-card-title">{heading}</h3>
      <p className="archgen-setup-card-body">{body}</p>
      {action === 'update' && (
        <p className="archgen-setup-reassure">Everything keeps working on older versions — updating is recommended.</p>
      )}
      <div className="archgen-setup-routes">
        <button type="button" className="archgen-setup-primary" onClick={() => post(wireMessage)}>
          Copy prompt for my agent
        </button>
        <span className="archgen-setup-manual">
          <span>Manual terminal: </span>
          <code>{MANUAL_ROUTES[action]}</code>
        </span>
        <RouteCopyPill text={MANUAL_ROUTES[action]} />
      </div>
    </div>
  );
}

export function SetupDialog({ state, actions, extVersion, post, onClose }: SetupDialogProps) {
  // initPlan intents are notification/empty-state territory — never a card here.
  const cards = actions.filter((a): a is 'install' | 'update' => a === 'install' || a === 'update');
  return (
    <div
      className="archgen-kickoff-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="ArchGen Setup"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
      onClick={onClose}
    >
      <div className="archgen-kickoff-card archgen-setup-dialog-card" onClick={(e) => e.stopPropagation()}>
        <div className="archgen-setup-dialog-head">
          <h3 className="archgen-kickoff-title">ArchGen setup</h3>
          <button type="button" className="archgen-setup-close" aria-label="Close ArchGen settings" title="Close" onClick={onClose}>
            ✕
          </button>
        </div>
        <section className="archgen-setup">
          <div className="archgen-setup-summary">
            <SummaryRow
              label="Skill"
              ok={state.skill.installed}
              detail={state.skill.installed
                ? `installed${state.skill.version !== null ? ` v${state.skill.version}` : ''} at ${state.skill.path ?? ''}`
                : 'not found'}
            />
            <SummaryRow label="Plan" ok={state.planInitialized} detail={state.planInitialized ? 'initialized' : 'no .archgen plan in this workspace'} />
            <SummaryRow
              label="Up to date"
              ok={state.upToDate}
              detail={state.upToDate === null ? 'unknown' : state.upToDate ? 'yes' : 'no'}
            />
          </div>
          {actions.length === 0 ? (
            <p className="archgen-setup-allgood">ArchGen is set up.</p>
          ) : (
            cards.map((a) => (
              <ActionCard key={a} action={a} state={state} extVersion={extVersion} post={post} />
            ))
          )}
        </section>
      </div>
    </div>
  );
}
