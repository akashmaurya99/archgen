// Wall-clock performance budget for parseTasks at scale.
//
// This file is EXCLUDED from the coverage run (see the "coverage" script in
// package.json, which passes --exclude '**/parsers.perf.test.ts'). v8 coverage
// instrumentation adds ~10-30% overhead to the instrumented parser, which
// distorts wall-clock timing and made the 500ms budget flaky under
// `npm run coverage`. The budget is still enforced by the plain `npm test`
// run (CI "extension" job), where no instrumentation is active and timing is
// valid. Correctness-at-scale (count / warnings / content) is asserted
// separately in parsers.test.ts so it stays covered.
import { describe, expect, it } from 'vitest';
import { parseTasks } from '../src/host/readers/archgen';

describe('parseTasks performance budget', () => {
  it('parses a 10,000-task file within the 500ms budget (generated, not committed)', () => {
    const N = 10_000;
    const lines: string[] = ['tasks:'];
    for (let i = 0; i < N; i++) {
      const id = `T-${String(i).padStart(5, '0')}`;
      lines.push(`  - id: ${id}`);
      lines.push(`    title: Enterprise task number ${i} with a realistic description`);
      lines.push(`    status: ${i % 7 === 0 ? 'done' : i % 7 === 1 ? 'running' : 'pending'}`);
      lines.push(`    depends_on: [${i > 0 ? `T-${String(i - 1).padStart(5, '0')}` : ''}]`);
      lines.push(`    file_ownership: ["src/mod${i % 50}/**"]`);
    }
    const text = lines.join('\n') + '\n';

    parseTasks(text); // warm-up: JIT-compile the hot path before timing
    const runs: number[] = [];
    for (let r = 0; r < 3; r++) {
      const t0 = performance.now();
      parseTasks(text);
      runs.push(performance.now() - t0);
    }
    // min-of-3 shields the budget from CI scheduling noise; budget is 500ms
    expect(Math.min(...runs), `runs: ${runs.map((x) => x.toFixed(1)).join(', ')}ms`).toBeLessThan(500);
  });
});
