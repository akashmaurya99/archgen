// store.ts — reactive status store for the task DAG (todo 5).
//
// CONTRACT (documented for consumers; enforced by tests):
// 1. IMMUTABLE UPDATES — updateById never mutates the previous item object;
//    it replaces it with a shallow-merged copy. React memoization stays valid.
// 2. SELECTOR SUBSCRIPTIONS ONLY — listeners subscribe to a derived slice via
//    a selector function and receive only that slice. NO API hands out the
//    whole nodes array to subscribers (perf rule: never re-render on unrelated
//    changes). Listeners fire at most once per flush, and only when their
//    selected value changed (shallow equality).
// 3. rAF BATCHING — mutations collect in a dirty set and flush once per
//    animation frame via an injectable scheduler (requestAnimationFrame in the
//    webview; tests inject a manual scheduler). 100 rapid updateById calls
//    produce AT MOST ONE flush.

export type NodeStatus = 'pending' | 'ready' | 'running' | 'blocked' | 'done' | 'failed';

export interface ScheduledFlush {
  (): void;
}

export type FlushScheduler = (cb: () => void) => ScheduledFlush;

/** Default scheduler: rAF when available (webview), otherwise microtask-ish timeout (tests/node). */
export const defaultScheduler: FlushScheduler = (cb) => {
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame(cb) as unknown as ScheduledFlush;
  }
  return setTimeout(cb, 16) as unknown as ScheduledFlush;
};

function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k]);
}

interface ItemSub<T, S> {
  id: string;
  selector: (item: T) => S;
  listener: (value: S) => void;
  last: { has: boolean; value?: S };
}

interface IndexSub<T, S> {
  selector: (items: ReadonlyMap<string, T>) => S;
  listener: (value: S) => void;
  last: { has: boolean; value?: S };
}

export class StatusStore<T extends { id: string }> {
  private items = new Map<string, T>();
  private dirty = new Set<string>();
  private allDirty = false;
  private scheduled: ScheduledFlush | null = null;
  private itemSubs = new Set<ItemSub<T, unknown>>();
  private indexSubs = new Set<IndexSub<T, unknown>>();
  private readonly schedule: FlushScheduler;

  constructor(initial: T[], opts: { scheduler?: FlushScheduler } = {}) {
    for (const item of initial) this.items.set(item.id, item);
    this.schedule = opts.scheduler ?? defaultScheduler;
  }

  /** Immutable snapshot lookup — returns the stored item (treat as frozen). */
  getById(id: string): T | undefined {
    return this.items.get(id);
  }

  /** Immutable ids snapshot. */
  ids(): string[] {
    return [...this.items.keys()];
  }

  /** Number of tracked items. */
  get size(): number {
    return this.items.size;
  }

  /**
   * Immutable per-node update. Returns true when the node exists and changed.
   * The patch is applied even if deep-equal (callers decide); notification is
   * still batched and deduped by selector equality.
   */
  updateById(id: string, patch: Partial<T>): boolean {
    const current = this.items.get(id);
    if (!current) return false;
    const next = { ...current, ...patch };
    this.items.set(id, next);
    this.dirty.add(id);
    this.ensureScheduled();
    return true;
  }

  /**
   * Apply many patches in one logical burst. Returns count applied.
   * Still flushed as ONE batch.
   */
  applyBatch(patches: Array<{ id: string } & Partial<T>>): number {
    let applied = 0;
    for (const p of patches) {
      const { id, ...rest } = p;
      if (this.updateById(id, rest as Partial<T>)) applied++;
    }
    return applied;
  }

  /**
   * Subscribe to a per-node slice. Listener receives selector(item) after each
   * flush where that item changed AND the selected value differs (shallow eq).
   * Returns unsubscribe.
   */
  subscribeItem<S>(id: string, selector: (item: T) => S, listener: (value: S) => void): () => void {
    const sub: ItemSub<T, S> = { id, selector, listener, last: { has: false } };
    this.itemSubs.add(sub as ItemSub<T, unknown>);
    // Prime with current value so new subscribers render immediately.
    const cur = this.items.get(id);
    if (cur) {
      sub.last = { has: true, value: selector(cur) };
      listener(sub.last.value as S);
    }
    return () => { this.itemSubs.delete(sub as ItemSub<T, unknown>); };
  }

  /**
   * Subscribe to a store-wide derived slice (e.g. counts by status). The
   * selector receives a READONLY Map view — never the raw array. Fires once
   * per flush when the derived value differs.
   */
  subscribeIndex<S>(selector: (items: ReadonlyMap<string, T>) => S, listener: (value: S) => void): () => void {
    const sub: IndexSub<T, S> = { selector, listener, last: { has: false } };
    this.indexSubs.add(sub as IndexSub<T, unknown>);
    sub.last = { has: true, value: selector(new Map(this.items)) };
    listener(sub.last.value as S);
    return () => { this.indexSubs.delete(sub as IndexSub<T, unknown>); };
  }

  /** Whether a flush is pending (test/observability hook). */
  get isFlushPending(): boolean {
    return this.scheduled !== null || this.dirty.size > 0 || this.allDirty;
  }

  /** Force the pending flush now (tests inject schedulers; UI never calls this). */
  flush(): void {
    if (this.scheduled) {
      const s = this.scheduled;
      this.scheduled = null;
      // Cancel semantics belong to the scheduler owner; we just mark consumed.
      void s;
    }
    const changedIds = [...this.dirty];
    this.dirty.clear();
    const indexChanged = this.allDirty || changedIds.length > 0;
    this.allDirty = false;

    for (const sub of this.itemSubs) {
      if (!changedIds.includes(sub.id)) continue;
      const item = this.items.get(sub.id);
      if (!item) continue;
      const next = sub.selector(item);
      if (!sub.last.has || !shallowEqual(next, sub.last.value)) {
        sub.last = { has: true, value: next };
        sub.listener(next);
      }
    }

    if (indexChanged) {
      const view = new Map(this.items);
      for (const sub of this.indexSubs) {
        const next = sub.selector(view);
        if (!sub.last.has || !shallowEqual(next, sub.last.value)) {
          sub.last = { has: true, value: next };
          sub.listener(next);
        }
      }
    }
  }

  private ensureScheduled(): void {
    if (this.scheduled !== null) return;
    this.allDirty = true;
    this.scheduled = this.schedule(() => {
      this.scheduled = null;
      this.flush();
    });
  }
}
