import { buildEpub, type TocNode, type WriterImage } from '../lib/epubWriter';
import { dataUriToBytes, escapeXml, extFromMime, stripInvalidXmlChars, uid } from '../lib/util';

export interface ChapterDraft {
  title: string;
  /** XHTML fragment for the chapter body. */
  html: string;
  /** Continuation parts are not listed in the table of contents. */
  hidden?: boolean;
}

export interface BookMeta {
  title: string;
  author: string;
  language: string;
  description?: string;
  cover?: { data: Uint8Array | Blob; mime: string };
}

/** Collects images found during conversion and hands out their EPUB paths. */
export class ImageStore {
  readonly images: WriterImage[] = [];

  add(data: Uint8Array | Blob, mime: string, hint = 'img'): string {
    const path = `images/${hint}-${String(this.images.length + 1).padStart(4, '0')}.${extFromMime(mime)}`;
    this.images.push({ path, data, mime });
    return path;
  }
}

const REMOVE = 'script,noscript,style,link,meta,iframe,frame,frameset,object,embed,applet,base,form,input,button,select,textarea,audio,video,source,template,title,head,canvas';
const XHTML_NS = / xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/g;
const KEEP_ATTRS = new Set(['id', 'href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'lang', 'start', 'type', 'width', 'height', 'cite']);

/** Strips scripts, styling and anything that reaches the network, and moves embedded images into the store. */
export function cleanDom(root: Element, images: ImageStore): void {
  root.querySelectorAll(REMOVE).forEach((el) => el.remove());
  for (const el of Array.from(root.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (!KEEP_ATTRS.has(name) || name.startsWith('on')) el.removeAttribute(attr.name);
    }
    const tag = el.localName.toLowerCase();
    if (tag === 'img') {
      const src = el.getAttribute('src') ?? '';
      const decoded = src.startsWith('data:image/') ? dataUriToBytes(src) : null;
      if (decoded && decoded.mime !== 'image/svg+xml') {
        el.setAttribute('src', '../' + images.add(decoded.data, decoded.mime));
        el.removeAttribute('width');
        el.removeAttribute('height');
        if (!el.hasAttribute('alt')) el.setAttribute('alt', '');
      } else {
        const alt = el.getAttribute('alt');
        el.replaceWith(root.ownerDocument.createTextNode(alt ? `[${alt}]` : ''));
      }
    } else if (tag === 'a') {
      const href = el.getAttribute('href') ?? '';
      if (/^\s*(javascript|vbscript|data):/i.test(href)) el.removeAttribute('href');
      else if (/^https?:/i.test(href)) el.setAttribute('rel', 'noopener');
    } else if (tag === 'svg') {
      el.remove();
    }
  }
}

/** Serialises the children of `root` (already cleaned) as an XHTML fragment. */
export function serializeChildren(nodes: Node[]): string {
  const ser = new XMLSerializer();
  const out: string[] = [];
  for (const n of nodes) {
    if (n.nodeType === Node.TEXT_NODE) {
      const text = (n.textContent ?? '').trim();
      if (text) out.push(`<p>${escapeXml(stripInvalidXmlChars(text))}</p>`);
    } else if (n.nodeType === Node.ELEMENT_NODE) {
      out.push(stripInvalidXmlChars(ser.serializeToString(n).replace(XHTML_NS, '')));
    }
  }
  return out.join('\n');
}

export function textLength(nodes: Node[]): number {
  let n = 0;
  for (const node of nodes) n += (node.textContent ?? '').length;
  return n;
}

function headingText(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** Descends through single wrapper elements (`<div><div>…`) to the level where content siblings live. */
export function contentRoot(body: Element): Element {
  let el = body;
  for (let i = 0; i < 6; i++) {
    const kids = Array.from(el.children).filter((c) => (c.textContent ?? '').trim() || c.querySelector('img'));
    const loose = Array.from(el.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim());
    if (kids.length === 1 && !loose && /^(div|section|article|main|body)$/i.test(kids[0].localName) && !/^h[1-6]$/i.test(kids[0].localName)) {
      el = kids[0];
    } else break;
  }
  return el;
}

export interface RawChapter {
  title: string;
  nodes: Node[];
}

/** Splits a flat run of nodes into chapters at the given heading tag. */
export function splitAtHeadings(nodes: Node[], tag: string, introTitle: string): RawChapter[] {
  const chapters: RawChapter[] = [];
  let current: RawChapter = { title: introTitle, nodes: [] };
  const flush = () => {
    if (textLength(current.nodes) > 0 || current.nodes.some((n) => (n as Element).querySelector?.('img') || (n as Element).localName === 'img')) {
      chapters.push(current);
    }
  };
  for (const node of nodes) {
    if (node.nodeType === Node.ELEMENT_NODE && (node as Element).localName.toLowerCase() === tag) {
      flush();
      current = { title: headingText(node as Element) || 'Untitled', nodes: [node] };
    } else current.nodes.push(node);
  }
  flush();
  return chapters;
}

/** Splits oversized chapters at top-level block boundaries so each stays quick to paginate. */
export function limitChapterSize(chapters: RawChapter[], maxChars = 70000): ChapterDraftSource[] {
  const out: ChapterDraftSource[] = [];
  for (const ch of chapters) {
    let part: Node[] = [];
    let size = 0;
    let n = 0;
    const emit = () => {
      if (!part.length) return;
      out.push({ title: ch.title, nodes: part, hidden: n > 0 });
      n++;
      part = [];
      size = 0;
    };
    for (const node of ch.nodes) {
      const len = (node.textContent ?? '').length;
      if (size > 0 && size + len > maxChars) emit();
      part.push(node);
      size += len;
    }
    emit();
  }
  return out;
}

export interface ChapterDraftSource extends RawChapter {
  hidden?: boolean;
}

/** Rewrites in-document links (`#id`) so they point at the chapter file that holds the id. */
export function fixInternalLinks(sources: ChapterDraftSource[]): void {
  const idToChapter = new Map<string, number>();
  sources.forEach((src, i) => {
    for (const node of src.nodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const el = node as Element;
      if (el.id) idToChapter.set(el.id, i);
      el.querySelectorAll('[id]').forEach((e) => idToChapter.set(e.id, i));
    }
  });
  for (const src of sources) {
    for (const node of src.nodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const links = [...((node as Element).matches('a[href^="#"]') ? [node as Element] : []), ...Array.from((node as Element).querySelectorAll('a[href^="#"]'))];
      for (const a of links) {
        const id = decodeURIComponent((a.getAttribute('href') ?? '').slice(1));
        const target = idToChapter.get(id);
        if (target === undefined) a.removeAttribute('href');
        else a.setAttribute('href', `ch-${String(target + 1).padStart(4, '0')}.xhtml#${encodeURIComponent(id)}`);
      }
    }
  }
}

export function draftsFromSources(sources: ChapterDraftSource[]): ChapterDraft[] {
  return sources.map((s) => ({ title: s.title, html: serializeChildren(s.nodes), hidden: s.hidden }));
}

/** Packs drafts into an EPUB. */
export async function assembleEpub(meta: BookMeta, drafts: ChapterDraft[], images: ImageStore): Promise<Blob> {
  const chapters = (drafts.length ? drafts : [{ title: meta.title, html: '<p></p>' }]).map((d, i) => ({
    id: `ch-${i + 1}`,
    title: d.title,
    body: d.html,
  }));
  const toc: TocNode[] = [];
  drafts.forEach((d, i) => {
    if (!d.hidden) toc.push({ title: d.title, href: `text/ch-${String(i + 1).padStart(4, '0')}.xhtml` });
  });
  return buildEpub({
    title: meta.title,
    author: meta.author,
    language: meta.language || 'en',
    description: meta.description,
    identifier: `urn:uuid:${uid()}-${uid()}`,
    cover: meta.cover,
    chapters,
    images: images.images,
    toc,
  });
}

/** Builds chapters from a parsed document body using the heading structure it has. */
export function chaptersFromBody(body: Element, bookTitle: string): ChapterDraftSource[] {
  const root = contentRoot(body);
  const nodes = Array.from(root.childNodes);
  const count = (tag: string) => nodes.filter((n) => n.nodeType === 1 && (n as Element).localName.toLowerCase() === tag).length;
  let tag: string | null = null;
  const h1 = count('h1');
  const h2 = count('h2');
  if (h1 >= 2 || (h1 === 1 && h2 === 0)) tag = 'h1';
  else if (h2 >= 2) tag = 'h2';
  else if (h1 === 1 && h2 >= 1) tag = 'h2';
  else if (count('h3') >= 3) tag = 'h3';
  const raw = tag ? splitAtHeadings(nodes, tag, bookTitle) : [{ title: bookTitle, nodes }];
  return limitChapterSize(raw.length ? raw : [{ title: bookTitle, nodes }]);
}

export function checkAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Import cancelled', 'AbortError');
}
