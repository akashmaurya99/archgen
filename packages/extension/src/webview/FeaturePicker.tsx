// FeaturePicker.tsx — Feature selection dropdown for multi-feature repositories.
// Uses native <select> for keyboard accessibility and CSP compatibility.
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
      <div className="archgen-feature-select-wrap">
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
        <span className="archgen-feature-chevron" aria-hidden="true">▾</span>
      </div>
    </label>
  );
}
