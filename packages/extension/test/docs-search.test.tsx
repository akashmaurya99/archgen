// DOCS in-document search tests: text-node-only highlighting (html:false
// sanitization untouched), hit counting, next/prev navigation, Escape clear
// restoring the original DOM nodes.
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { DocsView, applySearch, clearSearchMarks } from '../src/webview/DocsView';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg data-ok="1"></svg>' })),
  },
}));

const DOC = [
  '# Plan',
  '',
  'The graph grows wave by wave.',
  '',
  'A second graph reference here.',
  '',
  '## Notes',
  '',
  'Graphs are rendered client-side.',
].join('\n');

const HOSTILE_DOC = ['# X', '', '<img src=x onerror="alert(1)">', '', 'an img tag above'].join('\n');

function renderDoc(content: string): void {
  render(
    createElement(DocsView, {
      docs: [{ path: 'plan.md', title: 'plan.md' }],
      active: { path: 'plan.md', content },
      onSelect: vi.fn(),
      onOpenInEditor: vi.fn(),
    }),
  );
}

beforeEach(cleanup);

describe('applySearch / clearSearchMarks (DOM-level units)', () => {
  it('wraps only matching text nodes and reports them in order', () => {
    const host = document.createElement('div');
    host.innerHTML = '<p>one GRAPH two</p><p>graph three</p>';
    const hits = applySearch(host, 'graph');
    expect(hits).toHaveLength(2);
    expect(hits[0]?.textContent).toBe('GRAPH');
    expect(hits[1]?.textContent).toBe('graph');
    expect(host.querySelectorAll('mark.archgen-search-hit')).toHaveLength(2);
  });

  it('clear unwraps marks and normalize() restores single original text nodes', () => {
    const host = document.createElement('div');
    host.innerHTML = '<p>alpha beta</p>';
    const p = host.querySelector('p') as HTMLElement;
    applySearch(host, 'beta');
    expect(p.childNodes.length).toBeGreaterThan(1); // split around the mark
    clearSearchMarks(host);
    expect(host.querySelectorAll('mark')).toHaveLength(0);
    expect(p.childNodes.length).toBe(1); // merged back
    expect(p.textContent).toBe('alpha beta');
  });
});

describe('DocsView search UI', () => {
  it('highlights matches, shows a count badge, and navigates hit-to-hit', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
      writable: true,
    });
    try {
      renderDoc(DOC);
      await waitFor(() => expect(screen.getByLabelText('On this page')).toBeTruthy());
      fireEvent.change(screen.getByLabelText('Search in document'), { target: { value: 'graph' } });
      await waitFor(() => expect(screen.getByRole('status').textContent).toBe('3 hits'));
      const marks = document.querySelectorAll('mark.archgen-search-hit');
      expect(marks).toHaveLength(3);
      expect(marks[0]?.classList.contains('is-current')).toBe(true);

      fireEvent.click(screen.getByRole('button', { name: 'Next match' }));
      expect(marks[1]?.classList.contains('is-current')).toBe(true);
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
      fireEvent.click(screen.getByRole('button', { name: 'Previous match' }));
      expect(marks[0]?.classList.contains('is-current')).toBe(true);
    } finally {
      delete (Element.prototype as unknown as Record<string, unknown>)['scrollIntoView'];
    }
  });

  it('Escape clears the query and restores the original nodes', async () => {
    renderDoc(DOC);
    await waitFor(() => expect(screen.getByLabelText('On this page')).toBeTruthy());
    const input = screen.getByLabelText('Search in document') as HTMLInputElement;
    const para = document.querySelector('.archgen-markdown p') as HTMLElement;
    const before = para.textContent;

    fireEvent.change(input, { target: { value: 'graph' } });
    await waitFor(() => expect(document.querySelectorAll('mark.archgen-search-hit')).toHaveLength(3));

    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(document.querySelectorAll('mark.archgen-search-hit')).toHaveLength(0));
    expect(input.value).toBe('');
    expect(para.textContent).toBe(before);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('searching never materializes hostile HTML — escaping stays intact', async () => {
    renderDoc(HOSTILE_DOC);
    await waitFor(() => expect(screen.getByLabelText('Search in document')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Search in document'), { target: { value: 'img' } });
    await waitFor(() => expect(document.querySelectorAll('mark.archgen-search-hit').length).toBeGreaterThan(0));
    // html:false still holds: no <img> element was ever created…
    expect(document.querySelector('.archgen-markdown img')).toBeNull();
    // …the match is a plain TEXT node wrapped in <mark>.
    const mark = document.querySelector('mark.archgen-search-hit');
    expect(mark?.parentElement?.tagName).toBe('P');
    expect(mark?.innerHTML).not.toContain('<img');
  });
});
