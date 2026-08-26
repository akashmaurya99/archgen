// extension.ts — activation entry (host bundle: dist/extension.js).
import { commands, env, ExtensionContext, OutputChannel, workspace, window } from 'vscode';
import { ArchgenPanel, PanelHostOptions, registerBoard } from './panel';
import { ModelHub } from './hub';
import {
  composeStartWorkPayload,
  composeTaskPrompt,
  createDelivery,
  type DeliveryMode,
} from './delivery';
import { registerSidebar } from './sidebar';
import type { SidebarActions } from './sidebar/actions';
import { registerSetupStatusBar, registerStatusBar } from './statusbar';
import { createWatchPipeline, type WatchPipeline } from './watchers';
import { createSingleFollowup, createThrottle } from './debounce';
import { codegraphDbStat, detectCodegraph, openCodegraph } from './codegraph';
import { activeFeatureKey, buildScopedModel, discoverFeatures } from './features';
import {
  composeInitPlanPrompt,
  composeInstallPrompt,
  composeUpdatePrompt,
  evaluateSetup,
  pendingActions,
  resolveSetupAction,
} from './setup';
import type { SetupState } from './setup';
import {
  DEFAULT_TEMPLATES,
  ScriptsNotFoundError,
  describeExit,
  interpolateTemplate,
  launchHarness,
  loadWaves,
  outfileForTask,
  probeScriptsPath,
  type HarnessId,
} from './harness';
import type { ArchgenModelMessage, ArchgenSetupMessage, WebviewCopyInitPlanMessage } from '../shared/protocol';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const HARNESS_IDS: HarnessId[] = ['claude', 'opencode', 'codex', 'gemini', 'custom'];

/** State before the first probe completes: treated as "skill missing" but never notified on. */
const INITIAL_SETUP: SetupState = {
  skill: { installed: false, path: null, version: null },
  planInitialized: false,
  upToDate: null,
};

/** Strict-semver guard for untyped packageJSON surfaces; anything else falls back so comparisons stay numeric. */
function semverOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value) ? value : fallback;
}

/** The skill ROOT sits one level above the probed scripts dir (…/archgen/scripts → …/archgen). */
function skillRootOf(scriptsPath: string): string {
  return scriptsPath.replace(/[\\/]+scripts[\\/]?$/, '');
}

export function activate(context: ExtensionContext): void {
  const out: OutputChannel = window.createOutputChannel('ArchGen');
  context.subscriptions.push(out);

  // ONE fan-out point: every consumer (board panel, sidebar trees, status
  // bar) rides the same model snapshots produced by pushModel().
  const hub = new ModelHub();
  context.subscriptions.push(hub);

  // Clipboard-first delivery: agent buttons copy prompts instead of spawning
  // CLIs; archgen.delivery.mode = "spawn" restores the legacy harness path.
  // autoFillChat is a live getter so flipping the setting needs no reload.
  const delivery = createDelivery(
    {
      clipboard: env.clipboard,
      commands,
      notify: (message, ...actions) => window.showInformationMessage(message, ...actions),
      log: (line) => out.appendLine(line),
    },
    {
      get autoFillChat() {
        return setting<boolean>('delivery.autoFillChat', true);
      },
    },
  );

  let pipeline: WatchPipeline | null = null;
  let currentTasks: ArchgenModelMessage['tasks'] = [];

  const root = (): string | null => workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;

  /** Entry-point guard: with no folder open every board path is a silent noop — say so instead. */
  function requireWorkspaceFolder(): boolean {
    if (root() !== null) return true;
    void window.showInformationMessage('Open a folder to use ArchGen.');
    return false;
  }

  // Proactive setup UX: latest probe result for this workspace, re-evaluated
  // on activation and on every coalesced watcher batch.
  let latestSetup: SetupState = INITIAL_SETUP;
  const extVersion = semverOr(context.extension?.packageJSON?.version, '0.0.0');

  function setting<T>(section: string, fallback: T): T {
    return workspace.getConfiguration('archgen').get<T>(section, fallback);
  }

  /** Slug persisted for this workspace, if any. */
  function storedSlug(wsRoot: string): string | undefined {
    return context.workspaceState.get<string>(activeFeatureKey(wsRoot));
  }

  // DB-STAT GATE for codegraph snapshots (todo 6): snapshotting 60k–150k nodes
  // is O(MB) of SQLite work, and visible/focus/watcher events fire pushModel
  // constantly. The index is re-read ONLY when its file moved (mtimeMs+size);
  // otherwise the cached slice object is reused VERBATIM — panel.post digests
  // codegraph by object identity, so reuse also skips the multi-MB
  // JSON.stringify the fingerprint used to run per event. `force` deliberately
  // does NOT bypass this gate (it only invalidates the panel's dedupe): any
  // real DB write moves the stat, and the .codegraph/** watcher re-pushes on
  // exactly that signal, so freshness never depends on forced re-reads.
  let lastCodegraphDbPath: string | null = null;
  let lastCodegraphStat: { mtimeMs: number; size: number } | null = null;
  let lastCodegraphSlice: ArchgenModelMessage['codegraph'] | null = null;

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
    // Stat check BEFORE any SQLite work; detectCodegraph is existsSync-cheap.
    const detected = detectCodegraph(wsRoot);
    const stat = detected.dbPath !== null ? codegraphDbStat(detected.dbPath) : null;
    if (
      stat !== null &&
      stat.exists &&
      lastCodegraphSlice !== null &&
      lastCodegraphDbPath === detected.dbPath &&
      lastCodegraphStat !== null &&
      lastCodegraphStat.mtimeMs === stat.mtimeMs &&
      lastCodegraphStat.size === stat.size
    ) {
      return lastCodegraphSlice;
    }
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
        if (stat !== null && stat.exists) {
          // Cache against the stat captured BEFORE the read: a write racing
          // the snapshot then misses the gate on the next push and re-reads.
          lastCodegraphDbPath = detected.dbPath;
          lastCodegraphStat = { mtimeMs: stat.mtimeMs, size: stat.size };
          lastCodegraphSlice = vm;
        }
        return vm;
      } finally {
        reader.close();
      }
    } catch (e) {
      // A failed read must never serve a stale slice afterwards.
      lastCodegraphDbPath = null;
      lastCodegraphStat = null;
      lastCodegraphSlice = null;
      return {
        product: 'unsupported' as const,
        unsupportedReason: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * Build one snapshot, fan it out through the hub, then post to the board.
   * `force` invalidates ONLY the panel's fingerprint dedupe (re-send); the
   * codegraph DB stat gate above decides whether the index is re-read.
   */
  function pushModel(force = false): void {
    const model = buildModel();
    hub.fire(model);
    const panel = ArchgenPanel.active;
    if (!panel) return;
    if (force) panel.invalidateModel();
    panel.post(model);
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
      // Sanitized + pinned inside tmpdir (tasks.yaml is a supply-chain surface).
      outfile: outfileForTask(taskId),
    });
  }

  // ---- Workspace-trust gate (enterprise security, todo 5) ------------------
  // Spawn mode executes repo-contained skill scripts (next-tasks.mjs via
  // loadWaves, plus the harness CLI it dispatches) — arbitrary code straight
  // off a freshly cloned repo — so it requires workspace trust. Clipboard
  // mode stays allowed when untrusted: copying a prompt spawns nothing.
  // Distinct from maybeNotifySetup's isTrusted check, which only mutes toasts.
  const UNTRUSTED_SPAWN_WARNING = 'ArchGen: workspace is untrusted — enable trust to dispatch agents';

  /** Refuse spawn dispatch in an untrusted workspace (warning + audit line); clipboard is never blocked. */
  function spawnBlockedByTrust(what: string): boolean {
    if (workspace.isTrusted || setting<DeliveryMode>('delivery.mode', 'clipboard') !== 'spawn') return false;
    out.appendLine(`[harness] ${what} blocked: workspace is untrusted`);
    void window.showWarningMessage(UNTRUSTED_SPAWN_WARNING);
    return true;
  }

  /**
   * Dispatch one task. Clipboard mode (default) copies the composed prompt —
   * zero processes; "spawn" runs the legacy headless harness verbatim.
   */
  function dispatchBuild(taskId: string): void {
    if (spawnBlockedByTrust(`dispatch '${taskId}'`)) return;
    // Fail-safe: anything but an explicit "spawn" stays process-free.
    if (setting<DeliveryMode>('delivery.mode', 'clipboard') !== 'spawn') {
      const wsRoot = root();
      if (!wsRoot) {
        const msg = 'Open a workspace folder before dispatching work.';
        out.appendLine(`[delivery] dispatch failed for '${taskId}': ${msg}`);
        void window.showErrorMessage(`ArchGen: ${msg}`);
        return;
      }
      const task = currentTasks.find((t) => t.id === taskId);
      void delivery.deliver('buildTask', composeTaskPrompt(taskId, task?.title ?? null));
      ArchgenPanel.active?.post({ type: 'status', kind: 'info', message: `Copied '${taskId}' prompt to clipboard.` });
      return;
    }
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

  /** Sidebar feature row / TASKS picker: persist the slug, re-post the scoped model, land on the board. */
  function selectFeature(slug: string): void {
    const wsRoot = root();
    if (!wsRoot) return;
    if (!discoverFeatures(wsRoot).some((f) => f.slug === slug)) return;
    void context.workspaceState.update(activeFeatureKey(wsRoot), slug).then(() => {
      pushModel(true);
      openBoard();
    });
  }

  /**
   * Header "Start Work". Clipboard mode (default) copies a tiered payload —
   * short trigger when the skill is installed, self-contained brief otherwise;
   * next-tasks.mjs is never run (the agent recomputes waves itself). "spawn"
   * keeps the legacy wave-1 dispatch verbatim.
   */
  function dispatchStartWork(): void {
    void (async () => {
      try {
        const wsRoot = root();
        if (!wsRoot) throw new Error('Open a workspace folder before starting work.');
        // Before ANY process work: the spawn branch runs next-tasks.mjs (loadWaves)
        // plus one harness per wave-1 task.
        if (spawnBlockedByTrust('start-work')) return;
        if (setting<DeliveryMode>('delivery.mode', 'clipboard') !== 'spawn') {
          const scoped = buildScopedModel(wsRoot, storedSlug(wsRoot));
          const active = scoped.features.find((f) => f.slug === scoped.activeSlug);
          if (!active) throw new Error('No .archgen/*/tasks.yaml found in this workspace.');
          // Probe ONCE purely to tier the payload; absence is expected, not an error.
          let scriptsDir: string | null = null;
          try {
            scriptsDir = probeScriptsPath(wsRoot, os.homedir(), setting<string>('scriptsPath', ''));
          } catch {
            scriptsDir = null;
          }
          void delivery.deliver('startWork', composeStartWorkPayload(active.slug, { scriptsDir }));
          ArchgenPanel.active?.post({ type: 'status', kind: 'info', message: 'Copied start-work prompt to clipboard.' });
          return;
        }
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

  // ---- Proactive setup UX -------------------------------------------------
  //
  // Probe ONCE per evaluation (probeScriptsPath try/catch → null-safe), read
  // the CLI-written .archgen-version stamp next to SKILL.md, and fold
  // everything into a SetupState. The extension NEVER executes installs — it
  // only composes prompts and hands them to the delivery controller.

  function dismissedKey(signature: string): string {
    return `archgen.setup.dismissed.${signature}`;
  }

  /** Ask for a one-line idea, then copy the kickoff prompt. Cancel-safe; empty means generic kickoff. */
  function promptInitPlan(): void {
    void window
      .showInputBox({
        prompt: 'One-line idea for what to build (leave empty for a generic kickoff)',
        placeHolder: 'e.g. a booking platform with payments',
      })
      .then((idea) => {
        if (idea === undefined) return;
        void delivery.deliver('setupInitPlan', composeInitPlanPrompt(idea));
      });
  }

  // Board modal already collected the idea → deliver immediately; bare messages
  // (notification action, legacy callers) keep the native InputBox.
  function handleCopyInitPlan(msg: WebviewCopyInitPlanMessage): void {
    if (typeof msg.idea === 'string') {
      void delivery.deliver('setupInitPlan', composeInitPlanPrompt(msg.idea));
      return;
    }
    promptInitPlan();
  }

  /**
   * Setup opens as the board's centered dialog — no second window anywhere.
   * openBoard() first so a cold panel exists to receive the parked reveal;
   * setPendingRevealSetup() flushes after the ready handshake (or at once on
   * an already-loaded board).
   */
  function openSetup(): void {
    if (!requireWorkspaceFolder()) return;
    openBoard();
    ArchgenPanel.active?.setPendingRevealSetup();
  }

  /**
   * Notification fatigue control: at most ONE proactive toast per
   * action+version signature per workspace. The signature is persisted the
   * moment the toast is shown, so dismissing OR ignoring both silence that
   * exact state until it changes (e.g. the skill version moves).
   */
  async function maybeNotifySetup(state: SetupState): Promise<void> {
    const action = resolveSetupAction(state);
    if (action === 'none' || !workspace.isTrusted) return;
    const signature = `${action}:${state.skill.version ?? 'unknown'}`;
    if (context.workspaceState.get<boolean>(dismissedKey(signature), false)) return;
    await context.workspaceState.update(dismissedKey(signature), true);
    let picked: string | undefined;
    if (action === 'install') {
      picked = await window.showInformationMessage(
        'ArchGen skill not found in this workspace. Set it up to drive your coding agents?',
        'Fix now',
        'Do not show again',
      );
    } else if (action === 'initPlan') {
      picked = await window.showInformationMessage(
        'ArchGen skill is ready, but this workspace has no plan yet. Initialize one?',
        'Initialize…',
        'Do not show again',
      );
    } else {
      const versioned = state.skill.version === null ? '(unknown version)' : `(v${state.skill.version})`;
      picked = await window.showInformationMessage(
        `An older ArchGen skill is installed ${versioned}. Everything works, but updating is recommended.`,
        'View update steps',
        'Do not show again',
      );
    }
    if (picked === 'Fix now' || picked === 'View update steps') openSetup();
    else if (picked === 'Initialize…') {
      openSetup();
      promptInitPlan();
    }
    // 'Do not show again' needs nothing: the signature was persisted above.
  }

  // ONE composition point for the wire payload: live evaluation and the
  // ready-handshake replay both ride this assembly, so they can never drift.
  function setupSnapshot(): ArchgenSetupMessage {
    return {
      type: 'setup',
      state: latestSetup,
      actions: pendingActions(latestSetup),
      extVersion,
    };
  }

  /** Re-probe skill + plan, refresh status item + open panel, notify at most once per signature. */
  async function evaluateSetupNow(): Promise<void> {
    const wsRoot = root();
    let probed = false;
    let skillPath: string | null = null;
    if (wsRoot !== null) {
      try {
        skillPath = probeScriptsPath(wsRoot, os.homedir(), setting<string>('scriptsPath', ''));
        probed = true;
      } catch {
        probed = false; // ScriptsNotFoundError — absence is expected, not an error.
      }
    }
    let stampRaw: string | null = null;
    if (skillPath !== null) {
      try {
        stampRaw = await fs.promises.readFile(path.join(skillRootOf(skillPath), '.archgen-version'), 'utf8');
      } catch {
        stampRaw = null; // Missing/unreadable stamp = unknown legacy install.
      }
    }
    const prevAction = resolveSetupAction(latestSetup);
    latestSetup = evaluateSetup({
      probed,
      skillPath,
      stampRaw,
      extVersion,
      planInitialized: (hub.snapshot()?.features.length ?? 0) > 0,
    });
    setupStatus.apply(latestSetup);
    // The board's setup dialog rides the same live pipeline as the model;
    // pendingActions is recomputed per post so it NEVER renders stale cards.
    // Non-model messages bypass the panel's fingerprint dedupe entirely.
    ArchgenPanel.active?.post(setupSnapshot());
    const action = resolveSetupAction(latestSetup);
    if (action === 'none' && prevAction !== 'none') out.appendLine('[setup] resolved');
    await maybeNotifySetup(latestSetup);
  }

  /**
   * DOCS sidebar click → open the board ON that document. The read+post pair
   * parks on the panel (setPendingDoc) so a cold board replays it after the
   * ready handshake instead of posting into an unmounted webview.
   */
  function openDoc(rel: string): void {
    if (!requireWorkspaceFolder()) return;
    openBoard();
    ArchgenPanel.active?.setPendingDoc(rel);
  }

  /** Flush one parked/opened doc request: traversal guard, then revealDoc + docContent. */
  function revealDoc(rel: string): void {
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
        const panel = ArchgenPanel.active;
        panel?.post({ type: 'revealDoc', path: rel });
        panel?.post({ type: 'docContent', path: rel, content });
      } catch (e) {
        ArchgenPanel.active?.post({ type: 'status', kind: 'error', message: `Cannot read ${rel}: ${e instanceof Error ? e.message : String(e)}` });
      }
    })();
  }

  // Sidebar cockpit action bag: tree providers route every click through
  // here; extension.ts owns the real command registrations below.
  const actions: SidebarActions = {
    openBoard,
    selectFeature,
    buildTask: dispatchBuild,
    revealTask: (taskId: string) => {
      openBoard();
      ArchgenPanel.active?.setPendingReveal(taskId);
    },
    openDoc,
  };

  const panelOpts: PanelHostOptions = {
    onReady: () => {
      ensurePipeline();
      pushModel(true);
    },
    // Error-containment sink for the panel's `ready` handler (and any future
    // panel diagnostics) — keeps throws visible in the ArchGen OutputChannel.
    log: (line) => out.appendLine(line),
    onVisible: () => pushModel(true),
    onBuild: dispatchBuild,
    onStartWork: dispatchStartWork,
    onOpenDoc: openDoc,
    onRevealDoc: revealDoc,
    onSelectFeature: selectFeature,
    // Setup-dialog card buttons → the EXISTING delivery flows (identical to
    // the notification/status-bar paths; no second composition anywhere).
    onCopyInstall: () => {
      void delivery.deliver('setupInstall', composeInstallPrompt());
    },
    onCopyInitPlan: handleCopyInitPlan,
    onCopyUpdate: () => {
      void delivery.deliver('setupUpdate', composeUpdatePrompt(latestSetup.skill.version, extVersion));
    },
    // Snapshot-on-ready replay: evaluations that ran before this board opened
    // posted into the void, so a late-opened board would never learn the state.
    onSetupSync: () => {
      ArchgenPanel.active?.post(setupSnapshot());
    },
  };

  function ensurePipeline(): void {
    const folder = workspace.workspaceFolders?.[0];
    if (pipeline || !folder) return;
    pipeline = createWatchPipeline(folder, {
      isVisible: () => ArchgenPanel.active?.visible ?? false,
      onRefresh: (uris) => {
        out.appendLine(`[watch] refresh after changes: ${[...uris].join(', ')}`);
        pushModel(true);
      },
      // Skill installs/updates and .archgen plan appearance both re-resolve
      // setup through the SAME coalescing debounce.
      onSetupReeval: () => {
        void evaluateSetupNow();
      },
      // Scaffold race: a root entry (.archgen/.agents/.claude) appearing or
      // vanishing re-probes IMMEDIATELY — evaluateSetupNow reads the
      // filesystem directly, so no deeper watch event needs to be delivered —
      // plus ONE trailing follow-up absorbing descendants written during
      // mkdir -p chains.
      onRootEvent: () => {
        out.appendLine('[watch] scaffold root changed');
        void evaluateSetupNow();
        rootFollowUp.trigger();
      },
    });
    context.subscriptions.push(pipeline);
  }

  function openBoard(): void {
    if (!requireWorkspaceFolder()) return;
    ensurePipeline();
    ArchgenPanel.createOrShow(context, panelOpts);
  }

  context.subscriptions.push(
    commands.registerCommand('archgen.openPanel', openBoard),
    commands.registerCommand('archgen.startWork', () => dispatchStartWork()),
    commands.registerCommand('archgen.buildTask', (taskId?: string) => {
      if (!taskId) return;
      dispatchBuild(taskId);
    }),
    commands.registerCommand('archgen.revealTask', (taskId?: string) => {
      if (!taskId) return;
      actions.revealTask(taskId);
    }),
    commands.registerCommand('archgen.selectFeature', (slug?: string) => {
      if (!slug) return;
      selectFeature(slug);
    }),
    commands.registerCommand('archgen.openDoc', (rel?: string) => {
      if (!rel) return;
      openDoc(rel);
    }),
    commands.registerCommand('archgen.openSetup', () => openSetup()),
  );

  const sidebar = registerSidebar(context, hub, actions);
  context.subscriptions.push(sidebar);
  context.subscriptions.push(registerStatusBar(context, hub));

  // Second status item: surfaces the pending setup action only, hidden in the
  // good state. apply() is driven exclusively by evaluateSetupNow().
  const setupStatus = registerSetupStatusBar(context);
  context.subscriptions.push(setupStatus);

  // Scaffold-race absorber for the root-entry watchers: every scaffold-root
  // event re-probes immediately, then ONE trailing re-eval ~600ms after the
  // LAST event catches descendants written during mkdir -p chains.
  const ROOT_REEVAL_FOLLOWUP_MS = 600;
  const rootFollowUp = createSingleFollowup(ROOT_REEVAL_FOLLOWUP_MS, () => {
    void evaluateSetupNow();
  });
  context.subscriptions.push(rootFollowUp);

  // WINDOW-FOCUS RECONCILE (enterprise safety net): even if EVERY watcher
  // event were lost (CLI run in an external terminal, alt-tab back), focusing
  // the window converges setup truth AND the board model. Throttled so
  // rapid alt-tab bursts cannot hammer the probe.
  const FOCUS_RECONCILE_MIN_MS = 3000;
  const focusReconcile = createThrottle(FOCUS_RECONCILE_MIN_MS, () => {
    out.appendLine('[watch] window-focus reconcile');
    void evaluateSetupNow();
    pushModel(true);
  });
  context.subscriptions.push(
    window.onDidChangeWindowState((state) => {
      if (state.focused) focusReconcile.run();
    }),
    focusReconcile,
  );

  // Seed the hasFeatures context key so welcome content resolves correctly
  // before any model reaches the trees (null workspace root means none).
  const wsRoot = root();
  void commands.executeCommand('setContext', 'archgen.hasFeatures', wsRoot !== null && discoverFeatures(wsRoot).length > 0);

  // Prime the hub so the sidebar cockpit shows data on activation even before
  // the board panel is ever opened.
  pushModel();

  registerBoard(context, panelOpts);

  // Setup checks must run even with NO plan on disk — hence watchers start at
  // activation (not first board open) and the first evaluation happens after
  // the hub is primed above.
  ensurePipeline();
  void evaluateSetupNow();
}

export function deactivate(): void {
  /* pipelines dispose via context.subscriptions */
}
