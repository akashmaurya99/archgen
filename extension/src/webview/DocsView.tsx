// DocsView.tsx — DOCS tab (todo 11).
//
// SAFETY POSTURE (bg_c93dc9c0): markdown-it runs with html:false so raw HTML
// in docs is escaped, linkify:true for bare URLs; mermaid initializes with
// securityLevel:'strict' + startOnLoad:false and renders ONLY after the
// markdown HTML is in the DOM. Each diagram renders inside its own try/catch:
// a broken diagram becomes an inline error box and the rest of the document
// stays rendered.
import { useEffect, useMemo, useRef } from 'react';
import MarkdownIt from 'markdown-it';
import type { DocRef } from '../shared/protocol';

const md = new MarkdownIt({ html: false, linkify: true });

/** Structural surface of mermaid we rely on (avoids the package's awkward default-export types). */
interface MermaidApi {
  initialize(config: { startOnLoad: boolean; securityLevel: 'strict' | 'loose' | 'sandbox' | 'antiscript' }): void;
  render(id: string, text: string): Promise<{ svg: string }>;
}

let mermaidPromise: Promise<MermaidApi> | null = null;

function getMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      const api = m.default as MermaidApi;
      api.initialize({ startOnLoad: false, securityLevel: 'strict' });
      return api;
    });
  }
  return mermaidPromise;
}

/** Test seam: forget the lazy singleton so tests can re-run initialization. */
export function resetMermaidForTests(): void {
  mermaidPromise = null;
}

let diagramSeq = 0;

/** Replace every ```mermaid block with rendered SVG or an inline error box. */
export async function renderMermaidBlocks(container: HTMLElement): Promise<void> {
  const blocks = Array.from(container.querySelectorAll('pre > code.language-mermaid'));
  const mermaid = await getMermaid();
  for (const codeEl of blocks) {
    const pre = codeEl.parentElement;
    if (!pre) continue;
    const box = document.createElement('div');
    try {
      const { svg } = await mermaid.render(`archgen-mmd-${diagramSeq++}`, codeEl.textContent ?? '');
      box.className = 'archgen-diagram';
      box.innerHTML = svg;
    } catch (e) {
      box.className = 'archgen-diagram-error';
      box.setAttribute('role', 'alert');
      box.textContent = `Diagram failed to render: ${e instanceof Error ? e.message : String(e)}`;
    }
    pre.replaceWith(box);
  }
}

export interface DocsViewProps {
  docs: DocRef[];
  /** Content fetched from the host for the selected doc (null until clicked). */
  active: { path: string; content: string } | null;
  onSelect(path: string): void;
  onOpenInEditor(path: string): void;
}

export function DocsView({ docs, active, onSelect, onOpenInEditor }: DocsViewProps) {
  const html = useMemo(() => (active ? md.render(active.content) : ''), [active]);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el || !html) return;
    void renderMermaidBlocks(el).catch(() => {
      /* initialize failure: diagrams stay as escaped code blocks */
    });
  }, [html]);

  return (
    <section className="archgen-docs-view" aria-label="Docs">
      <nav className="archgen-doc-sidebar" aria-label="Documentation files">
        <ul className="archgen-doc-list">
          {docs.map((d) => (
            <li key={d.path} className={active?.path === d.path ? 'is-active' : undefined}>
              <button type="button" className="archgen-doc-link" onClick={() => onSelect(d.path)}>
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
      </nav>
      <article className="archgen-doc-body" ref={bodyRef}>
        {active ? (
          <div className="archgen-markdown" dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          <p className="archgen-hint">Select a document to preview it here.</p>
        )}
      </article>
    </section>
  );
}
