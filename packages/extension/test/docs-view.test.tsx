// Docs panel tests (todo 11): markdown-it html:false escaping, mermaid
// per-diagram error isolation, sidebar select + open-in-editor postMessage.
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { DocsView, renderMermaidBlocks, resetMermaidForTests } from '../src/webview/DocsView';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (_id: string, code: string) => {
      if (code.includes('broken')) throw new Error('Syntax error in graph');
      return { svg: `<svg data-ok="${code.includes('second') ? 'second' : 'first'}"></svg>` };
    }),
  },
}));

const FIXTURE = [
  '# Plan',
  '',
  'Intro text with https://example.com link.',
  '',
  '<img src=x onerror="alert(1)">',
  '',
  '```mermaid',
  'graph TD; a-->b;',
  '```',
  '',
  '```mermaid',
  'graph TD; second-->c;',
  '```',
  '',
  '```mermaid',
  'broken diagram $$$',
  '```',
].join('\n');

const DOCS = [
  { path: 'plan.md', title: 'plan.md' },
  { path: 'notes/arch.md', title: 'arch.md' },
];

function renderView(overrides: Partial<Parameters<typeof DocsView>[0]> = {}): void {
  const props: Parameters<typeof DocsView>[0] = {
    docs: DOCS,
    active: { path: 'plan.md', content: FIXTURE },
    onSelect: vi.fn(),
    onOpenInEditor: vi.fn(),
    ...overrides,
  };
  render(createElement(DocsView, props));
}

beforeEach(cleanup);

describe('DocsView', () => {
  it('renders two diagrams and boxes the broken one without killing the rest', async () => {
    const { container } = { container: document.body };
    renderView();
    await waitFor(() => expect(container.querySelectorAll('.archgen-diagram')).toHaveLength(2));
    const errors = container.querySelectorAll('.archgen-diagram-error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.getAttribute('role')).toBe('alert');
    expect(errors[0]?.textContent).toContain('Syntax error in graph');
    expect(container.querySelectorAll('.archgen-diagram svg')).toHaveLength(2);
    // surrounding markdown survived
    expect(container.querySelector('.archgen-markdown')?.textContent).toContain('Intro text');
  });

  it('escapes raw HTML (html:false)', async () => {
    renderView();
    await waitFor(() => expect(document.querySelectorAll('.archgen-diagram')).toHaveLength(2));
    expect(document.querySelector('.archgen-markdown img')).toBeNull();
    expect(document.querySelector('.archgen-markdown')?.innerHTML).toContain('&lt;img');
  });

  it('validateLink blocks javascript:/data:/vbscript: hrefs but keeps https and # anchors (todo 10)', () => {
    const DOC = [
      '[x](javascript:alert(1))',
      '',
      '[y](data:text/html,alert)',
      '',
      '[z](vbscript:alert(1))',
      '',
      '[ok](https://example.com)',
      '',
      '[anchor](#section)',
    ].join('\n');
    renderView({ active: { path: 'plan.md', content: DOC } });
    const mdEl = document.querySelector('.archgen-markdown');
    expect(mdEl).toBeTruthy();
    const inner = mdEl?.innerHTML ?? '';
    // dangerous schemes never reach an href attribute
    expect(inner).not.toContain('href="javascript');
    expect(inner).not.toContain('href="vbscript');
    expect(inner).not.toContain('href="data:');
    expect(mdEl?.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(mdEl?.querySelector('a[href^="data:"]')).toBeNull();
    expect(mdEl?.querySelector('a[href^="vbscript:"]')).toBeNull();
    // rejected links degrade to literal text, not anchors
    expect(mdEl?.textContent).toContain('[x](javascript:alert(1))');
    expect(mdEl?.textContent).toContain('[y](data:text/html,alert)');
    // safe schemes still render as clickable links
    expect(mdEl?.querySelector('a[href="https://example.com"]')).toBeTruthy();
    expect(mdEl?.querySelector('a[href="#section"]')).toBeTruthy();
  });

  it('sidebar click selects a doc; ↗ posts open-in-editor', () => {
    const onSelect = vi.fn();
    const onOpenInEditor = vi.fn();
    renderView({ active: null, onSelect, onOpenInEditor });
    fireEvent.click(screen.getByRole('button', { name: 'plan.md' }));
    expect(onSelect).toHaveBeenCalledWith('plan.md');
    fireEvent.click(screen.getByRole('button', { name: 'Open arch.md in editor' }));
    expect(onOpenInEditor).toHaveBeenCalledWith('notes/arch.md');
    expect(screen.getByText(/Select a document/)).toBeTruthy();
  });

  it('renderMermaidBlocks leaves code blocks untouched when init fails', async () => {
    const mod = await import('mermaid');
    resetMermaidForTests();
    vi.mocked(mod.default.initialize).mockImplementationOnce(() => {
      throw new Error('no init');
    });
    const host = document.createElement('div');
    host.innerHTML = '<pre><code class="language-mermaid">graph TD; x-->y;</code></pre>';
    document.body.appendChild(host);
    await renderMermaidBlocks(host).catch(() => {});
    expect(host.querySelectorAll('pre > code.language-mermaid')).toHaveLength(1);
    expect(host.querySelectorAll('.archgen-diagram')).toHaveLength(0);
    resetMermaidForTests();
  });

  it('sidebar: groups by top-level folder, filters, and shows a count chip', () => {
    renderView({ active: null });
    // notes/arch.md groups under a 'notes' label; plan.md stays ungrouped.
    expect(screen.getByText('notes')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'arch.md' })).toBeTruthy();
    expect(screen.getByLabelText('Showing 2 of 2 documents').textContent).toBe('2/2');
    fireEvent.change(screen.getByLabelText('Filter documents'), { target: { value: 'arch' } });
    expect(screen.getByLabelText('Showing 1 of 2 documents').textContent).toBe('1/2');
    expect(screen.queryByRole('button', { name: 'plan.md' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Filter documents'), { target: { value: 'zzz' } });
    expect(screen.getByLabelText('Showing 0 of 2 documents').textContent).toBe('0/2');
  });

  it('active doc link carries aria-current="page"', () => {
    renderView();
    expect(screen.getByRole('button', { name: 'plan.md' }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('button', { name: 'arch.md' }).getAttribute('aria-current')).toBeNull();
  });

  it('shows a reading-time chip for the active document', async () => {
    renderView();
    await waitFor(() => expect(document.querySelectorAll('.archgen-diagram')).toHaveLength(2));
    expect(screen.getByLabelText(/\d+ minute read/)).toBeTruthy();
  });

  it('retry button re-renders ONLY the failed diagram block', async () => {
    const mod = await import('mermaid');
    renderView();
    await waitFor(() => expect(document.querySelectorAll('.archgen-diagram-error')).toHaveLength(1));
    // Queue the successful retry AFTER the initial 3 renders have consumed
    // the default implementation, so the NEXT call is guaranteed to be the retry.
    const renderFn = vi.mocked(mod.default.render);
    type RenderResult = Awaited<ReturnType<typeof renderFn>>;
    const retried = { svg: '<svg data-retried="1"></svg>' } as RenderResult;
    renderFn.mockImplementationOnce(async () => retried);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => expect(document.querySelectorAll('.archgen-diagram-error')).toHaveLength(0));
    expect(document.querySelector('.archgen-diagram svg[data-retried]')).toBeTruthy();
    // the two originally-good diagrams are untouched
    expect(document.querySelectorAll('.archgen-diagram svg[data-ok]')).toHaveLength(2);
  });

  it('code frames get a language chip + copy button with Copied! feedback', async () => {
    const DOC = ['# T', '', '```js', 'const x = 1;', '```'].join('\n');
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    renderView({ active: { path: 'plan.md', content: DOC } });
    expect(screen.getByText('js')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Copy js block' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy js block' }).textContent).toBe('Copied!'));
    expect(writeText).toHaveBeenCalledWith('const x = 1;\n');
  });

  it('diagram viewport zoom controls scale the diagram box', async () => {
    renderView();
    await waitFor(() => expect(document.querySelectorAll('.archgen-diagram-viewport')).toHaveLength(2));
    const box = document.querySelector<HTMLElement>('.archgen-diagram');
    expect(box?.style.transform).toBe('');
    fireEvent.click(screen.getAllByLabelText('Zoom in diagram')[0] as Element);
    expect(box?.style.transform).toContain('scale(1.2)');
    fireEvent.click(screen.getAllByLabelText('Zoom out diagram')[0] as Element);
    fireEvent.click(screen.getAllByLabelText('Zoom out diagram')[0] as Element);
    expect(box?.style.transform).toContain('scale(0.8)');
    fireEvent.click(screen.getAllByLabelText('Reset diagram zoom')[0] as Element);
    expect(box?.style.transform).toBe('translate(0px, 0px) scale(1)');
  });

  it('ctrl-wheel zooms and pointer drag pans the diagram viewport', async () => {
    renderView();
    await waitFor(() => expect(document.querySelectorAll('.archgen-diagram-viewport')).toHaveLength(2));
    const viewport = document.querySelector<HTMLElement>('.archgen-diagram-viewport');
    const box = viewport?.querySelector<HTMLElement>('.archgen-diagram');
    viewport?.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -100, cancelable: true }));
    expect(box?.style.transform).toContain('scale(1.2)');
    // plain wheel (no ctrl) must NOT zoom
    viewport?.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }));
    expect(box?.style.transform).toContain('scale(1.2)');
    // drag-to-pan via pointer events (jsdom: MouseEvent stands in)
    viewport?.dispatchEvent(new MouseEvent('pointerdown', { clientX: 10, clientY: 10 }));
    viewport?.dispatchEvent(new MouseEvent('pointermove', { clientX: 60, clientY: 40 }));
    viewport?.dispatchEvent(new MouseEvent('pointerup'));
    expect(box?.style.transform).toBe('translate(50px, 30px) scale(1.2)');
  });

  it('back-to-top appears after 600px scroll and scrolls back up', async () => {
    renderView();
    await waitFor(() => expect(document.querySelectorAll('.archgen-diagram')).toHaveLength(2));
    const body = document.querySelector<HTMLElement>('.archgen-doc-body') as HTMLElement;
    Object.defineProperty(body, 'scrollTop', { value: 700, configurable: true });
    const scrollTo = vi.fn();
    Object.defineProperty(body, 'scrollTo', { value: scrollTo, configurable: true });
    fireEvent.scroll(body);
    const btn = screen.getByRole('button', { name: 'Back to top' });
    fireEvent.click(btn);
    expect(scrollTo).toHaveBeenCalledWith({ top: 0, behavior: 'smooth' });
    Object.defineProperty(body, 'scrollTop', { value: 100, configurable: true });
    fireEvent.scroll(body);
    expect(screen.queryByRole('button', { name: 'Back to top' })).toBeNull();
  });

  it('theme switch re-initializes mermaid with the mapped theme and re-renders diagrams', async () => {
    const mod = await import('mermaid');
    const initCallsBefore = vi.mocked(mod.default.initialize).mock.calls.length;
    const rendersBefore = vi.mocked(mod.default.render).mock.calls.length;
    const view = render(createElement(DocsView, { docs: DOCS, active: { path: 'plan.md', content: FIXTURE }, onSelect: vi.fn(), onOpenInEditor: vi.fn() }));
    await waitFor(() => expect(document.querySelectorAll('.archgen-diagram')).toHaveLength(2));
    // App.tsx paints <html data-theme>; DocsView observes it without new props.
    document.documentElement.setAttribute('data-theme', 'dark');
    await waitFor(() => {
      const themed = vi.mocked(mod.default.initialize).mock.calls.some((c) => (c[0] as { theme?: string }).theme === 'dark');
      expect(themed).toBe(true);
    });
    await waitFor(() => expect(vi.mocked(mod.default.render).mock.calls.length).toBeGreaterThan(rendersBefore + 1));
    expect(vi.mocked(mod.default.initialize).mock.calls.length).toBeGreaterThan(initCallsBefore);
    view.unmount();
    document.documentElement.removeAttribute('data-theme');
  });
});
