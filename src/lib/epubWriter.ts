import JSZip from 'jszip';
import { escapeXml, extFromMime } from './util';

export interface WriterChapter {
  /** Stable id, used for the file name. */
  id: string;
  title: string;
  /** Well-formed XHTML for the inside of <body>. */
  body: string;
}

export interface WriterImage {
  /** Path relative to the EPUB content root, e.g. `images/fig-1.jpg`. */
  path: string;
  data: Uint8Array | Blob;
  mime: string;
}

export interface TocNode {
  title: string;
  /** href relative to the content root, e.g. `text/ch-001.xhtml#sec-3`. */
  href: string;
  children?: TocNode[];
}

export interface BookSpec {
  title: string;
  author: string;
  language: string;
  identifier: string;
  description?: string;
  cover?: { data: Uint8Array | Blob; mime: string };
  chapters: WriterChapter[];
  images?: WriterImage[];
  /** Defaults to one entry per chapter. */
  toc?: TocNode[];
  css?: string;
}

export const DEFAULT_CSS = `
html { font-size: 100%; }
body { margin: 0; line-height: 1.5; }
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 1.4em 0 0.6em; break-after: avoid; }
h1 { font-size: 1.7em; }
h2 { font-size: 1.4em; }
h3 { font-size: 1.2em; }
h4, h5, h6 { font-size: 1em; }
p { margin: 0 0 0.8em; }
img, svg { max-width: 100%; height: auto; }
figure { margin: 1em 0; text-align: center; break-inside: avoid; }
figure img { max-width: 100%; max-height: 90vh; }
blockquote { margin: 1em 1.5em; }
pre { white-space: pre-wrap; font-family: monospace; font-size: 0.9em; margin: 1em 0; }
code { font-family: monospace; font-size: 0.92em; }
table { border-collapse: collapse; max-width: 100%; margin: 1em 0; }
th, td { border: 1px solid #8888; padding: 0.25em 0.5em; text-align: left; vertical-align: top; }
aside.footnote { font-size: 0.85em; margin: 0.2em 0 1em; opacity: 0.85; }
hr { border: 0; border-top: 1px solid #8886; margin: 1.5em 0; }
.pageimg { text-align: center; margin: 0; break-inside: avoid; }
.pageimg img { max-height: 98vh; width: auto; }
`;

function chapterPath(i: number): string {
  return `text/ch-${String(i + 1).padStart(4, '0')}.xhtml`;
}

function xhtmlPage(title: string, lang: string, body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(lang)}" xml:lang="${escapeXml(lang)}">
<head>
<meta charset="utf-8" />
<title>${escapeXml(title)}</title>
<link rel="stylesheet" type="text/css" href="../style.css" />
</head>
<body>
${body}
</body>
</html>
`;
}

function navList(nodes: TocNode[], indent = 2): string {
  const pad = '  '.repeat(indent);
  const items = nodes
    .map((n) => {
      const kids = n.children?.length ? `\n${navList(n.children, indent + 2)}\n${pad}` : '';
      return `${pad}<li><a href="${escapeXml(n.href)}">${escapeXml(n.title)}</a>${kids}</li>`;
    })
    .join('\n');
  return `${'  '.repeat(indent - 1)}<ol>\n${items}\n${'  '.repeat(indent - 1)}</ol>`;
}

function ncxPoints(nodes: TocNode[], counter: { n: number }): string {
  return nodes
    .map((n) => {
      const id = ++counter.n;
      const kids = n.children?.length ? ncxPoints(n.children, counter) : '';
      return `<navPoint id="np-${id}" playOrder="${id}"><navLabel><text>${escapeXml(n.title)}</text></navLabel><content src="${escapeXml(n.href)}"/>${kids}</navPoint>`;
    })
    .join('\n');
}

/** Builds a valid EPUB 3 package (with an EPUB 2 NCX for older readers). */
export async function buildEpub(spec: BookSpec): Promise<Blob> {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file(
    'META-INF/container.xml',
    `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
  );

  const oebps = zip.folder('OEBPS')!;
  oebps.file('style.css', spec.css ?? DEFAULT_CSS);

  const manifest: string[] = [];
  const spine: string[] = [];
  manifest.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
  manifest.push('<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>');
  manifest.push('<item id="css" href="style.css" media-type="text/css"/>');

  let coverMeta = '';
  if (spec.cover) {
    const path = `images/cover.${extFromMime(spec.cover.mime)}`;
    oebps.file(path, spec.cover.data);
    manifest.push(`<item id="cover-image" href="${path}" media-type="${spec.cover.mime}" properties="cover-image"/>`);
    coverMeta = '<meta name="cover" content="cover-image"/>';
  }

  (spec.images ?? []).forEach((img, i) => {
    oebps.file(img.path, img.data);
    manifest.push(`<item id="img-${i}" href="${escapeXml(img.path)}" media-type="${img.mime}"/>`);
  });

  spec.chapters.forEach((ch, i) => {
    const path = chapterPath(i);
    oebps.file(path, xhtmlPage(ch.title, spec.language, ch.body));
    manifest.push(`<item id="ch-${i}" href="${path}" media-type="application/xhtml+xml"/>`);
    spine.push(`<itemref idref="ch-${i}"/>`);
  });

  const toc: TocNode[] =
    spec.toc && spec.toc.length
      ? spec.toc
      : spec.chapters.map((ch, i) => ({ title: ch.title, href: chapterPath(i) }));

  oebps.file(
    'nav.xhtml',
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="${escapeXml(spec.language)}">
<head><meta charset="utf-8" /><title>Contents</title></head>
<body>
  <nav epub:type="toc" id="toc"><h1>Contents</h1>
${navList(toc)}
  </nav>
</body>
</html>
`,
  );

  oebps.file(
    'toc.ncx',
    `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
<head><meta name="dtb:uid" content="${escapeXml(spec.identifier)}"/></head>
<docTitle><text>${escapeXml(spec.title)}</text></docTitle>
<navMap>
${ncxPoints(toc, { n: 0 })}
</navMap>
</ncx>`,
  );

  const modified = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  oebps.file(
    'content.opf',
    `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${escapeXml(spec.identifier)}</dc:identifier>
    <dc:title>${escapeXml(spec.title)}</dc:title>
    <dc:creator>${escapeXml(spec.author)}</dc:creator>
    <dc:language>${escapeXml(spec.language)}</dc:language>
${spec.description ? `    <dc:description>${escapeXml(spec.description)}</dc:description>\n` : ''}    <meta property="dcterms:modified">${modified}</meta>
    ${coverMeta}
  </metadata>
  <manifest>
    ${manifest.join('\n    ')}
  </manifest>
  <spine toc="ncx">
    ${spine.join('\n    ')}
  </spine>
</package>`,
  );

  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/epub+zip',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}
