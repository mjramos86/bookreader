import { escapeXml, stripInvalidXmlChars } from '../lib/util';

/**
 * Turns positioned PDF text into reflowable structure: headings, paragraphs, lists, code and
 * figures, with running headers, page numbers and column layouts handled.
 *
 * Everything here is pure (no DOM, no pdf.js) so it can be unit-tested with synthetic input.
 * Coordinates are in points with the origin at the top-left of the page.
 */

export interface RawItem {
  str: string;
  x: number;
  /** Baseline. */
  y: number;
  width: number;
  size: number;
  bold: boolean;
  italic: boolean;
  mono: boolean;
}

export interface RawFigure {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  imageId: number;
}

export interface RawPage {
  index: number;
  width: number;
  height: number;
  items: RawItem[];
  figures: RawFigure[];
  /** Set when the page has no usable text and is kept as an image. */
  rasterImageId?: number;
}

export interface Run {
  text: string;
  bold?: boolean;
  italic?: boolean;
  mono?: boolean;
  sup?: boolean;
  sub?: boolean;
}

export interface Block {
  type: 'heading' | 'para' | 'li' | 'pre' | 'figure' | 'pageimage' | 'table';
  page: number;
  /** Top of the first line. */
  y: number;
  size: number;
  text: string;
  runs: Run[];
  level?: number;
  imageId?: number;
  notes?: Block[];
  /** Anchor id, assigned for table-of-contents targets. */
  id?: string;
  /** Block starts / ends a column region; used to join paragraphs split by a page or column. */
  regionStart?: boolean;
  regionEnd?: boolean;
  boldOnly?: boolean;
  /** Table cells, row by row. */
  rows?: Run[][][];
  /** The first row is a header row. */
  header?: boolean;
}

export interface Analysis {
  blocks: Block[];
  bodySize: number;
  /** Sizes of heading levels, largest first. */
  headingSizes: number[];
}

interface Line {
  kind: 'line';
  page: number;
  col: 'S' | 'L' | 'R';
  band: number;
  x0: number;
  x1: number;
  y: number;
  top: number;
  size: number;
  runs: Run[];
  text: string;
  allBold: boolean;
  mono: boolean;
  wideGap: boolean;
  /** x of the text after a bullet marker; continuation lines of a list item align with it. */
  listTextX: number;
  /** Dot-leader line (table of contents entry). */
  leader: boolean;
  /** Cells separated by wide gaps; the raw material for tables. */
  cells?: Cell[];
  heading: boolean;
  bullet: boolean;
  note: boolean;
}

interface Cell {
  x0: number;
  x1: number;
  runs: Run[];
}

interface TableEl {
  kind: 'table';
  page: number;
  col: 'S' | 'L' | 'R';
  band: number;
  top: number;
  rows: Run[][][];
  header: boolean;
  text: string;
}

interface FigureEl {
  kind: 'figure';
  page: number;
  col: 'S' | 'L' | 'R';
  band: number;
  top: number;
  x0: number;
  x1: number;
  imageId: number;
}

interface PageImageEl {
  kind: 'pageimage';
  page: number;
  imageId: number;
}

type El = Line | FigureEl | PageImageEl | TableEl;

const LIGATURES: Record<string, string> = {
  '\uFB00': 'ff',
  '\uFB01': 'fi',
  '\uFB02': 'fl',
  '\uFB03': 'ffi',
  '\uFB04': 'ffl',
  '\uFB05': 'st',
  '\uFB06': 'st',
  '\u00AD': '',
  '\u00A0': ' ',
  '\u2002': ' ',
  '\u2003': ' ',
  '\u2009': ' ',
};

export function normalizeText(s: string): string {
  return s.replace(/[\uFB00-\uFB06\u00AD\u00A0\u2002\u2003\u2009]/g, (c) => LIGATURES[c] ?? c);
}

const SENTENCE_END = /[.!?…:;]["'”’)\]»]*$/;
const BULLET_RE = /^\s*([•◦▪▫●■□○◆◇▶►‣⁃∙·]|[-–—*](?=\s))\s+(?=\S)/;
const NOTE_MARKER_RE = /^(?:[\d]{1,3}(?=\s+\S)|[*†‡§¶]|[¹²³⁴⁵⁶⁷⁸⁹⁰]+|\[\d{1,3}\])/;
const CAPTION_RE = /^(?:figure|fig\.|table|chart|plate|source|image|photo|illustration)\b/i;
const BULLET_ONLY_RE = /^([•◦▪▫●■□○◆◇▶►‣⁃∙·]|[-–—*])$/;
const LIST_NUMBER_RE = /^\(?(?:\d{1,3}|[a-z]|[ivxlcdm]{1,6})[.)]$/i;
const LEADER_RE = /(?:\.\s?){4,}\s*\S{1,8}$/;
const CELL_GAP_EM = 1.6;
const PAGE_NUMBER_RE = /^\s*[-–—]?\s*(?:page\s+)?(?:\d{1,4}|[ivxlc]{1,7})\s*[-–—]?\s*(?:(?:of|\/)\s*\d{1,4})?\s*$/i;

export function endsSentence(text: string): boolean {
  return SENTENCE_END.test(text.trimEnd());
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function percentile(nums: number[], p: number): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
}

// -------------------------------------------------------------------------------------------
// Lines
// -------------------------------------------------------------------------------------------

interface Cluster {
  y: number;
  size: number;
  items: RawItem[];
}

function clusterItems(items: RawItem[]): Cluster[] {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const clusters: Cluster[] = [];
  for (const it of sorted) {
    let target: Cluster | undefined;
    for (let i = clusters.length - 1; i >= 0 && i >= clusters.length - 3; i--) {
      const c = clusters[i];
      if (Math.abs(it.y - c.y) <= 0.5 * Math.max(it.size, c.size)) {
        target = c;
        break;
      }
    }
    if (target) {
      target.items.push(it);
      if (it.size > target.size) {
        target.size = it.size;
        target.y = it.y;
      }
    } else clusters.push({ y: it.y, size: it.size, items: [it] });
  }
  return clusters;
}

interface Gutter {
  start: number;
  end: number;
  mid: number;
}

function clusterExtent(c: Cluster): { x0: number; x1: number } {
  let x0 = Infinity;
  let x1 = -Infinity;
  for (const it of c.items) {
    x0 = Math.min(x0, it.x);
    x1 = Math.max(x1, it.x + it.width);
  }
  return { x0, x1 };
}

/** Finds a vertical gap that separates two text columns, if the page has one. */
export function detectGutter(clusters: Cluster[], pageWidth: number): Gutter | null {
  const lines = clusters.filter((c) => c.items.some((i) => i.str.trim().length > 0));
  if (lines.length < 8) return null;
  const cover = new Int32Array(Math.ceil(pageWidth) + 2);
  for (const c of lines) {
    for (const it of c.items) {
      const a = Math.max(0, Math.floor(it.x));
      const b = Math.min(cover.length - 1, Math.ceil(it.x + it.width));
      for (let x = a; x <= b; x++) cover[x]++;
    }
  }
  const lo = Math.floor(pageWidth * 0.25);
  const hi = Math.ceil(pageWidth * 0.75);
  const limit = Math.max(1, Math.floor(lines.length * 0.1));
  let best: { s: number; e: number } | null = null;
  let runStart = -1;
  for (let x = lo; x <= hi + 1; x++) {
    const open = x <= hi && cover[x] <= limit;
    if (open && runStart < 0) runStart = x;
    if (!open && runStart >= 0) {
      if (!best || x - runStart > best.e - best.s) best = { s: runStart, e: x };
      runStart = -1;
    }
  }
  if (!best || best.e - best.s < 9) return null;
  const mid = (best.s + best.e) / 2;
  let both = 0;
  let left = 0;
  let right = 0;
  for (const c of lines) {
    const hasL = c.items.some((i) => i.x + i.width <= best!.s + 3);
    const hasR = c.items.some((i) => i.x >= best!.e - 3);
    if (hasL && hasR) both++;
    if (hasL) left++;
    if (hasR) right++;
  }
  // Both columns must hold real text; a lone table row with a wide gap is not a column layout.
  if (left < 5 || right < 5 || both < Math.min(left, right) * 0.35) return null;
  return { start: best.s, end: best.e, mid };
}

function itemRuns(items: RawItem[], lineSize: number, lineY: number): { runs: Run[]; wideGap: boolean } {
  const runs: Run[] = [];
  let wideGap = false;
  let prev: RawItem | null = null;
  for (const it of items) {
    const raw = normalizeText(it.str);
    if (!raw) continue;
    let text = raw;
    if (prev) {
      const gap = it.x - (prev.x + prev.width);
      const prevEndsSpace = /\s$/.test(prev.str);
      const startsSpace = /^\s/.test(raw);
      const em = Math.max(it.size, prev.size);
      if (gap > 3 * em && gap > 24) {
        wideGap = true;
        if (!prevEndsSpace) text = '\u2003' + text;
      } else if (!prevEndsSpace && !startsSpace && gap > 0.16 * em) {
        text = ' ' + text;
      }
    }
    const small = it.size < lineSize * 0.82;
    const raised = it.y < lineY - 0.2 * lineSize;
    const lowered = it.y > lineY + 0.15 * lineSize;
    const run: Run = {
      text,
      bold: it.bold || undefined,
      italic: it.italic || undefined,
      mono: it.mono || undefined,
      sup: (small && raised) || undefined,
      sub: (small && lowered) || undefined,
    };
    const last = runs[runs.length - 1];
    if (last && last.bold === run.bold && last.italic === run.italic && last.mono === run.mono && last.sup === run.sup && last.sub === run.sub) {
      last.text += run.text;
    } else runs.push(run);
    prev = it;
  }
  return { runs, wideGap };
}

function makeLine(page: RawPage, items: RawItem[], col: Line['col'], band: number): Line | null {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const visible = sorted.filter((i) => i.str.trim().length > 0);
  if (!visible.length) return null;

  // Dominant size by character count.
  const bySize = new Map<number, number>();
  for (const it of visible) {
    const k = Math.round(it.size * 2) / 2;
    bySize.set(k, (bySize.get(k) ?? 0) + it.str.trim().length);
  }
  let size = 0;
  let best = -1;
  for (const [k, n] of bySize) {
    if (n > best) {
      best = n;
      size = k;
    }
  }
  const main = visible.filter((i) => Math.abs(i.size - size) <= 0.6);
  const y = median((main.length ? main : visible).map((i) => i.y));

  const { runs, wideGap } = itemRuns(sorted.filter((i) => i.str.length > 0), size, y);
  let text = runs.map((r) => r.text).join('');
  text = text.replace(/[ \t]+/g, ' ').trim();
  if (!text) return null;
  const x0 = Math.min(...visible.map((i) => i.x));
  const bullet = BULLET_RE.test(text);

  let listTextX = x0;
  if (bullet) {
    listTextX = BULLET_ONLY_RE.test(visible[0].str.trim()) && visible[1] ? visible[1].x : x0 + 1.2 * size;
  }

  // Split into cells at wide gaps (tables, tab-aligned columns). Bullets and numbered lists are not tables.
  let cells: Cell[] | undefined;
  if (!bullet) {
    const groups: RawItem[][] = [[]];
    for (let i = 0; i < visible.length; i++) {
      const it = visible[i];
      const prev = visible[i - 1];
      if (prev && it.x - (prev.x + prev.width) > Math.max(14, CELL_GAP_EM * Math.max(it.size, prev.size))) groups.push([]);
      groups[groups.length - 1].push(it);
    }
    const firstCell = groups[0].map((i) => i.str).join('').trim();
    if (groups.length >= 2 && !LIST_NUMBER_RE.test(firstCell)) {
      cells = groups.map((g) => ({
        x0: Math.min(...g.map((i) => i.x)),
        x1: Math.max(...g.map((i) => i.x + i.width)),
        runs: itemRuns(g, size, y).runs,
      }));
    }
  }
  const x1 = Math.max(...visible.map((i) => i.x + i.width));
  const chars = visible.reduce((n, i) => n + i.str.trim().length, 0);
  const boldChars = visible.filter((i) => i.bold).reduce((n, i) => n + i.str.trim().length, 0);
  const monoChars = visible.filter((i) => i.mono).reduce((n, i) => n + i.str.trim().length, 0);
  return {
    kind: 'line',
    page: page.index,
    col,
    band,
    x0,
    x1,
    y,
    top: y - size,
    size,
    runs,
    text,
    allBold: boldChars >= chars * 0.95,
    mono: monoChars >= chars * 0.8,
    wideGap,
    listTextX,
    leader: LEADER_RE.test(text),
    cells,
    heading: false,
    bullet,
    note: false,
  };
}

/** Text items outside any figure: text inside a figure is part of the picture. */
function itemsOutsideFigures(page: RawPage): RawItem[] {
  return page.items.filter((it) => {
    const cx = it.x + it.width / 2;
    const cy = it.y - it.size * 0.3;
    return !page.figures.some((f) => cx >= f.x0 && cx <= f.x1 && cy >= f.y0 && cy <= f.y1);
  });
}

/** Reading-order elements for one page. `furniture` clusters (running heads, page numbers) are skipped. */
function pageElements(page: RawPage, allClusters: Cluster[], furniture: Set<Cluster>): El[] {
  if (page.rasterImageId !== undefined) return [{ kind: 'pageimage', page: page.index, imageId: page.rasterImageId }];

  const clusters = allClusters.filter((c) => !furniture.has(c));
  const gutter = detectGutter(clusters, page.width);

  const els: El[] = [];
  for (const c of clusters) {
    const sorted = [...c.items].sort((a, b) => a.x - b.x);
    if (gutter) {
      const { x0, x1 } = clusterExtent(c);
      if (x1 <= gutter.start + 3) {
        const l = makeLine(page, sorted, 'L', 0);
        if (l) els.push(l);
        continue;
      }
      if (x0 >= gutter.end - 3) {
        const r = makeLine(page, sorted, 'R', 0);
        if (r) els.push(r);
        continue;
      }
      // The line reaches into the gutter: it is a column line only if a gap holds the whole gutter.
      let split = -1;
      for (let i = 0; i + 1 < sorted.length; i++) {
        if (sorted[i].x + sorted[i].width <= gutter.start + 3 && sorted[i + 1].x >= gutter.end - 3) split = i;
      }
      if (split >= 0) {
        const l = makeLine(page, sorted.slice(0, split + 1), 'L', 0);
        const r = makeLine(page, sorted.slice(split + 1), 'R', 0);
        if (l) els.push(l);
        if (r) els.push(r);
        continue;
      }
    }
    const line = makeLine(page, sorted, 'S', 0);
    if (line) els.push(line);
  }
  for (const f of page.figures) {
    const wide = f.x1 - f.x0 > page.width * 0.55;
    const col: FigureEl['col'] = !gutter || wide ? 'S' : (f.x0 + f.x1) / 2 < gutter.mid ? 'L' : 'R';
    els.push({ kind: 'figure', page: page.index, col, band: 0, top: f.y0, x0: f.x0, x1: f.x1, imageId: f.imageId });
  }

  const top = (e: El) => (e.kind === 'pageimage' ? 0 : e.top);
  els.sort((a, b) => top(a) - top(b) || ((a as Line).x0 ?? 0) - ((b as Line).x0 ?? 0));

  // Columns: text of the left column precedes the right column until a full-width element.
  const ordered: El[] = [];
  let band = 0;
  let left: El[] = [];
  let right: El[] = [];
  const flush = () => {
    if (left.length || right.length) {
      for (const e of [...left, ...right]) (e as Line).band = band;
      ordered.push(...left, ...right);
      left = [];
      right = [];
      band++;
    }
  };
  for (const e of els) {
    const col = (e as Line).col;
    if (col === 'L') left.push(e);
    else if (col === 'R') right.push(e);
    else {
      flush();
      (e as Line).band = band;
      ordered.push(e);
    }
  }
  flush();
  return buildTables(ordered);
}

// -------------------------------------------------------------------------------------------
// Tables
// -------------------------------------------------------------------------------------------

function cellText(runs: Run[]): string {
  return runs.map((r) => r.text).join('');
}

/** Builds a table from consecutive multi-cell lines, or returns null if their columns do not line up. */
function tableFromLines(lines: Line[]): TableEl | null {
  const minX = Math.min(...lines.map((l) => l.x0));
  const maxX = Math.max(...lines.map((l) => l.x1));
  const cover = new Int32Array(Math.ceil(maxX - minX) + 2);
  for (const l of lines) {
    for (const c of l.cells ?? []) {
      for (let x = Math.max(0, Math.floor(c.x0 - minX)); x <= Math.min(cover.length - 1, Math.ceil(c.x1 - minX)); x++) cover[x]++;
    }
  }
  // Column boundaries are x ranges that no cell crosses.
  const size = lines[0].size;
  const bounds: number[] = [];
  let run = -1;
  for (let x = 0; x < cover.length; x++) {
    if (cover[x] === 0 && run < 0) run = x;
    if ((cover[x] > 0 || x === cover.length - 1) && run >= 0) {
      if (run > 0 && cover[x] > 0 && x - run >= Math.max(4, size * 0.45)) bounds.push(minX + (run + x) / 2);
      run = -1;
    }
  }
  const cols = bounds.length + 1;
  if (cols < 2) return null;

  const rows: Run[][][] = lines.map((l) => {
    const row: Run[][] = Array.from({ length: cols }, () => []);
    for (const c of l.cells ?? []) {
      const center = (c.x0 + c.x1) / 2;
      let idx = 0;
      while (idx < bounds.length && center > bounds[idx]) idx++;
      row[idx] = row[idx].length ? [...row[idx], { text: ' ' }, ...c.runs] : c.runs;
    }
    return row;
  });
  const filled = rows.filter((r) => r.filter((c) => c.length).length >= 2).length;
  if (filled < Math.max(2, Math.ceil(rows.length * 0.6))) return null;
  if (rows.length < 3 && cols < 3) return null;

  const header = rows[0].every((c) => c.length === 0 || c.every((r) => r.bold));
  return {
    kind: 'table',
    page: lines[0].page,
    col: lines[0].col,
    band: lines[0].band,
    top: lines[0].top,
    rows,
    header,
    text: rows.map((r) => r.map(cellText).join(' ')).join(' '),
  };
}

function buildTables(els: El[]): El[] {
  const out: El[] = [];
  let run: Line[] = [];
  const flush = () => {
    if (run.length >= 2) {
      const table = tableFromLines(run);
      if (table) {
        out.push(table);
        run = [];
        return;
      }
    }
    out.push(...run);
    run = [];
  };
  for (const e of els) {
    if (e.kind === 'line' && e.cells && e.cells.length >= 2) {
      const prev = run[run.length - 1];
      if (prev && (prev.col !== e.col || prev.band !== e.band || e.y - prev.y > 2.6 * Math.max(e.size, prev.size))) flush();
      run.push(e);
    } else {
      flush();
      out.push(e);
    }
  }
  flush();
  return out;
}

// -------------------------------------------------------------------------------------------
// Headers, footers, page numbers
// -------------------------------------------------------------------------------------------

function furnitureKey(text: string): string {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

function clusterText(c: Cluster): string {
  return [...c.items]
    .sort((a, b) => a.x - b.x)
    .map((i) => i.str.trim())
    .filter(Boolean)
    .join(' ');
}

/**
 * Finds running headers, footers and page numbers: lines in the top or bottom margin that repeat
 * across pages (ignoring digits) or look like a page number. Done on whole line clusters, before
 * any column split, so a header spread across two columns still repeats exactly.
 */
function findFurniture(pages: { raw: RawPage; clusters: Cluster[] }[]): Set<Cluster> {
  const counts = new Map<string, number>();
  const candidates: { cluster: Cluster; key: string; text: string }[] = [];
  for (const { raw, clusters } of pages) {
    for (const c of clusters) {
      const inTop = c.y < raw.height * 0.085;
      const inBottom = c.y > raw.height * 0.915;
      if (!inTop && !inBottom) continue;
      const text = clusterText(c);
      if (!text) continue;
      const key = (inTop ? 'T:' : 'B:') + furnitureKey(text);
      candidates.push({ cluster: c, key, text });
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const total = pages.length;
  const out = new Set<Cluster>();
  for (const c of candidates) {
    const n = counts.get(c.key) ?? 0;
    if (PAGE_NUMBER_RE.test(c.text) || (n >= 3 && n >= total * 0.2)) out.add(c.cluster);
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// Paragraph building
// -------------------------------------------------------------------------------------------

function mergeRuns(runs: Run[]): Run[] {
  const out: Run[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    const last = out[out.length - 1];
    if (last && !!last.bold === !!r.bold && !!last.italic === !!r.italic && !!last.mono === !!r.mono && !!last.sup === !!r.sup && !!last.sub === !!r.sub) {
      last.text += r.text;
    } else out.push({ ...r });
  }
  return out;
}

function plain(runs: Run[]): string {
  return runs.map((r) => r.text).join('');
}

/** Appends `next` to `runs`, removing a line-end hyphen or inserting a space as appropriate. */
export function joinRuns(runs: Run[], next: Run[]): Run[] {
  if (!runs.length) return mergeRuns(next.map((r) => ({ ...r })));
  const out = runs.map((r) => ({ ...r }));
  const last = out[out.length - 1];
  const nextText = plain(next);
  const first = nextText.trimStart()[0] ?? '';
  const endsHyphen = /[A-Za-zÀ-ɏ]-$/.test(last.text);
  const isLower = first !== '' && first === first.toLowerCase() && first !== first.toUpperCase();
  if (endsHyphen && isLower) {
    last.text = last.text.slice(0, -1);
  } else if (!/[\s—]$/.test(last.text) && !/^\s/.test(nextText)) {
    last.text += ' ';
  }
  return mergeRuns([...out, ...next.map((r) => ({ ...r }))]);
}

function makeBlock(lines: Line[], type: Block['type'], bodySize: number): Block {
  let runs: Run[] = [];
  if (type === 'pre') {
    const minX = Math.min(...lines.map((l) => l.x0));
    const charW = Math.max(3, lines[0].size * 0.6);
    const text = lines
      .map((l) => ' '.repeat(Math.max(0, Math.round((l.x0 - minX) / charW))) + l.runs.map((r) => r.text).join('').replace(/\u2003/g, '    ').trim())
      .join('\n');
    return { type, page: lines[0].page, y: lines[0].top, size: lines[0].size, text, runs: [{ text, mono: true }] };
  }
  for (const l of lines) {
    let lr = l.runs;
    if (l === lines[0] && type === 'li') {
      lr = stripBullet(lr);
    }
    runs = joinRuns(runs, lr);
  }
  runs = mergeRuns(runs);
  if (runs.length) {
    runs[0].text = runs[0].text.replace(/^\s+/, '');
    runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\s+$/, '');
  }
  const text = plain(runs);
  const boldOnly = runs.length > 0 && runs.every((r) => r.bold);
  return {
    type,
    page: lines[0].page,
    y: lines[0].top,
    size: Math.max(...lines.map((l) => l.size)),
    text,
    runs: type === 'heading' ? runs.map((r) => ({ ...r, bold: undefined })) : runs,
    boldOnly: boldOnly && lines[0].size >= bodySize * 0.95 && lines[0].size < bodySize * 1.17 && !CAPTION_RE.test(text),
  };
}

function stripBullet(runs: Run[]): Run[] {
  const out = runs.map((r) => ({ ...r }));
  if (out.length) out[0].text = out[0].text.replace(BULLET_RE, '');
  return out;
}

interface Margins {
  left: number;
  right: number;
}

function computeMargins(lines: Line[], bodySize: number): Map<string, Margins> {
  const groups = new Map<string, Line[]>();
  for (const l of lines) {
    if (Math.abs(l.size - bodySize) > bodySize * 0.15) continue;
    const key = `${l.page}:${l.col}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(l);
  }
  const out = new Map<string, Margins>();
  for (const [key, ls] of groups) {
    if (ls.length < 3) continue;
    out.set(key, { left: percentile(ls.map((l) => l.x0), 0.2), right: percentile(ls.map((l) => l.x1), 0.9) });
  }
  return out;
}

function regionKey(l: Line): string {
  return `${l.page}:${l.band}:${l.col}`;
}

export interface AnalyzeOptions {
  /** Treat bold single-line paragraphs at body size as sub-headings. */
  boldHeadings?: boolean;
}

export function analyze(rawPages: RawPage[], options: AnalyzeOptions = {}): Analysis {
  const prepared = rawPages.map((raw) => ({
    raw,
    clusters: raw.rasterImageId !== undefined ? [] : clusterItems(itemsOutsideFigures(raw)),
  }));
  const furniture = findFurniture(prepared);
  const pages = prepared.map((p) => ({ raw: p.raw, els: pageElements(p.raw, p.clusters, furniture) }));

  // Body font size: the most common size by characters.
  const sizeChars = new Map<number, number>();
  for (const { els } of pages) {
    for (const e of els) {
      if (e.kind !== 'line') continue;
      sizeChars.set(e.size, (sizeChars.get(e.size) ?? 0) + e.text.length);
    }
  }
  let bodySize = 11;
  let bestChars = -1;
  for (const [size, n] of sizeChars) {
    if (n > bestChars) {
      bestChars = n;
      bodySize = size;
    }
  }

  const allLines: Line[] = [];
  for (const { els } of pages) for (const e of els) if (e.kind === 'line') allLines.push(e);

  // Typical distance between consecutive baselines of body text.
  const deltas: number[] = [];
  for (let i = 1; i < allLines.length; i++) {
    const a = allLines[i - 1];
    const b = allLines[i];
    if (regionKey(a) !== regionKey(b)) continue;
    const d = b.y - a.y;
    if (Math.abs(a.size - bodySize) < 1 && Math.abs(b.size - bodySize) < 1 && d > bodySize * 0.8 && d < bodySize * 2.4) deltas.push(d);
  }
  const leading = deltas.length ? median(deltas) : bodySize * 1.25;
  const margins = computeMargins(allLines, bodySize);

  // Classify lines.
  for (const l of allLines) {
    const big = l.size >= bodySize * 1.17;
    l.heading = big && l.text.length <= 180 && !l.mono;
  }
  // Footnotes: text at the bottom of the page that starts with a note marker (a small raised
  // number, a symbol or a number in smaller type), plus its continuation lines. Captions and code
  // are not footnotes.
  const pageHeight = new Map(rawPages.map((p) => [p.index, p.height]));
  let prevNote: boolean = false;
  let prevNoteSize: number = 0;
  let prevPage = -1;
  for (const l of allLines) {
    if (l.page !== prevPage) {
      prevNote = false;
      prevPage = l.page;
    }
    const h = pageHeight.get(l.page) ?? 800;
    const small = l.size < bodySize * 0.88 && l.size > bodySize * 0.5 && l.y > h * 0.7;
    const markedBySup = !!l.runs[0]?.sup && l.y > h * 0.72;
    const marker = NOTE_MARKER_RE.test(l.text);
    const continues: boolean = prevNote && l.y > h * 0.75 && Math.abs(l.size - prevNoteSize) < 0.8;
    l.note = !l.heading && !l.mono && !CAPTION_RE.test(l.text) && ((small && (marker || prevNote)) || markedBySup || continues);
    if (l.note) prevNoteSize = l.size;
    prevNote = l.note;
  }

  const blocks: Block[] = [];
  let pendingNotes: Block[] = [];

  const attachNotes = (page: number) => {
    if (!pendingNotes.length) return;
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].page === page && blocks[i].type !== 'figure') {
        blocks[i].notes = [...(blocks[i].notes ?? []), ...pendingNotes];
        pendingNotes = [];
        return;
      }
      if (blocks[i].page < page) break;
    }
    blocks.push(...pendingNotes.map((n) => ({ ...n, type: 'para' as const })));
    pendingNotes = [];
  };

  for (const { raw, els } of pages) {
    let region: Line[][] = [];
    let current: Line[] = [];
    let currentKey = '';
    let currentIsList = false;

    const closeParagraph = () => {
      if (current.length) region.push(current);
      current = [];
      currentIsList = false;
    };
    const emitRegion = () => {
      closeParagraph();
      const startIndex = blocks.length;
      for (const lines of region) {
        const first = lines[0];
        let type: Block['type'];
        if (first.note) {
          pendingNotes.push(makeBlock(lines, 'para', bodySize));
          continue;
        }
        if (first.heading) type = 'heading';
        else if (lines.every((l) => l.mono)) type = 'pre';
        else if (first.bullet) type = 'li';
        else type = 'para';
        blocks.push(makeBlock(lines, type, bodySize));
      }
      if (blocks.length > startIndex) {
        blocks[startIndex].regionStart = true;
        blocks[blocks.length - 1].regionEnd = true;
      }
      region = [];
      currentKey = '';
    };

    for (const e of els) {
      if (e.kind === 'pageimage') {
        emitRegion();
        blocks.push({ type: 'pageimage', page: raw.index, y: 0, size: 0, text: '', runs: [], imageId: e.imageId, regionStart: true, regionEnd: true });
        continue;
      }
      if (e.kind === 'table') {
        emitRegion();
        blocks.push({ type: 'table', page: raw.index, y: e.top, size: 0, text: e.text, runs: [], rows: e.rows, header: e.header, regionStart: true, regionEnd: true });
        continue;
      }
      if (e.kind === 'figure') {
        emitRegion();
        blocks.push({ type: 'figure', page: raw.index, y: e.top, size: 0, text: '', runs: [], imageId: e.imageId, regionStart: true, regionEnd: true });
        continue;
      }
      const key = regionKey(e);
      if (key !== currentKey) {
        emitRegion();
        currentKey = key;
      }
      const prev = current[current.length - 1];
      if (prev && shouldBreak(prev, e, { bodySize, leading, margins, listFirst: currentIsList ? current[0] : null })) closeParagraph();
      current.push(e);
      currentIsList = current[0].bullet;
    }
    emitRegion();
    attachNotes(raw.index);
  }

  const merged = mergeAcrossRegions(blocks);
  const headingSizes = assignHeadingLevels(merged, bodySize, rawPages.length, options.boldHeadings !== false);
  return { blocks: merged, bodySize, headingSizes };
}

interface BreakContext {
  bodySize: number;
  leading: number;
  margins: Map<string, Margins>;
  /** First line of the list item being built, if any. */
  listFirst: Line | null;
}

function shouldBreak(a: Line, b: Line, ctx: BreakContext): boolean {
  if (a.note !== b.note) return true;
  if (a.heading !== b.heading) return true;
  if (a.heading && b.heading) return Math.abs(a.size - b.size) > 0.5 || b.y - a.y > a.size * 1.9;
  if (a.mono !== b.mono) return true;
  if (b.bullet) return true;
  if (Math.abs(a.size - b.size) > 0.12 * Math.max(a.size, b.size)) return true;
  if (a.wideGap || a.leader) return true;
  if (a.allBold !== b.allBold && (a.allBold || b.allBold) && (a.text.length < 90 || b.text.length < 90) && !endsMidSentence(a)) return true;

  const gap = b.y - a.y;
  const lineGap = Math.max(ctx.leading, 1.2 * Math.max(a.size, b.size));
  if (a.mono && b.mono) return gap > lineGap * 2.2;
  if (gap > 1.45 * lineGap) return true;

  const m = ctx.margins.get(`${b.page}:${b.col}`) ?? ctx.margins.get(`${a.page}:${a.col}`);
  if (m) {
    const width = Math.max(1, m.right - m.left);
    const indent = b.x0 - m.left;
    if (ctx.listFirst && !b.bullet) {
      // Continuation lines of a list item line up with its text (or with its bullet).
      const tol = 0.6 * Math.max(b.size, ctx.bodySize);
      return !(Math.abs(b.x0 - ctx.listFirst.listTextX) <= tol || Math.abs(b.x0 - ctx.listFirst.x0) <= tol);
    }
    if (indent > 0.9 * ctx.bodySize && indent < 8 * ctx.bodySize && endsSentence(a.text)) return true;
    if (a.x1 < m.right - 0.22 * width && endsSentence(a.text)) return true;
  } else if (endsSentence(a.text) && gap > 1.25 * lineGap) {
    return true;
  }
  return false;
}

function endsMidSentence(l: Line): boolean {
  return !endsSentence(l.text);
}

function startsLowercase(text: string): boolean {
  const c = text.trimStart()[0];
  return !!c && c === c.toLowerCase() && c !== c.toUpperCase();
}

/** Joins paragraphs cut by a page or column boundary. */
function mergeAcrossRegions(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    if (
      prev &&
      prev.type === 'para' &&
      b.type === 'para' &&
      prev.regionEnd &&
      b.regionStart &&
      !endsSentence(prev.text) &&
      (startsLowercase(b.text) || /[,;–-]$/.test(prev.text))
    ) {
      prev.runs = joinRuns(prev.runs, b.runs);
      prev.text = plain(prev.runs);
      prev.notes = [...(prev.notes ?? []), ...(b.notes ?? [])];
      prev.regionEnd = b.regionEnd;
      continue;
    }
    // Continued code listings.
    if (prev && prev.type === 'pre' && b.type === 'pre' && prev.regionEnd && b.regionStart) {
      prev.text += '\n' + b.text;
      prev.runs = [{ text: prev.text, mono: true }];
      prev.regionEnd = b.regionEnd;
      continue;
    }
    out.push(b);
  }
  return out;
}

function assignHeadingLevels(blocks: Block[], bodySize: number, pageCount: number, boldHeadings: boolean): number[] {
  // Bold paragraphs standing alone, at about body size, are sub-headings.
  if (boldHeadings) {
    for (const b of blocks) {
      if (b.type === 'para' && b.boldOnly && b.text.length <= 100 && b.text.length >= 2 && !endsSentence(b.text) && !/^\d+$/.test(b.text)) {
        b.type = 'heading';
        b.runs = b.runs.map((r) => ({ ...r, bold: undefined }));
      }
    }
  }
  const key = (b: Block) => Math.round(b.size * 2) / 2;
  const counts = new Map<number, number>();
  for (const b of blocks) if (b.type === 'heading') counts.set(key(b), (counts.get(key(b)) ?? 0) + 1);
  const sizes = [...counts.keys()].sort((a, b) => b - a);
  // The chapter level is the largest size that recurs; one-off larger sizes (titles) join it at level 1.
  const minRepeat = pageCount >= 12 ? 2 : 1;
  const chapterSize = sizes.find((s) => (counts.get(s) ?? 0) >= minRepeat) ?? sizes[0];
  const levelSizes = sizes.filter((s) => s <= (chapterSize ?? Infinity));
  for (const b of blocks) {
    if (b.type !== 'heading') continue;
    const s = key(b);
    if (chapterSize === undefined || s >= chapterSize) b.level = 1;
    else {
      const idx = levelSizes.findIndex((x) => Math.abs(x - s) < 0.01);
      b.level = Math.min(4, (idx < 0 ? levelSizes.length : idx) + 1);
    }
  }
  void bodySize;
  return levelSizes;
}

// -------------------------------------------------------------------------------------------
// Chapters
// -------------------------------------------------------------------------------------------

export interface OutlineEntry {
  title: string;
  /** Zero-based page index. */
  page: number;
  /** Destination y in top-down page coordinates, when known. */
  y?: number;
  depth: number;
}

export interface TocEntry {
  title: string;
  depth: number;
  /** Index of the block that starts this entry. */
  block: number;
}

export interface ChapterPlan {
  title: string;
  /** How the chapter boundary was found; `outline` chapters get a heading if the text has none. */
  kind: 'outline' | 'heading' | 'front' | 'chunk';
  /** Block range [start, end). */
  start: number;
  end: number;
  /** Sub-entries inside this chapter. */
  entries: TocEntry[];
}

function normTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9À-ɏ]+/g, ' ').trim();
}

function blockOf(blocks: Block[], page: number, y: number | undefined): number {
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (b.page > page) return i;
    // Destinations point at the top of a heading box or at its baseline; compare with the first baseline.
    if (b.page === page && (y === undefined || b.y + b.size >= y - 3 || b.type === 'pageimage')) return i;
  }
  return blocks.length;
}

export function planChapters(blocks: Block[], outline: OutlineEntry[], bookTitle: string, pageCount: number): ChapterPlan[] {
  if (!blocks.length) return [];
  const text = (from: number, to: number) => blocks.slice(from, to).reduce((n, b) => n + b.text.length, 0);

  let starts: { block: number; title: string }[] = [];
  const entries: { block: number; title: string; depth: number }[] = [];

  const useOutline = outline.length >= 2 && new Set(outline.filter((o) => o.depth === 0).map((o) => o.page)).size >= 2;
  if (useOutline) {
    for (const o of outline) {
      if (o.depth > 2) continue;
      const block = blockOf(blocks, o.page, o.y);
      if (block >= blocks.length) continue;
      entries.push({ block, title: o.title, depth: o.depth });
    }
    starts = entries.filter((e) => e.depth === 0).map((e) => ({ block: e.block, title: e.title }));
  } else {
    const lvl1 = blocks.map((b, i) => ({ b, i })).filter(({ b }) => b.type === 'heading' && b.level === 1);
    const lvl2 = blocks.map((b, i) => ({ b, i })).filter(({ b }) => b.type === 'heading' && b.level === 2);
    let chapterLevel = 0;
    if (lvl1.length >= 2) chapterLevel = 1;
    else if (lvl1.length <= 1 && lvl2.length >= 3) chapterLevel = 2;
    if (chapterLevel) {
      for (let i = 0; i < blocks.length; i++) {
        const b = blocks[i];
        if (b.type !== 'heading' || (b.level ?? 9) > chapterLevel + 1) continue;
        const depth = (b.level ?? 1) - chapterLevel;
        if (depth < 0) {
          // A larger heading than the chapter level (e.g. a part title) starts a chapter too.
          entries.push({ block: i, title: b.text, depth: 0 });
        } else entries.push({ block: i, title: b.text, depth });
      }
      starts = entries.filter((e) => e.depth === 0).map((e) => ({ block: e.block, title: e.title }));
    }
  }

  // Collapse several starts on the same block (e.g. "Part I" and "Chapter 1" back to back).
  const unique: { block: number; title: string }[] = [];
  for (const s of starts.sort((a, b) => a.block - b.block)) {
    const last = unique[unique.length - 1];
    if (last && last.block === s.block) last.title = s.title;
    else unique.push(s);
  }
  starts = unique;

  if (starts.length < 2) {
    // No structure: break into evenly sized parts at page boundaries.
    const total = text(0, blocks.length);
    const target = 28000;
    const parts = Math.max(1, Math.round(total / target));
    if (parts === 1) {
      return [{ title: bookTitle, kind: 'front', start: 0, end: blocks.length, entries: [] }];
    }
    const plan: ChapterPlan[] = [];
    let begin = 0;
    let acc = 0;
    for (let i = 0; i < blocks.length; i++) {
      acc += blocks[i].text.length;
      const pageEnds = i + 1 >= blocks.length || blocks[i + 1].page !== blocks[i].page;
      if (acc >= total / parts && pageEnds && i + 1 < blocks.length && plan.length < parts - 1) {
        plan.push({ title: '', kind: 'chunk', start: begin, end: i + 1, entries: [] });
        begin = i + 1;
        acc = 0;
      }
    }
    plan.push({ title: '', kind: 'chunk', start: begin, end: blocks.length, entries: [] });
    plan.forEach((p, n) => {
      const first = blocks[p.start].page + 1;
      const last = blocks[p.end - 1].page + 1;
      p.title = `Part ${n + 1} (pages ${first}–${last})`;
    });
    void pageCount;
    return plan;
  }

  const plan: ChapterPlan[] = [];
  if (starts[0].block > 0) {
    const frontText = text(0, starts[0].block);
    const first = blocks[0];
    const title = first.type === 'heading' && first.text ? first.text : 'Front matter';
    if (frontText > 0 || blocks.slice(0, starts[0].block).some((b) => b.type !== 'para' && b.type !== 'heading')) {
      plan.push({ title: title === starts[0].title ? 'Front matter' : title, kind: 'front', start: 0, end: starts[0].block, entries: [] });
    }
  }
  starts.forEach((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].block : blocks.length;
    const sub = entries.filter((e) => e.depth > 0 && e.block >= s.block && e.block < end).map((e) => ({ title: e.title, depth: e.depth, block: e.block }));
    plan.push({ title: s.title || `Section ${i + 1}`, kind: useOutline ? 'outline' : 'heading', start: s.block, end, entries: sub });
  });
  // The first chapter begins at the front matter when it would otherwise be skipped.
  if (!plan.length) plan.push({ title: bookTitle, kind: 'front', start: 0, end: blocks.length, entries: [] });
  return plan;
}

export function titleMatchesHeading(blocks: Block[], plan: ChapterPlan): boolean {
  const first = blocks[plan.start];
  return !!first && first.type === 'heading' && normTitle(first.text) === normTitle(plan.title);
}

export { normTitle };

// -------------------------------------------------------------------------------------------
// Serialisation
// -------------------------------------------------------------------------------------------

export function runsToXhtml(runs: Run[]): string {
  return runs
    .map((r) => {
      let s = escapeXml(stripInvalidXmlChars(r.text)).replace(/\u2003/g, '&#8195;');
      if (r.mono) s = `<code>${s}</code>`;
      if (r.sup) s = `<sup>${s}</sup>`;
      if (r.sub) s = `<sub>${s}</sub>`;
      if (r.italic) s = `<em>${s}</em>`;
      if (r.bold) s = `<strong>${s}</strong>`;
      return s;
    })
    .join('');
}

export function blocksToXhtml(blocks: Block[], imagePath: (id: number) => string, idFor: (index: number) => string | undefined, baseIndex: number): string {
  const out: string[] = [];
  let list: string[] = [];
  const flushList = () => {
    if (list.length) {
      out.push(`<ul>\n${list.join('\n')}\n</ul>`);
      list = [];
    }
  };
  blocks.forEach((b, i) => {
    const id = idFor(baseIndex + i);
    const idAttr = id ? ` id="${escapeXml(id)}"` : '';
    if (b.type === 'li') {
      list.push(`<li${idAttr}>${runsToXhtml(b.runs)}</li>`);
      return;
    }
    flushList();
    switch (b.type) {
      case 'heading': {
        const level = Math.min(6, Math.max(1, b.level ?? 2));
        out.push(`<h${level}${idAttr}>${runsToXhtml(b.runs)}</h${level}>`);
        break;
      }
      case 'para':
        out.push(`<p${idAttr}>${runsToXhtml(b.runs)}</p>`);
        break;
      case 'pre':
        out.push(`<pre${idAttr}>${escapeXml(stripInvalidXmlChars(b.text))}</pre>`);
        break;
      case 'figure':
        out.push(`<figure${idAttr}><img src="${imagePath(b.imageId!)}" alt="Figure" /></figure>`);
        break;
      case 'table': {
        const rows = b.rows ?? [];
        const cellHtml = (cell: Run[], tag: string) => `<${tag}>${runsToXhtml(cell)}</${tag}>`;
        const head = b.header && rows.length > 1 ? `<thead><tr>${rows[0].map((c) => cellHtml(c, 'th')).join('')}</tr></thead>` : '';
        const bodyRows = (b.header && rows.length > 1 ? rows.slice(1) : rows).map((r) => `<tr>${r.map((c) => cellHtml(c, 'td')).join('')}</tr>`);
        out.push(`<table${idAttr}>${head}<tbody>${bodyRows.join('')}</tbody></table>`);
        break;
      }
      case 'pageimage':
        out.push(`<div class="pageimg"${idAttr}><img src="${imagePath(b.imageId!)}" alt="Page ${b.page + 1}" /></div>`);
        break;
    }
    if (b.notes?.length) {
      for (const n of b.notes) out.push(`<aside class="footnote"><p>${runsToXhtml(n.runs)}</p></aside>`);
    }
  });
  flushList();
  return out.join('\n');
}
