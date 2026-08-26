// Setup state machine tests: stamp parsing, semver comparison, the FULL
// evaluateSetup/resolveSetupAction precedence matrix, and byte-exact composer
// snapshots. Pure node — setup.ts is vscode-free by contract.
import { describe, expect, it } from 'vitest';

import {
  compareSemver,
  composeInitPlanPrompt,
  composeInstallPrompt,
  composeUpdatePrompt,
  evaluateSetup,
  parseVersionStamp,
  pendingActions,
  resolveSetupAction,
} from '../src/host/setup';
import type { EvaluateSetupInput } from '../src/host/setup';

describe('parseVersionStamp', () => {
  it('accepts a clean semver line', () => {
    expect(parseVersionStamp('1.2.3')).toBe('1.2.3');
  });

  it('trims surrounding whitespace (CLI writes a trailing newline)', () => {
    expect(parseVersionStamp('0.0.4\n')).toBe('0.0.4');
    expect(parseVersionStamp('  10.20.30  ')).toBe('10.20.30');
  });

  it('handles CRLF line endings', () => {
    expect(parseVersionStamp('1.2.3\r\n')).toBe('1.2.3');
  });

  it('rejects garbage, partial, and over-long versions as null', () => {
    expect(parseVersionStamp('not-a-version')).toBeNull();
    expect(parseVersionStamp('1.2')).toBeNull();
    expect(parseVersionStamp('1.2.3.4')).toBeNull();
    expect(parseVersionStamp('v1.2.3')).toBeNull();
    expect(parseVersionStamp('01.02.03')).toBe('01.02.03'); // digits are digits; numeric compare handles it
  });

  it('collapses null and empty input to null', () => {
    expect(parseVersionStamp(null)).toBeNull();
    expect(parseVersionStamp('')).toBeNull();
    expect(parseVersionStamp('   \n')).toBeNull();
  });
});

describe('compareSemver', () => {
  it('orders equal, less, and greater numerically (not lexically)', () => {
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('1.2.3', '1.2.4')).toBe(-1);
    expect(compareSemver('1.2.4', '1.2.3')).toBe(1);
    expect(compareSemver('9.9.9', '10.0.0')).toBe(-1); // numeric: 9 < 10
    expect(compareSemver('0.0.10', '0.0.9')).toBe(1);
  });

  it('pads missing segments as zero', () => {
    expect(compareSemver('1.2', '1.2.0')).toBe(0);
    expect(compareSemver('1', '1.0.0')).toBe(0);
    expect(compareSemver('1.2', '1.2.1')).toBe(-1);
  });

  it('treats empty segments as zero instead of NaN-poisoning the comparison', () => {
    // '1..2' parses [1, NaN, 2]; NaN pads to 0 so the result stays numeric.
    expect(compareSemver('1..2', '1.0.0')).toBe(1);
    expect(compareSemver('1..2', '1.3.0')).toBe(-1);
  });
});

function input(overrides: Partial<EvaluateSetupInput> = {}): EvaluateSetupInput {
  return {
    probed: true,
    skillPath: '/ws/.agents/skills/archgen/scripts',
    stampRaw: '0.0.4\n',
    extVersion: '0.0.4',
    planInitialized: true,
    ...overrides,
  };
}

describe('evaluateSetup + resolveSetupAction precedence matrix', () => {
  const cases: Array<{ name: string; input: EvaluateSetupInput; action: string; upToDate: boolean | null }> = [
    {
      name: 'probe failed → install wins over everything',
      input: input({ probed: false, skillPath: null, stampRaw: null, planInitialized: false }),
      action: 'install',
      upToDate: null,
    },
    {
      name: 'home-level skill present but workspace plan absent → initPlan (productivity first)',
      input: input({ planInitialized: false }),
      action: 'initPlan',
      upToDate: true,
    },
    {
      name: 'skill present, plan present, equal stamps → none',
      input: input({}),
      action: 'none',
      upToDate: true,
    },
    {
      name: 'stamp older than extension → update never blocks but is flagged',
      input: input({ stampRaw: '0.0.3\n' }),
      action: 'update',
      upToDate: false,
    },
    {
      name: 'legacy-null stamp → outdated-unknown update',
      input: input({ stampRaw: null }),
      action: 'update',
      upToDate: null,
    },
    {
      name: 'corrupt stamp → unknown legacy update',
      input: input({ stampRaw: 'garbage\n' }),
      action: 'update',
      upToDate: null,
    },
    {
      name: 'newer stamp than this extension build → ok, never downgrades the user',
      input: input({ stampRaw: '99.0.0\n' }),
      action: 'none',
      upToDate: true,
    },
    {
      name: 'install beats initPlan when BOTH skill and plan are missing',
      input: input({ probed: false, skillPath: null, stampRaw: null, planInitialized: false }),
      action: 'install',
      upToDate: null,
    },
    {
      name: 'outdated + no plan → initPlan outranks update',
      input: input({ stampRaw: '0.0.1\n', planInitialized: false }),
      action: 'initPlan',
      upToDate: false,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const state = evaluateSetup(c.input);
      expect(resolveSetupAction(state)).toBe(c.action);
      expect(state.upToDate).toBe(c.upToDate);
    });
  }

  it('keeps SkillInfo null-safety: path/version null exactly when not installed or unstamped', () => {
    const missing = evaluateSetup(input({ probed: false, skillPath: null, stampRaw: null }));
    expect(missing.skill).toEqual({ installed: false, path: null, version: null });
    const stamped = evaluateSetup(input({}));
    expect(stamped.skill).toEqual({
      installed: true,
      path: '/ws/.agents/skills/archgen/scripts',
      version: '0.0.4',
    });
  });

  it('ignores a stampRaw when no skill was found (no phantom versions)', () => {
    const state = evaluateSetup(input({ probed: false, skillPath: null, stampRaw: '1.2.3\n' }));
    expect(state.skill.version).toBeNull();
  });
});

describe('pendingActions (panel cards show full truth)', () => {
  it('healthy state shows no cards', () => {
    expect(pendingActions(evaluateSetup(input({})))).toEqual([]);
  });

  it('missing skill shows only the install card', () => {
    expect(pendingActions(evaluateSetup(input({ probed: false, skillPath: null, stampRaw: null })))).toEqual(['install']);
  });

  it('outdated skill without a plan shows initPlan AND update together', () => {
    expect(pendingActions(evaluateSetup(input({ stampRaw: '0.0.1\n', planInitialized: false })))).toEqual([
      'initPlan',
      'update',
    ]);
  });
});

describe('composers (byte-exact prompts)', () => {
  it('composeInstallPrompt hands the agent the full install-then-generate context', () => {
    expect(composeInstallPrompt()).toBe(
      [
        'The ArchGen VS Code extension could not find the archgen agent skill in this workspace.',
        '',
        '1. Run: npx archgen-skill init',
        '2. Verify that .agents/skills/archgen/SKILL.md now exists.',
        '3. Then ask me what to build, and generate the architecture following GENERATE mode, including both the verifier gate and the user approval gate.',
      ].join('\n'),
    );
  });

  it('composeInitPlanPrompt embeds the user idea between the SKILL.md read and the gates', () => {
    expect(composeInitPlanPrompt('a booking platform')).toBe(
      [
        'Read .agents/skills/archgen/SKILL.md first.',
        'Then interview me briefly and generate the architecture for: a booking platform.',
        'Follow GENERATE mode including verifier and approval gates.',
      ].join('\n'),
    );
  });

  it('composeInitPlanPrompt falls back to a generic interview when the idea is empty', () => {
    const generic = composeInitPlanPrompt('');
    expect(generic).toBe(
      [
        'Read .agents/skills/archgen/SKILL.md first.',
        'Then interview me briefly about what to build, and generate the architecture for it.',
        'Follow GENERATE mode including verifier and approval gates.',
      ].join('\n'),
    );
    // whitespace-only ideas count as empty too
    expect(composeInitPlanPrompt('   ')).toBe(generic);
  });

  it('composeUpdatePrompt names current vs target when the stamp is known', () => {
    expect(composeUpdatePrompt('0.0.3', '0.0.4')).toBe(
      [
        'The ArchGen skill in this workspace reports version 0.0.3, but the extension ships 0.0.4.',
        '',
        '1. Run: npx archgen-skill update',
        '2. Confirm that .archgen-version now reports a version >= 0.0.4.',
      ].join('\n'),
    );
  });

  it('composeUpdatePrompt uses explicit unknown-current wording for legacy installs', () => {
    const prompt = composeUpdatePrompt(null, '0.0.4');
    expect(prompt).toContain('does not report a version (a legacy install)');
    expect(prompt).toContain('the extension ships 0.0.4');
    expect(prompt).toContain('npx archgen-skill update');
    expect(prompt).toContain('reports a version >= 0.0.4');
    expect(prompt).not.toContain('reports version null');
  });
});
