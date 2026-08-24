// extension.ts — activation entry (host bundle: dist/extension.js).
import { commands, ExtensionContext, OutputChannel, workspace, window } from 'vscode';
import { ArchgenPanel, PanelHostOptions, registerBoard } from './panel';
import { createWatchPipeline, type WatchPipeline } from './watchers';
import { detectCodegraph, openCodegraph } from './codegraph';
import { parseTasks } from './readers/archgen';
import {
  DEFAULT_TEMPLATES,
  ScriptsNotFoundError,
  describeExit,
  interpolateTemplate,
  launchHarness,
  loadWaves,
  probeScriptsPath,
  type HarnessId,
} from './harness';
import type { ArchgenModelMessage, DocRef, TaskVM } from '../shared/protocol';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const HARNESS_IDS: HarnessId[] = ['claude', 'opencode', 'codex', 'gemini', 'custom'];

export function activate(context: ExtensionContext): void {
  const out: OutputChannel = window.createOutputChannel('ArchGen');
  context.subscriptions.push(out);

  let pipeline: WatchPipeline | null = null;
  let currentTasks: TaskVM[] = [];

  const root = (): string | null => workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;

  function setting<T>(section: string, fallback: T): T {
    return workspace.getConfiguration('archgen').get<T>(section, fallback);
  }

  /** Read .archgen/ + codegraph snapshot and build the full view model. */
  function buildModel(): ArchgenModelMessage {
    const wsRoot = root();
    const warnings: string[] = [];
    let tasks: TaskVM[] = [];
    const docs: DocRef[] = [];

    if (wsRoot) {
      const archgenDir = path.join(wsRoot, '.archgen');
      const candidates: string[] = [];
      if (fs.existsSync(archgenDir)) {
        for (const entry of fs.readdirSync(archgenDir, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          const p = path.join(archgenDir, entry.name, 'tasks.yaml');
          if (fs.existsSync(p)) candidates.push(p);
        }
      }
      const tasksPath = candidates[0];
      if (tasksPath) {
        try {
          const model = parseTasks(fs.readFileSync(tasksPath, 'utf8'), path.basename(tasksPath));
          tasks = model.tasks.map((t) => ({
            id: t.id,
            title: t.title,
            status: t.status,
            dependsOn: t.depends_on,
            fileOwnership: t.file_ownership,
            artifacts: t.artifacts,
            parallelGroup: t.parallel_group,
          }));
          for (const w of model.warnings) warnings.push(`${path.basename(tasksPath)}: ${w.message}`);
        } catch (e) {
          warnings.push(`tasks.yaml unreadable: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      collectMarkdown(archgenDir, docs, archgenDir);
    }
    currentTasks = tasks;

    const codegraph = readCodegraph(wsRoot);

    return { type: 'model', tasks, docs, codegraph, themeKind: 'dark', warnings };
  }

  function readCodegraph(wsRoot: string | null): ArchgenModelMessage['codegraph'] {
    if (!wsRoot) return { product: 'unsupported', unsupportedReason: 'No workspace folder open.' };
    try {
      const { reader } = openCodegraph(wsRoot);
      try {
        const snap = reader.snapshot(1000, 2000);
        return { product: reader.product, nodes: snap.nodes, edges: snap.edges, hasFts: snap.hasFts };
      } finally {
        reader.close();
      }
    } catch (e) {
      return {
        product: 'unsupported' as const,
        unsupportedReason: e instanceof Error ? e.message : String(e),
      };
    }
  }

  function collectMarkdown(dir: string, outDocs: DocRef[], base: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) collectMarkdown(p, outDocs, base);
      else if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) {
        outDocs.push({ path: path.relative(base, p), title: e.name });
      }
    }
  }

  function pushModel(force = false): void {
    const panel = ArchgenPanel.active;
    if (!panel) return;
    if (force) panel.invalidateModel();
    panel.post(buildModel());
  }

  /** Resolve the interpolated command line for one task; surfaces typed errors. */
  function commandForTask(taskId: string): string {
    const wsRoot = root();
    if (!wsRoot) throw new Error('Open a workspace folder before dispatching work.');
    const scripts = probeScriptsPath(wsRoot, os.homedir(), setting<string>('scriptsPath', ''));
    out.appendLine(`[harness] scripts resolved at ${scripts}`);
    const harness = setting<HarnessId>('harness.default', 'claude');
    if (!HARNESS_IDS.includes(harness)) throw new Error(`Unknown harness "${harness}".`);
    const templates = { ...DEFAULT_TEMPLATES, ...setting<Record<string, string>>('harness.templates', {}) };
    const template = templates[harness];
    if (!template || template.trim() === '') throw new Error(`No command template for harness "${harness}" — set archgen.harness.templates.${harness}.`);
    const task = currentTasks.find((t) => t.id === taskId);
    const prompt =
      task?.title
        ? `Implement task ${taskId}: ${task.title}. Follow the .archgen plan; only touch files you own.`
        : `Implement task ${taskId} from the .archgen plan.`;
    return interpolateTemplate(template, {
      prompt,
      task: taskId,
      outfile: path.join(os.tmpdir(), `archgen-${taskId}.json`),
    });
  }

  /** Spawn the configured harness for one task. NEVER mutates repo files itself. */
  function dispatchBuild(taskId: string): void {
    let command: string;
    try {
      command = commandForTask(taskId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      out.appendLine(`[harness] dispatch failed for '${taskId}': ${msg}`);
      void window.showErrorMessage(`ArchGen: ${msg}`);
      return;
    }
    const wsRoot = root() ?? process.cwd();
    out.appendLine(`[harness] dispatch '${taskId}' → ${command.split(' ')[0]} (cwd=${wsRoot})`);
    const child = launchHarness({ command, cwd: wsRoot, log: (line) => out.appendLine(line) });
    child.on('exit', (code, signal) => {
      const verdict = describeExit(taskId, code, signal);
      (verdict.kind === 'info' ? window.showInformationMessage : window.showErrorMessage)(verdict.message);
    });
    ArchgenPanel.active?.post({ type: 'status', kind: 'info', message: `Dispatched '${taskId}'.` });
  }

  /** Header "Start Work": dispatch the wave-1 set from next-tasks.mjs. */
  function dispatchStartWork(): void {
    void (async () => {
      try {
        const wsRoot = root();
        if (!wsRoot) throw new Error('Open a workspace folder before starting work.');
        const scripts = probeScriptsPath(wsRoot, os.homedir(), setting<string>('scriptsPath', ''));
        const waves = await loadWaves(scripts);
        const wave1 = waves[0] ?? [];
        if (wave1.length === 0) {
          void window.showInformationMessage('ArchGen: next-tasks reports an empty first wave — nothing to start.');
          return;
        }
        out.appendLine(`[harness] start-work wave-1: [${wave1.join(', ')}]`);
        for (const id of wave1) dispatchBuild(id);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        out.appendLine(`[harness] start-work failed: ${msg}`);
        void window.showErrorMessage(`ArchGen: ${msg}`);
      }
    })();
  }

  /** DOCS sidebar click → read .archgen/<path> and post its content back. */
  function openDoc(rel: string): void {
    void (async () => {
      const wsRoot = root();
      if (!wsRoot) return;
      const abs = path.resolve(wsRoot, '.archgen', rel);
      if (!abs.startsWith(path.resolve(wsRoot, '.archgen') + path.sep)) {
        ArchgenPanel.active?.post({ type: 'status', kind: 'error', message: `Refusing to open ${rel} outside .archgen/.` });
        return;
      }
      try {
        const content = await fs.promises.readFile(abs, 'utf8');
        ArchgenPanel.active?.post({ type: 'docContent', path: rel, content });
      } catch (e) {
        ArchgenPanel.active?.post({ type: 'status', kind: 'error', message: `Cannot read ${rel}: ${e instanceof Error ? e.message : String(e)}` });
      }
    })();
  }

  const panelOpts: PanelHostOptions = {
    onReady: () => {
      ensurePipeline();
      pushModel(true);
    },
    onVisible: () => pushModel(true),
    onBuild: dispatchBuild,
    onOpenDoc: openDoc,
  };

  function ensurePipeline(): void {
    const folder = workspace.workspaceFolders?.[0];
    if (pipeline || !folder) return;
    pipeline = createWatchPipeline(folder, {
      isVisible: () => ArchgenPanel.active?.visible ?? false,
      onCatchUp: () => pushModel(true),
      onRefresh: (uris) => {
        out.appendLine(`[watch] refresh after changes: ${[...uris].join(', ')}`);
        pushModel(true);
      },
    });
    context.subscriptions.push(pipeline);
  }

  context.subscriptions.push(
    commands.registerCommand('archgen.openPanel', () => {
      ensurePipeline();
      ArchgenPanel.createOrShow(context, panelOpts);
    }),
  );
  registerBoard(context, panelOpts);
}

export function deactivate(): void {
  /* pipelines dispose via context.subscriptions */
}
