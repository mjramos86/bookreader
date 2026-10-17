import { beforeAll, describe, expect, it } from 'vitest';
import { EpubBook } from '../lib/epub';
import type { ConvertContext } from '../lib/importer';
import { convertFb2 } from './fb2';
import { convertHtml } from './html';
import { convertMarkdown } from './markdown';
import { convertText, decodePlainText } from './text';

const ctx: ConvertContext = { fileName: 'x', progress: () => undefined };
const bytes = (s: string) => new TextEncoder().encode(s);

beforeAll(() => {
  let n = 0;
  URL.createObjectURL = () => `blob:test/${n++}`;
});

async function chapters(epub: Blob) {
  const book = await EpubBook.open(epub);
  const out: string[] = [];
  for (const item of book.spine) out.push((await book.readText(item.path)) ?? '');
  return { book, html: out };
}

describe('plain text', () => {
  const chapterText = (title: string, n: number) =>
    `${title}\n\n` + Array.from({ length: n }, (_, i) => `Paragraph ${i + 1} of ${title}. It has words that wrap\nacross two hard-wrapped lines in the file.`).join('\n\n');

  it('finds chapters, unwraps hard-wrapped lines and builds a TOC', async () => {
    const text = [chapterText('Chapter 1', 3), chapterText('Chapter 2', 3), chapterText('Chapter 3', 3)].join('\n\n');
    const { epub } = await convertText(bytes(text), 'Fallback', ctx);
    const { book, html } = await chapters(epub);
    expect(book.metadata.title).toBe('Fallback');
    expect(book.toc.map((t) => t.title)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3']);
    expect(html[0]).toContain('<h1>Chapter 1</h1>');
    expect(html[0]).toContain('words that wrap across two hard-wrapped lines');
  });

  it('reads Project Gutenberg metadata and drops the licence boilerplate', async () => {
    const text = `Title: A Tale\nAuthor: Some Body\n\n*** START OF THE PROJECT GUTENBERG EBOOK A TALE ***\n\nOnce upon a time there was text.\n\n*** END OF THE PROJECT GUTENBERG EBOOK A TALE ***\nLicence terms nobody wants.`;
    const { epub } = await convertText(bytes(text), 'fallback', ctx);
    const { book, html } = await chapters(epub);
    expect(book.metadata).toMatchObject({ title: 'A Tale', author: 'Some Body' });
    expect(html.join('')).toContain('Once upon a time');
    expect(html.join('')).not.toContain('Licence terms');
  });

  it('splits an unstructured long text into parts', async () => {
    const text = Array.from({ length: 400 }, (_, i) => `Sentence block ${i} ${'word '.repeat(60)}`).join('\n\n');
    const { epub } = await convertText(bytes(text), 'Long', ctx);
    const { book } = await chapters(epub);
    expect(book.spine.length).toBeGreaterThan(2);
    expect(book.toc.map((t) => t.title)[0]).toBe('Part 1');
  });

  it('decodes legacy Windows-1252 text', () => {
    expect(decodePlainText(Uint8Array.from([0x63, 0x61, 0x66, 0xe9]))).toBe('café');
    expect(decodePlainText(bytes('﻿hello'))).toBe('hello');
  });
});

describe('markdown', () => {
  it('uses front matter, splits on H1 and keeps inline formatting', async () => {
    const md = `---\ntitle: My Book\nauthor: Jane\n---\n\n# One\n\nSome **bold** and *italic* text.\n\n# Two\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n`;
    const { epub } = await convertMarkdown(bytes(md), 'x', ctx);
    const { book, html } = await chapters(epub);
    expect(book.metadata).toMatchObject({ title: 'My Book', author: 'Jane' });
    expect(book.toc.map((t) => t.title)).toEqual(['One', 'Two']);
    expect(html[0]).toContain('<strong>bold</strong>');
    expect(html[1]).toContain('<li>a</li>');
    expect(html[1]).toContain('<table');
  });

  it('drops raw scripts and event handlers from the source', async () => {
    const { epub } = await convertMarkdown(bytes('# T\n\n<script>alert(1)</script>\n\n<p onclick="x()">hi</p>\n\n[bad](javascript:alert(1))'), 'x', ctx);
    const { html } = await chapters(epub);
    expect(html.join('')).not.toMatch(/<script|onclick|javascript:/);
  });
});

describe('html', () => {
  it('takes metadata from the document, embeds data-URI images and removes remote ones', async () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    const doc = `<!doctype html><html lang="fr"><head><title>Mon livre</title><meta name="author" content="Zoé"><style>p{color:red}</style></head><body><h1>Un</h1><p>Texte <img src="data:image/png;base64,${png}" alt="pixel"></p><img src="http://t.example/x.gif" alt="remote"><h1>Deux</h1><p>Suite</p></body></html>`;
    const { epub } = await convertHtml(bytes(doc), 'x', ctx);
    const { book, html } = await chapters(epub);
    expect(book.metadata).toMatchObject({ title: 'Mon livre', author: 'Zoé', language: 'fr' });
    expect(book.toc.map((t) => t.title)).toEqual(['Un', 'Deux']);
    expect(html[0]).toMatch(/src="\.\.\/images\/img-0001\.png"/);
    expect(html[0]).toContain('[remote]');
    expect(html[0]).not.toContain('t.example');
    expect(html[0]).not.toContain('color:red');
  });

  it('keeps in-document links working across the split chapters', async () => {
    const doc = '<html><body><h1 id="a">A</h1><p><a href="#b">go to b</a></p><h1 id="b">B</h1><p>text</p></body></html>';
    const { epub } = await convertHtml(bytes(doc), 'x', ctx);
    const { html } = await chapters(epub);
    expect(html[0]).toContain('href="ch-0002.xhtml#b"');
  });
});

describe('fb2', () => {
  const fb2 = `<?xml version="1.0" encoding="utf-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
  <description><title-info><book-title>Хроники</book-title><author><first-name>Анна</first-name><last-name>Ким</last-name></author><lang>ru</lang>
    <coverpage><image l:href="#cover.png"/></coverpage></title-info></description>
  <body>
    <section><title><p>Глава 1</p></title><p>Первый <strong>абзац</strong> со <a l:href="#n1" type="note">[1]</a> ссылкой.</p><poem><stanza><v>строка раз</v><v>строка два</v></stanza></poem></section>
    <section><title><p>Глава 2</p></title><p>Второй абзац.</p></section>
  </body>
  <body name="notes"><section id="n1"><title><p>1</p></title><p>Примечание.</p></section></body>
  <binary id="cover.png" content-type="image/png">iVBORw0KGgo=</binary>
</FictionBook>`;

  it('maps sections to chapters and reads metadata, notes and the cover', async () => {
    const { epub } = await convertFb2(bytes(fb2), 'x', ctx);
    const { book, html } = await chapters(epub);
    expect(book.metadata).toEqual({ title: 'Хроники', author: 'Анна Ким', language: 'ru' });
    expect(book.toc.map((t) => t.title)).toEqual(['Глава 1', 'Глава 2', 'Notes']);
    expect(html[0]).toContain('<strong>абзац</strong>');
    expect(html[0]).toContain('строка раз<br />строка два');
    expect(html[0]).toContain('href="ch-0003.xhtml#n1"');
    expect(await book.getCover()).not.toBeNull();
  });

  it('rejects documents that are not FictionBook', async () => {
    await expect(convertFb2(bytes('<html/>'), 'x', ctx)).rejects.toThrow(/FB2/);
  });
});
