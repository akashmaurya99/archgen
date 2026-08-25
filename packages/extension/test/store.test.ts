// Status store: immutability, selector subscriptions, rAF batching.
import { describe, expect, it, vi } from 'vitest';
import { StatusStore } from '../src/host/store';

interface Item { id: string; status: string; title: string }

function makeItems(n: number): Item[] {
  return Array.from({ length: n }, (_, i) => ({ id: `t${i}`, status: 'pending', title: `Task ${i}` }));
}

/** Manual scheduler capturing the rAF callback. */
function manualScheduler() {
  const cbs: Array<() => void> = [];
  return {
    schedule: (cb: () => void) => { cbs.push(cb); return cb; },
    fireAll: () => { const list = cbs.splice(0); for (const cb of list) cb(); },
    get count() { return cbs.length; },
  };
}

describe('StatusStore', () => {
  it('updateById replaces the item immutably', () => {
    const items = makeItems(2);
    const store = new StatusStore<Item>(items);
    const before = store.getById('t0');
    const sched = manualScheduler();
    const s2 = new StatusStore<Item>(items, { scheduler: sched.schedule });
    s2.updateById('t0', { status: 'running' });
    const after = s2.getById('t0');
    expect(after).toEqual({ ...before, status: 'running' });
    expect(after).not.toBe(before); // new object
    expect(items[0]).toEqual({ id: 't0', status: 'pending', title: 'Task 0' }); // source untouched
  });

  it('updateById returns false for unknown ids', () => {
    const store = new StatusStore<Item>(makeItems(1), { scheduler: (cb) => cb });
    expect(store.updateById('ghost', { status: 'done' })).toBe(false);
  });

  it('100 rapid events schedule AT MOST ONE flush and notify once', () => {
    const sched = manualScheduler();
    const store = new StatusStore<Item>(makeItems(100), { scheduler: sched.schedule });
    let listenerCalls = 0;
    store.subscribeItem('t0', (it) => it.status, (s) => { listenerCalls++; expect(s).toBe(listenerCalls === 1 ? 'pending' : 'ready'); });
    expect(listenerCalls).toBe(1); // primed with current value at subscribe time
    for (let i = 0; i < 100; i++) store.updateById(`t${i}`, { status: 'ready' });
    expect(sched.count).toBe(1); // exactly ONE scheduled callback for the whole burst
    expect(store.isFlushPending).toBe(true);
    sched.fireAll();
    expect(listenerCalls).toBe(2); // exactly one notify after the burst
    expect(sched.count).toBe(0);
    expect(store.isFlushPending).toBe(false);
  });

  it('selector listeners only fire when THEIR slice changes', () => {
    const sched = manualScheduler();
    const store = new StatusStore<Item>(makeItems(3), { scheduler: sched.schedule });
    const t0Statuses: string[] = [];
    const t1Statuses: string[] = [];
    store.subscribeItem('t0', (it) => it.status, (s) => t0Statuses.push(s));
    store.subscribeItem('t1', (it) => it.status, (s) => t1Statuses.push(s));
    expect(t0Statuses).toEqual(['pending']);
    expect(t1Statuses).toEqual(['pending']);

    store.updateById('t1', { status: 'running' });
    sched.fireAll();
    expect(t0Statuses).toEqual(['pending']); // untouched
    expect(t1Statuses).toEqual(['pending', 'running']);

    // Same-value update does not re-notify the selector.
    store.updateById('t1', { status: 'running' });
    sched.fireAll();
    expect(t1Statuses).toEqual(['pending', 'running']);
  });

  it('subscribeIndex receives derived slices, never the raw array', () => {
    const sched = manualScheduler();
    const store = new StatusStore<Item>(makeItems(4), { scheduler: sched.schedule });
    const countsByStatus: Array<Record<string, number>> = [];
    store.subscribeIndex(
      (items) => {
        const counts: Record<string, number> = {};
        for (const it of items.values()) counts[it.status] = (counts[it.status] ?? 0) + 1;
        return counts;
      },
      (c) => countsByStatus.push(c),
    );
    expect(countsByStatus).toEqual([{ pending: 4 }]);
    store.updateById('t0', { status: 'done' });
    store.updateById('t1', { status: 'done' });
    sched.fireAll();
    expect(countsByStatus).toEqual([{ pending: 4 }, { pending: 2, done: 2 }]);
  });

  it('applyBatch applies many patches in one burst/flush', () => {
    const sched = manualScheduler();
    const store = new StatusStore<Item>(makeItems(5), { scheduler: sched.schedule });
    const applied = store.applyBatch([
      { id: 't0', status: 'done' },
      { id: 't1', status: 'failed' },
      { id: 'ghost', status: 'done' },
    ]);
    expect(applied).toBe(2);
    expect(sched.count).toBe(1);
    sched.fireAll();
    expect(store.getById('t0')?.status).toBe('done');
    expect(store.getById('t1')?.status).toBe('failed');
  });

  it('unsubscribe stops notifications', () => {
    const sched = manualScheduler();
    const store = new StatusStore<Item>(makeItems(1), { scheduler: sched.schedule });
    const seen: string[] = [];
    const unsub = store.subscribeItem('t0', (it) => it.status, (s) => seen.push(s));
    unsub();
    store.updateById('t0', { status: 'done' });
    sched.fireAll();
    expect(seen).toEqual(['pending']); // only the prime
  });
});
