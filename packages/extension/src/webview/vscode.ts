// Single-acquisition wrapper around acquireVsCodeApi.
// VS Code throws if acquireVsCodeApi is called twice per webview — this module
// guarantees exactly one acquisition for the whole bundle.
export interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | null = null;

export function getVsCodeApi(): VsCodeApi {
  if (api) return api;
  if (typeof acquireVsCodeApi !== 'function') {
    throw new Error('acquireVsCodeApi is unavailable outside a VS Code webview');
  }
  api = acquireVsCodeApi();
  return api;
}

/** Test seam: forget the cached handle (never used in production). */
export function resetVsCodeApiForTests(): void {
  api = null;
}
