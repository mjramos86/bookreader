import type { EpubBook } from './epub';
import { filterDeclarations, filterStyleSheet, prepareChapter, type PreparedChapter } from './chapter';
import { fontFaceCss, fontStack } from './fonts';
import { themeByName, type Settings } from './settings';
import type { HighlightColor } from './types';
import { clamp } from './util';

export interface RelocateInfo {
  spine: number;
  /** Character offset of the first visible character. */
  offset: number;
  /** Character offset just past the last visible character. */
  endOffset: number;
  chapterLength: number;
  /** Zero-based page within the chapter (paged layout only). */
  page: number;
  pageCount: number;
  bookFraction: number;
  chapterFraction: number;
}

export interface SelectionInfo {
  spine: number;
  start: number;
  end: number;
  text: string;
  /** Selection rectangle relative to the renderer's container. */
  rect: { left: number; top: number; width: number; height: number };
}

export interface MarkSpec {
  id: string;
  spine: number;
  start: number;
  end: number;
  color: HighlightColor;
  hasNote: boolean;
}

export interface LinkTarget {
  path?: string;
  fragment?: string;
  external?: string;
}

export interface DisplayTarget {
  spine: number;
  offset?: number;
  fraction?: number;
  fragment?: string;
  /** Open on the chapter's last page (used when paging backwards). */
  atEnd?: boolean;
}

export interface RendererHandlers {
  onRelocate(info: RelocateInfo): void;
  onToggleChrome(): void;
  onSelection(sel: SelectionInfo | null): void;
  onHighlightClick(id: string, rect: { left: number; top: number; width: number; height: number }): void;
  onLink(target: LinkTarget): void;
  onImage(src: string): void;
  onKey(e: KeyboardEvent): void;
  onInteract(): void;
  /** The reader turned a page by tap, key, swipe or button. */
  onPageTurn(): void;
  onLoading(loading: boolean): void;
  onError(message: string): void;
}

interface Frame {
  iframe: HTMLIFrameElement;
  doc: Document;
  spine: number;
  prepared: PreparedChapter;
  nodes: Text[];
  starts: number[];
  total: number;
  nodeIndex: Map<Text, number>;
  W: number;
  H: number;
  cols: number;
  gap: number;
  stride: number;
  page: number;
  pageCount: number;
  startOffset: number;
  endOffset: number;
  /** Where the reader intends to be; survives re-pagination without drifting to page starts. */
  anchor: number;
  /** Image-only chapter (a comic page, a cover): always one column. */
  single: boolean;
}

const MARGIN_FRACTION = { narrow: 0.035, medium: 0.09, wide: 0.17 } as const;
const HL_ALPHA_LIGHT: Record<HighlightColor, string> = {
  yellow: 'rgba(255, 214, 10, 0.42)',
  blue: 'rgba(80, 160, 255, 0.34)',
  pink: 'rgba(255, 110, 170, 0.34)',
  orange: 'rgba(255, 150, 40, 0.42)',
};
const HL_ALPHA_DARK: Record<HighlightColor, string> = {
  yellow: 'rgba(255, 214, 10, 0.32)',
  blue: 'rgba(80, 160, 255, 0.38)',
  pink: 'rgba(255, 110, 170, 0.36)',
  orange: 'rgba(255, 150, 40, 0.38)',
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class BookRenderer {
  private frame: Frame | null = null;
  private settings: Settings;
  private gen = 0;
  private scroller: HTMLDivElement;
  private marks: MarkSpec[] = [];
  private searchMark: { spine: number; start: number; end: number } | null = null;
  private resizeObserver: ResizeObserver;
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;
  private lastSize = '';
  private wheelLock = 0;
  private selectionTimer: ReturnType<typeof setTimeout> | undefined;
  private range: Range | null = null;
  private destroyed = false;
  private preparedCache = new Map<number, PreparedChapter>();

  constructor(
    private container: HTMLElement,
    private book: EpubBook,
    settings: Settings,
    private handlers: RendererHandlers,
  ) {
    this.settings = settings;
    this.scroller = document.createElement('div');
    this.scroller.className = 'rd-scroller';
    container.appendChild(this.scroller);
    this.updateScrollerMode();
    this.scroller.addEventListener('scroll', () => this.onScroll(), { passive: true });
    this.scroller.addEventListener('wheel', (e) => this.onWheel(e), { passive: true });
    this.resizeObserver = new ResizeObserver(() => {
      const size = `${container.clientWidth}x${container.clientHeight}`;
      if (size === this.lastSize) return;
      const first = this.lastSize === '';
      this.lastSize = size;
      if (first) return;
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => void this.relayout(), 150);
    });
    this.resizeObserver.observe(container);
  }

  // ---------------------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------------------

  get currentSpine(): number {
    return this.frame?.spine ?? 0;
  }

  get isPaged(): boolean {
    return this.settings.layout === 'paged';
  }

  pageRange(): { spine: number; start: number; end: number } | null {
    const f = this.frame;
    return f ? { spine: f.spine, start: f.startOffset, end: f.endOffset } : null;
  }

  async display(target: DisplayTarget): Promise<void> {
    const gen = ++this.gen;
    this.handlers.onLoading(true);
    try {
      const spine = clamp(target.spine, 0, this.book.spine.length - 1);
      let prepared = this.preparedCache.get(spine);
      if (!prepared) {
        prepared = await prepareChapter(this.book, spine, true);
        this.preparedCache.clear();
        this.preparedCache.set(spine, prepared);
      }
      if (gen !== this.gen || this.destroyed) return;
      const frame = await this.buildFrame(spine, prepared, gen);
      if (!frame || gen !== this.gen || this.destroyed) return;

      this.frame = frame;
      this.updateScrollerMode();
      // Never re-insert the iframe itself: moving an iframe in the DOM reloads it and drops its content.
      for (const child of Array.from(this.scroller.children)) if (child !== frame.iframe) child.remove();
      this.addChapterNav(frame);
      frame.iframe.style.visibility = 'visible';
      this.autoSizeFrame(frame);

      this.applyMarks();
      this.goTo(frame, target);
      if (!this.isPaged) this.refreshScrollFrame();
    } catch (err) {
      if (gen === this.gen) this.handlers.onError(err instanceof Error ? err.message : String(err));
    } finally {
      if (gen === this.gen) this.handlers.onLoading(false);
    }
  }

  next(): void {
    this.handlers.onPageTurn();
    this.clearSearchMark();
    const f = this.frame;
    if (!f) return;
    if (!this.isPaged) {
      const s = this.scroller;
      if (s.scrollTop + s.clientHeight < s.scrollHeight - 4) s.scrollBy({ top: s.clientHeight * 0.9, behavior: 'smooth' });
      else this.nextChapter();
      return;
    }
    if (f.page + 1 < f.pageCount) this.setPage(f, f.page + 1);
    else this.nextChapter();
  }

  prev(): void {
    this.handlers.onPageTurn();
    this.clearSearchMark();
    const f = this.frame;
    if (!f) return;
    if (!this.isPaged) {
      const s = this.scroller;
      if (s.scrollTop > 4) s.scrollBy({ top: -s.clientHeight * 0.9, behavior: 'smooth' });
      else this.prevChapter();
      return;
    }
    if (f.page > 0) this.setPage(f, f.page - 1);
    else this.prevChapter();
  }

  scrollBy(dy: number): void {
    if (!this.isPaged) this.scroller.scrollBy({ top: dy });
  }

  nextChapter(): void {
    const f = this.frame;
    if (f && f.spine + 1 < this.book.spine.length) void this.display({ spine: f.spine + 1, offset: 0 });
  }

  prevChapter(): void {
    const f = this.frame;
    if (f && f.spine > 0) void this.display({ spine: f.spine - 1, atEnd: this.isPaged });
  }

  /** Moves within the current chapter by page; used by the progress slider. */
  goToFraction(bookFraction: number): void {
    const loc = this.book.locate(bookFraction);
    void this.display({ spine: loc.spine, offset: loc.offset });
  }

  updateSettings(next: Settings): void {
    const prev = this.settings;
    this.settings = next;
    const f = this.frame;
    if (!f) return;
    if (prev.layout !== next.layout || prev.publisherFonts !== next.publisherFonts) {
      this.preparedCache.clear();
      void this.display({ spine: f.spine, offset: f.anchor });
      return;
    }
    const layoutChanged =
      prev.fontFamily !== next.fontFamily ||
      prev.fontSize !== next.fontSize ||
      prev.lineHeight !== next.lineHeight ||
      prev.margin !== next.margin ||
      prev.align !== next.align ||
      prev.hyphenate !== next.hyphenate ||
      prev.columns !== next.columns;
    if (layoutChanged) void this.relayout();
    else this.installReaderCss(f);
  }

  setMarks(marks: MarkSpec[]): void {
    this.marks = marks;
    this.applyMarks();
  }

  showSearchMark(mark: { spine: number; start: number; end: number } | null): void {
    this.searchMark = mark;
    this.applyMarks();
  }

  clearSelection(): void {
    this.frame?.doc.getSelection()?.removeAllRanges();
    this.handlers.onSelection(null);
  }

  destroy(): void {
    this.destroyed = true;
    this.gen++;
    this.resizeObserver.disconnect();
    clearTimeout(this.resizeTimer);
    clearTimeout(this.selectionTimer);
    this.scroller.remove();
    this.frame = null;
  }

  // ---------------------------------------------------------------------------------------
  // Frame construction
  // ---------------------------------------------------------------------------------------

  private updateScrollerMode(): void {
    this.scroller.classList.toggle('scroll-mode', !this.isPaged);
  }

  private geometry(single = false): { W: number; H: number; cols: number; gap: number; left: number; top: number } {
    const cw = this.container.clientWidth;
    const ch = this.container.clientHeight;
    const s = this.settings;
    const padX = Math.max(14, cw * MARGIN_FRACTION[s.margin]);
    const padY = clamp(ch * 0.035, 12, 36);
    const cols = this.isPaged && !single ? (s.columns === 'auto' ? (cw >= 980 ? 2 : 1) : cw < 640 ? 1 : s.columns) : 1;
    const gap = cols > 1 ? Math.round(clamp(cw * 0.05, 36, 72)) : 0;
    const colMax = s.fontSize * (this.isPaged ? 34 : 40);
    const maxW = cols * colMax + (cols - 1) * gap;
    const W = Math.floor(Math.max(120, Math.min(cw - 2 * padX, maxW)));
    const H = Math.floor(Math.max(120, ch - 2 * padY));
    return { W, H, cols, gap, left: Math.round((cw - W) / 2), top: Math.round(padY) };
  }

  private async buildFrame(spine: number, prepared: PreparedChapter, gen: number): Promise<Frame | null> {
    const single = prepared.text.trim().length < 60 && /<(img|svg|image)\b/i.test(prepared.body.innerHTML);
    const g = this.geometry(single);
    const iframe = document.createElement('iframe');
    iframe.className = 'rd-frame';
    iframe.setAttribute('sandbox', 'allow-same-origin');
    iframe.setAttribute('title', 'Book content');
    iframe.style.visibility = 'hidden';
    iframe.style.width = `${g.W}px`;
    if (this.isPaged) {
      iframe.style.height = `${g.H}px`;
      iframe.style.left = `${g.left}px`;
      iframe.style.top = `${g.top}px`;
    } else {
      iframe.style.height = `${g.H}px`;
    }
    // Load a skeleton through srcdoc and wait for it: writing into the initial about:blank
    // document races with the iframe's own navigation, which would discard the content.
    const loaded = new Promise<void>((resolve) => iframe.addEventListener('load', () => resolve(), { once: true }));
    iframe.srcdoc = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';
    this.scroller.appendChild(iframe);
    await loaded;
    const doc = iframe.contentDocument;
    if (!doc || gen !== this.gen || this.destroyed) {
      iframe.remove();
      return null;
    }

    const root = doc.documentElement;
    root.lang = prepared.lang ?? this.book.metadata.language ?? 'en';
    if (prepared.htmlClass) root.className = prepared.htmlClass;
    if (prepared.bodyClass) doc.body.className = prepared.bodyClass;
    if (prepared.bodyId) doc.body.id = prepared.bodyId;

    const fonts = doc.createElement('style');
    fonts.textContent = fontFaceCss();
    doc.head.appendChild(fonts);
    const styleEls: HTMLStyleElement[] = [];
    for (const css of prepared.styles) {
      const el = doc.createElement('style');
      el.textContent = css;
      doc.head.appendChild(el);
      styleEls.push(el);
    }
    for (const el of styleEls) if (el.sheet) filterStyleSheet(el.sheet, { publisherFonts: this.settings.publisherFonts });
    const reader = doc.createElement('style');
    reader.id = 'rd-css';
    doc.head.appendChild(reader);

    // Import the sanitised content. Inline styles get the same filtering as the sheets.
    const imported = doc.importNode(prepared.body, true) as HTMLElement;
    for (const child of Array.from(imported.childNodes)) doc.body.appendChild(child);
    for (const el of Array.from(doc.body.querySelectorAll<HTMLElement>('[style]'))) {
      filterDeclarations(el.style, false, { publisherFonts: this.settings.publisherFonts });
      if (!el.getAttribute('style')?.trim()) el.removeAttribute('style');
    }
    const bodyStyle = doc.body.style;
    if (bodyStyle.length) bodyStyle.cssText = '';

    const frame: Frame = {
      iframe,
      doc,
      spine,
      prepared,
      nodes: [],
      starts: [],
      total: prepared.text.length,
      nodeIndex: new Map(),
      W: g.W,
      H: g.H,
      cols: g.cols,
      gap: g.gap,
      stride: g.W + g.gap,
      page: 0,
      pageCount: 1,
      startOffset: 0,
      endOffset: 0,
      anchor: 0,
      single,
    };
    this.installReaderCss(frame);
    this.collectText(frame);
    this.attachFrameListeners(frame);

    // Wait for fonts and images so the first measurement is right.
    const settle = Promise.all([
      doc.fonts?.ready ?? Promise.resolve(),
      ...Array.from(doc.images).map((img) => (img.complete ? Promise.resolve() : img.decode().catch(() => undefined))),
    ]);
    await Promise.race([settle, sleep(3500)]);
    if (gen !== this.gen || this.destroyed) {
      iframe.remove();
      return null;
    }
    for (const img of Array.from(doc.images)) {
      if (!img.complete) img.addEventListener('load', () => this.onLateLoad(frame), { once: true });
      if (img.naturalWidth >= 120 || img.width >= 120) img.classList.add('rd-fig');
    }
    this.measure(frame);
    return frame;
  }

  /** In continuous-scroll mode, buttons above and below the chapter move between chapters. */
  private addChapterNav(frame: Frame): void {
    if (this.isPaged) return;
    const make = (label: string, action: () => void, disabled: boolean) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'rd-chapter-nav';
      btn.textContent = label;
      btn.disabled = disabled;
      btn.addEventListener('click', action);
      return btn;
    };
    const hasPrev = frame.spine > 0;
    const hasNext = frame.spine + 1 < this.book.spine.length;
    frame.iframe.before(make('\u2191 Previous chapter', () => this.prevChapter(), !hasPrev));
    frame.iframe.after(make(hasNext ? 'Next chapter \u2193' : 'End of book', () => this.nextChapter(), !hasNext));
  }

  private installReaderCss(f: Frame): void {
    const s = this.settings;
    const theme = themeByName(s.theme);
    const sh = s.theme === 'dark' || s.theme === 'black' ? HL_ALPHA_DARK : HL_ALPHA_LIGHT;
    const paged = this.isPaged;
    const family = fontStack(s.fontFamily);
    const css = `
html {
  color-scheme: ${theme.dark ? 'dark' : 'light'};
  margin: 0; padding: 0; background: transparent;
  font-size: ${s.fontSize}px;
  font-family: ${family};
  color: ${theme.fg};
  line-height: ${s.lineHeight};
  text-align: ${s.align === 'justify' ? 'justify' : 'left'};
  -webkit-hyphens: ${s.hyphenate ? 'auto' : 'manual'}; hyphens: ${s.hyphenate ? 'auto' : 'manual'};
  overflow-wrap: break-word;
  text-rendering: optimizeLegibility;
  -webkit-text-size-adjust: 100%;
  touch-action: ${paged ? 'pan-y pinch-zoom' : 'auto'};
  ${paged ? 'overflow: hidden;' : 'overflow-y: hidden; overflow-x: hidden;'}
}
body {
  margin: 0 !important; padding: 0 !important; background: transparent !important; color: inherit;
  width: ${f.W}px !important; max-width: none !important;
  ${
    paged
      ? `height: ${f.H}px !important; column-count: ${f.cols}; column-gap: ${f.gap}px; column-fill: auto; will-change: transform;`
      : 'height: auto !important;'
  }
}
body * { box-sizing: border-box; }
h1, h2, h3, h4, h5, h6 { break-after: avoid; break-inside: avoid; line-height: 1.25; }
p, li, blockquote, dd { orphans: 2; widows: 2; }
img, svg, video { max-width: 100%; height: auto; break-inside: avoid; }
img { max-height: ${paged ? f.H : 4000}px; object-fit: contain; }
svg { max-height: ${paged ? f.H : 4000}px; }
figure, table, pre { max-width: 100%; }
table { break-inside: auto; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; }
a[href] { color: ${theme.link}; text-decoration-thickness: 1px; text-underline-offset: 2px; }
a[data-ext]::after { content: '\\2197'; font-size: 0.7em; margin-left: 0.15em; vertical-align: super; }
${theme.dark ? 'img.rd-fig { background: #fff; border-radius: 3px; }' : ''}
::selection { background: ${theme.dark ? 'rgba(120,170,255,.45)' : 'rgba(0,110,255,.28)'}; }
mark.hl { color: inherit; padding: 0; border-radius: 2px; cursor: pointer; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
mark.hl-yellow { background: ${sh.yellow}; }
mark.hl-blue { background: ${sh.blue}; }
mark.hl-pink { background: ${sh.pink}; }
mark.hl-orange { background: ${sh.orange}; }
mark.hl-note { border-bottom: 2px dotted ${theme.accent}; }
mark.sh { background: rgba(255, 120, 0, .55); color: inherit; border-radius: 2px; }
`;
    const el = f.doc.getElementById('rd-css');
    if (el) el.textContent = css;
  }

  private collectText(f: Frame): void {
    const nodes: Text[] = [];
    const starts: number[] = [];
    const index = new Map<Text, number>();
    let total = 0;
    const walker = f.doc.createTreeWalker(f.doc.body, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text;
      index.set(t, nodes.length);
      nodes.push(t);
      starts.push(total);
      total += t.data.length;
    }
    f.nodes = nodes;
    f.starts = starts;
    f.nodeIndex = index;
    f.total = total;
  }

  // ---------------------------------------------------------------------------------------
  // Layout and position mapping
  // ---------------------------------------------------------------------------------------

  private autoSizeFrame(f: Frame): void {
    if (this.isPaged) return;
    const h = Math.max(f.H, f.doc.documentElement.scrollHeight, f.doc.body.scrollHeight);
    f.iframe.style.height = `${h}px`;
  }

  private measure(f: Frame): void {
    const root = f.doc.documentElement;
    if (this.isPaged) {
      // A translated body shifts its scrollable overflow, so measure with the transform cleared.
      const body = f.doc.body;
      const transform = body.style.transform;
      body.style.transform = 'none';
      const width = root.scrollWidth;
      body.style.transform = transform;
      f.pageCount = Math.max(1, Math.ceil((width + f.gap - 1) / f.stride));
    } else {
      f.pageCount = 1;
      f.iframe.style.height = `${Math.max(f.H, root.scrollHeight, f.doc.body.scrollHeight)}px`;
    }
  }

  private onLateLoad(f: Frame): void {
    if (this.frame !== f) return;
    const anchor = f.anchor;
    this.measure(f);
    this.goToOffset(f, anchor);
  }

  async relayout(): Promise<void> {
    const f = this.frame;
    if (!f || this.destroyed) return;
    const anchor = f.anchor;
    const g = this.geometry(f.single);
    f.W = g.W;
    f.H = g.H;
    f.cols = g.cols;
    f.gap = g.gap;
    f.stride = g.W + g.gap;
    f.iframe.style.width = `${g.W}px`;
    if (this.isPaged) {
      f.iframe.style.height = `${g.H}px`;
      f.iframe.style.left = `${g.left}px`;
      f.iframe.style.top = `${g.top}px`;
    }
    this.installReaderCss(f);
    await f.doc.fonts?.ready;
    if (this.frame !== f) return;
    this.measure(f);
    this.goToOffset(f, anchor);
  }

  private nodeAt(f: Frame, offset: number): number {
    let lo = 0;
    let hi = f.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (f.starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Position of a character relative to the body's untransformed origin. */
  private posOf(f: Frame, offset: number): { x: number; y: number } | null {
    if (!f.nodes.length) return null;
    const range = (this.range ??= f.doc.createRange());
    const bodyRect = f.doc.body.getBoundingClientRect();
    const limit = Math.min(f.total, offset + 48);
    for (let o = Math.max(0, offset); o < limit; o++) {
      const i = this.nodeAt(f, o);
      const node = f.nodes[i];
      const at = o - f.starts[i];
      if (at >= node.data.length) continue;
      range.setStart(node, at);
      range.setEnd(node, at + 1);
      const r = range.getClientRects()[0];
      if (r && (r.width > 0 || r.height > 0)) return { x: r.left - bodyRect.left, y: r.top - bodyRect.top };
    }
    return null;
  }

  private pageOfOffset(f: Frame, offset: number): number {
    const p = this.posOf(f, offset);
    return p ? Math.max(0, Math.floor((p.x + 2) / f.stride)) : Infinity;
  }

  private firstOffsetOnPage(f: Frame, page: number): number {
    let lo = 0;
    let hi = f.total;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.pageOfOffset(f, mid) >= page) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  private offsetAtY(f: Frame, y: number): number {
    let lo = 0;
    let hi = f.total;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const p = this.posOf(f, mid);
      if (p && p.y >= y - 1) hi = mid;
      else if (!p) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  }

  private offsetOfElement(f: Frame, el: Element): number {
    const walker = f.doc.createTreeWalker(f.doc.body, NodeFilter.SHOW_TEXT);
    walker.currentNode = el;
    const node = walker.nextNode() as Text | null;
    const idx = node ? f.nodeIndex.get(node) : undefined;
    return idx === undefined ? f.total : f.starts[idx];
  }

  private goTo(f: Frame, t: DisplayTarget): void {
    if (t.fragment) {
      const el = f.doc.getElementById(t.fragment) ?? f.doc.getElementsByName(t.fragment)[0];
      if (el) {
        this.goToOffset(f, this.offsetOfElement(f, el), el);
        return;
      }
    }
    if (t.atEnd && this.isPaged) {
      this.setPage(f, f.pageCount - 1);
      return;
    }
    if (t.offset !== undefined) this.goToOffset(f, clamp(t.offset, 0, Math.max(0, f.total - 1)));
    else if (t.fraction !== undefined) this.goToOffset(f, Math.floor(clamp(t.fraction, 0, 1) * Math.max(0, f.total - 1)));
    else this.goToOffset(f, 0);
  }

  private goToOffset(f: Frame, offset: number, anchorEl?: Element): void {
    if (this.isPaged) {
      let page = offset <= 0 ? 0 : this.pageOfOffset(f, offset);
      if (!isFinite(page)) {
        const r = anchorEl?.getBoundingClientRect();
        const bodyRect = f.doc.body.getBoundingClientRect();
        page = r ? Math.max(0, Math.floor((r.left - bodyRect.left + 2) / f.stride)) : f.pageCount - 1;
      }
      this.setPage(f, clamp(page, 0, f.pageCount - 1), offset);
    } else {
      const pos = offset > 0 ? this.posOf(f, offset) : { x: 0, y: 0 };
      const frameTop = f.iframe.offsetTop;
      this.scroller.scrollTop = Math.max(0, (pos?.y ?? 0) + frameTop - 8);
      this.reportScroll(f);
    }
  }

  private setPage(f: Frame, page: number, preferOffset?: number): void {
    f.page = page;
    f.doc.body.style.transform = `translate3d(${-page * f.stride}px,0,0)`;
    const start = page === 0 ? 0 : this.firstOffsetOnPage(f, page);
    const end = page + 1 >= f.pageCount ? f.total : this.firstOffsetOnPage(f, page + 1);
    f.startOffset = start;
    f.endOffset = Math.max(start, end);
    f.anchor = preferOffset !== undefined && preferOffset >= start && preferOffset < Math.max(end, start + 1) ? preferOffset : start;
    this.handlers.onSelection(null);
    this.emitRelocate(f);
  }

  private onScroll(): void {
    const f = this.frame;
    if (!f || this.isPaged) return;
    this.reportScroll(f);
  }

  private scrollTick = 0;
  private reportScroll(f: Frame): void {
    cancelAnimationFrame(this.scrollTick);
    this.scrollTick = requestAnimationFrame(() => {
      if (this.frame !== f) return;
      const top = this.scroller.scrollTop - f.iframe.offsetTop;
      const bottom = top + this.scroller.clientHeight;
      f.startOffset = this.offsetAtY(f, Math.max(0, top));
      f.anchor = f.startOffset;
      f.endOffset = bottom >= f.iframe.offsetHeight - 2 ? f.total : this.offsetAtY(f, bottom);
      this.emitRelocate(f);
    });
  }

  private refreshScrollFrame(): void {
    const f = this.frame;
    if (f) this.reportScroll(f);
  }

  private emitRelocate(f: Frame): void {
    this.handlers.onRelocate({
      spine: f.spine,
      offset: f.startOffset,
      endOffset: f.endOffset,
      chapterLength: f.total,
      page: f.page,
      pageCount: f.pageCount,
      bookFraction: this.book.bookFraction(f.spine, f.startOffset),
      chapterFraction: f.total ? f.startOffset / f.total : 0,
    });
  }

  // ---------------------------------------------------------------------------------------
  // Marks (highlights and search hits)
  // ---------------------------------------------------------------------------------------

  private clearSearchMark(): void {
    if (this.searchMark) {
      this.searchMark = null;
      this.applyMarks();
    }
  }

  private applyMarks(): void {
    const f = this.frame;
    if (!f) return;
    const doc = f.doc;
    for (const m of Array.from(doc.querySelectorAll('mark[data-rd]'))) {
      const parent = m.parentNode;
      if (!parent) continue;
      while (m.firstChild) parent.insertBefore(m.firstChild, m);
      parent.removeChild(m);
    }
    doc.body.normalize();
    this.collectText(f);

    const specs: { start: number; end: number; cls: string; id?: string }[] = [];
    for (const m of this.marks) {
      if (m.spine === f.spine) specs.push({ start: m.start, end: m.end, cls: `hl hl-${m.color}${m.hasNote ? ' hl-note' : ''}`, id: m.id });
    }
    if (this.searchMark && this.searchMark.spine === f.spine) {
      specs.push({ start: this.searchMark.start, end: this.searchMark.end, cls: 'sh' });
    }
    for (const spec of specs) {
      this.wrapRange(f, spec.start, Math.min(spec.end, f.total), spec.cls, spec.id);
      this.collectText(f);
    }
    // Wrapping splits text nodes; page assignment is unchanged but our cached nodes are not.
    this.collectText(f);
  }

  private wrapRange(f: Frame, start: number, end: number, cls: string, id?: string): void {
    if (end <= start || !f.nodes.length) return;
    const doc = f.doc;
    const first = this.nodeAt(f, start);
    const targets: { node: Text; from: number; to: number }[] = [];
    for (let i = first; i < f.nodes.length && f.starts[i] < end; i++) {
      const node = f.nodes[i];
      const from = Math.max(0, start - f.starts[i]);
      const to = Math.min(node.data.length, end - f.starts[i]);
      if (to > from && node.data.slice(from, to).trim() !== '') targets.push({ node, from, to });
    }
    for (const t of targets) {
      let node = t.node;
      if (t.from > 0) node = node.splitText(t.from);
      if (t.to - t.from < node.data.length) node.splitText(t.to - t.from);
      const mark = doc.createElement('mark');
      mark.className = cls;
      mark.setAttribute('data-rd', '1');
      if (id) mark.setAttribute('data-id', id);
      node.parentNode?.insertBefore(mark, node);
      mark.appendChild(node);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------------------

  private attachFrameListeners(f: Frame): void {
    const doc = f.doc;
    // Taps are detected from pointer events. iOS Safari does not deliver `click` to a plain document
    // (no handler on the tapped element, no pointer cursor), but it does deliver pointer events.
    doc.addEventListener('pointerdown', (e) => {
      this.handlers.onInteract();
      this.pointerStart = { x: e.clientX, y: e.clientY, t: Date.now() };
    });
    doc.addEventListener('pointerup', (e) => this.onPointerUp(f, e));
    doc.addEventListener('pointercancel', () => (this.pointerStart = null));
    // Links navigate to "#" by default; we handle them ourselves.
    doc.addEventListener('click', (e) => {
      if ((e.target as Element | null)?.closest('a')) e.preventDefault();
    });
    doc.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: true });
    doc.addEventListener('touchend', (e) => this.onTouchEnd(f, e), { passive: true });
    doc.addEventListener('keydown', (e) => this.handlers.onKey(e));
    doc.addEventListener('wheel', (e) => this.onWheel(e), { passive: true });
    doc.addEventListener('selectionchange', () => {
      clearTimeout(this.selectionTimer);
      this.selectionTimer = setTimeout(() => this.onSelectionChange(f), 160);
    });
  }

  private touchStart: { x: number; y: number; t: number } | null = null;
  private pointerStart: { x: number; y: number; t: number } | null = null;

  private onTouchStart(e: TouchEvent): void {
    const t = e.touches[0];
    this.touchStart = t ? { x: t.clientX, y: t.clientY, t: Date.now() } : null;
  }

  private onPointerUp(f: Frame, e: PointerEvent): void {
    const s = this.pointerStart;
    this.pointerStart = null;
    if (!s) return;
    // A tap: short, and the pointer barely moved. Drags (selection, swipes) and long presses are not taps.
    if (Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10 || Date.now() - s.t > 600) return;
    this.onTap(f, e.target as Element | null, e.clientX);
  }

  private onTouchEnd(f: Frame, e: TouchEvent): void {
    const s = this.touchStart;
    const t = e.changedTouches[0];
    this.touchStart = null;
    if (!s || !t || !this.isPaged) return;
    const sel = f.doc.getSelection();
    if (sel && !sel.isCollapsed) return;
    const dx = t.clientX - s.x;
    const dy = t.clientY - s.y;
    if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(dy) * 1.6 && Date.now() - s.t < 900) {
      if (dx < 0) this.next();
      else this.prev();
    }
  }

  private onWheel(e: WheelEvent): void {
    if (!this.isPaged || Math.abs(e.deltaY) + Math.abs(e.deltaX) < 25) return;
    const now = Date.now();
    if (now < this.wheelLock) return;
    this.wheelLock = now + 450;
    if (e.deltaY + e.deltaX > 0) this.next();
    else this.prev();
  }

  private onTap(f: Frame, target: Element | null, clientX: number): void {
    const sel = f.doc.getSelection();
    if (sel && !sel.isCollapsed) return;
    const link = target?.closest('a');
    if (link) {
      const ext = link.getAttribute('data-ext');
      if (ext) this.handlers.onLink({ external: ext });
      else if (link.getAttribute('data-path')) {
        this.handlers.onLink({ path: link.getAttribute('data-path') ?? undefined, fragment: link.getAttribute('data-frag') ?? undefined });
      }
      return;
    }
    const mark = target?.closest('mark.hl');
    if (mark) {
      const id = mark.getAttribute('data-id');
      if (id) {
        this.handlers.onHighlightClick(id, this.toContainerRect(f, mark.getBoundingClientRect()));
        return;
      }
    }
    const img = target?.closest('img');
    if (img && (img as HTMLImageElement).naturalWidth >= 120 && img.getAttribute('src')) {
      this.handlers.onImage(img.getAttribute('src') ?? '');
      return;
    }
    this.clearSearchMark();
    if (!this.isPaged) {
      this.handlers.onToggleChrome();
      return;
    }
    const abs = (clientX + f.iframe.offsetLeft) / this.container.clientWidth;
    if (abs < 0.28) this.prev();
    else if (abs > 0.72) this.next();
    else this.handlers.onToggleChrome();
  }

  private toContainerRect(f: Frame, r: DOMRect): { left: number; top: number; width: number; height: number } {
    const fr = f.iframe.getBoundingClientRect();
    const cr = this.container.getBoundingClientRect();
    return { left: r.left + fr.left - cr.left, top: r.top + fr.top - cr.top, width: r.width, height: r.height };
  }

  private onSelectionChange(f: Frame): void {
    if (this.frame !== f) return;
    const sel = f.doc.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      this.handlers.onSelection(null);
      return;
    }
    const range = sel.getRangeAt(0);
    const text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!text) {
      this.handlers.onSelection(null);
      return;
    }
    const pre = f.doc.createRange();
    pre.setStart(f.doc.body, 0);
    pre.setEnd(range.startContainer, range.startOffset);
    const start = pre.toString().length;
    const end = start + range.toString().length;
    const rects = Array.from(range.getClientRects());
    const last = rects[rects.length - 1] ?? range.getBoundingClientRect();
    const first = rects[0] ?? last;
    const box = {
      left: Math.min(first.left, last.left),
      top: first.top,
      width: Math.max(first.width, last.right - first.left),
      height: last.bottom - first.top,
    };
    this.handlers.onSelection({
      spine: f.spine,
      start,
      end,
      text,
      rect: this.toContainerRect(f, box as DOMRect),
    });
  }
}
