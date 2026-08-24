// Watcher pipeline core: URI-coalescing trailing debounce (fake timers).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUriDebouncer } from '../src/host/debounce';

function uri(s: string): { toString(): string } {
  return { toString: () => s };
}

describe('createUriDebouncer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('coalesces a burst of writes to ONE flush after 300ms', () => {
    const flushes: Array<Set<string>> = [];
    const d = createUriDebouncer(300, (uris) => flushes.push(uris));
    d.push(uri('file:///ws/.archgen/demo/tasks.yaml'));
    d.push(uri('file:///ws/.archgen/demo/tasks.yaml'));
    d.push(uri('file:///ws/.archgen/demo/tasks.yaml'));
    expect(d.pending).toBe(true);
    vi.advanceTimersByTime(299);
    expect(flushes).toHaveLength(0); // trailing: nothing before the window closes
    vi.advanceTimersByTime(1);
    expect(flushes).toHaveLength(1);
    expect([...flushes[0]!]).toHaveLength(1); // same URI coalesced
    d.dispose();
  });

  it('coalesces by URI: distinct files arrive together in one batch', () => {
    const flushes: Array<Set<string>> = [];
    const d = createUriDebouncer(300, (uris) => flushes.push(uris));
    d.push(uri('file:///ws/.archgen/a/tasks.yaml'));
    d.push(uri('file:///ws/.archgen/a/architecture.yaml'));
    d.push(uri('file:///ws/.codegraph/codegraph.db'));
    vi.advanceTimersByTime(300);
    expect(flushes).toHaveLength(1);
    expect(flushes[0]!.size).toBe(3);
    d.dispose();
  });

  it('a write inside the window RESTARTS the timer (trailing semantics)', () => {
    const flushes: Array<Set<string>> = [];
    const d = createUriDebouncer(300, (uris) => flushes.push(uris));
    d.push(uri('file:///x/1.yaml'));
    vi.advanceTimersByTime(250);
    d.push(uri('file:///x/2.yaml')); // restarts window
    vi.advanceTimersByTime(250);
    expect(flushes).toHaveLength(0);
    vi.advanceTimersByTime(50);
    expect(flushes).toHaveLength(1);
    expect(flushes[0]!.size).toBe(2);
    d.dispose();
  });

  it('rapid bursts separated by >delay produce one flush per burst', () => {
    const flushes: Array<Set<string>> = [];
    const d = createUriDebouncer(300, (uris) => flushes.push(uris));
    for (let i = 0; i < 5; i++) d.push(uri('file:///burst1.yaml'));
    vi.advanceTimersByTime(300);
    for (let i = 0; i < 5; i++) d.push(uri('file:///burst2.yaml'));
    vi.advanceTimersByTime(300);
    expect(flushes).toHaveLength(2);
    d.dispose();
  });

  it('dispose cancels pending flush without firing', () => {
    const flushes: Array<Set<string>> = [];
    const d = createUriDebouncer(300, (uris) => flushes.push(uris));
    d.push(uri('file:///x.yaml'));
    d.dispose();
    vi.advanceTimersByTime(1000);
    expect(flushes).toHaveLength(0);
    expect(d.pending).toBe(false);
  });
});
