// SetupView.tsx — SETUP tab (board-integrated setup UX).
//
// Renders the live setup snapshot posted by the host's evaluateSetupNow()
// through the SAME pipeline as the model (no second window, no second
// state machine). Every dynamic value arrives via postMessage and renders at
// textContent level — probe-derived paths can never inject markup. User
// intents leave as exact protocol messages: the card buttons post
// copyInstall/copyInitPlan/copyUpdate; the manual-route pills copy their
// route text locally (same clipboard pattern as EmptyState).
import { useState } from 'react';
import type { SetupAction, SetupStateLike } from '../shared/protocol';

export interface SetupViewProps {
  state: SetupStateLike;
  /** Derived pending-action list from the host (pendingActions(state)). */
  actions: SetupAction[];
  extVersion: string;
  /** Post one WebviewToHost message to the host. */
  post: (msg: { type: 'copyInstall' } | { type: 'copyInitPlan' } | { type: 'copyUpdate' }) => void;
}

/** Manual terminal route per action card; initPlan has no command — the copied prompt IS the route. */
const MANUAL_ROUTES: Record<Exclude<SetupAction, 'none'>, string> = {
  install: 'npx archgen-skill init',
  initPlan: 'see copied prompt for the generate flow',
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
  action: Exclude<SetupAction, 'none'>;
  state: SetupStateLike;
  extVersion: string;
  post: SetupViewProps['post'];
}

function ActionCard({ action, state, extVersion, post }: ActionCardProps) {
  const heading =
    action === 'install' ? 'Install the ArchGen skill'
    : action === 'initPlan' ? 'Initialize a plan'
    : 'Update the ArchGen skill';
  const body =
    action === 'install'
      ? 'No archgen skill was found in this workspace or your home directory. The prompt below gives your agent everything it needs to install archgen and generate your first architecture.'
      : action === 'initPlan'
        ? 'The skill is installed, but this workspace has no .archgen plan yet. Copy a kickoff prompt for your agent, or run the terminal command to scaffold manually.'
        : state.skill.version === null
          ? `The installed skill predates version stamping (this extension ships v${extVersion}).`
          : `Installed skill v${state.skill.version} is older than this extension (v${extVersion}).`;
  const wireMessage =
    action === 'install' ? ({ type: 'copyInstall' } as const)
    : action === 'initPlan' ? ({ type: 'copyInitPlan' } as const)
    : ({ type: 'copyUpdate' } as const);
  return (
    <div className="archgen-setup-card" data-setup-action={action}>
      <h3 className="archgen-setup-card-title">{heading}</h3>
      <p className="archgen-setup-card-body">{body}</p>
      {action === 'update' && (
        <p className="archgen-setup-reassure">Everything keeps working on older versions — updating is recommended.</p>
      )}
      <div className="archgen-setup-routes">
        <button
          type="button"
          className="archgen-setup-primary"
          onClick={() => post(wireMessage)}
        >
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

export function SetupView({ state, actions, extVersion, post }: SetupViewProps) {
  return (
    <section className="archgen-setup" aria-label="ArchGen setup">
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
        actions.map((a) =>
          a === 'none' ? null : (
            <ActionCard key={a} action={a} state={state} extVersion={extVersion} post={post} />
          ),
        )
      )}
    </section>
  );
}
