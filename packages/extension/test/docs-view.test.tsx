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
});
