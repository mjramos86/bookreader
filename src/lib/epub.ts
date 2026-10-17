import JSZip from 'jszip';
import { dirname, fragmentOf, ImportError, mimeFromPath, resolvePath, safeDecode } from './util';

export interface SpineItem {
  id: string;
  /** Path inside the zip. */
  path: string;
  mediaType: string;
  linear: boolean;
}

export interface TocItem {
  title: string;
  /** Index into `spine`. */
  spine: number;
  fragment?: string;
  /** Character offset of the fragment inside its chapter; filled in by the indexer. */
  offset?: number;
  children: TocItem[];
}

export interface FlatTocItem {
  title: string;
  spine: number;
  fragment?: string;
  offset?: number;
  depth: number;
}

export interface EpubMetadata {
  title: string;
  author: string;
  language: string;
}

interface ManifestItem {
  id: string;
  path: string;
  mediaType: string;
  properties: string[];
}

const FONT_OBFUSCATION = 'http://www.idpf.org/2008/embedding';

function parseXml(text: string, type: DOMParserSupportedType = 'application/xml'): Document {
  return new DOMParser().parseFromString(text, type);
}

/** Case-insensitive, namespace-agnostic child lookup (EPUBs mix prefixes freely). */
function byLocalName(root: Element | Document, name: string): Element[] {
  return Array.from(root.getElementsByTagNameNS('*', name));
}

function textOf(el: Element | undefined | null): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/** A parsed EPUB, backed by the zip archive. Resources are read lazily. */
export class EpubBook {
  metadata: EpubMetadata = { title: '', author: '', language: 'en' };
  spine: SpineItem[] = [];
  toc: TocItem[] = [];
  /** Plain text of each chapter, filled in by the indexer. */
  chapterText: string[] = [];
  /** Cumulative character offsets: chapterStart[i] = chars before chapter i. */
  chapterStart: number[] = [];
  totalChars = 0;

  private manifest = new Map<string, ManifestItem>();
  private pathToSpine = new Map<string, number>();
  private urlCache = new Map<string, string>();
  private obfuscated = new Map<string, number>();
  private fontKey: Uint8Array | null = null;
  private coverPath: string | null = null;
  private opfPath = '';

  private constructor(private zip: JSZip) {}

  static async open(data: Blob | ArrayBuffer | Uint8Array): Promise<EpubBook> {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(data);
    } catch {
      throw new ImportError('This file is not a valid EPUB (it could not be opened as a zip archive).');
    }
    const book = new EpubBook(zip);
    await book.parse();
    return book;
  }

  private async readXml(path: string, type: DOMParserSupportedType = 'application/xml'): Promise<Document | null> {
    const text = await this.readText(path);
    if (text == null) return null;
    const doc = parseXml(text, type);
    return doc;
  }

  async readText(path: string): Promise<string | null> {
    const entry = this.findEntry(path);
    if (!entry) return null;
    const bytes = await entry.async('uint8array');
    return decodeText(bytes);
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    const entry = this.findEntry(path);
    if (!entry) return null;
    let bytes = await entry.async('uint8array');
    const key = this.obfuscated.get(entry.name);
    if (key !== undefined && this.fontKey) {
      bytes = bytes.slice();
      const n = Math.min(key, bytes.length);
      for (let i = 0; i < n; i++) bytes[i] ^= this.fontKey[i % this.fontKey.length];
    }
    return bytes;
  }

  private findEntry(path: string): JSZip.JSZipObject | null {
    const direct = this.zip.file(path);
    if (direct) return direct;
    // Tolerate case mismatches and un-decoded names.
    const lower = path.toLowerCase();
    const alt = this.zip.file(safeDecode(path)) ?? this.zip.file(encodeURI(path));
    if (alt) return alt;
    let found: JSZip.JSZipObject | null = null;
    this.zip.forEach((p, f) => {
      if (!found && !f.dir && p.toLowerCase() === lower) found = f;
    });
    return found;
  }

  private async parse(): Promise<void> {
    const container = await this.readXml('META-INF/container.xml');
    const rootfile = container && byLocalName(container, 'rootfile')[0];
    const opfPath = rootfile?.getAttribute('full-path');
    if (!opfPath) throw new ImportError('This EPUB is missing its container.xml, so it cannot be read.');
    this.opfPath = opfPath;

    await this.parseEncryption();

    const opf = await this.readXml(opfPath);
    if (!opf || opf.getElementsByTagName('parsererror').length) {
      throw new ImportError('This EPUB has a damaged package file.');
    }

    // Manifest
    for (const item of byLocalName(opf, 'item')) {
      const id = item.getAttribute('id');
      const href = item.getAttribute('href');
      if (!id || !href) continue;
      this.manifest.set(id, {
        id,
        path: resolvePath(opfPath, href),
        mediaType: item.getAttribute('media-type') ?? mimeFromPath(href),
        properties: (item.getAttribute('properties') ?? '').split(/\s+/).filter(Boolean),
      });
    }

    // Spine
    const spineEl = byLocalName(opf, 'spine')[0];
    for (const ref of spineEl ? byLocalName(spineEl, 'itemref') : []) {
      const m = this.manifest.get(ref.getAttribute('idref') ?? '');
      if (!m) continue;
      if (!/x?html|xml/.test(m.mediaType) && !/\.(x?html?|xml)$/i.test(m.path)) continue;
      this.spine.push({
        id: m.id,
        path: m.path,
        mediaType: m.mediaType,
        linear: ref.getAttribute('linear') !== 'no',
      });
    }
    if (!this.spine.length) throw new ImportError('This EPUB has no readable content.');
    this.spine.forEach((s, i) => this.pathToSpine.set(s.path, i));

    // Metadata
    const meta = byLocalName(opf, 'metadata')[0];
    const first = (name: string) => textOf(meta ? byLocalName(meta, name)[0] : null);
    const creators = (meta ? byLocalName(meta, 'creator') : []).map(textOf).filter(Boolean);
    this.metadata = {
      title: first('title') || 'Untitled',
      author: creators.join(', '),
      language: first('language') || 'en',
    };

    // Cover
    const coverItem = Array.from(this.manifest.values()).find((m) => m.properties.includes('cover-image'));
    if (coverItem) this.coverPath = coverItem.path;
    else {
      const metaCover = meta
        ? byLocalName(meta, 'meta').find((m) => m.getAttribute('name') === 'cover')?.getAttribute('content')
        : null;
      const viaMeta = metaCover ? this.manifest.get(metaCover) : undefined;
      if (viaMeta && viaMeta.mediaType.startsWith('image/')) this.coverPath = viaMeta.path;
      else {
        const guess = Array.from(this.manifest.values()).find(
          (m) => m.mediaType.startsWith('image/') && /cover/i.test(m.id + m.path),
        );
        if (guess) this.coverPath = guess.path;
      }
    }

    await this.parseToc(opf, spineEl);
    this.chapterText = new Array(this.spine.length).fill('');
  }

  private async parseEncryption(): Promise<void> {
    const enc = await this.readXml('META-INF/encryption.xml');
    if (!enc) return;
    const items = byLocalName(enc, 'EncryptedData');
    let drm = false;
    const paths: string[] = [];
    for (const item of items) {
      const method = byLocalName(item, 'EncryptionMethod')[0]?.getAttribute('Algorithm') ?? '';
      const uri = byLocalName(item, 'CipherReference')[0]?.getAttribute('URI');
      if (method === FONT_OBFUSCATION && uri) paths.push(safeDecode(uri));
      else drm = true;
    }
    if (drm) {
      throw new ImportError('This EPUB is protected by DRM and cannot be opened here.');
    }
    if (paths.length) {
      const opf = await this.readXml(this.opfPath);
      const idRef = opf?.documentElement.getAttribute('unique-identifier');
      const idEl = opf && byLocalName(opf, 'identifier').find((e) => !idRef || e.getAttribute('id') === idRef);
      const id = (idEl?.textContent ?? '').replace(/[\t\n\r ]/g, '');
      if (id) {
        const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(id));
        this.fontKey = new Uint8Array(digest);
        for (const p of paths) this.obfuscated.set(p, 1040);
      }
    }
  }

  private async parseToc(opf: Document, spineEl: Element | undefined): Promise<void> {
    const navItem = Array.from(this.manifest.values()).find((m) => m.properties.includes('nav'));
    if (navItem) {
      const doc = await this.readXml(navItem.path, 'application/xhtml+xml');
      if (doc && !doc.getElementsByTagName('parsererror').length) {
        const navs = Array.from(doc.getElementsByTagName('nav'));
        const tocNav =
          navs.find((n) => (n.getAttribute('epub:type') ?? n.getAttributeNS('http://www.idpf.org/2007/ops', 'type') ?? '').includes('toc')) ??
          navs[0];
        const ol = tocNav && Array.from(tocNav.children).find((c) => c.localName === 'ol');
        if (ol) this.toc = this.tocFromNavList(ol, navItem.path);
      }
    }
    if (!this.toc.length) {
      const ncxId = spineEl?.getAttribute('toc');
      const ncxItem =
        (ncxId && this.manifest.get(ncxId)) ||
        Array.from(this.manifest.values()).find((m) => m.mediaType === 'application/x-dtbncx+xml');
      if (ncxItem) {
        const doc = await this.readXml(ncxItem.path);
        const navMap = doc && byLocalName(doc, 'navMap')[0];
        if (navMap) this.toc = this.tocFromNcx(navMap, ncxItem.path);
      }
    }
    void opf;
  }

  private mapHref(basePath: string, href: string | null): { spine: number; fragment?: string } | null {
    if (!href) return null;
    const path = resolvePath(basePath, href);
    const spine = this.pathToSpine.get(path);
    if (spine === undefined) return null;
    return { spine, fragment: fragmentOf(href) };
  }

  private tocFromNavList(ol: Element, navPath: string): TocItem[] {
    const out: TocItem[] = [];
    for (const li of Array.from(ol.children).filter((c) => c.localName === 'li')) {
      const label = Array.from(li.children).find((c) => c.localName === 'a' || c.localName === 'span');
      const sub = Array.from(li.children).find((c) => c.localName === 'ol');
      const children = sub ? this.tocFromNavList(sub, navPath) : [];
      const target = label?.localName === 'a' ? this.mapHref(navPath, label.getAttribute('href')) : null;
      const title = textOf(label);
      if (target) out.push({ title: title || 'Untitled', ...target, children });
      else out.push(...children); // heading with no target: hoist its children
    }
    return out;
  }

  private tocFromNcx(parent: Element, ncxPath: string): TocItem[] {
    const out: TocItem[] = [];
    for (const point of Array.from(parent.children).filter((c) => c.localName === 'navPoint')) {
      const label = textOf(byLocalName(point, 'text')[0]);
      const content = Array.from(point.children).find((c) => c.localName === 'content');
      const target = this.mapHref(ncxPath, content?.getAttribute('src') ?? null);
      const children = this.tocFromNcx(point, ncxPath);
      if (target) out.push({ title: label || 'Untitled', ...target, children });
      else out.push(...children);
    }
    return out;
  }

  flatToc(): FlatTocItem[] {
    const out: FlatTocItem[] = [];
    const walk = (items: TocItem[], depth: number) => {
      for (const it of items) {
        out.push({ title: it.title, spine: it.spine, fragment: it.fragment, offset: it.offset, depth });
        walk(it.children, depth + 1);
      }
    };
    walk(this.toc, 0);
    return out;
  }

  spineIndexOf(path: string): number | undefined {
    return this.pathToSpine.get(path);
  }

  /** The TOC entry that contains the given position (the last one that starts at or before it). */
  tocEntryAt(flat: FlatTocItem[], spine: number, offset: number): number {
    let best = -1;
    for (let i = 0; i < flat.length; i++) {
      const it = flat[i];
      // Entries pointing into the middle of a chapter count only once their position is known.
      if (it.fragment && it.offset === undefined && it.spine === spine) continue;
      const pos = it.offset ?? 0;
      const before = it.spine < spine || (it.spine === spine && pos <= offset);
      if (!before) continue;
      if (best < 0 || it.spine > flat[best].spine || (it.spine === flat[best].spine && pos >= (flat[best].offset ?? 0))) best = i;
    }
    return best;
  }

  /** Title of the section at a position; falls back to the book title. */
  chapterTitle(spine: number, offset = 0, flat: FlatTocItem[] = this.flatToc()): string {
    const i = this.tocEntryAt(flat, spine, offset);
    return i >= 0 ? flat[i].title : this.metadata.title;
  }

  /** Visits every TOC item that points into the given chapter. */
  tocItemsInSpine(spine: number): TocItem[] {
    const out: TocItem[] = [];
    const walk = (items: TocItem[]) => {
      for (const it of items) {
        if (it.spine === spine) out.push(it);
        walk(it.children);
      }
    };
    walk(this.toc);
    return out;
  }

  async getCover(): Promise<Blob | null> {
    if (!this.coverPath) return null;
    const bytes = await this.readBytes(this.coverPath);
    if (!bytes) return null;
    return new Blob([bytes as BlobPart], { type: mimeFromPath(this.coverPath) });
  }

  /** Blob URL for a resource inside the archive; cached and revoked in `dispose`. */
  async resourceUrl(path: string): Promise<string | null> {
    const cached = this.urlCache.get(path);
    if (cached) return cached;
    const bytes = await this.readBytes(path);
    if (!bytes) return null;
    const mime = this.manifestMime(path) ?? mimeFromPath(path);
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
    this.urlCache.set(path, url);
    return url;
  }

  private manifestMime(path: string): string | undefined {
    for (const m of this.manifest.values()) if (m.path === path) return m.mediaType;
    return undefined;
  }

  setChapterTexts(texts: string[]): void {
    this.chapterText = texts;
    this.chapterStart = [];
    let total = 0;
    for (const t of texts) {
      this.chapterStart.push(total);
      total += t.length;
    }
    this.totalChars = total;
  }

  /** Fraction (0..1) of the whole book that precedes the given position. */
  bookFraction(spine: number, offset: number): number {
    if (!this.totalChars) return spine / Math.max(1, this.spine.length);
    return Math.min(1, ((this.chapterStart[spine] ?? 0) + offset) / this.totalChars);
  }

  /** Inverse of `bookFraction`. */
  locate(fraction: number): { spine: number; offset: number } {
    if (!this.totalChars) return { spine: Math.min(this.spine.length - 1, Math.floor(fraction * this.spine.length)), offset: 0 };
    const target = Math.min(this.totalChars - 1, Math.max(0, fraction * this.totalChars));
    let spine = 0;
    for (let i = 0; i < this.chapterStart.length; i++) {
      if (this.chapterStart[i] <= target) spine = i;
      else break;
    }
    return { spine, offset: Math.floor(target - this.chapterStart[spine]) };
  }

  dispose(): void {
    for (const url of this.urlCache.values()) URL.revokeObjectURL(url);
    this.urlCache.clear();
  }

  get baseDir(): string {
    return dirname(this.opfPath);
  }
}

/** Decodes bytes honouring a BOM or an XML `encoding=` declaration, defaulting to UTF-8. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
  const m = /encoding\s*=\s*["']([\w-]+)["']/i.exec(head) ?? /charset\s*=\s*["']?([\w-]+)/i.exec(head);
  const label = m?.[1]?.toLowerCase();
  if (label && label !== 'utf-8' && label !== 'utf8') {
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      /* fall through */
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}
