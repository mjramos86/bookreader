import JSZip from 'jszip';
import { getBook, saveBook } from './db';
import { EpubBook } from './epub';
import type { BookRecord } from './types';
import { extOf, ImportError, sanitizeFileName, sha256Hex, stripExtension } from './util';

export interface ConvertContext {
  fileName: string;
  /** Called with a 0..1 fraction and a short status message. */
  progress: (fraction: number, message: string) => void;
  signal?: AbortSignal;
}

export interface ConvertResult {
  /** The EPUB to store. */
  epub: Blob;
  /** Warnings worth showing to the user (e.g. a scanned PDF). */
  warnings: string[];
}

export type SourceFormat = 'epub' | 'pdf' | 'docx' | 'txt' | 'md' | 'html' | 'fb2' | 'cbz';

export const ACCEPTED_EXTENSIONS = ['.epub', '.pdf', '.docx', '.txt', '.md', '.markdown', '.html', '.htm', '.xhtml', '.fb2', '.cbz'];
export const ACCEPT_ATTR = ACCEPTED_EXTENSIONS.join(',');

const UNSUPPORTED: Record<string, string> = {
  mobi: 'MOBI',
  azw: 'Kindle (AZW)',
  azw3: 'Kindle (AZW3)',
  kfx: 'Kindle (KFX)',
  djvu: 'DjVu',
  rtf: 'RTF',
  doc: 'legacy Word (.doc)',
  odt: 'OpenDocument',
  cbr: 'CBR (RAR comics)',
  lit: 'LIT',
};

export async function detectFormat(file: File, bytes: Uint8Array): Promise<SourceFormat> {
  const ext = extOf(file.name);
  if (ext in UNSUPPORTED) {
    throw new ImportError(
      `${UNSUPPORTED[ext]} files aren't supported yet. Convert the book to EPUB (for example with Calibre) and add that instead.`,
    );
  }
  const head = String.fromCharCode(...bytes.subarray(0, 5));
  if (head.startsWith('%PDF')) return 'pdf';
  if (head.startsWith('PK')) {
    let zip: JSZip;
    try {
      zip = await JSZip.loadAsync(bytes);
    } catch {
      throw new ImportError('This file looks like a zip archive but could not be opened.');
    }
    if (zip.file('META-INF/container.xml')) return 'epub';
    if (zip.file('word/document.xml')) return 'docx';
    const images = Object.keys(zip.files).filter((n) => /\.(jpe?g|png|gif|webp)$/i.test(n));
    if (images.length) return 'cbz';
    throw new ImportError('This zip archive does not contain a recognised book format.');
  }
  switch (ext) {
    case 'epub':
      throw new ImportError('This file has an .epub extension but is not a valid EPUB archive.');
    case 'md':
    case 'markdown':
      return 'md';
    case 'html':
    case 'htm':
    case 'xhtml':
      return 'html';
    case 'fb2':
      return 'fb2';
    case 'txt':
    case 'text':
      return 'txt';
  }
  if (/^\s*<\?xml[^>]*>\s*<FictionBook/i.test(new TextDecoder().decode(bytes.subarray(0, 300)))) return 'fb2';
  if (/^\s*(<!doctype html|<html)/i.test(new TextDecoder().decode(bytes.subarray(0, 200)))) return 'html';
  // Unknown extension: accept it if it is plain text.
  const sample = bytes.subarray(0, 4000);
  let odd = 0;
  for (const b of sample) if (b < 9 || (b > 13 && b < 32)) odd++;
  if (sample.length && odd / sample.length < 0.01) return 'txt';
  throw new ImportError(`"${file.name}" is not a format Bookreader can read. Supported: EPUB, PDF, DOCX, TXT, Markdown, HTML, FB2 and CBZ.`);
}

export interface ImportOutcome {
  book: BookRecord;
  duplicate: boolean;
  warnings: string[];
}

/** Reads a user file, converts it to EPUB when needed, and stores it in the library. */
export async function importFile(file: File, ctx: ConvertContext): Promise<ImportOutcome> {
  ctx.progress(0, 'Reading file');
  const buffer = await file.arrayBuffer();
  const id = (await sha256Hex(buffer)).slice(0, 24);
  const existing = await getBook(id);
  if (existing) return { book: existing, duplicate: true, warnings: [] };

  const bytes = new Uint8Array(buffer);
  const format = await detectFormat(file, bytes);
  const fallbackTitle = stripExtension(file.name).replace(/[_]+/g, ' ').trim() || 'Untitled';
  const sub = (from: number, to: number) => (f: number, message: string) => ctx.progress(from + (to - from) * f, message);

  let epub: Blob;
  let warnings: string[] = [];
  if (format === 'epub') {
    epub = new Blob([buffer], { type: 'application/epub+zip' });
  } else {
    const inner: ConvertContext = { ...ctx, progress: sub(0.02, 0.92) };
    let result: ConvertResult;
    switch (format) {
      case 'pdf':
        // Converters load on demand: pdf.js and mammoth are large, and the app must start without them.
        result = await (await import('../convert/pdf')).convertPdf(bytes, fallbackTitle, inner);
        break;
      case 'docx':
        result = await (await import('../convert/docx')).convertDocx(buffer, fallbackTitle, inner);
        break;
      case 'md':
        result = await (await import('../convert/markdown')).convertMarkdown(bytes, fallbackTitle, inner);
        break;
      case 'html':
        result = await (await import('../convert/html')).convertHtml(bytes, fallbackTitle, inner);
        break;
      case 'fb2':
        result = await (await import('../convert/fb2')).convertFb2(bytes, fallbackTitle, inner);
        break;
      case 'cbz':
        result = await (await import('../convert/cbz')).convertCbz(bytes, fallbackTitle, inner);
        break;
      default:
        result = await (await import('../convert/text')).convertText(bytes, fallbackTitle, inner);
    }
    epub = result.epub;
    warnings = result.warnings;
  }

  ctx.progress(0.94, 'Adding to library');
  const parsed = await EpubBook.open(epub);
  const cover = await parsed.getCover();
  const meta = parsed.metadata;
  parsed.dispose();

  const title = meta.title && meta.title !== 'Untitled' ? meta.title : fallbackTitle;
  const record: BookRecord = {
    id,
    title,
    author: meta.author,
    language: meta.language,
    cover: cover ?? undefined,
    addedAt: Date.now(),
    lastOpenedAt: 0,
    progress: 0,
    sourceFormat: format,
    converted: format !== 'epub',
    size: epub.size,
    fileName: `${sanitizeFileName(meta.author ? `${title} - ${meta.author}` : title)}.epub`,
  };
  await saveBook(record, epub);
  ctx.progress(1, 'Done');
  return { book: record, duplicate: false, warnings };
}
