// hub.ts — ModelHub event source (host side).
//
// Single fan-out point for ArchgenModelMessage snapshots: extension.ts fires
// each freshly built model here, and every consumer (sidebar trees, panel,
// future views) subscribes to one event and can pull the latest snapshot
// synchronously via snapshot(). The EventEmitter sits behind a tiny structural
// interface with an injectable factory so vitest can drive the hub without a
// real 'vscode' runtime; production uses vscode.EventEmitter via lazy require.
import type { Event } from 'vscode';
import type { ArchgenModelMessage } from '../shared/protocol';

/** Minimal structural surface of vscode.EventEmitter (fake-friendly). */
export interface HubEmitter<T> {
  readonly event: Event<T>;
  fire(value: T): void;
  dispose(): void;
}

function createVscodeEmitter(): HubEmitter<ArchgenModelMessage> {
  // Lazy require keeps this module importable under vitest's node env (tests
  // inject fakes and never call this); inside the esbuild host bundle
  // 'vscode' stays external so the require resolves at VS Code runtime.
  const vscode = require('vscode') as typeof import('vscode');
  return new vscode.EventEmitter<ArchgenModelMessage>();
}

export class ModelHub {
  private readonly emitter: HubEmitter<ArchgenModelMessage>;
  private latest: ArchgenModelMessage | null = null;

  constructor(createEmitter: () => HubEmitter<ArchgenModelMessage> = createVscodeEmitter) {
    this.emitter = createEmitter();
  }

  /** Store the newest model and notify every subscriber. */
  fire(m: ArchgenModelMessage): void {
    this.latest = m;
    this.emitter.fire(m);
  }

  /** Most recently fired model, or null before the first fire. */
  snapshot(): ArchgenModelMessage | null {
    return this.latest;
  }

  get onModel(): Event<ArchgenModelMessage> {
    return this.emitter.event;
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
