// Canonical task status enum — the SINGLE source of truth for both host and
// webview. EXACTLY six values; the tasks.schema.json contract defines no
// seventh lifecycle state, so none may be added here.
export const TASK_STATUSES = ['pending', 'ready', 'running', 'blocked', 'done', 'failed'] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export function isTaskStatus(v: unknown): v is TaskStatus {
  return typeof v === 'string' && (TASK_STATUSES as readonly string[]).includes(v);
}
