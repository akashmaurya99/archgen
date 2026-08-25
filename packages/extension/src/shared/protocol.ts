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

/** Per-file symbol rollup row: one entry per indexed file. */
export interface FileRollupEntry {
  file: string;
  symbols: number;
  /** symbol count per kind within this file (function/class/import/module/…) */
  kinds: Record<string, number>;
}

/** Cross-file edge coalesced by (source file, target file, edge kind). */
export interface FileRollupEdge {
  source: string;
  target: string;
  kind: string;
  count: number;
}

/**
 * File-level aggregation of the code graph — feeds the DOM graph (which never
 * renders >300 nodes) while the full constellation goes to the Canvas MAP layer.
 */
export interface FileRollupVM {
  files: FileRollupEntry[];
  edges: FileRollupEdge[];
  totals: { files: number; symbols: number; edges: number };
}

/** High-degree node (in+out) anchoring the Canvas MAP constellation view. */
export interface HubVM {
  id: string;
  label: string;
  kind: string;
  file: string;
  degree: number;
}

export interface CodegraphVM {
  product: CodegraphProduct;
  /** present when product !== 'unsupported' */
  nodes?: Array<{ id: string; label: string; kind: string; file: string; line: number }>;
  edges?: Array<{ source: string; target: string; kind: string }>;
  /** whether the index exposes a nodes_fts table (host-side search available) */
  hasFts?: boolean;
  /** human-readable reason when unsupported */
  unsupportedReason?: string;
  /**
   * File-level rollup + top hubs — OPTIONAL for backward compatibility; views
   * must tolerate absence (host leaves them undefined when computation fails
   * or the product is unsupported).
   */
  fileRollup?: FileRollupVM;
  hubs?: HubVM[];
}

/** One discovered `.archgen/<slug>/` feature in a multi-feature repo. */
export interface FeatureInfo {
  slug: string;
  /** absolute workspace path of this feature's tasks.yaml */
  tasksPath: string;
  /** tasks.yaml mtime in ms — drives most-recent-first ordering */
  updatedAt: number;
}

/** Full snapshot sent on open/refresh. */
export interface ArchgenModelMessage {
  type: 'model';
  tasks: TaskVM[];
  docs: DocRef[];
  codegraph: CodegraphVM;
  themeKind: ThemeKind;
  warnings: string[];
  /**
   * Every `.archgen/<slug>/tasks.yaml` discovered under the workspace root,
   * ordered most-recently-modified FIRST. Empty when the repo has no
   * features (empty-state UX stays untouched).
   */
  features: FeatureInfo[];
  /** Slug whose DAG `tasks` currently holds — persisted choice or most-recent. */
  activeSlug: string;
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

export type HostToWebview = ArchgenModelMessage | ArchgenUpdateMessage | ArchgenStatusMessage | ArchgenDocContentMessage | { type: 'theme'; themeKind: ThemeKind };

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

/** Header "Start Work": dispatch wave-1 of next-tasks.mjs through the harness. */
export interface WebviewStartWorkMessage {
  type: 'startWork';
}

/** DOCS sidebar click: request in-panel markdown render for one doc. */
export interface WebviewOpenDocMessage {
  type: 'openDoc';
  path: string;
}

/** TASKS-tab feature picker: switch the active `.archgen/<slug>/` feature. */
export interface WebviewSelectFeatureMessage {
  type: 'selectFeature';
  slug: string;
}

export type WebviewToHost = WebviewReadyMessage | WebviewOpenFileMessage | WebviewBuildMessage | WebviewStartWorkMessage | WebviewOpenDocMessage | WebviewSelectFeatureMessage;

export interface ArchgenDocContentMessage {
  type: 'docContent';
  path: string;
  content: string;
}
