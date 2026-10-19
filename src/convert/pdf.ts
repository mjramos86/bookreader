// The legacy build carries polyfills, so conversion also works in browsers a few versions old.
import '../lib/polyfills';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/types/src/display/api';
import type { TocNode } from '../lib/epubWriter';
import { buildEpub } from '../lib/epubWriter';
import type { ConvertContext, ConvertResult } from '../lib/importer';
import { escapeXml, ImportError, uid } from '../lib/util';
import { checkAborted } from './common';
import { extractPage, mergeRects, type ExtractedPage, type FontFlags, type Rect } from './pdfExtract';
import {
  analyze,
  blocksToXhtml,
  planChapters,
  titleMatchesHeading,
  type OutlineEntry,
  type RawFigure,
} from './pdfLayout';

// Our own worker entry adds the polyfills that pdf.js needs in Safari before loading pdf.js's worker.
pdfjs.GlobalWorkerOptions.workerPort = new Worker(new URL('./pdfWorker.ts', import.meta.url), { type: 'module' });

const ASSET_BASE = () => new URL(`${import.meta.env.BASE_URL}pdfjs/`, document.baseURI).href;

interface StoredImage {
  id: number;
  blob: Blob;
}

/** Rejects if `work` has not settled in `ms`. Phones can lose a worker or a canvas without any error. */
function withTimeout<T>(work: Promise<T>, ms: number, message: string, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        /* already gone */
      }
      reject(new Error(message));
    }, ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

const EXTRACT_TIMEOUT = 90_000;
const RENDER_TIMEOUT = 30_000;
// Mobile Safari kills pages that hold too much canvas memory, so renders stay small.
const MAX_PIXELS = 4_000_000;

// One canvas for the whole conversion: allocating and dropping hundreds of them is what makes
// iOS run out of canvas memory part-way through a long book.
let sharedCanvas: HTMLCanvasElement | null = null;

function releaseCanvas(): void {
  if (sharedCanvas) sharedCanvas.width = sharedCanvas.height = 0;
  sharedCanvas = null;
}

async function canvasToJpeg(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  const encode = new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), 'image/jpeg', quality);
  });
  return withTimeout(encode, RENDER_TIMEOUT, 'Encoding an image took too long');
}

/** Renders a region of a page (or all of it) to a JPEG. Rect is in page points, top-down. */
async function renderRegion(page: PDFPageProxy, rect: Rect | null, targetWidth: number, quality: number): Promise<Blob> {
  const base = page.getViewport({ scale: 1 });
  const r = rect ?? { x0: 0, y0: 0, x1: base.width, y1: base.height };
  const w = Math.max(1, r.x1 - r.x0);
  const h = Math.max(1, r.y1 - r.y0);
  let scale = Math.min(3, Math.max(0.5, targetWidth / w));
  if (w * h * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (w * h));
  const viewport = page.getViewport({ scale, offsetX: -r.x0 * scale, offsetY: -r.y0 * scale });
  const canvas = (sharedCanvas ??= document.createElement('canvas'));
  canvas.width = Math.max(1, Math.ceil(w * scale));
  canvas.height = Math.max(1, Math.ceil(h * scale));
  const task = page.render({ canvas, viewport, background: '#ffffff' });
  try {
    await withTimeout(task.promise, RENDER_TIMEOUT, 'Drawing a figure took too long', () => task.cancel());
    return await canvasToJpeg(canvas, quality);
  } catch (err) {
    // A canvas that failed once is not trusted again.
    releaseCanvas();
    throw err;
  }
}

async function resolveOutline(pdf: PDFDocumentProxy, pages: ExtractedPage[]): Promise<OutlineEntry[]> {
  const out: OutlineEntry[] = [];
  let outline: Awaited<ReturnType<PDFDocumentProxy['getOutline']>>;
  try {
    outline = await pdf.getOutline();
  } catch {
    return out;
  }
  if (!outline) return out;
  const walk = async (items: NonNullable<typeof outline>, depth: number) => {
    for (const item of items) {
      try {
        let dest = item.dest;
        if (typeof dest === 'string') dest = await pdf.getDestination(dest);
        if (Array.isArray(dest) && dest.length) {
          const ref = dest[0];
          const index = typeof ref === 'number' ? ref : await pdf.getPageIndex(ref);
          const kind = (dest[1] as { name?: string } | null)?.name;
          let y: number | undefined;
          const raw = kind === 'XYZ' ? dest[3] : kind === 'FitH' || kind === 'FitBH' ? dest[2] : undefined;
          const vp = pages[index]?.viewport;
          if (typeof raw === 'number' && vp) y = vp.convertToViewportPoint(0, raw)[1];
          const title = (item.title ?? '').replace(/\s+/g, ' ').trim();
          if (title && index >= 0 && index < pages.length) out.push({ title, page: index, y, depth });
        }
      } catch {
        /* skip unresolvable entries */
      }
      if (item.items?.length) await walk(item.items, depth + 1);
    }
  };
  await walk(outline, 0);
  return out;
}

function stalled(page: number, total: number): ImportError {
  return new ImportError(
    `Conversion stopped on page ${page} of ${total}: this device ran out of time or memory there. Try again with the page open in the foreground, or split the PDF into smaller parts.`,
  );
}

function cleanTitle(t: string | undefined | null): string {
  const s = (t ?? '').replace(/\s+/g, ' ').trim();
  if (!s || /^(untitled|microsoft word - |.*\.(docx?|pdf|tex|indd)$)/i.test(s)) return '';
  return s;
}

export async function convertPdf(bytes: Uint8Array, fallbackTitle: string, ctx: ConvertContext): Promise<ConvertResult> {
  const warnings: string[] = [];
  const assets = ASSET_BASE();
  let pdf: PDFDocumentProxy;
  const task = pdfjs.getDocument({
      data: bytes.slice(),
      cMapUrl: `${assets}cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${assets}standard_fonts/`,
      wasmUrl: `${assets}wasm/`,
      iccUrl: `${assets}iccs/`,
      fontExtraProperties: true,
      // Glyphs are drawn as paths: loading hundreds of embedded fonts through the browser can stall on iOS.
      disableFontFace: true,
    });
  try {
    pdf = await task.promise;
  } catch (err) {
    const name = (err as { name?: string })?.name;
    if (name === 'PasswordException') throw new ImportError('This PDF is password-protected. Remove the password and try again.');
    throw new ImportError('This PDF could not be read. It may be damaged.');
  }

  try {
    const n = pdf.numPages;
    const fontCache = new Map<string, FontFlags>();
    const pages: ExtractedPage[] = [];
    const images: StoredImage[] = [];
    let nextImageId = 0;
    const addImage = (blob: Blob) => {
      const id = nextImageId++;
      images.push({ id, blob });
      return id;
    };
    let cover: Blob | null = null;
    let rasterPages = 0;
    let skippedImages = 0;
    let lang: string | null = null;

    for (let i = 1; i <= n; i++) {
      checkAborted(ctx.signal);
      ctx.progress((i / n) * 0.8, `Reading page ${i} of ${n}`);
      // Let the screen update (and the browser breathe) between pages.
      await new Promise((r) => setTimeout(r, 0));
      let page: PDFPageProxy;
      try {
        page = await withTimeout(pdf.getPage(i), EXTRACT_TIMEOUT, 'timeout');
      } catch {
        throw stalled(i, n);
      }
      try {
        const ex = await withTimeout(extractPage(pdfjs, page, fontCache), EXTRACT_TIMEOUT, 'timeout').catch((err) => {
          throw err instanceof Error && err.message === 'timeout' ? stalled(i, n) : err;
        });
        lang ??= ex.lang;
        const { width, height } = ex.raw;
        const pageArea = width * height;

        // Decide which images are figures, backgrounds or whole-page scans.
        const minW = Math.max(60, width * 0.12);
        const minH = Math.max(40, height * 0.05);
        const candidates = mergeRects(
          ex.imageRects
            .map((r) => ({ x0: Math.max(0, r.x0), y0: Math.max(0, r.y0), x1: Math.min(width, r.x1), y1: Math.min(height, r.y1) }))
            .filter((r) => r.x1 - r.x0 > 12 && r.y1 - r.y0 > 12),
        );
        const big = candidates.filter((r) => (r.x1 - r.x0) * (r.y1 - r.y0) > pageArea * 0.8);
        const figures = candidates.filter((r) => r.x1 - r.x0 >= minW && r.y1 - r.y0 >= minH && (r.x1 - r.x0) * (r.y1 - r.y0) <= pageArea * 0.8);

        const scanned = ex.textChars < 20 && (big.length > 0 || ex.paintOps >= 6 || figures.length > 0);
        if (scanned) {
          ctx.progress((i / n) * 0.8, `Reading page ${i} of ${n} (saving page image)`);
          try {
            ex.raw.rasterImageId = addImage(await renderRegion(page, null, 1100, 0.72));
            ex.raw.items = [];
            rasterPages++;
          } catch {
            skippedImages++;
          }
        } else if (figures.length) {
          ctx.progress((i / n) * 0.8, `Reading page ${i} of ${n} (saving figures)`);
          const raw: RawFigure[] = [];
          for (const rect of figures) {
            try {
              raw.push({ ...rect, imageId: addImage(await renderRegion(page, rect, 1000, 0.86)) });
            } catch {
              skippedImages++;
            }
          }
          ex.raw.figures = raw;
        }

        if (i === 1) cover = await renderRegion(page, null, 520, 0.8).catch(() => null);
        pages.push(ex);
      } finally {
        page.cleanup();
      }
    }

    if (skippedImages) {
      warnings.push(
        `${skippedImages} figure${skippedImages === 1 ? ' was' : 's were'} left out because this device could not draw ${skippedImages === 1 ? 'it' : 'them'}.`,
      );
    }
    if (rasterPages / n > 0.5) {
      warnings.push(
        'This PDF looks scanned: it has no selectable text, so its pages are kept as images and font, size and theme settings will not change them. Run OCR on the PDF first (for example with OCRmyPDF) to get a fully reflowable book.',
      );
    } else if (rasterPages > 0) {
      warnings.push(`${rasterPages} page${rasterPages === 1 ? ' has' : 's have'} no selectable text and ${rasterPages === 1 ? 'is' : 'are'} kept as an image.`);
    }

    ctx.progress(0.82, 'Analysing layout');
    await new Promise((r) => setTimeout(r, 0));
    const analysis = analyze(pages.map((p) => p.raw));
    if (!analysis.blocks.length) {
      throw new ImportError(
        skippedImages
          ? 'This device could not draw the pages of this PDF. Try again after closing other tabs, or on a computer.'
          : 'No readable text or images were found in this PDF.',
      );
    }

    // Metadata.
    const meta = await pdf.getMetadata().catch(() => null);
    const info = (meta?.info ?? {}) as Record<string, unknown>;
    let title = cleanTitle(info.Title as string);
    if (!title) {
      const first = analysis.blocks.find((b) => b.type === 'heading' && b.text.length >= 3 && b.text.length <= 120 && b.page <= 1);
      title = first?.text ?? '';
    }
    title ||= fallbackTitle;
    const author = String(info.Author ?? '').replace(/\s+/g, ' ').trim();
    const language = (lang || String(info.Language ?? '') || 'en').split(/[-_]/)[0].toLowerCase().replace(/[^a-z]/g, '') || 'en';

    ctx.progress(0.86, 'Finding chapters');
    const outline = await resolveOutline(pdf, pages);
    const plan = planChapters(analysis.blocks, outline, title);

    // Table-of-contents anchors for sub-entries.
    const anchors = new Map<number, string>();
    for (const ch of plan) for (const e of ch.entries) anchors.set(e.block, `s-${e.block}`);
    const imagePath = (id: number) => `../images/pdf-${String(id + 1).padStart(4, '0')}.jpg`;

    ctx.progress(0.9, 'Building EPUB');
    const chapters = plan.map((ch, i) => {
      const blocks = analysis.blocks.slice(ch.start, ch.end);
      let body = blocksToXhtml(blocks, imagePath, (idx) => anchors.get(idx), ch.start);
      if (ch.kind === 'outline' && !titleMatchesHeading(analysis.blocks, ch)) {
        body = `<h1>${escapeXml(ch.title)}</h1>\n${body}`;
      }
      return { id: `ch-${i + 1}`, title: ch.title, body };
    });

    const file = (i: number) => `text/ch-${String(i + 1).padStart(4, '0')}.xhtml`;
    const toc: TocNode[] = plan.map((ch, i) => {
      const node: TocNode = { title: ch.title, href: file(i), children: [] };
      const stack: { depth: number; node: TocNode }[] = [{ depth: 0, node }];
      for (const e of ch.entries) {
        const child: TocNode = { title: e.title, href: `${file(i)}#${anchors.get(e.block)}`, children: [] };
        while (stack.length > 1 && stack[stack.length - 1].depth >= e.depth) stack.pop();
        stack[stack.length - 1].node.children!.push(child);
        stack.push({ depth: e.depth, node: child });
      }
      return node;
    });

    const epub = await buildEpub({
      title,
      author,
      language,
      identifier: `urn:uuid:${uid()}-${uid()}`,
      cover: cover ? { data: cover, mime: 'image/jpeg' } : undefined,
      chapters,
      images: images.map((im) => ({ path: `images/pdf-${String(im.id + 1).padStart(4, '0')}.jpg`, data: im.blob, mime: 'image/jpeg' })),
      toc,
    });
    ctx.progress(1, 'Done');
    return { epub, warnings };
  } finally {
    releaseCanvas();
    void task.destroy();
  }
}
