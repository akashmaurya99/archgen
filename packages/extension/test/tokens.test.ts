// Design token tests (todo 2 acceptance):
// 1. Parse every --archgen-* token from media/webview/tokens.css.
// 2. Compute WCAG contrast ratios programmatically vs both dark surfaces.
// 3. Assert ≥4.5:1 for text-carrying colors, ≥3:1 for UI component colors
//    (WCAG 1.4.3 / 1.4.11).
// 4. Grep-prove every COLOR token carries a --vscode-* fallback alias;
//    structural literals (spacing/radius) are whitelisted with justification.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const CSS_PATH = join(HERE, '..', 'media', 'webview', 'tokens.css');
const css = readFileSync(CSS_PATH, 'utf8');

interface Token { name: string; value: string }

function parseTokens(source: string): Token[] {
  const out: Token[] = [];
  const re = /--archgen-[\w-]+\s*:\s*[^;]+;/g;
  for (const m of source.match(re) ?? []) {
    const [name, ...rest] = m.replace(/;$/, '').split(':');
    out.push({ name: name!.trim(), value: rest.join(':').trim() });
  }
  return out;
}

/** Extract the fallback hex from `var(--vscode-x, #hex)` or a bare hex value. */
function fallbackHex(value: string): string | null {
  const inVar = /var\([^,]+,\s*(#[0-9a-fA-F]{6})\s*\)/.exec(value);
  if (inVar) return inVar[1]!.toLowerCase();
  const bare = /(^|[\s(])(#[0-9a-fA-F]{6})[\s)]/.exec(value);
  return bare ? bare[2]!.toLowerCase() : null;
}

function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

export function contrastRatio(fgHex: string, bgHex: string): number {
  const l1 = luminance(fgHex);
  const l2 = luminance(bgHex);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

const CANVAS = '#0d1117';
const SURFACE = '#161b22';

/** Text colors must hit AA (4.5); UI-component colors need non-text AA (3.0). */
const TEXT_TOKENS = new Set(['--archgen-text', '--archgen-text-muted']);
/** Text rendered ON status-colored chips must contrast against those colors. */
const ON_STATUS_TOKEN = '--archgen-text-on-status';
const STATUS_UI = [
  ['--archgen-status-pending', '#8b949e'],
  ['--archgen-status-ready', '#58a6ff'],
  ['--archgen-status-running', '#d29922'],
  ['--archgen-status-blocked', '#e3b341'],
  ['--archgen-status-done', '#3fb950'],
  ['--archgen-status-failed', '#f85149'],
] as const;

describe('tokens.css design contract', () => {
  const tokens = parseTokens(css);

  it('defines the full expected token set', () => {
    const names = new Set(tokens.map((t) => t.name));
    for (const required of [
      '--archgen-canvas', '--archgen-surface', '--archgen-surface-elevated',
      '--archgen-hairline', '--archgen-focus-ring',
      '--archgen-text', '--archgen-text-muted',
      ...STATUS_UI.map(([n]) => n),
      '--archgen-font-mono', '--archgen-radius', '--archgen-space-1',
    ]) {
      expect(names.has(required), `missing token ${required}`).toBe(true);
    }
  });

  it('surfaces use the Primer dark values as fallbacks', () => {
    const byName = new Map(tokens.map((t) => [t.name, t.value]));
    expect(fallbackHex(byName.get('--archgen-canvas')!)).toBe(CANVAS);
    expect(fallbackHex(byName.get('--archgen-surface')!)).toBe(SURFACE);
    expect(fallbackHex(byName.get('--archgen-surface-elevated')!)).toBe('#21262d');
  });

  it('status palette matches the canonical hex values; NO cancelled exists', () => {
    const byName = new Map(tokens.map((t) => [t.name, t.value]));
    for (const [name, hex] of STATUS_UI) {
      expect(fallbackHex(byName.get(name)!), `${name} fallback`).toBe(hex);
    }
    expect(css.includes('cancelled')).toBe(false);
  });

  it('WCAG contrast: text ≥4.5:1 and status/UI colors ≥3:1 on BOTH dark surfaces', () => {
    // Print the math so the evidence log carries the numbers (plan todo 2 QA).
    const rows: string[] = [];
    const check = (name: string, hex: string, min: number): boolean => {
      const cCanvas = contrastRatio(hex, CANVAS);
      const cSurface = contrastRatio(hex, SURFACE);
      rows.push(`${name.padEnd(28)} ${hex}  canvas=${cCanvas.toFixed(2)}:1  surface=${cSurface.toFixed(2)}:1  (min ${min}:1)`);
      return cCanvas >= min && cSurface >= min;
    };

    let allPass = true;
    for (const t of tokens) {
      if (TEXT_TOKENS.has(t.name)) {
        const hex = fallbackHex(t.value);
        if (!hex) throw new Error(`text token ${t.name} has no resolvable fallback hex`);
        allPass = check(t.name, hex, 4.5) && allPass;
      }
    }
    for (const [name, hex] of STATUS_UI) {
      allPass = check(name, hex, 3) && allPass;
    }
    // on-status text vs every status color it may sit on:
    const byName2 = new Map(tokens.map((t) => [t.name, t.value]));
    const onStatusHex = fallbackHex(byName2.get(ON_STATUS_TOKEN)!);
    if (!onStatusHex) throw new Error(`${ON_STATUS_TOKEN} has no resolvable fallback hex`);
    for (const [, hex] of STATUS_UI) {
      const c = contrastRatio(onStatusHex, hex);
      rows.push(`${ON_STATUS_TOKEN.padEnd(28)} ${onStatusHex} vs ${hex} = ${c.toFixed(2)}:1 (min 4.5:1)`);
      if (c < 4.5) allPass = false;
    }
    console.log('\nWCAG contrast audit (computed):\n' + rows.join('\n'));
    expect(allPass).toBe(true);
  });

  it('every COLOR token carries a --vscode-* fallback alias', () => {
    // Structural literals with no VS Code counterpart are whitelisted on purpose
    // (documented in tokens.css header): spacing/radius/motion have no theme vars,
    // and inheriting an unrelated var would corrupt layout.
    const structural = /^(--archgen-(space|radius|motion)-?[\w-]*|--archgen-font-size-(xs|sm|md|xl))$/;
    const colorish = /#[0-9a-fA-F]{3,8}|rgba?\(|color-mix/;
    const offenders: string[] = [];
    for (const t of tokens) {
      if (structural.test(t.name)) continue;
      const isColorToken = colorish.test(t.value) || t.name.includes('status') || t.name.includes('fill');
      if (!isColorToken) continue;
      if (!t.value.includes('var(--vscode-')) offenders.push(`${t.name}: ${t.value}`);
    }
    expect(offenders, `tokens missing --vscode-* alias:\n${offenders.join('\n')}`).toEqual([]);
  });

  it('pulse keyframes exist and reduced-motion disables animation', () => {
    expect(css).toContain('@keyframes archgen-pulse-ring');
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    // reduced-motion block must actually neutralize animations
    const block = css.slice(css.indexOf('prefers-reduced-motion'));
    expect(block).toContain('animation-duration');
    expect(block).toContain('animation-iteration-count');
  });
});
