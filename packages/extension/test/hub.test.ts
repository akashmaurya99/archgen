// ModelHub tests with a fake vscode.EventEmitter-compatible stub — proves the
// hub's store-latest + fan-out + dispose behavior without a real 'vscode'.
import { describe, expect, it } from 'vitest';
import type { Disposable, Event } from 'vscode';

import { ModelHub, type HubEmitter } from '../src/host/hub.js';
import type { ArchgenModelMessage } from '../src/shared/protocol.js';

class FakeEmitter<T> implements HubEmitter<T> {
  readonly fired: T[] = [];
  disposeCount = 0;
  private listeners: Array<(e: T) => void> = [];

  readonly event: Event<T> = (listener: (e: T) => void): Disposable => {
    this.listeners.push(listener);
    return {
      dispose: () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      },
    };
  };

  fire(value: T): void {
    this.fired.push(value);
    for (const listener of [...this.listeners]) listener(value);
  }

  dispose(): void {
    this.disposeCount += 1;
  }
}

function model(slug: string): ArchgenModelMessage {
  return { type: 'model', tasks: [], docs: [], codegraph: { product: 'unsupported' }, themeKind: 'dark', warnings: [], features: [], activeSlug: slug };
}

describe('ModelHub', () => {
  it('starts with a null snapshot before any fire', () => {
    const emitter = new FakeEmitter<ArchgenModelMessage>();
    const hub = new ModelHub(() => emitter);
    expect(hub.snapshot()).toBeNull();
    hub.dispose();
  });

  it('fire() stores the latest model and notifies subscribers with the payload', () => {
    const emitter = new FakeEmitter<ArchgenModelMessage>();
    const hub = new ModelHub(() => emitter);
    const seen: ArchgenModelMessage[] = [];
    hub.onModel((m) => seen.push(m));

    const first = model('alpha');
    const second = model('beta');
    hub.fire(first);
    hub.fire(second);

    expect(seen).toEqual([first, second]);
    expect(hub.snapshot()).toBe(second);
    expect(emitter.fired).toEqual([first, second]);
    hub.dispose();
  });

  it('supports multiple subscribers and honors unsubscribe', () => {
    const emitter = new FakeEmitter<ArchgenModelMessage>();
    const hub = new ModelHub(() => emitter);
    const a: unknown[] = [];
    const b: unknown[] = [];
    const subA = hub.onModel((m) => a.push(m));
    hub.onModel((m) => b.push(m));

    hub.fire(model('x'));
    subA.dispose();
    hub.fire(model('y'));

    expect(a).toHaveLength(1);
    expect(b).toHaveLength(2);
    hub.dispose();
  });

  it('dispose() delegates to the injected emitter exactly once', () => {
    const emitter = new FakeEmitter<ArchgenModelMessage>();
    const hub = new ModelHub(() => emitter);
    expect(emitter.disposeCount).toBe(0);
    hub.dispose();
    expect(emitter.disposeCount).toBe(1);
  });
});
