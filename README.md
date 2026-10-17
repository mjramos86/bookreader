# Bookreader

An e-book reader that runs entirely in your browser. Add a PDF and it is converted into a
reflowable **EPUB**, so you get the same adjustments you would find on a Kindle: resize text,
change fonts, line spacing and margins, switch themes, and read in pages or as a continuous scroll.
EPUB and several similar formats can be added directly.

Nothing is uploaded: conversion, storage (IndexedDB) and reading all happen on your device.

## Supported formats

| Format | How it is handled |
| --- | --- |
| EPUB (2 and 3) | Read as is. DRM-protected files are refused with a clear message. |
| PDF | Converted to EPUB (see below). |
| DOCX | Converted with mammoth; title and author come from the document properties. |
| TXT | Chapters detected from headings such as "Chapter 1"; hard-wrapped lines are unwrapped; Project Gutenberg boilerplate is dropped. |
| Markdown | Converted with marked; YAML front matter is read; split at top-level headings. |
| HTML | Metadata read from the page; embedded images kept; scripts and remote resources removed. |
| FB2 | Sections, poems, notes, cover and metadata. |
| CBZ | Comic archives: one full-page chapter per image. |

MOBI/AZW and other Kindle formats are not supported; convert them to EPUB first (for example with Calibre).

## Reading features

- Paged layout (one page, or a two-page spread on wide screens) or continuous scroll
- Themes (white, sepia, green, dark, black), five bundled fonts (Literata, Georgia, Palatino,
  Atkinson Hyperlegible, OpenDyslexic), text size, line spacing, margins, justification,
  hyphenation, brightness, optional publisher fonts
- Position is stored as a character offset, so it survives changes to font, size and window size
- Contents, full-text search, highlights in four colours with notes, bookmarks, export of notes to Markdown
- Progress slider with chapter ticks; footer cycles through Kindle-style location, time left in
  chapter, time left in book and page
- Keyboard (arrows, space, PageUp/Down, `T` contents, `/` search, `B` bookmark, `+`/`-` size,
  `F` full screen), tap zones and swipe on touch screens, "back" after following a link
- Publisher CSS is filtered so colours, fixed font sizes, widths and positioning cannot fight your settings

## How PDF conversion works

PDFs have no structure, only positioned text, so `src/convert/pdfLayout.ts` rebuilds it:

- text is grouped into lines, and two-column pages are detected from the gap between columns
- running headers, footers and page numbers are removed (they repeat across pages)
- paragraphs are formed from line spacing, indentation and line length; line-end hyphens are removed
- headings are ranked by font size (plus short bold lines); lists, code blocks and tables are recognised
- footnotes are attached to the paragraph they belong to
- images are cropped from the rendered page and placed in reading order
- chapters come from the PDF outline when present (using its position on the page), otherwise from
  the largest recurring heading, otherwise from evenly sized parts
- pages without text (scans) are kept as images, with a warning suggesting OCR

Limits: there is no OCR, vector drawings that are not raster images are not preserved, and
right-to-left or vertical text is not handled.

## Development

```bash
npm install        # also copies the pdf.js data files into public/pdfjs
npm run dev        # development server
npm test           # unit tests (vitest)
npm run build      # typecheck and production build into dist/
```

The build is static and uses relative paths, so `dist/` can be hosted from any folder.

### Layout

- `src/lib/epub.ts`, `chapter.ts`: EPUB parsing; chapter sanitising and CSS filtering
- `src/lib/renderer.ts`: pagination (CSS columns in a sandboxed iframe), anchoring, highlights, input
- `src/lib/importer.ts`, `src/convert/*`: format detection and converters, all producing EPUB via `epubWriter.ts`
- `src/components/*`: library, reader, panels
- `test/fixtures/sample.pdf`: PDF used by the layout tests (generated with ReportLab)

The pdf.js legacy build is used so conversion works in browsers that lack newer JavaScript built-ins.
