import { decodeText } from '../lib/epub';
import type { ConvertContext, ConvertResult } from '../lib/importer';
import { base64ToBytes, escapeXml, ImportError, stripInvalidXmlChars } from '../lib/util';
import { assembleEpub, ImageStore, type ChapterDraft } from './common';

function kids(el: Element, name?: string): Element[] {
  return Array.from(el.children).filter((c) => !name || c.localName === name);
}

function plain(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

class Fb2Renderer {
  constructor(
    private binaries: Map<string, { mime: string; data: Uint8Array }>,
    private images: ImageStore,
  ) {}

  private imageSrc = new Map<string, string>();

  private image(el: Element): string {
    const href = el.getAttribute('l:href') ?? el.getAttribute('xlink:href') ?? el.getAttribute('href') ?? '';
    const id = href.replace(/^#/, '');
    const bin = this.binaries.get(id);
    if (!bin) return '';
    let src = this.imageSrc.get(id);
    if (!src) {
      src = '../' + this.images.add(bin.data, bin.mime, 'fb2');
      this.imageSrc.set(id, src);
    }
    return `<img src="${src}" alt="${escapeXml(el.getAttribute('alt') ?? '')}" />`;
  }

  inline(el: Element): string {
    let out = '';
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType === Node.TEXT_NODE) {
        out += escapeXml(stripInvalidXmlChars(n.textContent ?? ''));
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        const c = n as Element;
        const inner = () => this.inline(c);
        switch (c.localName) {
          case 'strong':
            out += `<strong>${inner()}</strong>`;
            break;
          case 'emphasis':
            out += `<em>${inner()}</em>`;
            break;
          case 'strikethrough':
            out += `<del>${inner()}</del>`;
            break;
          case 'sub':
            out += `<sub>${inner()}</sub>`;
            break;
          case 'sup':
            out += `<sup>${inner()}</sup>`;
            break;
          case 'code':
            out += `<code>${inner()}</code>`;
            break;
          case 'a': {
            const href = c.getAttribute('l:href') ?? c.getAttribute('xlink:href') ?? c.getAttribute('href') ?? '';
            if (href.startsWith('#') || /^https?:/i.test(href)) out += `<a href="${escapeXml(href)}">${inner()}</a>`;
            else out += inner();
            break;
          }
          case 'image':
            out += this.image(c);
            break;
          default:
            out += inner();
        }
      }
    }
    return out;
  }

  private idAttr(el: Element): string {
    const id = el.getAttribute('id');
    return id ? ` id="${escapeXml(id)}"` : '';
  }

  block(el: Element, depth: number): string {
    switch (el.localName) {
      case 'p':
        return `<p${this.idAttr(el)}>${this.inline(el)}</p>`;
      case 'empty-line':
        return '<p>&#160;</p>';
      case 'subtitle':
        return `<h4${this.idAttr(el)}>${this.inline(el)}</h4>`;
      case 'text-author':
        return `<p><em>${this.inline(el)}</em></p>`;
      case 'image':
        return `<figure>${this.image(el)}</figure>`;
      case 'title':
        return `<h${Math.min(6, depth)}>${kids(el, 'p').map((p) => this.inline(p)).join('<br />')}</h${Math.min(6, depth)}>`;
      case 'epigraph':
      case 'cite':
        return `<blockquote>${kids(el).map((c) => this.block(c, depth)).join('\n')}</blockquote>`;
      case 'poem':
        return `<blockquote class="poem">${kids(el)
          .map((c) => {
            if (c.localName === 'stanza') {
              return `<p>${kids(c, 'v').map((v) => this.inline(v)).join('<br />')}</p>`;
            }
            return this.block(c, depth);
          })
          .join('\n')}</blockquote>`;
      case 'table':
        return `<table>${kids(el, 'tr')
          .map((tr) => `<tr>${kids(tr).map((td) => `<${td.localName === 'th' ? 'th' : 'td'}>${this.inline(td)}</${td.localName === 'th' ? 'th' : 'td'}>`).join('')}</tr>`)
          .join('')}</table>`;
      case 'section':
        return `<div${this.idAttr(el)}>${kids(el).map((c) => this.block(c, depth + 1)).join('\n')}</div>`;
      default:
        return '';
    }
  }
}

export async function convertFb2(bytes: Uint8Array, fallbackTitle: string, ctx: ConvertContext): Promise<ConvertResult> {
  ctx.progress(0.1, 'Reading FictionBook');
  const doc = new DOMParser().parseFromString(decodeText(bytes), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length || doc.documentElement.localName !== 'FictionBook') {
    throw new ImportError('This FB2 file is damaged or not valid.');
  }
  const info = doc.getElementsByTagName('title-info')[0];
  const title = plain(info?.getElementsByTagName('book-title')[0]) || fallbackTitle;
  const authors = Array.from(info?.getElementsByTagName('author') ?? []).map((a) =>
    ['first-name', 'middle-name', 'last-name'].map((t) => plain(a.getElementsByTagName(t)[0])).filter(Boolean).join(' '),
  );
  const language = plain(info?.getElementsByTagName('lang')[0]) || 'en';
  const description = plain(info?.getElementsByTagName('annotation')[0]);

  const binaries = new Map<string, { mime: string; data: Uint8Array }>();
  for (const b of Array.from(doc.getElementsByTagName('binary'))) {
    const id = b.getAttribute('id');
    if (!id) continue;
    try {
      binaries.set(id, { mime: b.getAttribute('content-type') || 'image/jpeg', data: base64ToBytes(b.textContent ?? '') });
    } catch {
      /* skip undecodable images */
    }
  }
  const coverHref = info?.getElementsByTagName('coverpage')[0]?.getElementsByTagName('image')[0];
  const coverId = (coverHref?.getAttribute('l:href') ?? coverHref?.getAttribute('xlink:href') ?? '').replace(/^#/, '');
  const coverBin = binaries.get(coverId);

  const images = new ImageStore();
  const r = new Fb2Renderer(binaries, images);
  const drafts: ChapterDraft[] = [];

  const bodies = Array.from(doc.getElementsByTagName('body'));
  const main = bodies.filter((b) => b.getAttribute('name') !== 'notes');
  const notes = bodies.filter((b) => b.getAttribute('name') === 'notes');

  const addSection = (section: Element, headingDepth: number) => {
    const t = kids(section, 'title')[0];
    const chTitle = plain(t) || `Section ${drafts.length + 1}`;
    drafts.push({ title: chTitle, html: r.block(section, headingDepth).replace(/^<div[^>]*>|<\/div>$/g, '') });
  };

  for (const body of main) {
    const bodyTitle = kids(body, 'title')[0];
    const intro = [...(bodyTitle ? [bodyTitle] : []), ...kids(body, 'epigraph'), ...kids(body, 'image')];
    let sections = kids(body, 'section');
    if (sections.length === 1 && kids(sections[0], 'section').length > 1) {
      const only = sections[0];
      const preface = kids(only).filter((c) => c.localName !== 'section');
      intro.push(...preface);
      sections = kids(only, 'section');
    }
    if (intro.length) {
      drafts.push({ title: plain(bodyTitle) || title, html: intro.map((c) => r.block(c, 1)).join('\n') });
    }
    for (const s of sections) addSection(s, 1);
    // Loose paragraphs directly in the body.
    const loose = kids(body).filter((c) => c.localName === 'p');
    if (!sections.length && loose.length) drafts.push({ title, html: loose.map((p) => r.block(p, 1)).join('\n') });
    if (ctx.signal?.aborted) throw new DOMException('Import cancelled', 'AbortError');
  }
  for (const body of notes) {
    drafts.push({ title: 'Notes', html: `<h1>Notes</h1>\n${kids(body, 'section').map((s) => r.block(s, 2)).join('\n')}` });
  }
  if (!drafts.length) throw new ImportError('No readable text was found in this FB2 file.');

  // Point #id links at the chapter that defines the id.
  const owner = new Map<string, number>();
  drafts.forEach((d, i) => {
    for (const m of d.html.matchAll(/ id="([^"]+)"/g)) owner.set(m[1], i);
  });
  for (const d of drafts) {
    d.html = d.html.replace(/href="#([^"]+)"/g, (_m, id: string) => {
      const target = owner.get(id.replace(/&amp;/g, '&'));
      return target === undefined ? '' : `href="ch-${String(target + 1).padStart(4, '0')}.xhtml#${id}"`;
    });
  }

  ctx.progress(0.85, 'Building EPUB');
  const epub = await assembleEpub(
    { title, author: authors.filter(Boolean).join(', '), language, description, cover: coverBin },
    drafts,
    images,
  );
  return { epub, warnings: [] };
}
