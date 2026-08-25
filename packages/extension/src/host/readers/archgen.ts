// Typed models for .archgen/ files, built on the ported YAML subset parser.
// Tolerant by design: structural problems that don't block rendering become
// ParseWarnings with line numbers; only unreadable YAML throws.
import { parseYaml, YamlComment } from './yaml.js';
import { TASK_STATUSES, TaskStatus, isTaskStatus } from '../../shared/status.js';

export interface ParseWarning {
  message: string;
  line?: number;
}

export class ArchgenParseError extends Error {
  readonly line?: number;
  constructor(message: string, line?: number) {
    super(message);
    this.name = 'ArchgenParseError';
    this.line = line;
  }
}

/** Extract "file.ext:LINE:" prefix written by the yaml parser into line info. */
function toParseError(e: unknown, filename: string): ArchgenParseError {
  const msg = e instanceof Error ? e.message : String(e);
  const m = new RegExp(`^${filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:(\\d+):\\s*(.*)$`).exec(msg);
  if (m) return new ArchgenParseError(m[2] ?? msg, Number(m[1]));
  return new ArchgenParseError(msg);
}

export interface ArchgenTask {
  id: string;
  title: string;
  status: TaskStatus;
  depends_on: string[];
  parallel_group: string | null;
  file_ownership: string[];
  artifacts: string[];
  acceptance: string[];
}

export interface TasksModel {
  tasks: ArchgenTask[];
  meta: Record<string, unknown>;
  comments: YamlComment[];
  warnings: ParseWarning[];
}

function asStringArray(v: unknown): string[] {
  if (v === null || v === undefined) return [];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === 'string');
  if (typeof v === 'string') return [v];
  return [];
}

/**
 * Parse a tasks.yaml document into a typed model.
 * - Missing status defaults to 'pending'.
 * - Unknown statuses / non-string ids become warnings, not throws.
 * - Duplicate ids and dangling depends_on references are warned.
 */
export function parseTasks(text: string, filename = 'tasks.yaml'): TasksModel {
  let parsed: ReturnType<typeof parseYaml>;
  try {
    parsed = parseYaml(text, { filename });
  } catch (e) {
    throw toParseError(e, filename);
  }
  const warnings: ParseWarning[] = [];
  const data = (parsed.data && typeof parsed.data === 'object') ? parsed.data as Record<string, unknown> : {};
  const rawTasks = Array.isArray(data['tasks']) ? data['tasks'] : [];
  const tasks: ArchgenTask[] = [];
  const seen = new Set<string>();

  rawTasks.forEach((raw, i) => {
    const lineBase = i + 1; // approximate location for warnings
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      warnings.push({ message: `tasks[${i}] is not a mapping; skipped`, line: lineBase });
      return;
    }
    const t = raw as Record<string, unknown>;
    const id = t['id'];
    if (typeof id !== 'string' || id.length === 0) {
      warnings.push({ message: `tasks[${i}] has no string id; skipped`, line: lineBase });
      return;
    }
    if (seen.has(id)) warnings.push({ message: `duplicate task id '${id}'`, line: lineBase });
    seen.add(id);

    const statusRaw = t['status'];
    let status: TaskStatus = 'pending';
    if (statusRaw === undefined || statusRaw === null) {
      status = 'pending';
    } else if (isTaskStatus(statusRaw)) {
      status = statusRaw;
    } else {
      warnings.push({ message: `task '${id}' has invalid status ${JSON.stringify(statusRaw)}; expected one of ${TASK_STATUSES.join('|')}; using 'pending'`, line: lineBase });
    }

    tasks.push({
      id,
      title: typeof t['title'] === 'string' ? t['title'] : id,
      status,
      depends_on: asStringArray(t['depends_on']),
      parallel_group: typeof t['parallel_group'] === 'string' ? t['parallel_group'] : null,
      file_ownership: asStringArray(t['file_ownership']),
      artifacts: asStringArray(t['artifacts']),
      acceptance: asStringArray(t['acceptance']),
    });
  });

  // Dangling prerequisite references.
  for (const t of tasks) {
    for (const dep of t.depends_on) {
      if (!seen.has(dep)) warnings.push({ message: `task '${t.id}' depends on unknown task '${dep}'` });
    }
  }

  const meta = (data['meta'] && typeof data['meta'] === 'object' && !Array.isArray(data['meta']))
    ? data['meta'] as Record<string, unknown>
    : {};

  return { tasks, meta, comments: parsed.comments, warnings };
}

export interface ArchitectureModule {
  name: string;
  responsibility: string;
  owns: string[];
}

export interface ArchitectureDecision {
  id: string;
  title: string;
  context: string;
  decision: string;
  consequences: string[];
}

export interface ArchitectureModel {
  name: string;
  slug: string;
  stack: string[];
  structure: string | null;
  modules: ArchitectureModule[];
  decisions: ArchitectureDecision[];
  warnings: ParseWarning[];
}

/**
 * Parse an architecture.yaml document into a typed model.
 * NOTE: `structure` is optional — block scalars (`|`) are outside the shared
 * YAML subset, so hand-written files may omit it; a warning records that.
 */
export function parseArchitecture(text: string, filename = 'architecture.yaml'): ArchitectureModel {
  let parsed: ReturnType<typeof parseYaml>;
  try {
    parsed = parseYaml(text, { filename });
  } catch (e) {
    throw toParseError(e, filename);
  }
  const warnings: ParseWarning[] = [];
  const data = (parsed.data && typeof parsed.data === 'object') ? parsed.data as Record<string, unknown> : {};

  const str = (k: string): string => (typeof data[k] === 'string' ? data[k] as string : '');
  const name = str('name');
  const slug = str('slug');
  if (!name) warnings.push({ message: 'architecture.yaml is missing required key: name' });
  if (!slug) warnings.push({ message: 'architecture.yaml is missing required key: slug' });
  else if (!(/^[a-z0-9]+(-[a-z0-9]+)*$/).test(slug)) warnings.push({ message: `slug '${slug}' must be lowercase-hyphen` });

  const stack = asStringArray(data['stack']);
  const structure = typeof data['structure'] === 'string' ? data['structure'] as string : null;
  if (!structure) warnings.push({ message: 'no readable structure tree (block scalars are outside the shared YAML subset); structure omitted' });

  const modules: ArchitectureModule[] = [];
  if (Array.isArray(data['modules'])) {
    data['modules'].forEach((m, i) => {
      if (!m || typeof m !== 'object' || Array.isArray(m)) {
        warnings.push({ message: `modules[${i}] is not a mapping; skipped`, line: i + 1 });
        return;
      }
      const rec = m as Record<string, unknown>;
      modules.push({
        name: typeof rec['name'] === 'string' ? rec['name'] : `module-${i}`,
        responsibility: typeof rec['responsibility'] === 'string' ? rec['responsibility'] : '',
        owns: asStringArray(rec['owns']),
      });
    });
  } else {
    warnings.push({ message: 'architecture.yaml is missing required key: modules' });
  }

  const decisions: ArchitectureDecision[] = [];
  if (Array.isArray(data['decisions'])) {
    data['decisions'].forEach((d, i) => {
      if (!d || typeof d !== 'object' || Array.isArray(d)) {
        warnings.push({ message: `decisions[${i}] is not a mapping; skipped`, line: i + 1 });
        return;
      }
      const rec = d as Record<string, unknown>;
      decisions.push({
        id: typeof rec['id'] === 'string' ? rec['id'] : `ADR-${String(i + 1).padStart(3, '0')}`,
        title: typeof rec['title'] === 'string' ? rec['title'] : '',
        context: typeof rec['context'] === 'string' ? rec['context'] : '',
        decision: typeof rec['decision'] === 'string' ? rec['decision'] : '',
        consequences: asStringArray(rec['consequences']),
      });
    });
  }

  return { name, slug, stack, structure, modules, decisions, warnings };
}
