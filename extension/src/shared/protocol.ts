// Shared message protocol between host (extension) and webview.
// Imported by BOTH sides — keep it dependency-free and JSON-serializable.
import { TASK_STATUSES, type TaskStatus, isTaskStatus } from './status';

export { TASK_STATUSES };
export type { TaskStatus };
export { isTaskStatus };

export interface TaskVM {
  id: string;
  title: string;
  status: TaskStatus;
  dependsOn: string[];
  fileOwnership: string[];
  artifacts: string[];
  parallelGroup?: string | null;
}

export interface DocRef {
  /** workspace-relative path of the markdown file */
  path: string;
  title: string;
}

export type CodegraphProduct = 'colby' | 'optave' | 'unsupported';

export interface CodegraphVM {
  product: CodegraphProduct;
  /** present when product !== 'unsupported' */
  nodes?: Array<{ id: string; label: string; kind: string; file: string; line: number }>;
  edges?: Array<{ source: string; target: string; kind: string }>;
  /** human-readable reason when unsupported */
  unsupportedReason?: string;
}

/** Full snapshot sent on open/refresh. */
export interface ArchgenModelMessage {
  type: 'model';
  tasks: TaskVM[];
  docs: DocRef[];
  codegraph: CodegraphVM;
  themeKind: ThemeKind;
  warnings: string[];
}

/** Minimal diff sent when only statuses changed (watcher pipeline). */
export interface ArchgenUpdateMessage {
  type: 'update';
  changed: Array<{ id: string; status: TaskStatus }>;
}

export interface ArchgenStatusMessage {
  type: 'status';
  kind: 'info' | 'warn' | 'error';
  message: string;
}

export type ThemeKind = 'light' | 'dark' | 'highContrast' | 'highContrastLight';

export type HostToWebview = ArchgenModelMessage | ArchgenUpdateMessage | ArchgenStatusMessage | { type: 'theme'; themeKind: ThemeKind };

export interface WebviewReadyMessage {
  type: 'ready';
}

export interface WebviewOpenFileMessage {
  type: 'openFile';
  /** absolute or workspace-relative fs path */
  path: string;
  line?: number;
}

export interface WebviewBuildMessage {
  type: 'build';
  taskId: string;
}

export type WebviewToHost = WebviewReadyMessage | WebviewOpenFileMessage | WebviewBuildMessage;
