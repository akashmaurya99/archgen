// KickoffModal.tsx — in-board centered replacement for the native quick-input.
// Native Quick Input has no positioning API, so the idea prompt renders as a
// fixed overlay centered inside the Task Board (no focus jump out of the
// webview). Enter submits, Escape/backdrop/Cancel dismiss; submit always
// carries the current input value — an empty string means generic kickoff.
import { useState } from 'react';

export interface KickoffModalProps {
  /** Submit with the current input value (empty string allowed = generic kickoff). */
  onSubmit: (idea: string) => void;
  /** Dismiss via Escape, backdrop click, or the Cancel button. */
  onCancel: () => void;
}

export function KickoffModal({ onSubmit, onCancel }: KickoffModalProps) {
  const [idea, setIdea] = useState('');
  return (
    <div
      className="archgen-kickoff-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Kickoff prompt"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onCancel();
      }}
      onClick={onCancel}
    >
      <div className="archgen-kickoff-card" onClick={(e) => e.stopPropagation()}>
        <h3 className="archgen-kickoff-title">Describe your idea</h3>
        <input
          type="text"
          className="archgen-kickoff-input"
          autoFocus
          aria-label="Describe your idea"
          placeholder="e.g. booking platform with payments (optional)"
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSubmit(idea);
            if (e.key === 'Escape') onCancel();
          }}
        />
        <p className="archgen-kickoff-hint">(optional — empty gives you a generic interview kickoff)</p>
        <div className="archgen-kickoff-actions">
          <button type="button" className="archgen-copy-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="archgen-setup-primary" onClick={() => onSubmit(idea)}>
            Copy prompt
          </button>
        </div>
      </div>
    </div>
  );
}
