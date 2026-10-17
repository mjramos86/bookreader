import { decodeText } from '../lib/epub';
import { escapeXml, stripInvalidXmlChars } from '../lib/util';
import type { ConvertContext, ConvertResult } from '../lib/importer';
import { assembleEpub, ImageStore, type ChapterDraft } from './common';

/** Decodes bytes as UTF-8, falling back to Windows-1252 for legacy text files. */
export function decodePlainText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  } catch {
    if (bytes[0] === 0xff || bytes[0] === 0xfe) return decodeText(bytes);
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

const HEADING_RE =
  /^(?:(?:chapter|part|book|section|act|canto|volume|letter)\s+(?:[ivxlcdm]+|\d+|[a-z]+(?:[- ][a-z]+)?)\b.{0,60}|(?:prologue|epilogue|preface|foreword|introduction|afterword|appendix(?:\s+[a-z0-9]+)?|contents|acknowledg(?:e)?ments|dedication|conclusion)\b.{0,40}|[ivxlcdm]{1,7}\.?|\d{1,3}\.?)$/i;

function isHeadingLine(line: string): boolean {
  const t = line.trim();
  return t.length > 0 && t.length <= 80 && HEADING_RE.test(t) && !/[,;]$/.test(t);
}

function unwrapGutenberg(text: string): { body: string; title?: string; author?: string } {
  const head = text.slice(0, 6000);
  const title = /^Title:\s*(.+)$/im.exec(head)?.[1]?.trim();
  const author = /^Author:\s*(.+)$/im.exec(head)?.[1]?.trim();
  const start = /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^*]*\*\*\*/i.exec(text);
  const end = /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK/i.exec(text);
  if (start) {
    const from = start.index + start[0].length;
    return { body: text.slice(from, end && end.index > from ? end.index : undefined), title, author };
  }
  return { body: text, title, author };
}

interface Para {
  text: string;
  /** Keep the original line breaks (verse, addresses). */
  verse: boolean;
}

function toParagraphs(text: string): Para[] {
  const blocks = text.split(/\n[ \t]*\n+/).map((b) => b.replace(/^\n+|\n+$/g, '')).filter((b) => b.trim());
  const lineCount = text.split('\n').length;
  // No blank lines at all: every line is its own paragraph.
  if (blocks.length < 3 && lineCount > 40) {
    return text.split('\n').filter((l) => l.trim()).map((l) => ({ text: l.trim(), verse: false }));
  }
  return blocks.map((block) => {
    const lines = block.split('\n').map((l) => l.replace(/\s+$/g, ''));
    if (lines.length === 1) return { text: lines[0].trim(), verse: false };
    const lens = lines.map((l) => l.trim().length);
    const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
    const max = Math.max(...lens);
    const verse = lines.length >= 3 && avg < 46 && max < 64 && lines.every((l) => !/^\s{0,2}\S.*[a-z,]$/.test(l) || l.length < 50);
    if (verse) return { text: lines.map((l) => l.trim()).join('\n'), verse: true };
    return { text: lines.map((l) => l.trim()).join(' ').replace(/(\w)- (?=[a-z])/g, '$1-'), verse: false };
  });
}

function paraHtml(p: Para): string {
  const safe = escapeXml(stripInvalidXmlChars(p.text));
  return p.verse ? `<p>${safe.replace(/\n/g, '<br />')}</p>` : `<p>${safe}</p>`;
}

export async function convertText(bytes: Uint8Array, fallbackTitle: string, ctx: ConvertContext): Promise<ConvertResult> {
  ctx.progress(0.1, 'Reading text');
  const raw = decodePlainText(bytes).replace(/\r\n?/g, '\n').replace(/\u00A0/g, ' ');
  const { body, title, author } = unwrapGutenberg(raw);
  const bookTitle = title || fallbackTitle;
  const paras = toParagraphs(body.replace(/\t/g, '    '));
  ctx.progress(0.4, 'Finding chapters');

  interface Chapter {
    title: string;
    paras: Para[];
    /** The first paragraph is the chapter's own heading line. */
    heading: boolean;
  }
  const chapters: Chapter[] = [];
  let current: Chapter = { title: bookTitle, paras: [], heading: false };
  const headingCount = paras.filter((p) => !p.verse && isHeadingLine(p.text)).length;
  const useHeadings = headingCount >= 2;
  for (const p of paras) {
    if (useHeadings && !p.verse && isHeadingLine(p.text)) {
      if (current.paras.length) chapters.push(current);
      current = { title: p.text.trim(), paras: [{ text: p.text.trim(), verse: false }], heading: true };
    } else current.paras.push(p);
  }
  if (current.paras.length) chapters.push(current);

  // Chunk anything oversized (or an unstructured file) into readable parts.
  const drafts: ChapterDraft[] = [];
  for (const ch of chapters) {
    const hasHeading = ch.heading;
    const parts: Para[][] = [];
    let cur: Para[] = [];
    let size = 0;
    for (const p of hasHeading ? ch.paras.slice(1) : ch.paras) {
      if (size > 0 && size + p.text.length > 60000) {
        parts.push(cur);
        cur = [];
        size = 0;
      }
      cur.push(p);
      size += p.text.length;
    }
    if (cur.length || !parts.length) parts.push(cur);
    parts.forEach((part, i) => {
      const title = chapters.length === 1 && parts.length > 1 ? `Part ${i + 1}` : ch.title;
      const heading = hasHeading && i === 0 ? `<h1>${escapeXml(ch.title)}</h1>\n` : parts.length > 1 && chapters.length === 1 ? `<h1>${escapeXml(title)}</h1>\n` : '';
      drafts.push({ title, html: heading + part.map(paraHtml).join('\n'), hidden: i > 0 && hasHeading ? true : false });
    });
  }

  ctx.progress(0.8, 'Building EPUB');
  const epub = await assembleEpub({ title: bookTitle, author: author ?? '', language: 'en' }, drafts, new ImageStore());
  return { epub, warnings: [] };
}
