// Pure cores of the watcher race fix (fake timers):
// - createSingleFollowup: ONE trailing re-eval ~delayMs after the LAST
//   scaffold-root event absorbs descendants written during mkdir -p chains.
// - createThrottle: leading-edge min-interval gate for the window-focus
//   reconcile safety net.
// The vscode-coupled wiring around them (watchers.ts factory, extension.ts
// subscriptions) stays MANUAL-coverage territory per the coverage-exclusion
// precedent for thin adapters.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSingleFollowup, createThrottle } from '../src/host/debounce';

describe('createSingleFollowup', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('fires exactly once ~delayMs after a single trigger', () => {
    const fn = vi.fn();
    const f = createSingleFollowup(600, fn);
    f.trigger();
    vi.advanceTimersByTime(599);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    f.dispose();
  });

  it('a burst of triggers yields ONE call timed from the LAST trigger', () => {
    const fn = vi.fn();
    const f = createSingleFollowup(600, fn);
    f.trigger();
    vi.advanceTimersByTime(250);
    f.trigger(); // restarts the window — mkdir chain still writing
    vi.advanceTimersByTime(250);
    f.trigger();
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(599);
    expect(fn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
    f.dispose();
  });

  it('dispose cancels a pending follow-up without firing', () => {
    const fn = vi.fn();
    const f = createSingleFollowup(600, fn);
    f.trigger();
    f.dispose();
    vi.advanceTimersByTime(5000);
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('createThrottle', () => {
  afterEach(() => vi.useRealTimers());

  it('runs immediately when outside the interval, drops calls inside it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const fn = vi.fn();
    const t = createThrottle(3000, fn);
    t.run();
    t.run();
    t.run();
    expect(fn).toHaveBeenCalledTimes(1); // inside window: dropped, not queued
    vi.advanceTimersByTime(3001);
    t.run();
    expect(fn).toHaveBeenCalledTimes(2);
    t.dispose();
  });

  it('defers at most ONE trailing call to the end of the window', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const fn = vi.fn();
    const t = createThrottle(3000, fn);
    t.run();
    vi.advanceTimersByTime(2000);
    t.run(); // inside window → scheduled for the remaining 1000ms
    vi.advanceTimersByTime(999);
    expect(fn).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(2);
    // And the deferred call itself opens a fresh quiet period.
    t.run();
    expect(fn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(2999);
    expect(fn).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(3);
    t.dispose();
  });

  it('dispose cancels a pending deferred call without firing', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const fn = vi.fn();
    const t = createThrottle(3000, fn);
    t.run();
    vi.advanceTimersByTime(1000);
    t.run();
    t.dispose();
    vi.advanceTimersByTime(10000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
