// delivery.ts — clipboard-first agent dispatch (host side).
//
// SAFETY CONTRACT: this module NEVER spawns a process and NEVER touches the
// filesystem. It composes prompt text and hands it to injected ports
// (clipboard, commands, notifications, log) so vitest (node env) can drive it
// with fakes and no 'vscode' import; extension.ts owns the real port wiring.
// The legacy headless-CLI spawn path lives in harness.ts and stays reachable
// via archgen.delivery.mode = "spawn".
//
// Composed prompts are byte-identical to what the spawn path feeds its harness
// templates (see composeTaskPrompt), so both modes hand agents the same
// instruction — only the transport differs.

/** Values of the archgen.delivery.mode setting. */
export type DeliveryMode = 'clipboard' | 'spawn';

/** Which agent-triggering action produced a delivery (audit-log discriminator). */
export type DeliveryIntent = 'buildTask' | 'startWork' | 'setupInstall' | 'setupInitPlan' | 'setupUpdate';

/** Exact toast shown after every successful copy. */
export const DELIVERY_TOAST_TEXT = 'Prompt copied — paste into your agent chat and send';

const COPY_AGAIN_ACTION = 'Copy Again';
const OPEN_CHAT_ACTION = 'Open Chat';
const CHAT_OPEN_COMMAND = 'workbench.action.chat.open';
const CHAT_FOCUS_INPUT_COMMAND = 'workbench.action.chat.focusInput';

/**
 * Compose the per-task build prompt. MUST stay byte-identical to the `prompt`
 * string commandForTask() interpolates into harness templates so clipboard
 * mode and spawn mode dispatch the same instruction (guarded by test).
 */
export function composeTaskPrompt(taskId: string, taskTitle: string | null): string {
  return taskTitle
    ? `Implement task ${taskId}: ${taskTitle}. Follow the .archgen plan; only touch files you own.`
    : `Implement task ${taskId} from the .archgen plan.`;
}

export interface StartWorkContext {
  /** Resolved archgen scripts dir; null when the skill is not installed. */
  scriptsDir: string | null;
}

/**
 * Compose the start-work payload. When the skill is installed (scriptsDir
 * resolved) a short trigger line suffices — SKILL.md routes it. Otherwise the
 * payload must be self-contained so any agent can execute the plan cold,
 * without archgen tooling on disk.
 */
export function composeStartWorkPayload(slug: string, ctx: StartWorkContext): string {
  if (ctx.scriptsDir !== null) return `Start work on ${slug}.`;
  return [
    `Read .archgen/${slug}/tasks.yaml and execute its plan in dependency order.`,
    "Implement ONE task at a time; edit only files matched by that task's file_ownership globs.",
    'After each task, update its status in tasks.yaml (done or failed).',
    'Continue wave by wave until every task is done or blocked.',
    'Report failures with a short summary per failed task.',
  ].join('\n');
}

/** Minimal structural surface of vscode.env.clipboard (fake-friendly). */
export interface DeliveryClipboard {
  writeText(value: string): Thenable<void>;
}

/** Minimal structural surface of the vscode commands namespace (fake-friendly). */
export interface DeliveryCommands {
  executeCommand(id: string, arg?: unknown): Thenable<unknown>;
}

/** Ports delivery needs; hosts adapt real vscode APIs to these shapes. */
export interface DeliveryPorts {
  clipboard: DeliveryClipboard;
  commands: DeliveryCommands;
  /** vscode window.showInformationMessage shaped for action picks. */
  notify(message: string, ...actions: string[]): Thenable<string | undefined>;
  /** Audit sink (host passes its OutputChannel). */
  log(line: string): void;
}

export interface DeliveryConfig {
  /**
   * Best-effort pre-fill of the IDE's native chat input after copying.
   * Read at EACH deliver() call, so hosts may back it with a live settings
   * getter instead of an activation-time snapshot.
   */
  autoFillChat: boolean;
}

export interface DeliveryController {
  /**
   * Copy `text` to the clipboard, log the audit line, then offer Copy
   * Again / Open Chat actions. NEVER rejects: every port failure is swallowed
   * and logged, so fire-and-forget call sites cannot produce unhandled
   * rejections.
   */
  deliver(intent: DeliveryIntent, text: string): Promise<void>;
}

/**
 * Build the clipboard-first delivery controller. Mirrors hub.ts's injectable
 * style: pure core here, vscode adapters at the call site.
 */
export function createDelivery(ports: DeliveryPorts, config: DeliveryConfig): DeliveryController {
  let lastText = '';

  async function openChat(): Promise<void> {
    try {
      if (config.autoFillChat) {
        // Pre-fill, don't auto-send: the user reviews and presses Enter.
        await ports.commands.executeCommand(CHAT_OPEN_COMMAND, { query: lastText, isPartialQuery: true });
      } else {
        await ports.commands.executeCommand(CHAT_FOCUS_INPUT_COMMAND);
      }
    } catch {
      // Chat input APIs vary across IDEs/versions — absence is expected, never surfaced.
      ports.log('[delivery] openChat unavailable');
    }
  }

  async function deliver(intent: DeliveryIntent, text: string): Promise<void> {
    try {
      await ports.clipboard.writeText(text);
    } catch (e) {
      ports.log(`[delivery] clipboard write failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    lastText = text;
    ports.log(`[delivery] intent=${intent} chars=${text.length}`);
    let picked: string | undefined;
    try {
      picked = await ports.notify(DELIVERY_TOAST_TEXT, COPY_AGAIN_ACTION, OPEN_CHAT_ACTION);
    } catch {
      picked = undefined; // Toast failures must never break delivery.
    }
    if (picked === COPY_AGAIN_ACTION) {
      try {
        await ports.clipboard.writeText(text);
      } catch (e) {
        ports.log(`[delivery] clipboard write failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      return;
    }
    if (picked === OPEN_CHAT_ACTION) await openChat();
  }

  return { deliver };
}
