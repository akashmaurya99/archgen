// extension.ts — activation entry (host bundle: dist/extension.js).
import { commands, ExtensionContext, OutputChannel, workspace, window } from 'vscode';
import { ArchgenPanel, PanelHostOptions, registerBoard } from './panel';
import { registerLauncher } from './launcher';
import { createWatchPipeline, type WatchPipeline } from './watchers';
import { detectCodegraph, openCodegraph } from './codegraph';
import { activeFeatureKey, buildScopedModel, discoverFeatures } from './features';
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
import type { ArchgenModelMessage } from '../shared/protocol';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const HARNESS_IDS: HarnessId[] = ['claude', 'opencode', 'codex', 'gemini', 'custom'];

export function activate(context: ExtensionContext): void {
  const out: OutputChannel = window.createOutputChannel('ArchGen');
  context.subscriptions.push(out);

  let pipeline: WatchPipeline | null = null;
  let currentTasks: ArchgenModelMessage['tasks'] = [];

  const root = (): string | null => workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;

  function setting<T>(section: string, fallback: T): T {
    return workspace.getConfiguration('archgen').get<T>(section, fallback);
  }

  /** Slug persisted for this workspace, if any. */
  function storedSlug(wsRoot: string): string | undefined {
    return context.workspaceState.get<string>(activeFeatureKey(wsRoot));
  }

  /** Read .archgen/ (ALL features; DAG scoped to the active slug) + codegraph snapshot. */
  function buildModel(): ArchgenModelMessage {
    const wsRoot = root();
    const scoped = buildScopedModel(wsRoot, wsRoot ? storedSlug(wsRoot) : undefined);
    currentTasks = scoped.tasks;
    const codegraph = readCodegraph(wsRoot);
    return {
      type: 'model',
      tasks: scoped.tasks,
      docs: scoped.docs,
      codegraph,
      themeKind: 'dark',
      warnings: scoped.warnings,
      features: scoped.features,
      activeSlug: scoped.activeSlug,
    };
  }

  function readCodegraph(wsRoot: string | null): ArchgenModelMessage['codegraph'] {
    if (!wsRoot) return { product: 'unsupported', unsupportedReason: 'No workspace folder open.' };
    try {
      const { reader } = openCodegraph(wsRoot);
      try {
        // Raised snapshot caps: the full constellation rides to the Canvas MAP
        // layer; the DOM graph consumes fileRollup instead of raw nodes.
        const snap = reader.snapshot();
        const vm: ArchgenModelMessage['codegraph'] = {
          product: reader.product,
          nodes: snap.nodes,
          edges: snap.edges,
          hasFts: snap.hasFts,
        };
        try {
          vm.fileRollup = reader.fileRollup();
          vm.hubs = reader.topHubs(25);
        } catch {
          // Rollups are progressive enhancement — views tolerate absence.
        }
        return vm;
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

  function pushModel(force = false): void {    const panel = ArchgenPanel.active;
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

  /** TASKS-tab feature picker: persist the slug, then re-post the scoped model. */
  function selectFeature(slug: string): void {
    const wsRoot = root();
    if (!wsRoot) return;
    if (!discoverFeatures(wsRoot).some((f) => f.slug === slug)) return;
    void context.workspaceState.update(activeFeatureKey(wsRoot), slug).then(() => pushModel(true));
  }

  /** Header "Start Work": dispatch the wave-1 set from next-tasks.mjs. */
  function dispatchStartWork(): void {
    void (async () => {
      try {
        const wsRoot = root();
        if (!wsRoot) throw new Error('Open a workspace folder before starting work.');
        const scripts = probeScriptsPath(wsRoot, os.homedir(), setting<string>('scriptsPath', ''));
        const scoped = buildScopedModel(wsRoot, storedSlug(wsRoot));
        const active = scoped.features.find((f) => f.slug === scoped.activeSlug);
        if (!active) throw new Error('No .archgen/*/tasks.yaml found in this workspace.');
        const waves = await loadWaves(scripts, active.tasksPath);
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
    onSelectFeature: selectFeature,
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

  function openBoard(): void {
    ensurePipeline();
    ArchgenPanel.createOrShow(context, panelOpts);
  }

  context.subscriptions.push(commands.registerCommand('archgen.openPanel', openBoard));
  context.subscriptions.push(registerLauncher(openBoard));
  registerBoard(context, panelOpts);
}

export function deactivate(): void {
  /* pipelines dispose via context.subscriptions */
}
