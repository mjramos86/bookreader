# Bookreader

An e-book reader that runs entirely in your browser. Add a PDF and it is converted into a
reflowable **EPUB**, so you get the same adjustments you would find on a Kindle: resize text,
change fonts, line spacing and margins, switch themes, and read in pages or as a continuous scroll.
EPUB and several similar formats can be added directly.

Nothing is uploaded: conversion, storage (IndexedDB) and reading all happen on your device.

## Quick start

**Easiest:** open the hosted version (GitHub Pages, deployed automatically from `main`; see the
repository's Settings, Pages, Source: GitHub Actions, once). Nothing to install.

**Run it yourself:** install [Node.js](https://nodejs.org) 22 or newer, then in this folder:

```bash
npm install
npm start
```

That builds the app and opens it in your browser.

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

## Building a library from Google Drive

Choose **Google Drive** in the library, paste a folder link, and sign in. Every supported book in that
folder and its subfolders (and Google Docs, fetched as Word files) is downloaded and converted into your
library on this device. Run it again any time: only new or changed files are fetched, and a book you
removed comes back if it is still in the folder. Access is read-only, and the app talks to Google directly
from your browser; nothing goes through a server.

Google requires every app that reads Drive to have its own (free) OAuth client ID, which has to be created
under your own Google account. One time:

1. Create a project in the [Google Cloud Console](https://console.cloud.google.com/projectcreate) and
   [enable the Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com).
2. APIs & Services, OAuth consent screen: choose External, fill in an app name and your email, and add your
   own Google account under **Test users** (an unverified app works for up to 100 test users).
3. Credentials, Create credentials, OAuth client ID, **Web application**. Add your site's address (for
   example `https://YOUR-NAME.github.io`, no path) under **Authorized JavaScript origins**.
4. Paste the client ID into the Drive dialog on each device, **or** set it once for everyone: in GitHub,
   Settings, Secrets and variables, Actions, Variables, add `GOOGLE_CLIENT_ID`, then re-run the deploy.

While the consent screen is in "Testing", Google asks you to sign in again about once a week.

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

The build is static and uses relative paths, so `dist/` can be hosted from any folder or sub-path
(GitHub Pages, Netlify, any web server).

**It must be served over http(s).** Double-clicking `dist/index.html` (a `file://` address) does not
work, because browsers refuse to run module scripts from disk; the page then shows an explanation
instead of the app. To try a build locally run `npm run preview` and open the address it prints.

### Layout

- `src/lib/epub.ts`, `chapter.ts`: EPUB parsing; chapter sanitising and CSS filtering
- `src/lib/renderer.ts`: pagination (CSS columns in a sandboxed iframe), anchoring, highlights, input
- `src/lib/importer.ts`, `src/convert/*`: format detection and converters, all producing EPUB via `epubWriter.ts`
- `src/components/*`: library, reader, panels
- `test/fixtures/sample.pdf`: PDF used by the layout tests (generated with ReportLab)

The pdf.js legacy build is used so conversion works in browsers that lack newer JavaScript built-ins.
