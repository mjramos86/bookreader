import type * as Pdfjs from 'pdfjs-dist';
import type { PDFPageProxy } from 'pdfjs-dist/types/src/display/api';
import type { RawItem, RawPage } from './pdfLayout';

export type PdfjsLib = typeof Pdfjs;
export type PageViewport = ReturnType<PDFPageProxy['getViewport']>;

export interface FontFlags {
  bold: boolean;
  italic: boolean;
  mono: boolean;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface ExtractedPage {
  raw: RawPage;
  viewport: PageViewport;
  textChars: number;
  /** Raster images placed on the page, in top-down page coordinates. */
  imageRects: Rect[];
  /** Number of fill/stroke operations; a rough measure of vector artwork. */
  paintOps: number;
  lang: string | null;
}

const BOLD_RE = /bold|black|heavy|semibold|demibold|extrabold|ultrabold|[-,]bd\b|^cmbx|^cmssbx|^cmb\d/i;
const ITALIC_RE = /italic|oblique|slanted|[-,]it$|^cmti|^cmsl|^cmbxti|^cmmi/i;
const MONO_RE = /mono|courier|consolas|menlo|lucida ?console|andale|^cmtt|typewriter|source ?code|fira ?code/i;

export function flagsFromFont(name: string, isMono: boolean, family: string): FontFlags {
  const base = name.replace(/^[A-Z]{6}\+/, '');
  return {
    bold: BOLD_RE.test(base),
    italic: ITALIC_RE.test(base),
    mono: isMono || MONO_RE.test(base) || family === 'monospace',
  };
}

function fontFlags(
  page: PDFPageProxy,
  fontName: string,
  family: string,
  cache: Map<string, FontFlags>,
): FontFlags {
  const cached = cache.get(fontName);
  if (cached) return cached;
  let flags: FontFlags = { bold: false, italic: false, mono: family === 'monospace' };
  try {
    if (page.commonObjs.has(fontName)) {
      const font = page.commonObjs.get(fontName) as { name?: string; isMonospace?: boolean } | null;
      if (font?.name) flags = flagsFromFont(font.name, !!font.isMonospace, family);
    }
  } catch {
    /* font not resolved: fall back to the generic family */
  }
  cache.set(fontName, flags);
  return flags;
}

/** Reads one page: positioned text, image placements and a count of vector paint operations. */
export async function extractPage(
  pdfjs: PdfjsLib,
  page: PDFPageProxy,
  fontCache: Map<string, FontFlags>,
): Promise<ExtractedPage> {
  const { OPS, Util } = pdfjs;
  const viewport = page.getViewport({ scale: 1 });
  const [content, ops] = await Promise.all([page.getTextContent(), page.getOperatorList()]);

  const items: RawItem[] = [];
  let textChars = 0;
  for (const it of content.items) {
    if (!('str' in it)) continue;
    const str = it.str;
    if (!str || !str.trim()) continue;
    const m = Util.transform(viewport.transform, it.transform);
    if (Math.abs(m[1]) > Math.abs(m[0]) * 0.5) continue; // rotated or vertical text
    const size = Math.hypot(m[2], m[3]);
    if (!(size > 1)) continue;
    const style = content.styles[it.fontName];
    const flags = fontFlags(page, it.fontName, style?.fontFamily ?? '', fontCache);
    items.push({ str, x: m[4], y: m[5], width: it.width * viewport.scale, size, ...flags });
    textChars += str.trim().length;
  }

  const imageRects: Rect[] = [];
  let paintOps = 0;
  let ctm: number[] = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const toRect = (m: number[]): Rect => {
    const full = Util.transform(viewport.transform, m);
    const xs = [full[4], full[4] + full[0], full[4] + full[2], full[4] + full[0] + full[2]];
    const ys = [full[5], full[5] + full[1], full[5] + full[3], full[5] + full[1] + full[3]];
    return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  };
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    switch (fn) {
      case OPS.save:
        stack.push(ctm);
        break;
      case OPS.restore:
        ctm = stack.pop() ?? ctm;
        break;
      case OPS.transform:
        ctm = Util.transform(ctm, args as number[]);
        break;
      case OPS.paintFormXObjectBegin:
        stack.push(ctm);
        if (Array.isArray(args?.[0])) ctm = Util.transform(ctm, args[0] as number[]);
        break;
      case OPS.paintFormXObjectEnd:
        ctm = stack.pop() ?? ctm;
        break;
      case OPS.paintImageXObject:
      case OPS.paintInlineImageXObject:
      case OPS.paintImageXObjectRepeat:
        imageRects.push(toRect(ctm));
        break;
      case OPS.fill:
      case OPS.eoFill:
      case OPS.stroke:
      case OPS.fillStroke:
      case OPS.eoFillStroke:
        paintOps++;
        break;
    }
  }

  return {
    raw: { index: page.pageNumber - 1, width: viewport.width, height: viewport.height, items, figures: [] },
    viewport,
    textChars,
    imageRects,
    paintOps,
    lang: content.lang,
  };
}

/** Merges rectangles that overlap or nearly touch (a figure is often drawn as several image strips). */
export function mergeRects(rects: Rect[], pad = 6): Rect[] {
  const out = rects.map((r) => ({ ...r }));
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < out.length; i++) {
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i];
        const b = out[j];
        if (a.x0 - pad <= b.x1 && b.x0 - pad <= a.x1 && a.y0 - pad <= b.y1 && b.y0 - pad <= a.y1) {
          out[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };
          out.splice(j, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  return out;
}
