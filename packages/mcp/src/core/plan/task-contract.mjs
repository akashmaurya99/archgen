// Canonical task-state vocabulary. The published JSON Schema mirrors this list
// and schema-parity tests reject any drift.
export const TASK_STATUSES = Object.freeze(['pending', 'ready', 'running', 'blocked', 'done', 'failed']);
