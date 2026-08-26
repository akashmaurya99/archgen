// Webview shell smoke tests (jsdom): tabs, states, acquireVsCodeApi-once,
// setState/getState persistence, message intake.
// @vitest-environment jsdom
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { createElement } from 'react';
import { App } from '../src/webview/App';
import { initialTab } from '../src/webview/states';
import type { ArchgenModelMessage, HostToWebview, SetupAction, SetupStateLike } from '../src/shared/protocol';
import { resetVsCodeApiForTests } from '../src/webview/vscode';
import { installFlowDomStubs } from './helpers/dom-stubs';

interface FakeApi {
  posted: unknown[];
  state: Record<string, unknown>;
  postMessage(msg: unknown): void;
  getState<T>(): T | undefined;
  setState<T>(s: T): void;
}

function makeApi(): FakeApi {
  const api: FakeApi = {
    posted: [],
    state: {},
    postMessage(msg) { api.posted.push(msg); },
    getState<T>() { return api.state as T; },
    setState<T>(s: T) { api.state = s as Record<string, unknown>; },
  };
  return api;
}

const MODEL: ArchgenModelMessage = {
  type: 'model',
  tasks: [
    { id: 'C', title: 'Root', status: 'done', dependsOn: [], fileOwnership: ['a/**'], artifacts: [] },
    { id: 'B', title: 'Mid', status: 'running', dependsOn: ['C'], fileOwnership: ['b/**'], artifacts: [] },
  ],
  docs: [{ path: 'plans/demo.md', title: 'demo.md' }],
  codegraph: { product: 'unsupported', unsupportedReason: 'No .codegraph/ index found in this workspace.' },
  themeKind: 'dark',
  warnings: [],
  features: [],
  activeSlug: '',
};

function lastPosted(api: FakeApi): HostToWebview {
  return api.posted[api.posted.length - 1] as HostToWebview;
}

beforeEach(() => {
  installFlowDomStubs();
  cleanup();
  resetVsCodeApiForTests();
});

describe('App shell', () => {
  it('posts ready handshake on mount and shows loading until model arrives', async () => {
    const api = makeApi();
    const { rerender } = render(createElement(App, { api }));
    expect(lastPosted(api)).toEqual({ type: 'ready' });
    expect(screen.getByRole('status')).toBeTruthy();

    // Simulate host pushing the model through the message channel.
    act(() => {
      const evt = new MessageEvent<HostToWebview>('message', { data: MODEL });
      window.dispatchEvent(evt);
    });
    rerender(createElement(App, { api }));
    expect(await screen.findByTestId('archgen-root')).toBeTruthy();
    expect(screen.getByText('B')).toBeTruthy();
  });

  it('renders TASKS | CODE | DOCS tabs and persists selection via setState', () => {
    const api = makeApi();
    render(createElement(App, { api }));
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: MODEL }));
    });

    fireEvent.click(screen.getByRole('tab', { name: 'CODE' }));
    expect(api.state).toEqual({ tab: 'CODE' });
    expect(screen.getByRole('tab', { name: 'CODE' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText(/Codegraph unavailable/i)).toBeTruthy();
    expect(MODEL.codegraph.unsupportedReason).toBeTruthy();
    expect(screen.getByText(/No \.codegraph\/ index found/)).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'DOCS' }));
    expect(api.state).toEqual({ tab: 'DOCS' });
    expect(screen.getByRole('button', { name: 'demo.md' })).toBeTruthy();
  });

  it('shows empty state when model has no content', () => {
    const api = makeApi();
    render(createElement(App, { api }));
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { ...MODEL, tasks: [], docs: [] },
      }));
    });
    expect(screen.getByText(/No ArchGen plan found/i)).toBeTruthy();
  });

  it('surfaces error status messages via alert banner and dismisses', () => {
    const api = makeApi();
    render(createElement(App, { api }));
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: MODEL }));
    });
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'status', kind: 'error', message: 'tasks.yaml unreadable: boom' },
      }));
    });
    const banner = screen.getByRole('alert');
    expect(banner.textContent).toContain('boom');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('applies update diffs without replacing the whole model', async () => {
    const api = makeApi();
    render(createElement(App, { api }));
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: MODEL }));
    });
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'update', changed: [{ id: 'B', status: 'failed' }] },
      }));
    });
    // store batches patches into one rAF flush — wait out the frame
    await act(async () => {
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    });
    const chip = document.querySelector('[data-task-id="B"] [data-status]');
    expect(chip?.getAttribute('data-status')).toBe('failed');
    // untouched task keeps its status
    const chipC = document.querySelector('[data-task-id="C"] [data-status]');
    expect(chipC?.getAttribute('data-status')).toBe('done');
  });

  it('theme message flips the data-theme attribute', () => {
    const api = makeApi();
    render(createElement(App, { api }));
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'theme', themeKind: 'light' } }));
    });
    expect(document.documentElement.dataset['theme']).toBe('light');
  });

  it('surfaces task acceptance criteria as read-only node hover detail', () => {
    const api = makeApi();
    render(createElement(App, { api }));
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          ...MODEL,
          tasks: [{ ...MODEL.tasks[0], acceptance: ['tests pass', 'docs updated'] }, MODEL.tasks[1]],
        },
      }));
    });
    const detail = document.querySelector('[data-task-id="C"]')?.getAttribute('title');
    expect(detail).toContain('Acceptance:');
    expect(detail).toContain('- tests pass');
    expect(detail).toContain('- docs updated');
    // tasks WITHOUT acceptance render no tooltip rather than an empty one
    expect(document.querySelector('[data-task-id="B"]')?.getAttribute('title')).toBeNull();
  });

  it('revealTask message switches to TASKS (persisted) and spotlights the node', () => {
    const api = makeApi();
    render(createElement(App, { api }));
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: MODEL }));
    });
    fireEvent.click(screen.getByRole('tab', { name: 'CODE' }));
    expect(api.state).toEqual({ tab: 'CODE' });

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'revealTask', taskId: 'B' },
      }));
    });

    expect(screen.getByRole('tab', { name: 'TASKS' }).getAttribute('aria-selected')).toBe('true');
    expect(api.state).toEqual({ tab: 'TASKS' });
    expect(document.querySelector('[data-task-id="B"]')?.classList.contains('is-highlighted')).toBe(true);
    expect(document.querySelector('[data-task-id="C"]')?.classList.contains('is-highlighted')).toBe(false);
  });

  it('revealDoc message switches to DOCS (persisted) and the following docContent renders that document', () => {
    const api = makeApi();
    render(createElement(App, { api }));
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: MODEL }));
    });
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'revealDoc', path: 'plans/demo.md' } }));
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'docContent', path: 'plans/demo.md', content: '# Demo plan\n\nHello board.' },
      }));
    });

    expect(screen.getByRole('tab', { name: 'DOCS' }).getAttribute('aria-selected')).toBe('true');
    expect(api.state).toEqual({ tab: 'DOCS' });
    expect(document.querySelector('.archgen-doc-body')?.textContent).toContain('Hello board.');
    expect(screen.getByRole('button', { name: 'demo.md' }).getAttribute('aria-current')).toBe('page');
  });

  it('clears the spotlight when a feature is picked or a refresh drops the task', () => {
    const api = makeApi();
    render(createElement(App, { api }));
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          ...MODEL,
          features: [
            { slug: 'demo', tasksPath: '/ws/.archgen/demo/tasks.yaml', updatedAt: 2 },
            { slug: 'other', tasksPath: '/ws/.archgen/other/tasks.yaml', updatedAt: 1 },
          ],
          activeSlug: 'demo',
        },
      }));
    });
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'revealTask', taskId: 'B' },
      }));
    });
    expect(document.querySelector('[data-task-id="B"]')?.classList.contains('is-highlighted')).toBe(true);

    // Feature pick clears the spotlight AND still posts the host intent.
    fireEvent.change(screen.getByRole('combobox', { name: /Select ArchGen feature/ }), {
      target: { value: 'other' },
    });
    expect(document.querySelector('.is-highlighted')).toBeNull();
    expect(api.posted[api.posted.length - 1]).toEqual({ type: 'selectFeature', slug: 'other' });

    // A model refresh without the revealed task keeps it cleared.
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { ...MODEL, tasks: [MODEL.tasks[0]] },
      }));
    });
    expect(document.querySelector('[data-task-id="B"]')).toBeNull();
    expect(document.querySelector('.is-highlighted')).toBeNull();
  });
});

describe('ready watchdog (restore handshake)', () => {
  function readyCount(api: FakeApi): number {
    return api.posted.filter((m) => (m as { type: string }).type === 'ready').length;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('re-posts ready every 750ms until the first model, then never again', () => {
    const api = makeApi();
    render(createElement(App, { api }));
    expect(readyCount(api)).toBe(1);

    act(() => { vi.advanceTimersByTime(750); });
    expect(readyCount(api)).toBe(2);

    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: MODEL }));
    });
    act(() => { vi.advanceTimersByTime(5 * 60_000); });
    expect(readyCount(api)).toBe(2);
    expect(screen.getByTestId('archgen-root')).toBeTruthy();
  });

  it('backs off: ten 750ms re-posts (11 readies) then 5s spacing', () => {
    const api = makeApi();
    render(createElement(App, { api }));
    act(() => { vi.advanceTimersByTime(750 * 10); });
    expect(readyCount(api)).toBe(11);

    act(() => { vi.advanceTimersByTime(4_999); });
    expect(readyCount(api)).toBe(11);
    act(() => { vi.advanceTimersByTime(1); });
    expect(readyCount(api)).toBe(12);
  });

  it('visibilitychange→visible and window focus re-post ready immediately', () => {
    const api = makeApi();
    render(createElement(App, { api }));
    expect(readyCount(api)).toBe(1);

    act(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(readyCount(api)).toBe(2);

    act(() => { window.dispatchEvent(new Event('focus')); });
    expect(readyCount(api)).toBe(3);
  });

  it('caps after 2 minutes: error UI + Retry, timer cleared until Retry re-arms', () => {
    const api = makeApi();
    render(createElement(App, { api }));
    // 10 fast re-posts (7.5s) then 5s spacing; the first tick at/after 120s
    // (t=122.5s) caps instead of posting.
    act(() => { vi.advanceTimersByTime(122_500); });
    const readiesAtCap = readyCount(api);

    expect(screen.getByText('ArchGen: waiting for host — click Retry')).toBeTruthy();
    const retry = screen.getByRole('button', { name: 'Retry' });

    // Timer is cleared — a still-silent host gets no further readies.
    act(() => { vi.advanceTimersByTime(5 * 60_000); });
    expect(readyCount(api)).toBe(readiesAtCap);

    // Retry re-posts ready at once and re-arms the capped watchdog.
    fireEvent.click(retry);
    expect(readyCount(api)).toBe(readiesAtCap + 1);
    expect(screen.queryByText(/waiting for host/)).toBeNull();
    act(() => { vi.advanceTimersByTime(750); });
    expect(readyCount(api)).toBe(readiesAtCap + 2);
  });
});

describe('SetupDialog (centered dialog replaces the SETUP tab)', () => {
  const SKILL_OK = { installed: true, path: '/ws/.agents/skills/archgen/scripts', version: '0.0.1' };
  const SKILL_MISSING = { installed: false, path: null, version: null };

  function setupMessage(overrides?: { state?: SetupStateLike; actions?: SetupAction[]; extVersion?: string }): HostToWebview {
    return {
      type: 'setup',
      state: overrides?.state ?? { skill: SKILL_OK, planInitialized: true, upToDate: false },
      actions: overrides?.actions ?? ['update'],
      extVersion: overrides?.extVersion ?? '0.0.4',
    };
  }

  function mountWithSetup(msg: HostToWebview = setupMessage()): FakeApi {
    const api = makeApi();
    render(createElement(App, { api }));
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: MODEL }));
      window.dispatchEvent(new MessageEvent('message', { data: msg }));
    });
    return api;
  }

  function openViaGear(): void {
    fireEvent.click(screen.getByRole('button', { name: 'Open ArchGen settings' }));
  }

  function dialog(): HTMLElement {
    return screen.getByRole('dialog', { name: 'ArchGen Setup' });
  }

  it('tab strip shows exactly TASKS | CODE | DOCS — no SETUP tab exists', () => {
    mountWithSetup();
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('.archgen-tab')].map((b) => b.textContent);
    expect(tabs).toEqual(['TASKS', 'CODE', 'DOCS']);
  });

  it('gear button beside the ⋯ menu opens the dialog', () => {
    mountWithSetup();
    expect(screen.queryByRole('dialog')).toBeNull();
    const gear = screen.getByRole('button', { name: 'Open ArchGen settings' });
    expect(gear.textContent).toBe('⚙');
    expect(gear.getAttribute('title')).toBe('Open ArchGen settings');
    openViaGear();
    expect(dialog()).toBeTruthy();
  });

  it('⋯ menu "Setup & updates" opens the SAME dialog and closes the menu', () => {
    mountWithSetup();
    const menu = document.querySelector<HTMLDetailsElement>('details.archgen-menu');
    expect(menu).toBeTruthy();
    menu!.open = true;
    fireEvent.click(screen.getByRole('button', { name: 'Setup & updates' }));
    expect(dialog()).toBeTruthy();
    expect(menu!.open).toBe(false);
  });

  it('revealSetup message opens the dialog without touching the tab strip', () => {
    const api = mountWithSetup();
    fireEvent.click(screen.getByRole('tab', { name: 'CODE' }));
    expect(api.state).toEqual({ tab: 'CODE' });
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'revealSetup' } }));
    });
    expect(dialog()).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'CODE' }).getAttribute('aria-selected')).toBe('true');
    expect(api.state).toEqual({ tab: 'CODE' });
  });

  it('Escape closes the dialog', () => {
    mountWithSetup();
    openViaGear();
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('backdrop click closes; clicks inside the card do not', () => {
    mountWithSetup();
    openViaGear();
    fireEvent.click(dialog());
    expect(screen.queryByRole('dialog')).toBeNull();

    openViaGear();
    fireEvent.click(screen.getByText('ArchGen setup'));
    expect(dialog()).toBeTruthy();
  });

  it('✕ affordance in the card header closes the dialog', () => {
    mountWithSetup();
    openViaGear();
    fireEvent.click(screen.getByRole('button', { name: 'Close ArchGen settings' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders summary rows with glyph/detail truth from the setup snapshot', () => {
    mountWithSetup(setupMessage({
      state: { skill: SKILL_MISSING, planInitialized: false, upToDate: null },
      actions: ['install'],
    }));
    openViaGear();
    const rows = [...document.querySelectorAll('.archgen-setup-row')];
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain('Skill');
    expect(rows[0]!.textContent).toContain('not found');
    expect(rows[1]!.textContent).toContain('Plan');
    expect(rows[1]!.textContent).toContain('no .archgen plan');
    expect(rows[2]!.textContent).toContain('Up to date');
    expect(rows[2]!.textContent).toContain('unknown');
    expect(document.querySelector('.archgen-setup-glyph--warn')).toBeTruthy();
  });

  it('renders the version-aware update card + reassurance line', () => {
    mountWithSetup(setupMessage({ actions: ['update'] }));
    openViaGear();
    expect(screen.getByText('Update the ArchGen skill')).toBeTruthy();
    expect(
      screen.getByText('Installed skill v0.0.1 is older than this extension (v0.0.4).'),
    ).toBeTruthy();
    expect(
      screen.getByText('Everything keeps working on older versions — updating is recommended.'),
    ).toBeTruthy();
  });

  it('legacy install (no stamp) renders the predates-stamping body', () => {
    mountWithSetup(setupMessage({
      state: { skill: { ...SKILL_OK, version: null }, planInitialized: true, upToDate: null },
      actions: ['update'],
    }));
    openViaGear();
    expect(
      screen.getByText('The installed skill predates version stamping (this extension ships v0.0.4).'),
    ).toBeTruthy();
  });

  it.each([
    ['install', { type: 'copyInstall' }],
    ['update', { type: 'copyUpdate' }],
  ] as const)('%s card button posts the EXACT wire message %j', (action, expected) => {
    const api = mountWithSetup(setupMessage({
      ...(action === 'install'
        ? { state: { skill: SKILL_MISSING, planInitialized: false, upToDate: null } as SetupStateLike }
        : {}),
      actions: [action],
    }));
    openViaGear();
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt for my agent' }));
    const copies = api.posted.filter((m) => (m as { type: string }).type === expected.type);
    expect(copies).toEqual([expected]);
  });

  it('NO initPlan card exists anywhere in the dialog DOM even when the host reports one', () => {
    mountWithSetup(setupMessage({ actions: ['initPlan', 'update'] }));
    openViaGear();
    expect(document.querySelector('[data-setup-action="initPlan"]')).toBeNull();
    expect(screen.queryByText('Initialize a plan')).toBeNull();
    expect(dialog().textContent).not.toContain('see copied prompt for the generate flow');
    expect(screen.getByText('Update the ArchGen skill')).toBeTruthy();
  });

  it('empty-actions snapshot renders the compact all-good row instead of cards', () => {
    mountWithSetup(setupMessage({
      state: { skill: SKILL_OK, planInitialized: true, upToDate: true },
      actions: [],
    }));
    openViaGear();
    expect(screen.getByText('ArchGen is set up.')).toBeTruthy();
    expect(document.querySelector('.archgen-setup-card')).toBeNull();
  });

  it('manual-route Copy pill writes the route text via the clipboard pattern', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mountWithSetup();
    openViaGear();
    fireEvent.click(screen.getByRole('button', { name: 'Copy npx archgen-skill update' }));
    await act(async () => { await Promise.resolve(); });
    expect(writeText).toHaveBeenCalledWith('npx archgen-skill update');
    expect(screen.getByText('Copied!')).toBeTruthy();
  });

  it('revealSetup in an EMPTY workspace opens a live-truth dialog over the empty state', () => {
    const api = makeApi();
    render(createElement(App, { api }));
    act(() => {
      // Host always posts a model first; an empty workspace carries zero
      // ArchGen content, so the ONLY content-bearing message is the setup
      // snapshot (exactly what the status-bar/notification entry points hit).
      window.dispatchEvent(new MessageEvent('message', { data: { ...MODEL, tasks: [], docs: [] } }));
      window.dispatchEvent(new MessageEvent('message', {
        data: setupMessage({
          state: { skill: SKILL_MISSING, planInitialized: false, upToDate: null },
          actions: ['install'],
        }),
      }));
    });
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'revealSetup' } }));
    });
    const rows = [...document.querySelectorAll('.archgen-setup-row')];
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain('not found');
    expect(screen.getByRole('button', { name: 'Copy prompt for my agent' })).toBeTruthy();
    void api;
  });

  it('⋯ menu Copy install prompt posts copyInstall WITHOUT opening the dialog', () => {
    const api = mountWithSetup();
    const menu = document.querySelector<HTMLDetailsElement>('details.archgen-menu');
    menu!.open = true;
    fireEvent.click(screen.getByRole('button', { name: 'Copy install prompt' }));
    expect(api.posted.filter((m) => (m as { type: string }).type === 'copyInstall')).toEqual([{ type: 'copyInstall' }]);
    expect(menu!.open).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('⋯ menu closes when a click lands outside it', () => {
    mountWithSetup();
    const menu = document.querySelector<HTMLDetailsElement>('details.archgen-menu');
    expect(menu).toBeTruthy();
    act(() => { menu!.open = true; });
    fireEvent.click(document.body);
    expect(menu!.open).toBe(false);
  });
});

describe('persisted-tab sanitization (SETUP tab removed)', () => {
  it('initialTab falls back to TASKS for the removed SETUP tab, junk, and nothing', () => {
    expect(initialTab('SETUP')).toBe('TASKS');
    expect(initialTab('setup')).toBe('TASKS');
    expect(initialTab(undefined)).toBe('TASKS');
    expect(initialTab(null)).toBe('TASKS');
    expect(initialTab('CODE')).toBe('CODE');
    expect(initialTab('DOCS')).toBe('DOCS');
    expect(initialTab('TASKS')).toBe('TASKS');
  });

  it('a webview restored with a persisted SETUP tab renders TASKS instead of a blank board', () => {
    const api = makeApi();
    api.state = { tab: 'SETUP' };
    render(createElement(App, { api }));
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: MODEL }));
    });
    expect(screen.getByRole('tab', { name: 'TASKS' }).getAttribute('aria-selected')).toBe('true');
    // Sanitization is read-time only — the stale value is not rewritten
    // until the user actually navigates.
    expect(api.state).toEqual({ tab: 'SETUP' });
  });
});

describe('EmptyState setup-awareness (post-init dead-end fix)', () => {
  function mountEmpty(...messages: HostToWebview[]): FakeApi {
    const api = makeApi();
    render(createElement(App, { api }));
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { ...MODEL, tasks: [], docs: [] } }));
      for (const msg of messages) window.dispatchEvent(new MessageEvent('message', { data: msg }));
    });
    return api;
  }

  function emptyStateText(): string {
    return document.querySelector('.archgen-state--empty')!.textContent ?? '';
  }

  it('no setup snapshot yet → legacy install guidance byte-for-byte', () => {
    mountEmpty();
    expect(emptyStateText()).toContain('This workspace has no .archgen/ folder yet.');
    expect(emptyStateText()).toContain(
      'Run npx archgen-skill init once to scaffold the plan, then tell your coding agent: "generate architecture for <your idea>".',
    );
    expect(screen.getByRole('button', { name: 'Copy install command' })).toBeTruthy();
    expect(screen.queryByText('ArchGen skill is ready.')).toBeNull();
  });

  it('skill installed → ready variant opens the centered kickoff modal posting EXACT copyInitPlan+idea', () => {
    const api = mountEmpty({
      type: 'setup',
      state: {
        skill: { installed: true, path: '/ws/.agents/skills/archgen/scripts', version: '0.0.4' },
        planInitialized: false,
        upToDate: true,
      },
      actions: ['initPlan'],
      extVersion: '0.0.4',
    });
    expect(screen.getByText('Ready to build.')).toBeTruthy();
    expect(emptyStateText()).toContain('Tell your coding agent: "generate architecture for <your idea>"');
    expect(emptyStateText()).not.toContain('doctor');
    expect(emptyStateText()).not.toContain('or copy a kickoff prompt below');
    expect(screen.queryByRole('button', { name: 'Open Setup & updates' })).toBeNull();
    expect(screen.queryByText(/scaffold the plan/)).toBeNull();

    // Step 1: the button opens the IN-BOARD centered modal (no native InputBox).
    fireEvent.click(screen.getByRole('button', { name: 'Copy kickoff prompt' }));
    expect(screen.getByRole('dialog', { name: 'Kickoff prompt' })).toBeTruthy();
    const input = screen.getByPlaceholderText('e.g. booking platform with payments (optional)');
    expect(document.activeElement).toBe(input);

    // Step 2: submitting posts the idea-bearing wire message exactly once.
    fireEvent.change(input, { target: { value: 'auth service' } });
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    expect(api.posted.filter((m) => (m as { type: string }).type === 'copyInitPlan')).toEqual([
      { type: 'copyInitPlan', idea: 'auth service' },
    ]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('kickoff modal Escape cancels silently — no wire post, dialog gone', () => {
    const api = mountEmpty({
      type: 'setup',
      state: {
        skill: { installed: true, path: '/ws/.agents/skills/archgen/scripts', version: '0.0.4' },
        planInitialized: false,
        upToDate: true,
      },
      actions: ['initPlan'],
      extVersion: '0.0.4',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Copy kickoff prompt' }));
    expect(screen.getByRole('dialog', { name: 'Kickoff prompt' })).toBeTruthy();
    fireEvent.keyDown(screen.getByPlaceholderText('e.g. booking platform with payments (optional)'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(api.posted.filter((m) => (m as { type: string }).type === 'copyInitPlan')).toEqual([]);
  });

  it('kickoff modal empty submit posts the generic-kickoff intent with idea:""', () => {
    const api = mountEmpty({
      type: 'setup',
      state: {
        skill: { installed: true, path: '/ws/.agents/skills/archgen/scripts', version: '0.0.4' },
        planInitialized: false,
        upToDate: true,
      },
      actions: ['initPlan'],
      extVersion: '0.0.4',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Copy kickoff prompt' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy prompt' }));
    expect(api.posted.filter((m) => (m as { type: string }).type === 'copyInitPlan')).toEqual([{ type: 'copyInitPlan', idea: '' }]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('skill explicitly missing → legacy install guidance again', () => {
    mountEmpty({
      type: 'setup',
      state: { skill: { installed: false, path: null, version: null }, planInitialized: false, upToDate: null },
      actions: ['install'],
      extVersion: '0.0.4',
    });
    expect(screen.queryByText('ArchGen skill is ready.')).toBeNull();
    expect(emptyStateText()).toContain('Run npx archgen-skill init once to scaffold the plan');
    expect(screen.getByRole('button', { name: 'Copy install command' })).toBeTruthy();
  });
});
