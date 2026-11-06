// Shared message protocol between host (extension) and webview.
// Imported by BOTH sides — keep it dependency-free and JSON-serializable.
import { TASK_STATUSES, type TaskStatus, isTaskStatus } from './status';
// setup.ts is vscode-free pure TS, so a TYPE-ONLY import drags no runtime
// (let alone node built-ins) into the browser bundle; it keeps the setup
// payload structurally honest instead of duplicated by hand.
import type { SetupAction, SetupState } from '../host/setup';

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
  /** Objective done-criteria from tasks.yaml — surfaced read-only in tooltips. */
  acceptance?: string[];
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
 * File-level aggregation of the code graph — feeds the DOM graph, which never
 * renders more than 300 nodes at a time (the rest is reachable through search
 * and the file-level rollup).
 */
export interface FileRollupVM {
  files: FileRollupEntry[];
  edges: FileRollupEdge[];
  totals: { files: number; symbols: number; edges: number };
}

/** High-degree node (in+out) flagged by the host for emphasis in the graph. */
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

/** The three board views. */
export type ViewTab = 'TASKS' | 'CODE' | 'DOCS';

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
  /**
   * Whether the workspace really has an `.archgen/` folder. Optional for
   * backward compatibility; when absent the webview derives it from the
   * model content (features/docs imply the folder exists).
   */
  hasArchgenFolder?: boolean;
}

/**
 * Minimal diff sent when ONLY task statuses changed (the host's watcher
 * pipeline compares the new snapshot with the previous one and ships the
 * delta instead of a full model).
 */
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

/** Sidebar/context-menu intent: open board focused on one task node. */
export interface WebviewRevealTaskMessage {
  type: 'revealTask';
  taskId: string;
}

/** Structural mirror of the host-side SetupState (see setup.ts). */
export type SetupStateLike = SetupState;
export type { SetupAction };

/** Live setup snapshot: full state truth plus the derived pending-action list. */
export interface ArchgenSetupMessage {
  type: 'setup';
  state: SetupStateLike;
  actions: SetupAction[];
  extVersion: string;
}

/** Parked-navigation intent: open the centered setup dialog once the board is up. */
export interface WebviewRevealSetupMessage {
  type: 'revealSetup';
}

/** Parked-navigation intent: land the DOCS tab on one document (path matches the following docContent). */
export interface WebviewRevealDocMessage {
  type: 'revealDoc';
  path: string;
}

/** Bridge `focus` intent: land the board on one view. */
export interface WebviewFocusViewMessage {
  type: 'focusView';
  view: ViewTab;
}

/** SETUP-tab card button: copy the install prompt for any agent chat. */
export interface WebviewCopyInstallMessage {
  type: 'copyInstall';
}

/** SETUP-tab card button: ask for an idea, then copy the plan-kickoff prompt. */
export interface WebviewCopyInitPlanMessage {
  type: 'copyInitPlan';
  /** Board-collected idea (kickoff modal); absent = host falls back to its native InputBox. */
  idea?: string;
}

/** SETUP-tab card button: copy the skill-update prompt. */
export interface WebviewCopyUpdateMessage {
  type: 'copyUpdate';
}

export type HostToWebview = ArchgenModelMessage | ArchgenUpdateMessage | ArchgenStatusMessage | ArchgenDocContentMessage | ArchgenSetupMessage | WebviewRevealTaskMessage | WebviewRevealSetupMessage | WebviewRevealDocMessage | WebviewFocusViewMessage | { type: 'theme'; themeKind: ThemeKind };

export interface WebviewReadyMessage {
  type: 'ready';
}

export interface WebviewOpenFileMessage {
  type: 'openFile';
  /** path relative to <workspace>/.archgen, or an absolute path inside the workspace */
  path: string;
  line?: number;
}

export interface WebviewBuildMessage {
  type: 'build';
  taskId: string;
}

/** Header "Start Work": dispatch wave-1 (resolved by the MCP server) through the harness. */
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

export type WebviewToHost = WebviewReadyMessage | WebviewOpenFileMessage | WebviewBuildMessage | WebviewStartWorkMessage | WebviewOpenDocMessage | WebviewSelectFeatureMessage | WebviewCopyInstallMessage | WebviewCopyInitPlanMessage | WebviewCopyUpdateMessage;

/**
 * Exhaustiveness guard for message-router switches: the `default` arm calls
 * this with the narrowed message, so adding a union member without a case
 * fails `tsc` instead of silently dropping traffic.
 */
export function assertNever(value: never): never {
  throw new Error(`Unhandled protocol message: ${JSON.stringify(value)}`);
}

export interface ArchgenDocContentMessage {
  type: 'docContent';
  path: string;
  content: string;
}
