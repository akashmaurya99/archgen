// DOCS TOC tests: heading extraction + id assignment, pure scroll-spy core,
// TOC link click → smooth scroll + aria-current movement.
// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { DocsView, extractToc, pickActiveHeading } from '../src/webview/DocsView';

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async () => ({ svg: '<svg data-ok="1"></svg>' })),
  },
}));

const DOC = [
  '# Plan',
  '',
  'Intro.',
  '',
  '## Architecture',
  '',
  'body text',
  '',
  '### Wave mechanics',
  '',
  'more text',
  '',
  '## Architecture', // duplicate heading → deduped id
  '',
  'tail',
].join('\n');

beforeEach(cleanup);

describe('extractToc', () => {
  it('assigns slug ids to h2/h3 and dedupes collisions', () => {
    const host = document.createElement('div');
    host.innerHTML = '<h2>Architecture</h2><h3>Wave mechanics!</h3><h2>Architecture</h2>';
    const toc = extractToc(host);
    expect(toc.map((t) => t.id)).toEqual(['architecture', 'wave-mechanics', 'architecture-1']);
    expect(toc.map((t) => t.level)).toEqual([2, 3, 2]);
    expect(host.querySelector('h2')?.id).toBe('architecture');
    expect(host.querySelectorAll('h2')[1]?.id).toBe('architecture-1');
  });

  it('falls back to a stable id for punctuation-only headings', () => {
    const host = document.createElement('div');
    host.innerHTML = '<h2>??? !!!</h2>';
    expect(extractToc(host)[0]?.id).toBe('section');
  });
});

describe('pickActiveHeading (pure scroll-spy core)', () => {
  const candidates = [
    { id: 'a', top: 0 },
    { id: 'b', top: 400 },
    { id: 'c', top: 900 },
  ];

  it('highlights the first heading at the top of the document', () => {
    expect(pickActiveHeading(candidates, 0)).toBe('a');
  });

  it('advances as sections scroll past the anchor line', () => {
    expect(pickActiveHeading(candidates, 380)).toBe('b');
    expect(pickActiveHeading(candidates, 10_000)).toBe('c');
  });

  it('returns empty when there are no headings', () => {
    expect(pickActiveHeading([], 100)).toBe('');
  });
});

describe('DocsView TOC rail', () => {
  function renderDoc(): void {
    render(
      createElement(DocsView, {
        docs: [{ path: 'plan.md', title: 'plan.md' }],
        active: { path: 'plan.md', content: DOC },
        onSelect: vi.fn(),
        onOpenInEditor: vi.fn(),
      }),
    );
  }

  it('renders h2/h3 entries with sub-level indentation class', async () => {
    renderDoc();
    await waitFor(() => expect(screen.getAllByRole('link', { name: 'Architecture' }).length).toBeGreaterThan(0));
    expect(screen.getByRole('link', { name: 'Wave mechanics' }).closest('li')?.className).toContain('is-sub');
    expect(screen.getByLabelText('On this page')).toBeTruthy();
  });

  it('clicking a TOC entry smooth-scrolls to its heading and marks it current', async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: scrollIntoView,
      configurable: true,
      writable: true,
    });
    try {
      renderDoc();
      await waitFor(() => expect(screen.getByRole('link', { name: 'Wave mechanics' })).toBeTruthy());
      fireEvent.click(screen.getByRole('link', { name: 'Wave mechanics' }));
      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
      await waitFor(() =>
        expect(screen.getByRole('link', { name: 'Wave mechanics' }).getAttribute('aria-current')).toBe('true'),
      );
      const architectureLinks = screen.getAllByRole('link', { name: 'Architecture' });
      expect(architectureLinks.every((l) => l.getAttribute('aria-current') === null)).toBe(true);
    } finally {
      delete (Element.prototype as unknown as Record<string, unknown>)['scrollIntoView'];
    }
  });

  it('collapse toggle hides the list but keeps the rail header', async () => {
    renderDoc();
    await waitFor(() => expect(screen.getAllByRole('link', { name: 'Architecture' }).length).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: 'Collapse contents' }));
    expect(screen.queryByRole('link', { name: 'Architecture' })).toBeNull();
    expect(screen.getByText('Contents')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Expand contents' }));
    expect(screen.getAllByRole('link', { name: 'Architecture' })).toHaveLength(2);
  });
});
