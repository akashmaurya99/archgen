// FeaturePicker.tsx — TASKS-tab header dropdown for multi-feature repos.
// Native <select>: full keyboard support out of the box and zero CSP surface.
// The aria-label announces the CURRENT selection so screen readers hear which
// feature's DAG is mounted; options arrive host-ordered (most-recent first).
import type { FeatureInfo } from '../shared/protocol';

export interface FeaturePickerProps {
  features: FeatureInfo[];
  activeSlug: string;
  onSelect?: (slug: string) => void;
}

export function FeaturePicker({ features, activeSlug, onSelect }: FeaturePickerProps) {
  return (
    <label className="archgen-feature-picker">
      <span className="archgen-feature-label" aria-hidden="true">Feature</span>
      <select
        className="archgen-feature-select"
        aria-label={`Select ArchGen feature (currently ${activeSlug === '' ? 'none' : activeSlug})`}
        value={activeSlug}
        onChange={(e) => onSelect?.(e.target.value)}
      >
        {features.map((f) => (
          <option key={f.slug} value={f.slug}>
            {f.slug}
          </option>
        ))}
      </select>
    </label>
  );
}
