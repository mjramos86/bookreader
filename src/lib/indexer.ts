import { fragmentOffset, prepareChapter } from './chapter';
import type { EpubBook } from './epub';

/**
 * Reads every chapter once to learn its text length (for progress and time-left estimates)
 * and to build the full-text search index. Works in small slices so the UI stays responsive.
 */
export async function indexBook(
  book: EpubBook,
  onProgress?: (done: number, total: number) => void,
  isCancelled?: () => boolean,
): Promise<void> {
  const texts: string[] = [];
  const headings: string[] = [];
  const n = book.spine.length;
  let last = performance.now();
  for (let i = 0; i < n; i++) {
    if (isCancelled?.()) return;
    try {
      const prepared = await prepareChapter(book, i, false);
      texts.push(prepared.text);
      headings.push(prepared.firstHeading);
      for (const item of book.tocItemsInSpine(i)) {
        if (item.fragment) item.offset = fragmentOffset(prepared.body, item.fragment);
      }
    } catch {
      texts.push('');
      headings.push('');
    }
    if (performance.now() - last > 24) {
      onProgress?.(i + 1, n);
      await new Promise((r) => setTimeout(r, 0));
      last = performance.now();
    }
  }
  book.setChapterTexts(texts);
  if (!book.toc.length) {
    book.toc = book.spine.map((_, i) => ({
      title: headings[i] || (texts[i].trim() ? `Section ${i + 1}` : `Page ${i + 1}`),
      spine: i,
      children: [],
    }));
  }
  onProgress?.(n, n);
}

/** Lower-cases without changing string length, so offsets in the folded text match the original. */
export function foldCase(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const lower = c.toLowerCase();
    out += lower.length === 1 ? lower : c;
  }
  return out;
}

export interface SearchHit {
  spine: number;
  start: number;
  end: number;
  before: string;
  match: string;
  after: string;
}

export function searchBook(book: EpubBook, query: string, limit = 400): SearchHit[] {
  const q = foldCase(query.trim());
  if (q.length < 2) return [];
  const hits: SearchHit[] = [];
  for (let spine = 0; spine < book.chapterText.length; spine++) {
    const text = book.chapterText[spine];
    if (!text) continue;
    const folded = foldCase(text);
    let from = 0;
    for (;;) {
      const at = folded.indexOf(q, from);
      if (at < 0) break;
      const end = at + q.length;
      hits.push({
        spine,
        start: at,
        end,
        before: text.slice(Math.max(0, at - 42), at).replace(/\s+/g, ' '),
        match: text.slice(at, end),
        after: text.slice(end, end + 60).replace(/\s+/g, ' '),
      });
      if (hits.length >= limit) return hits;
      from = end;
    }
  }
  return hits;
}
