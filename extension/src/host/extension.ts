// extension.ts — activation entry (host bundle: dist/extension.js).
import { commands, ExtensionContext, OutputChannel, workspace, window } from 'vscode';
import { ArchgenPanel, PanelHostOptions, registerBoard } from './panel';
import { createWatchPipeline, type WatchPipeline } from './watchers';
import { detectCodegraph } from './codegraph';
import { parseTasks } from './readers/archgen';
import type { ArchgenModelMessage, DocRef, TaskVM } from '../shared/protocol';
import * as fs from 'node:fs';
import * as path from 'node:path';

export function activate(context: ExtensionContext): void {
  const out: OutputChannel = window.createOutputChannel('ArchGen');
  context.subscriptions.push(out);

  let pipeline: WatchPipeline | null = null;

  const root = (): string | null => workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;

  /** Read .archgen/ + codegraph detection and build the full view model. */
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

    const detected = wsRoot
      ? detectCodegraph(wsRoot)
      : ({ product: 'unsupported' as const, dbPath: null, reason: 'No workspace folder open.' });
    const codegraph: ArchgenModelMessage['codegraph'] = detected.product === 'unsupported'
      ? { product: 'unsupported', unsupportedReason: detected.reason }
      : { product: detected.product };

    return { type: 'model', tasks, docs, codegraph, themeKind: 'dark', warnings };
  }

  function collectMarkdown(dir: string, out: DocRef[], base: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) collectMarkdown(p, out, base);
      else if (e.isFile() && /\.(md|markdown)$/i.test(e.name)) {
        out.push({ path: path.relative(base, p), title: e.name });
      }
    }
  }

  function pushModel(force = false): void {
    const panel = ArchgenPanel.active;
    if (!panel) return;
    if (force) panel.invalidateModel();
    panel.post(buildModel());
  }

  const panelOpts: PanelHostOptions = {
    onReady: () => {
      ensurePipeline();
      pushModel(true);
    },
    onVisible: () => pushModel(true),
    onBuild: (taskId) => {
      out.appendLine(`[build] requested for task ${taskId} (harness spawn lands in wave 5)`);
      ArchgenPanel.active?.post({ type: 'status', kind: 'info', message: `Build dispatch for '${taskId}' arrives with the harness milestone.` });
    },
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
