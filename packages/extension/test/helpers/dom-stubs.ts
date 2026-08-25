// dom-stubs.ts — jsdom shims required by @xyflow/react v12 in tests.
// jsdom has NO layout engine, so:
// - ResizeObserver never fires by itself → stub replays a minimal entry
//   (node observers read entry.target[data-id]; pane observers read
//   entry.contentRect — supply both).
// - offsetWidth/offsetHeight are permanently 0 → xyflow's getDimensions()
//   reads exactly those, so nodes never become "initialized" and EDGES never
//   render. Patch them to plausible positives.
// - DOMMatrixReadOnly is missing entirely → @xyflow/system constructs one per
//   updateNodeInternals to read the viewport zoom (m22); emulate identity.

export function installFlowDomStubs(): void {
  const g = globalThis as unknown as Record<string, unknown>;

  if (!g['ResizeObserver']) {
    interface FakeEntry {
      target: Element;
      contentRect: { width: number; height: number; x: number; y: number; top: number; left: number };
    }
    g['ResizeObserver'] = class {
      private cb: (entries: FakeEntry[]) => void;
      constructor(cb: (entries: FakeEntry[]) => void) {
        this.cb = cb;
      }
      observe(target: Element): void {
        // Fire on a microtask: NodeWrapper observes BEFORE the container
        // effect stores `domNode`, and updateNodeInternals bails without it.
        queueMicrotask(() => {
          this.cb([{ target, contentRect: { width: 800, height: 600, x: 0, y: 0, top: 0, left: 0 } }]);
        });
      }
      unobserve(): void {}
      disconnect(): void {}
    };
  }

  const htmlProto = HTMLElement.prototype as unknown as Record<string, unknown>;
  if (!htmlProto['__archgenOffsetPatched']) {
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get(this: HTMLElement): number {
        return this.classList.contains('react-flow__node') ? 180 : 24;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement): number {
        return this.classList.contains('react-flow__node') ? 56 : 24;
      },
    });
    htmlProto['__archgenOffsetPatched'] = true;
  }

  if (!g['DOMMatrixReadOnly']) {
    g['DOMMatrixReadOnly'] = class {
      m11 = 1;
      m22 = 1;
      m41 = 0;
      m42 = 0;
      constructor(transform?: string) {
        const m = transform && transform !== 'none' ? /matrix\(([^)]+)\)/.exec(transform) : null;
        if (m?.[1]) {
          const v = m[1].split(',').map((s) => Number(s.trim()));
          this.m11 = v[0] ?? 1;
          this.m22 = v[3] ?? 1;
          this.m41 = v[4] ?? 0;
          this.m42 = v[5] ?? 0;
        }
      }
    };
  }
}
