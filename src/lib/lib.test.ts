import JSZip from 'jszip';
import { beforeAll, describe, expect, it } from 'vitest';
import { filterDeclarations, fragmentOffset, prepareChapter } from './chapter';
import { EpubBook } from './epub';
import { buildEpub } from './epubWriter';
import { detectFormat } from './importer';
import { foldCase, indexBook, searchBook } from './indexer';
import { dataUriToBytes, escapeXml, fragmentOf, isExternalUrl, resolvePath, sanitizeFileName, stripInvalidXmlChars } from './util';

beforeAll(() => {
  let n = 0;
  // jsdom has no object URLs; chapters only need a unique string per resource.
  URL.createObjectURL = () => `blob:test/${n++}`;
  URL.revokeObjectURL = () => undefined;
});

async function sampleEpub(extraBody = '') {
  const blob = await buildEpub({
    title: 'Sample & Co',
    author: 'A. Writer',
    language: 'en',
    identifier: 'urn:uuid:test',
    cover: { data: new Uint8Array([1, 2, 3]), mime: 'image/png' },
    chapters: [
      { id: 'a', title: 'One', body: `<h1 id="top">One</h1><p>Hello <a href="ch-0002.xhtml#deep">world</a> and <a href="https://example.com/x">outside</a>.</p>${extraBody}` },
      { id: 'b', title: 'Two', body: '<h1>Two</h1><p>Second chapter text about Lighthouses.</p><h2 id="deep">Deeper</h2><p>More text under the subheading.</p>' },
    ],
    toc: [
      { title: 'One', href: 'text/ch-0001.xhtml' },
      { title: 'Two', href: 'text/ch-0002.xhtml', children: [{ title: 'Deeper', href: 'text/ch-0002.xhtml#deep' }] },
    ],
  });
  return EpubBook.open(blob);
}

describe('util', () => {
  it('resolves relative paths inside an archive', () => {
    expect(resolvePath('OEBPS/text/ch1.xhtml', '../images/a%20b.png')).toBe('OEBPS/images/a b.png');
    expect(resolvePath('OEBPS/text/ch1.xhtml', 'ch2.xhtml#x')).toBe('OEBPS/text/ch2.xhtml');
    expect(resolvePath('a/b.xhtml', '/root/c.png')).toBe('root/c.png');
    expect(resolvePath('a/b.xhtml', '../../../escape.png')).toBe('escape.png');
  });

  it('splits fragments and classifies URLs', () => {
    expect(fragmentOf('x.xhtml#a%20b')).toBe('a b');
    expect(fragmentOf('x.xhtml')).toBeUndefined();
    expect(isExternalUrl('https://a.b')).toBe(true);
    expect(isExternalUrl('data:image/png;base64,AA')).toBe(false);
    expect(isExternalUrl('chapter.xhtml')).toBe(false);
  });

  it('escapes and cleans XML text', () => {
    expect(escapeXml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
    expect(stripInvalidXmlChars('a\u0000b\u000Bc퟿d')).toBe('abc퟿d');
    expect(sanitizeFileName('A/B: "C"?')).toBe('A B C');
  });

  it('decodes data URIs', () => {
    const out = dataUriToBytes('data:image/png;base64,AQID');
    expect(out?.mime).toBe('image/png');
    expect(Array.from(out!.data)).toEqual([1, 2, 3]);
    expect(dataUriToBytes('not a uri')).toBeNull();
  });
});

describe('EPUB writer and reader', () => {
  it('round-trips metadata, spine, TOC and cover', async () => {
    const book = await sampleEpub();
    expect(book.metadata).toEqual({ title: 'Sample & Co', author: 'A. Writer', language: 'en' });
    expect(book.spine).toHaveLength(2);
    expect(book.toc.map((t) => t.title)).toEqual(['One', 'Two']);
    expect(book.toc[1].children[0]).toMatchObject({ title: 'Deeper', spine: 1, fragment: 'deep' });
    expect((await book.getCover())?.size).toBe(3);
    expect(book.flatToc().map((t) => [t.title, t.depth])).toEqual([['One', 0], ['Two', 0], ['Deeper', 1]]);
  });

  it('rejects things that are not EPUBs', async () => {
    await expect(EpubBook.open(new Blob(['plain text']))).rejects.toThrow(/not a valid EPUB/);
    const zip = new JSZip();
    zip.file('hello.txt', 'hi');
    await expect(EpubBook.open(await zip.generateAsync({ type: 'blob' }))).rejects.toThrow(/container/);
  });

  it('refuses DRM-protected books with a clear message', async () => {
    const zip = new JSZip();
    zip.file('mimetype', 'application/epub+zip');
    zip.file('META-INF/container.xml', '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="c.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
    zip.file(
      'META-INF/encryption.xml',
      '<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptedData><enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/><enc:CipherData><enc:CipherReference URI="c1.xhtml"/></enc:CipherData></enc:EncryptedData></encryption>',
    );
    await expect(EpubBook.open(await zip.generateAsync({ type: 'blob' }))).rejects.toThrow(/DRM/);
  });
});

describe('chapter preparation', () => {
  it('strips scripts and handlers, and rewrites links', async () => {
    const book = await sampleEpub(
      '<script>alert(1)</script><p onclick="steal()">click</p><iframe src="https://evil"></iframe><a href="javascript:alert(2)">bad</a><img src="https://tracker/x.gif" alt="t" />',
    );
    const ch = await prepareChapter(book, 0, true);
    const html = ch.body.innerHTML;
    expect(html).not.toMatch(/<script|onclick|<iframe|javascript:|tracker/);
    const links = Array.from(ch.body.querySelectorAll('a'));
    const internal = links.find((a) => a.textContent === 'world')!;
    expect(internal.getAttribute('data-path')).toBe('OEBPS/text/ch-0002.xhtml');
    expect(internal.getAttribute('data-frag')).toBe('deep');
    expect(links.find((a) => a.textContent === 'outside')?.getAttribute('data-ext')).toBe('https://example.com/x');
    expect(ch.text).toContain('Hello world and outside.');
  });

  it('computes the offset of a fragment in canonical text', async () => {
    const book = await sampleEpub();
    const ch = await prepareChapter(book, 1, false);
    const off = fragmentOffset(ch.body, 'deep')!;
    expect(ch.text.slice(off, off + 6)).toBe('Deeper');
    expect(fragmentOffset(ch.body, 'missing')).toBeUndefined();
  });
});

describe('style filtering', () => {
  const style = (css: string) => {
    const el = document.createElement('div');
    el.setAttribute('style', css);
    return el.style;
  };

  it('drops colours, fixed line heights and absolute font sizes but keeps relative ones', () => {
    const s = style('color: red; background-color: #000; line-height: 20px; font-size: 14px; text-indent: 1.5em; font-weight: bold');
    filterDeclarations(s, false, { publisherFonts: false });
    expect(s.getPropertyValue('color')).toBe('');
    expect(s.getPropertyValue('background-color')).toBe('');
    expect(s.getPropertyValue('line-height')).toBe('');
    expect(s.getPropertyValue('font-size')).toBe('');
    expect(s.getPropertyValue('text-indent')).toBe('1.5em');
    expect(s.getPropertyValue('font-weight')).toBe('bold');
    const rel = style('font-size: 1.2em');
    filterDeclarations(rel, false, { publisherFonts: false });
    expect(rel.getPropertyValue('font-size')).toBe('1.2em');
  });

  it('only keeps publisher fonts when asked, and always keeps monospace', () => {
    const a = style("font-family: 'Times New Roman'");
    filterDeclarations(a, false, { publisherFonts: false });
    expect(a.getPropertyValue('font-family')).toBe('');
    const b = style("font-family: 'Times New Roman'");
    filterDeclarations(b, false, { publisherFonts: true });
    expect(b.getPropertyValue('font-family')).not.toBe('');
    const c = style('font-family: Courier New, monospace');
    filterDeclarations(c, false, { publisherFonts: false });
    expect(c.getPropertyValue('font-family')).not.toBe('');
  });

  it('strips layout-breaking declarations from the root', () => {
    const s = style('margin: 40px; width: 600px; position: fixed; top: 0');
    filterDeclarations(s, true, { publisherFonts: false });
    expect(s.length).toBe(0);
  });
});

describe('indexing and search', () => {
  it('indexes chapters, resolves TOC offsets and finds matches case-insensitively', async () => {
    const book = await sampleEpub();
    await indexBook(book);
    expect(book.totalChars).toBeGreaterThan(50);
    expect(book.chapterStart[1]).toBe(book.chapterText[0].length);

    const hits = searchBook(book, 'lighthouses');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ spine: 1, match: 'Lighthouses' });
    expect(book.chapterText[1].slice(hits[0].start, hits[0].end)).toBe('Lighthouses');

    const flat = book.flatToc();
    const deeper = flat.find((t) => t.title === 'Deeper')!;
    expect(deeper.offset).toBeGreaterThan(0);
    expect(book.chapterTitle(1, 0, flat)).toBe('Two');
    expect(book.chapterTitle(1, deeper.offset! + 5, flat)).toBe('Deeper');
    expect(book.chapterTitle(0, 0, flat)).toBe('One');
  });

  it('maps book fractions to positions and back', async () => {
    const book = await sampleEpub();
    await indexBook(book);
    const pos = book.locate(0.75);
    const back = book.bookFraction(pos.spine, pos.offset);
    expect(Math.abs(back - 0.75)).toBeLessThan(0.02);
    expect(book.bookFraction(0, 0)).toBe(0);
  });

  it('folds case without changing string length', () => {
    for (const s of ['İstanbul', 'ÀÉÎ', 'ǅ', 'Straße']) expect(foldCase(s)).toHaveLength(s.length);
    expect(searchBook({ chapterText: [] } as unknown as EpubBook, 'a')).toEqual([]);
  });
});

describe('format detection', () => {
  const file = (name: string) => new File([], name);

  it('recognises formats by content before extension', async () => {
    expect(await detectFormat(file('x.bin'), new TextEncoder().encode('%PDF-1.7 ...'))).toBe('pdf');

    const epub = new JSZip();
    epub.file('META-INF/container.xml', '<container/>');
    expect(await detectFormat(file('book.zip'), await epub.generateAsync({ type: 'uint8array' }))).toBe('epub');

    const docx = new JSZip();
    docx.file('word/document.xml', '<w/>');
    expect(await detectFormat(file('doc.docx'), await docx.generateAsync({ type: 'uint8array' }))).toBe('docx');

    const cbz = new JSZip();
    cbz.file('001.jpg', 'x');
    expect(await detectFormat(file('c.cbz'), await cbz.generateAsync({ type: 'uint8array' }))).toBe('cbz');
  });

  it('uses the extension for text formats and sniffs unknown plain text', async () => {
    const text = new TextEncoder().encode('# Title\n\nSome text');
    expect(await detectFormat(file('a.md'), text)).toBe('md');
    expect(await detectFormat(file('a.html'), text)).toBe('html');
    expect(await detectFormat(file('notes'), text)).toBe('txt');
    expect(await detectFormat(file('story.fb2'), text)).toBe('fb2');
  });

  it('explains unsupported formats instead of failing obscurely', async () => {
    await expect(detectFormat(file('book.mobi'), new Uint8Array(10))).rejects.toThrow(/MOBI.*Calibre/);
    await expect(detectFormat(file('x.dat'), new Uint8Array([0, 1, 2, 3, 0, 0, 0, 9]))).rejects.toThrow(/not a format/);
  });
});
