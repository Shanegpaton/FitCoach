import { memo, useEffect, useId, useState, type ComponentProps } from 'react';
import Markdown, { defaultUrlTransform, type ExtraProps } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import rehypeHighlight from 'rehype-highlight';
import 'katex/dist/katex.min.css';
import 'highlight.js/styles/github-dark.css';

export function CopyText({ text, label = 'Copy code' }: { text: string; label?: string }) {
  const [status, setStatus] = useState('');
  useEffect(() => {
    if (!status) return;
    const timer = window.setTimeout(() => setStatus(''), 3000);
    return () => clearTimeout(timer);
  }, [status]);
  return <span className="coach-copy"><button type="button" onClick={async () => {
    try { await navigator.clipboard.writeText(text); setStatus('Copied'); }
    catch { setStatus('Copy unavailable. Select the text to copy.'); }
  }}>{label}</button><span role="status">{status}</span></span>;
}

// Serialize Mermaid's shared renderer and keep it out of the initial chat bundle.
let renderQueue = Promise.resolve();
let diagramId = 0;
async function renderDiagram(source: string): Promise<string> {
  if (source.length > 20000) throw new Error('Diagram is too large');
  // Do not allow renderer configuration from model output.
  if (/%%\s*\{|^\s*---/m.test(source)) throw new Error('Diagram configuration is not supported');
  const [{ default: mermaid }, { default: DOMPurify }] = await Promise.all([import('mermaid'), import('dompurify')]);
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark', htmlLabels: false,
    suppressErrorRendering: true, maxTextSize: 20000, maxEdges: 200,
    flowchart: { htmlLabels: false }, secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'themeCSS', 'dompurifyConfig'] });
  const { svg } = await mermaid.render(`coach-diagram-${++diagramId}`, source);
  return DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['foreignObject', 'image', 'a', 'script', 'animate', 'set'],
    FORBID_ATTR: ['href', 'xlink:href'] });
}

function Diagram({ source }: { source: string }) {
  const [result, setResult] = useState<{ source: string; svg?: string; failed?: boolean }>();
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    let active = true;
    renderQueue = renderQueue.then(async () => {
      if (!active) return;
      try {
        const svg = await renderDiagram(source);
        if (active) setResult({ source, svg });
      } catch { if (active) setResult({ source, failed: true }); }
    });
    return () => { active = false; };
  }, [source]);
  const current = result?.source === source ? result : undefined;
  const url = current?.svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(current.svg)}` : undefined;
  return <figure className="coach-diagram">
    <figcaption>Diagram</figcaption>
    {url ? <>
      <div className="coach-diagram-actions">
        <button type="button" aria-label="Zoom out diagram" disabled={zoom <= 1} onClick={() => setZoom(z => Math.max(1, z - .5))}>−</button>
        <span>{Math.round(zoom * 100)}%</span>
        <button type="button" aria-label="Zoom in diagram" disabled={zoom >= 3} onClick={() => setZoom(z => Math.min(3, z + .5))}>+</button>
        <a href={url} download="coach-diagram.svg">Save SVG</a>
      </div>
      <div className="coach-diagram-scroll" tabIndex={0} role="region" aria-label="Diagram preview, scroll to explore">
        <img src={url} alt="Coach diagram. Its text description is available in Diagram source below." style={{ width: `${zoom * 100}%`, maxWidth: 'none' }} />
      </div>
    </> : <p role="status">{current?.failed ? 'This diagram could not be rendered. The source is preserved below.' : 'Rendering diagram…'}</p>}
    <details open={current?.failed || undefined}><summary>Diagram source</summary><pre><code>{source}</code></pre></details>
    <CopyText text={source} label="Copy diagram source" />
  </figure>;
}

function CodeBlock({ children, node }: ComponentProps<'pre'> & ExtraProps) {
  const code = node?.children[0];
  const language = code?.type === 'element' ? String(code.properties.className ?? '').match(/language-([\w-]+)/)?.[1] : undefined;
  // Use the syntax tree so highlighted spans do not change the copied source.
  const getText = (item: typeof node): string => !item ? '' : item.children.map(child =>
    child.type === 'text' ? child.value : child.type === 'element' ? getText(child) : '').join('');
  const source = getText(node).replace(/\n$/, '');
  if (language?.toLowerCase() === 'mermaid') return <Diagram source={source} />;
  return <div className="coach-code"><div className="coach-code-toolbar"><span>{language ?? 'text'}</span><CopyText text={source} /></div><pre>{children}</pre></div>;
}

function MessageImage({ src, alt }: { src?: string; alt?: string }) {
  const [loadedSrc, setLoadedSrc] = useState('');
  const [failed, setFailed] = useState(false);
  // External images require a deliberate tap; merely reading a reply makes no tracking request.
  let url: URL;
  try { url = new URL(src ?? ''); }
  catch { return <span>{alt || 'Image unavailable'}</span>; }
  if (!src || !['https:', 'http:'].includes(url.protocol)) return <span>{alt || 'Image unavailable'}</span>;
  return <span className="coach-image">{loadedSrc === src && !failed
    ? <img src={src} alt={alt || 'Coach image'} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
    : <button type="button" onClick={() => { setFailed(false); setLoadedSrc(src); }}>{failed ? 'Retry image' : 'Load image'}: {alt || url.hostname}</button>}</span>;
}

function RichMarkdown({ text }: { text: string }) {
  const id = useId().replace(/:/g, '');
  return <Markdown skipHtml remarkPlugins={[remarkGfm, remarkMath]}
    remarkRehypeOptions={{ clobberPrefix: `coach-${id}-` }}
    rehypePlugins={[[rehypeKatex, { trust: false, strict: 'ignore', maxExpand: 1000, maxSize: 20 }], [rehypeHighlight, { detect: false, ignoreMissing: true }]]}
    urlTransform={(url, key) => {
      const safe = defaultUrlTransform(url);
      return key === 'href' && safe && /^(https?:|mailto:|#|\/)/i.test(safe) ? safe
        : key === 'src' && /^https?:\/\//i.test(safe) ? safe : '';
    }}
    components={{ pre: CodeBlock, img: MessageImage,
      a: ({ node: _node, href, ...props }) => href ? <a {...props} href={href} target={href.startsWith('#') ? undefined : '_blank'} rel="noopener noreferrer" /> : <span>{props.children}</span>,
      table: ({ children }) => <div className="coach-table-scroll" role="region" aria-label="Coach table, scroll for more columns" tabIndex={0}><table>{children}</table></div>,
    }}>{text}</Markdown>;
}

export const CoachMarkdown = memo(RichMarkdown);
