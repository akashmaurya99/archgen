// ui.mjs — the `archgen_ui` tool: real-time control of the VS Code extension.
//
// BEST-EFFORT BY DESIGN. With the extension closed, every action returns
// `{available:false}` — never an error. The file writes themselves already
// update the board in real time through the extension's existing watcher; this
// tool adds the ability to NAVIGATE it.
import { z } from 'zod/v4';
import { registerTool, projectRootArg } from './_register.mjs';
import { sendUiCommand, readBridgeHeartbeat, pendingUiCommands } from '../core/ui-channel.mjs';
import { invalidInput } from '../core/errors.mjs';

const ACTION_DESC = 'status | select_feature | reveal_task | open_doc | focus | refresh — see archgen_help.';

const schema = z.object({
  action: z.enum(['status', 'select_feature', 'reveal_task', 'open_doc', 'focus', 'refresh']).describe(ACTION_DESC),
  slug: z.string().optional().describe('Feature slug (select_feature).'),
  taskId: z.string().optional().describe('Task id (reveal_task).'),
  path: z.string().optional().describe('Repo-root-relative document path (open_doc).'),
  view: z.enum(['board', 'tasks', 'docs', 'codegraph']).optional().describe('Which view to focus.'),
  timeoutMs: z.number().optional().describe('How long to wait for the extension to acknowledge (default 1500ms, max 5000ms).'),
  projectRoot: projectRootArg,
});

/**
 * @param {import('@modelcontextprotocol/server').McpServer} server
 */
export function registerUiTools(server) {
  registerTool(server, 'archgen_ui', {
    title: 'ArchGen UI',
    description:
      'Control the ArchGen VS Code extension in real time: point the user at a task, open a document, switch ' +
      'feature, or bring a view forward. Best-effort — it reports "not available" when the extension is closed ' +
      'and never blocks your work.',
    inputSchema: schema,
    readOnly: false,
    destructive: false,
    handler: async (ctx, args) => {
      if (args.action === 'status') {
        const heartbeat = readBridgeHeartbeat(ctx.projectRoot);
        return { ...heartbeat, pendingCommands: pendingUiCommands(ctx.projectRoot) };
      }

      if (args.action === 'select_feature') {
        if (!args.slug) throw invalidInput('select_feature requires slug', { action: 'select_feature' });
        return sendUiCommand(ctx.projectRoot, 'select_feature', { slug: args.slug }, { timeoutMs: args.timeoutMs });
      }

      if (args.action === 'reveal_task') {
        if (!args.taskId) throw invalidInput('reveal_task requires taskId', { action: 'reveal_task' });
        return sendUiCommand(ctx.projectRoot, 'reveal_task', { taskId: args.taskId }, { timeoutMs: args.timeoutMs });
      }

      if (args.action === 'open_doc') {
        if (!args.path) throw invalidInput('open_doc requires path', { action: 'open_doc' });
        return sendUiCommand(ctx.projectRoot, 'open_doc', { path: args.path }, { timeoutMs: args.timeoutMs });
      }

      if (args.action === 'focus') {
        if (!args.view) throw invalidInput('focus requires view', { action: 'focus' });
        return sendUiCommand(ctx.projectRoot, 'focus', { view: args.view }, { timeoutMs: args.timeoutMs });
      }

      // refresh
      return sendUiCommand(ctx.projectRoot, 'refresh', {}, { timeoutMs: args.timeoutMs });
    },
  });
}
