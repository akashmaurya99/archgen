// DocsView.tsx — DOCS tab (todo 11, enterprise upgrade).
//
// SAFETY POSTURE (bg_c93dc9c0): markdown-it runs with html:false so raw HTML
// in docs is escaped, linkify:true for bare URLs; mermaid initializes with
// securityLevel:'strict' + startOnLoad:false and renders ONLY after the
// markdown HTML is in the DOM. Each diagram renders inside its own try/catch:
// a broken diagram becomes an inline error box (with a Retry button that
// re-invokes render for THAT block only) and the rest of the document stays
// rendered.
//
// ENTERPRISE LAYER: table-of-contents rail with scroll-spy, in-document
// search over rendered TEXT NODES only (html:false sanitization untouched —
// matches are wrapped in <mark> after parsing, never via HTML injection),
// sidebar filter/group/count, reading-time chip, back-to-top, code frames
// with language chip + copy button, highlight.js token classes (CSP-safe:
// classes only, colors come from dag.css vars), and mermaid zoom/pan
// viewports whose theme follows the VS Code theme kind.
import { useEffect, useMemo, useRef, useState } from 'react';
import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import jsonLang from 'highlight.js/lib/languages/json';
import bashLang from 'highlight.js/lib/languages/bash';
import markdownLang from 'highlight.js/lib/languages/markdown';
import cssLang from 'highlight.js/lib/languages/css';
import xmlLang from 'highlight.js/lib/languages/xml';
import pythonLang from 'highlight.js/lib/languages/python';
import yamlLang from 'highlight.js/lib/languages/yaml';
import type { DocRef, ThemeKind } from '../shared/protocol';

/* ------------------------------------------------------------------ */
/* Syntax highlighting (F): highlight.js CORE + consciously chosen     */
/* common languages only — tree-shaken, CSP-safe (class output, never  */
/* inline styles); token colors themed via CSS vars in dag.css.        */
/* ------------------------------------------------------------------ */
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('json', jsonLang);
hljs.registerLanguage('bash', bashLang);
hljs.registerLanguage('markdown', markdownLang);
hljs.registerLanguage('css', cssLang);
hljs.registerLanguage('xml', xmlLang);
hljs.registerLanguage('python', pythonLang);
hljs.registerLanguage('yaml', yamlLang);

const md = new MarkdownIt({
  html: false,
  linkify: true,
  highlight(code: string, lang: string): string {
    const safeLang = md.utils.escapeHtml(lang);
    if (lang && hljs.getLanguage(lang)) {
      try {
        return `<code class="hljs language-${safeLang}">${hljs.highlight(code, { language: lang, ignoreIllegals: true }).value}</code>`;
      } catch {
        /* fall through to plain escaping */
      }
    }
    return `<code class="language-${safeLang}">${md.utils.escapeHtml(code)}</code>`;
  },
});

/* ------------------------------------------------------------------ */
/* Mermaid lazy singleton with theme-aware initialization              */
/* ------------------------------------------------------------------ */

type MermaidTheme = 'dark' | 'neutral';

/** Structural surface of mermaid we rely on (avoids the package's awkward default-export types). */
interface MermaidApi {
  initialize(config: {
    startOnLoad: boolean;
    securityLevel: 'strict' | 'loose' | 'sandbox' | 'antiscript';
    theme?: MermaidTheme;
  }): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

let mermaidPromise: Promise<MermaidApi> | null = null;
let initializedTheme: MermaidTheme | null = null;
let activeMermaidTheme: MermaidTheme = 'neutral';

function getMermaid(theme: MermaidTheme = 'neutral'): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => m.default as MermaidApi);
  }
  return mermaidPromise.then((api) => {
    // Re-initialize ONLY when the requested theme differs — mermaid merges
    // config, so this is cheap and keeps securityLevel:'strict' pinned.
    if (initializedTheme !== theme) {
      api.initialize({ startOnLoad: false, securityLevel: 'strict', theme });
      initializedTheme = theme;
    }
    activeMermaidTheme = theme;
    return api;
  });
}

/** Test seam: forget the lazy singleton so tests can re-run initialization. */
export function resetMermaidForTests(): void {
  mermaidPromise = null;
  initializedTheme = null;
  activeMermaidTheme = 'neutral';
}

function mapThemeKind(kind: ThemeKind): MermaidTheme {
  return kind === 'dark' || kind === 'highContrast' ? 'dark' : 'neutral';
}

/** Read the theme attribute App.tsx paints onto <html data-theme="…">. */
function readDomThemeKind(): ThemeKind | undefined {
  const v = document.documentElement.getAttribute('data-theme');
  return v === 'light' || v === 'dark' || v === 'highContrast' || v === 'highContrastLight' ? v : undefined;
}

let diagramSeq = 0;

/** Re-render ONE failed diagram block in place (Retry button). */
function wireRetry(box: HTMLElement, retryBtn: HTMLButtonElement): void {
  retryBtn.addEventListener('click', () => {
    const source = box.dataset['mermaidSource'] ?? '';
    void getMermaid(activeMermaidTheme)
      .then(async (mermaid) => {
        const { svg } = await mermaid.render(`archgen-mmd-${diagramSeq++}`, source);
        box.className = 'archgen-diagram';
        box.removeAttribute('role');
        box.innerHTML = svg;
        mountDiagramViewport(box);
      })
      .catch((e: unknown) => {
        const msg = box.querySelector('.archgen-diagram-error-msg');
        if (msg) msg.textContent = `Diagram failed to render: ${e instanceof Error ? e.message : String(e)}`;
      });
  });
}

/* ------------------------------------------------------------------ */
/* Diagram viewport: zoom (+ / − / reset / ctrl-wheel) + drag-to-pan   */
/* ------------------------------------------------------------------ */

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.2;

/** Wrap a rendered diagram box in a toolbar + scrollable pan/zoom viewport. */
function mountDiagramViewport(box: HTMLElement): void {
  const wrap = document.createElement('div');
  wrap.className = 'archgen-diagram-wrap';

  const toolbar = document.createElement('div');
  toolbar.className = 'archgen-diagram-toolbar';

  const mkBtn = (cls: string, label: string, glyph: string): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = cls;
    b.textContent = glyph;
    b.setAttribute('aria-label', label);
    return b;
  };
  const zin = mkBtn('archgen-diagram-zoom-in', 'Zoom in diagram', '+');
  const zout = mkBtn('archgen-diagram-zoom-out', 'Zoom out diagram', '−');
  const zreset = mkBtn('archgen-diagram-zoom-reset', 'Reset diagram zoom', 'Reset');
  toolbar.append(zout, zin, zreset);

  const viewport = document.createElement('div');
  viewport.className = 'archgen-diagram-viewport';

  const parent = box.parentNode;
  if (!parent) return;
  parent.insertBefore(wrap, box);
  viewport.appendChild(box);
  wrap.append(toolbar, viewport);

  let scale = 1;
  let tx = 0;
  let ty = 0;
  const apply = (): void => {
    box.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  };
  const setScale = (next: number): void => {
    scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    apply();
  };
  zin.addEventListener('click', () => setScale(scale + ZOOM_STEP));
  zout.addEventListener('click', () => setScale(scale - ZOOM_STEP));
  zreset.addEventListener('click', () => {
    scale = 1;
    tx = 0;
    ty = 0;
    apply();
  });
  viewport.addEventListener(
    'wheel',
    (e: WheelEvent) => {
      if (!e.ctrlKey) return; // plain wheel scrolls the document
      e.preventDefault();
      setScale(scale + (e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
    },
    { passive: false },
  );

  // Drag-to-pan via pointer events (works for mouse/touch/pen alike).
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let baseTx = 0;
  let baseTy = 0;
  viewport.addEventListener('pointerdown', (e: PointerEvent) => {
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    baseTx = tx;
    baseTy = ty;
    try {
      viewport.setPointerCapture(e.pointerId);
    } catch {
      /* jsdom / older runtimes: capture unavailable, drag still works */
    }
  });
  viewport.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragging) return;
    tx = baseTx + (e.clientX - startX);
    ty = baseTy + (e.clientY - startY);
    apply();
  });
  const endDrag = (): void => {
    dragging = false;
  };
  viewport.addEventListener('pointerup', endDrag);
  viewport.addEventListener('pointercancel', endDrag);
}

/** Replace every ```mermaid block with rendered SVG or an inline error box. */
export async function renderMermaidBlocks(container: HTMLElement, theme: MermaidTheme = 'neutral'): Promise<void> {
  const blocks = Array.from(container.querySelectorAll('pre > code.language-mermaid'));
  const mermaid = await getMermaid(theme);
  for (const codeEl of blocks) {
    const pre = codeEl.parentElement;
    if (!pre) continue;
    const source = codeEl.textContent ?? '';
    const box = document.createElement('div');
    try {
      const { svg } = await mermaid.render(`archgen-mmd-${diagramSeq++}`, source);
      box.className = 'archgen-diagram';
      box.dataset['mermaidSource'] = source;
      box.innerHTML = svg;
    } catch (e) {
      box.className = 'archgen-diagram-error';
      box.setAttribute('role', 'alert');
      box.dataset['mermaidSource'] = source;
      const msg = document.createElement('span');
      msg.className = 'archgen-diagram-error-msg';
      msg.textContent = `Diagram failed to render: ${e instanceof Error ? e.message : String(e)}`;
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.className = 'archgen-diagram-retry';
      retry.textContent = 'Retry';
      wireRetry(box, retry);
      box.append(msg, retry);
    }
    pre.replaceWith(box);
    if (box.classList.contains('archgen-diagram')) mountDiagramViewport(box);
  }
}

/** Re-render EXISTING successful diagram boxes in place (theme switch). */
export async function rerenderDiagramBoxes(container: HTMLElement, theme: MermaidTheme): Promise<void> {
  const boxes = Array.from(container.querySelectorAll<HTMLElement>('.archgen-diagram[data-mermaid-source]'));
  if (boxes.length === 0) return;
  const mermaid = await getMermaid(theme);
  for (const box of boxes) {
    const source = box.dataset['mermaidSource'] ?? '';
    try {
      const { svg } = await mermaid.render(`archgen-mmd-${diagramSeq++}`, source);
      box.innerHTML = svg;
    } catch {
      /* keep the previous SVG rather than blanking a good diagram */
    }
  }
}

/* ------------------------------------------------------------------ */
/* Table of contents (A)                                               */
/* ------------------------------------------------------------------ */

export interface TocEntry {
  id: string;
  text: string;
  level: 2 | 3;
}

function slugify(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'section';
}

/** Assign stable ids to h2/h3 and return the TOC model. */
export function extractToc(root: HTMLElement): TocEntry[] {
  const used = new Map<string, number>();
  const entries: TocEntry[] = [];
  root.querySelectorAll('h2, h3').forEach((h) => {
    const text = h.textContent ?? '';
    const base = slugify(text);
    const n = used.get(base) ?? 0;
    used.set(base, n + 1);
    const id = n === 0 ? base : `${base}-${n}`;
    h.id = id;
    entries.push({ id, text, level: h.tagName === 'H2' ? 2 : 3 });
  });
  return entries;
}

/** PURE scroll-spy core: last heading at/below the scroll anchor wins. */
export function pickActiveHeading(candidates: { id: string; top: number }[], scrollTop: number): string {
  const anchor = scrollTop + 56;
  let active = candidates[0]?.id ?? '';
  for (const c of candidates) {
    if (c.top <= anchor) active = c.id;
  }
  return active;
}

/* ------------------------------------------------------------------ */
/* In-document search (B) — operates on rendered DOM text nodes ONLY.  */
/* html:false sanitization is untouched: we wrap existing text in      */
/* <mark class="archgen-search-hit"> after parsing, never inject HTML. */
/* ------------------------------------------------------------------ */

const SEARCH_SKIP_SELECTOR =
  'mark, script, style, svg, .archgen-code-head, .archgen-diagram-toolbar, .archgen-diagram-retry';

/** Unwrap every search mark, restoring the original text nodes. */
export function clearSearchMarks(root: HTMLElement): void {
  const marks = Array.from(root.querySelectorAll('mark.archgen-search-hit'));
  for (const m of marks) {
    const parent = m.parentNode;
    if (!parent) continue;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    m.remove();
  }
  root.normalize(); // merge the split text nodes back together
}

/** Highlight case-insensitive matches; returns the marks in document order. */
export function applySearch(root: HTMLElement, query: string): HTMLElement[] {
  clearSearchMarks(root);
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const parent = node.parentElement;
      if (!parent || !node.nodeValue) return NodeFilter.FILTER_REJECT;
      if (parent.closest(SEARCH_SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
      return node.nodeValue.toLowerCase().includes(q) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });

  const matched: Text[] = [];
  let current = walker.nextNode();
  while (current) {
    matched.push(current as Text);
    current = walker.nextNode();
  }

  const hits: HTMLElement[] = [];
  for (const node of matched) {
    const text = node.nodeValue ?? '';
    const lower = text.toLowerCase();
    const frag = document.createDocumentFragment();
    let pos = 0;
    let idx = lower.indexOf(q);
    while (idx !== -1) {
      if (idx > pos) frag.appendChild(document.createTextNode(text.slice(pos, idx)));
      const mark = document.createElement('mark');
      mark.className = 'archgen-search-hit';
      mark.textContent = text.slice(idx, idx + q.length);
      frag.appendChild(mark);
      hits.push(mark);
      pos = idx + q.length;
      idx = lower.indexOf(q, pos);
    }
    if (pos < text.length) frag.appendChild(document.createTextNode(text.slice(pos)));
    node.replaceWith(frag);
  }
  return hits;
}

/* ------------------------------------------------------------------ */
/* Code frames (E): language chip + copy button around fenced blocks   */
/* ------------------------------------------------------------------ */

async function copyCode(text: string, btn: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard?.writeText(text);
  } catch {
    /* clipboard unavailable (tests / permissions) — feedback still shows */
  }
  btn.textContent = 'Copied!';
  btn.classList.add('is-copied');
  setTimeout(() => {
    btn.textContent = 'Copy';
    btn.classList.remove('is-copied');
  }, 1400);
}

/** Wrap every non-mermaid fenced block in a frame with lang chip + Copy. */
function enhanceCodeBlocks(root: HTMLElement): void {
  root.querySelectorAll('pre > code').forEach((code) => {
    if (!(code instanceof HTMLElement)) return;
    if (code.classList.contains('language-mermaid')) return;
    const pre = code.parentElement;
    if (!pre || pre.parentElement?.classList.contains('archgen-code-frame')) return;

    const langClass = Array.from(code.classList).find((c) => c.startsWith('language-'));
    const lang = langClass ? langClass.slice('language-'.length) : '';

    const frame = document.createElement('div');
    frame.className = 'archgen-code-frame';
    const head = document.createElement('div');
    head.className = 'archgen-code-head';
    const chip = document.createElement('span');
    chip.className = 'archgen-code-lang';
    chip.textContent = lang || 'text';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'archgen-copy-btn archgen-code-copy';
    btn.setAttribute('aria-label', `Copy ${lang || 'code'} block`);
    btn.textContent = 'Copy';
    btn.addEventListener('click', () => void copyCode(code.textContent ?? '', btn));
    head.append(chip, btn);

    pre.replaceWith(frame);
    frame.append(head, pre);
  });
}

/* ------------------------------------------------------------------ */
/* Sidebar model (C): filter + top-level-folder grouping               */
/* ------------------------------------------------------------------ */

interface DocGroup {
  /** Top-level folder name, or null for docs without '/' in their path. */
  label: string | null;
  items: DocRef[];
}

export function groupDocs(docs: DocRef[], filter: string): DocGroup[] {
  const f = filter.trim().toLowerCase();
  const visible = docs.filter(
    (d) => !f || d.title.toLowerCase().includes(f) || d.path.toLowerCase().includes(f),
  );
  const groups: DocGroup[] = [];
  const byLabel = new Map<string, DocGroup>();
  for (const d of visible) {
    const slash = d.path.indexOf('/');
    const label = slash === -1 ? null : d.path.slice(0, slash);
    const key = label ?? '';
    let g = byLabel.get(key);
    if (!g) {
      g = { label, items: [] };
      byLabel.set(key, g);
      groups.push(g);
    }
    g.items.push(d);
  }
  return groups;
}

/** Reading-time estimate: words / 200, minimum one minute. */
export function readingMinutes(content: string): number {
  const words = content.trim() ? content.trim().split(/\s+/).length : 0;
  return Math.max(1, Math.ceil(words / 200));
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export interface DocsViewProps {
  docs: DocRef[];
  /** Content fetched from the host for the selected doc (null until clicked). */
  active: { path: string; content: string } | null;
  onSelect(path: string): void;
  onOpenInEditor(path: string): void;
  /**
   * Explicit VS Code theme kind. Optional: when omitted (App.tsx is not
   * allowed to change in this task) the component OBSERVES the
   * `<html data-theme>` attribute App already paints, via MutationObserver,
   * so diagrams still re-render live on theme switches.
   */
  themeKind?: ThemeKind;
}

/** jsdom-safe smooth scroll: no-ops where scrollIntoView is unavailable. */
function scrollToEl(el: HTMLElement | null, block: ScrollLogicalPosition): void {
  try {
    el?.scrollIntoView?.({ behavior: 'smooth', block });
  } catch {
    /* ignore */
  }
}

export function DocsView({ docs, active, onSelect, onOpenInEditor, themeKind }: DocsViewProps) {
  const html = useMemo(() => (active ? md.render(active.content) : ''), [active]);
  const readMin = useMemo(() => (active ? readingMinutes(active.content) : 0), [active]);
  const bodyRef = useRef<HTMLElement | null>(null);
  const marksRef = useRef<HTMLElement[]>([]);

  const [domTheme, setDomTheme] = useState<ThemeKind | undefined>(() => readDomThemeKind());
  useEffect(() => {
    if (typeof MutationObserver === 'undefined') return;
    const mo = new MutationObserver(() => setDomTheme(readDomThemeKind()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  }, []);
  const resolvedKind: ThemeKind = themeKind ?? domTheme ?? 'light';
  const mermaidTheme = mapThemeKind(resolvedKind);

  const [filter, setFilter] = useState('');
  const [toc, setToc] = useState<TocEntry[]>([]);
  const [tocOpen, setTocOpen] = useState(true);
  const [activeHeading, setActiveHeading] = useState('');
  const [query, setQuery] = useState('');
  const [hitCount, setHitCount] = useState(0);
  const [hitIndex, setHitIndex] = useState(0);
  const [showTop, setShowTop] = useState(false);

  const groups = useMemo(() => groupDocs(docs, filter), [docs, filter]);
  const visibleCount = groups.reduce((n, g) => n + g.items.length, 0);

  /* Master enhancement pass — runs whenever a new document is rendered.
     Order matters: this effect is declared BEFORE the search effect so the
     search always applies to the enhanced DOM. */
  useEffect(() => {
    const el = bodyRef.current;
    const mdEl = el?.querySelector('.archgen-markdown');
    if (!el || !html || !(mdEl instanceof HTMLElement)) return;
    clearSearchMarks(mdEl);
    enhanceCodeBlocks(mdEl);
    setToc(extractToc(mdEl));
    setActiveHeading('');
    void renderMermaidBlocks(mdEl, mermaidTheme).catch(() => {
      /* initialize failure: diagrams stay as escaped code blocks */
    });
  }, [html]);

  /* Search application — text-node wrapping only (see applySearch). */
  useEffect(() => {
    const mdEl = bodyRef.current?.querySelector('.archgen-markdown');
    if (!(mdEl instanceof HTMLElement)) return;
    const hits = applySearch(mdEl, query);
    marksRef.current = hits;
    setHitCount(hits.length);
    setHitIndex(0);
    if (hits[0]) hits[0].classList.add('is-current');
  }, [query, html]);

  /* Theme switch → re-initialize mermaid and re-render existing boxes. */
  useEffect(() => {
    const mdEl = bodyRef.current?.querySelector('.archgen-markdown');
    if (!(mdEl instanceof HTMLElement)) return;
    void rerenderDiagramBoxes(mdEl, mermaidTheme).catch(() => {});
  }, [mermaidTheme]);

  /* Reset transient doc-scoped state when switching documents. */
  useEffect(() => {
    setQuery('');
    setFilter((f) => f); // filter intentionally persists across docs
  }, [active?.path]);

  /* Back-to-top visibility — independent of the TOC (any scrollable doc). */
  useEffect(() => {
    const container = bodyRef.current;
    if (!container) return;
    const onScroll = (): void => setShowTop(container.scrollTop > 600);
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, []);

  /* Scroll-spy: IntersectionObserver when available, scroll fallback otherwise. */
  useEffect(() => {
    const container = bodyRef.current;
    if (!container || toc.length === 0) return;
    const headings = toc
      .map((t) => document.getElementById(t.id))
      .filter((h): h is HTMLElement => h !== null);

    let ioActive = false;
    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver !== 'undefined') {
      ioActive = true;
      io = new IntersectionObserver(
        (entries) => {
          const visible = entries
            .filter((e) => e.isIntersecting)
            .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
          if (visible[0]) setActiveHeading(visible[0].target.id);
        },
        { root: container, rootMargin: '0px 0px -70% 0px', threshold: 0 },
      );
      headings.forEach((h) => io?.observe(h));
    }

    const onScroll = (): void => {
      if (!ioActive) {
        setActiveHeading(
          pickActiveHeading(
            headings.map((h) => ({ id: h.id, top: h.offsetTop })),
            container.scrollTop,
          ),
        );
      }
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      container.removeEventListener('scroll', onScroll);
      io?.disconnect();
    };
  }, [toc]);

  const jumpTo = (id: string): void => {
    scrollToEl(document.getElementById(id), 'start');
    setActiveHeading(id);
  };

  const goToHit = (dir: 1 | -1): void => {
    const hits = marksRef.current;
    if (hits.length === 0) return;
    const next = (hitIndex + dir + hits.length) % hits.length;
    setHitIndex(next);
    hits.forEach((m) => m.classList.remove('is-current'));
    const target = hits[next];
    if (target) {
      target.classList.add('is-current');
      scrollToEl(target, 'center');
    }
  };

  const backToTop = (): void => {
    const c = bodyRef.current;
    if (!c) return;
    try {
      c.scrollTo({ top: 0, behavior: 'smooth' });
    } catch {
      c.scrollTop = 0;
    }
  };

  return (
    <section className="archgen-docs-view" aria-label="Docs">
      <nav className="archgen-doc-sidebar" aria-label="Documentation files">
        <div className="archgen-doc-side-tools">
          <input
            type="search"
            className="archgen-doc-filter"
            placeholder="Filter docs…"
            aria-label="Filter documents"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <span className="archgen-doc-count" aria-label={`Showing ${visibleCount} of ${docs.length} documents`}>
            {visibleCount}/{docs.length}
          </span>
        </div>
        <ul className="archgen-doc-list">
          {groups.map((g) => (
            <li key={g.label ?? ''} className="archgen-doc-group">
              {g.label && <span className="archgen-doc-group-label">{g.label}</span>}
              <ul className="archgen-doc-list">
                {g.items.map((d) => (
                  <li key={d.path} className={active?.path === d.path ? 'is-active' : undefined}>
                    <button
                      type="button"
                      className="archgen-doc-link"
                      aria-current={active?.path === d.path ? 'page' : undefined}
                      onClick={() => onSelect(d.path)}
                    >
                      {d.title}
                    </button>
                    <button
                      type="button"
                      className="archgen-doc-external"
                      aria-label={`Open ${d.title} in editor`}
                      title="Open in editor"
                      onClick={() => onOpenInEditor(d.path)}
                    >
                      ↗
                    </button>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </nav>

      <article className="archgen-doc-body" ref={bodyRef}>
        {active ? (
          <>
            <div className="archgen-doc-toolbar">
              <span className="archgen-doc-readtime" aria-label={`${readMin} minute read`}>
                {readMin} min read
              </span>
              <div className="archgen-doc-search">
                <input
                  type="search"
                  className="archgen-doc-search-input"
                  placeholder="Search document…"
                  aria-label="Search in document"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setQuery('');
                    if (e.key === 'Enter') goToHit(e.shiftKey ? -1 : 1);
                  }}
                />
                {query.trim() && (
                  <span className="archgen-search-count" role="status">
                    {hitCount} {hitCount === 1 ? 'hit' : 'hits'}
                  </span>
                )}
                <button
                  type="button"
                  className="archgen-search-nav"
                  aria-label="Previous match"
                  disabled={hitCount === 0}
                  onClick={() => goToHit(-1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="archgen-search-nav"
                  aria-label="Next match"
                  disabled={hitCount === 0}
                  onClick={() => goToHit(1)}
                >
                  ↓
                </button>
              </div>
            </div>
            <div className="archgen-markdown" dangerouslySetInnerHTML={{ __html: html }} />
          </>
        ) : (
          <div className="archgen-doc-empty" role="region" aria-label="No document selected">
            <h3 className="archgen-doc-empty-title">No Document Selected</h3>
            <p className="archgen-hint archgen-doc-empty-desc">Select a document to preview it here.</p>
          </div>
        )}
      </article>

      {showTop && (
        <button type="button" className="archgen-back-to-top" aria-label="Back to top" onClick={backToTop}>
          ↑ Top
        </button>
      )}

      {active && toc.length > 0 && (
        <>
          <button
            type="button"
            className="archgen-doc-toc-fab"
            aria-label="Toggle table of contents"
            aria-expanded={tocOpen}
            onClick={() => setTocOpen((v) => !v)}
          >
            ☰
          </button>
          <nav className={`archgen-doc-toc${tocOpen ? '' : ' is-collapsed'}`} aria-label="On this page">
            <div className="archgen-doc-toc-head">
              <span>Contents</span>
              <button
                type="button"
                className="archgen-doc-toc-toggle"
                aria-label={tocOpen ? 'Collapse contents' : 'Expand contents'}
                aria-expanded={tocOpen}
                onClick={() => setTocOpen((v) => !v)}
              >
                {tocOpen ? '▾' : '▸'}
              </button>
            </div>
            {tocOpen && (
              <ul className="archgen-doc-toc-list">
                {toc.map((e) => (
                  <li key={e.id} className={e.level === 3 ? 'is-sub' : undefined}>
                    <a
                      href={`#${e.id}`}
                      className="archgen-doc-toc-link"
                      aria-current={activeHeading === e.id ? 'true' : undefined}
                      onClick={(ev) => {
                        ev.preventDefault();
                        jumpTo(e.id);
                      }}
                    >
                      {e.text}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </nav>
        </>
      )}
    </section>
  );
}
