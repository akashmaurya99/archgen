// Delivery tests: clipboard-first dispatch core with fake ports — proves copy,
// toast text/action wiring, chat-open fallbacks, and composer parity with the
// legacy spawn-path prompt strings. No vi.mock('vscode'); pure node fakes only.
import { describe, expect, it } from 'vitest';

import {
  DELIVERY_TOAST_TEXT,
  composeStartWorkPayload,
  composeTaskPrompt,
  createDelivery,
  type DeliveryConfig,
  type DeliveryController,
  type DeliveryPorts,
} from '../src/host/delivery';
import { composeInstallPrompt } from '../src/host/setup';

/** Records every port interaction so tests assert observable behavior. */
class FakeVscode {
  readonly writes: string[] = [];
  readonly executed: Array<{ id: string; arg?: unknown }> = [];
  readonly notices: Array<{ message: string; actions: string[] }> = [];
  readonly logs: string[] = [];
  failExecuteCommand = false;
  /** Action label the fake toast "user" picks; undefined = dismissed. */
  pick: string | undefined;

  ports(): DeliveryPorts {
    return {
      clipboard: {
        writeText: (value) => {
          this.writes.push(value);
          return Promise.resolve();
        },
      },
      commands: {
        executeCommand: (id, arg) => {
          if (this.failExecuteCommand) return Promise.reject(new Error('chat input unsupported'));
          this.executed.push({ id, arg });
          return Promise.resolve(undefined);
        },
      },
      notify: (message, ...actions) => {
        this.notices.push({ message, actions });
        return Promise.resolve(this.pick);
      },
      log: (line) => this.logs.push(line),
    };
  }
}

function makeDelivery(fake: FakeVscode, config: DeliveryConfig = { autoFillChat: true }): DeliveryController {
  return createDelivery(fake.ports(), config);
}

describe('composeTaskPrompt (spawn/clipboard parity)', () => {
  it('equals the legacy commandForTask format byte-for-byte when a title exists', () => {
    expect(composeTaskPrompt('T12', 'Add rate limiter')).toBe(
      'Implement task T12: Add rate limiter. Follow the .archgen plan; only touch files you own.',
    );
  });

  it('equals the legacy title-less fallback byte-for-byte', () => {
    expect(composeTaskPrompt('T7', null)).toBe('Implement task T7 from the .archgen plan.');
  });

  it('treats an empty-string title like the legacy truthiness check (fallback)', () => {
    expect(composeTaskPrompt('T7', '')).toBe('Implement task T7 from the .archgen plan.');
  });
});

describe('composeStartWorkPayload', () => {
  it('emits the short trigger line when the skill is installed', () => {
    expect(composeStartWorkPayload('booking-platform', { scriptsDir: '/ws/.agents/skills/archgen/scripts' })).toBe(
      'Start work on booking-platform.',
    );
  });

  it('emits the self-contained brief when the skill is absent', () => {
    const brief = composeStartWorkPayload('booking-platform', { scriptsDir: null });
    expect(brief.split('\n')).toEqual([
      'Read .archgen/booking-platform/tasks.yaml and execute its plan in dependency order.',
      "Implement ONE task at a time; edit only files matched by that task's file_ownership globs.",
      'After each task, update its status in tasks.yaml (done or failed).',
      'Continue wave by wave until every task is done or blocked.',
      'Report failures with a short summary per failed task.',
    ]);
  });

  it('brief references tasks.yaml and status guidance but never the scripts dir', () => {
    const brief = composeStartWorkPayload('demo', { scriptsDir: null });
    expect(brief).toContain('.archgen/demo/tasks.yaml');
    expect(brief).toContain('done or failed');
    expect(brief).not.toContain('scripts');
  });
});

describe('createDelivery', () => {
  it('copies the composed text and shows the exact toast with both actions', async () => {
    const fake = new FakeVscode();
    await makeDelivery(fake).deliver('buildTask', 'Implement task T1');
    expect(fake.writes).toEqual(['Implement task T1']);
    expect(fake.notices).toEqual([
      { message: 'Prompt copied — paste into your agent chat and send', actions: ['Copy Again', 'Open Chat'] },
    ]);
  });

  it('locks the toast constant to the shipped wording', () => {
    expect(DELIVERY_TOAST_TEXT).toBe('Prompt copied — paste into your agent chat and send');
  });

  it('logs the audit line as intent=<intent> chars=<n>', async () => {
    const fake = new FakeVscode();
    const text = composeTaskPrompt('T3', 'Wire the panel');
    await makeDelivery(fake).deliver('buildTask', text);
    expect(fake.logs).toContain(`[delivery] intent=buildTask chars=${text.length}`);
  });

  it("'Copy Again' rewrites the same text without touching commands", async () => {
    const fake = new FakeVscode();
    fake.pick = 'Copy Again';
    await makeDelivery(fake).deliver('startWork', 'Start work on demo.');
    expect(fake.writes).toEqual(['Start work on demo.', 'Start work on demo.']);
    expect(fake.executed).toEqual([]);
  });

  it("'Open Chat' with autoFillChat pre-fills via workbench.action.chat.open", async () => {
    const fake = new FakeVscode();
    fake.pick = 'Open Chat';
    const payload = composeStartWorkPayload('demo', { scriptsDir: null });
    await makeDelivery(fake).deliver('startWork', payload);
    expect(fake.executed).toEqual([
      { id: 'workbench.action.chat.open', arg: { query: payload, isPartialQuery: true } },
    ]);
  });

  it("'Open Chat' without autoFillChat focuses the chat input instead", async () => {
    const fake = new FakeVscode();
    fake.pick = 'Open Chat';
    await makeDelivery(fake, { autoFillChat: false }).deliver('buildTask', 'Implement task T2');
    expect(fake.executed).toEqual([{ id: 'workbench.action.chat.focusInput', arg: undefined }]);
  });

  it("reads autoFillChat live per deliver() call", async () => {
    const fake = new FakeVscode();
    const config: DeliveryConfig = { autoFillChat: true };
    fake.pick = 'Open Chat';
    const delivery = makeDelivery(fake, config);
    await delivery.deliver('buildTask', 'first');
    config.autoFillChat = false;
    await delivery.deliver('buildTask', 'second');
    expect(fake.executed.map((e) => e.id)).toEqual(['workbench.action.chat.open', 'workbench.action.chat.focusInput']);
  });

  it('swallows executeCommand rejections and logs them instead of throwing', async () => {
    const fake = new FakeVscode();
    fake.failExecuteCommand = true;
    fake.pick = 'Open Chat';
    await expect(makeDelivery(fake).deliver('startWork', 'Start work on demo.')).resolves.toBeUndefined();
    expect(fake.logs).toContain('[delivery] openChat unavailable');
  });

  it('executes nothing when the toast is dismissed', async () => {
    const fake = new FakeVscode();
    fake.pick = undefined;
    await makeDelivery(fake).deliver('buildTask', 'Implement task T4');
    expect(fake.executed).toEqual([]);
    expect(fake.writes).toEqual(['Implement task T4']);
  });

  it('never crashes on an empty payload', async () => {
    const fake = new FakeVscode();
    await makeDelivery(fake).deliver('startWork', '');
    expect(fake.writes).toEqual(['']);
    expect(fake.logs).toContain('[delivery] intent=startWork chars=0');
    expect(fake.notices).toHaveLength(1);
  });

  it.each(['setupInstall', 'setupInitPlan', 'setupUpdate'] as const)(
    'passes new setup intent %s through deliver unchanged',
    async (intent) => {
      const fake = new FakeVscode();
      const text = composeInstallPrompt();
      await makeDelivery(fake).deliver(intent, text);
      expect(fake.writes).toEqual([text]);
      expect(fake.notices).toEqual([
        { message: DELIVERY_TOAST_TEXT, actions: ['Copy Again', 'Open Chat'] },
      ]);
      expect(fake.logs).toContain(`[delivery] intent=${intent} chars=${text.length}`);
    },
  );
});
