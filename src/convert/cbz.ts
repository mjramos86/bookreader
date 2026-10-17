import JSZip from 'jszip';
import type { ConvertContext, ConvertResult } from '../lib/importer';
import { buildEpub, type TocNode } from '../lib/epubWriter';
import { escapeXml, extOf, ImportError, mimeFromPath, uid } from '../lib/util';

const naturalCompare = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' }).compare;

/** Comic book archive: every image becomes a full-page chapter. */
export async function convertCbz(bytes: Uint8Array, fallbackTitle: string, ctx: ConvertContext): Promise<ConvertResult> {
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files)
    .filter((n) => !zip.files[n].dir && /\.(jpe?g|png|gif|webp)$/i.test(n) && !/(^|\/)(__MACOSX|\.)/.test(n))
    .sort(naturalCompare);
  if (!names.length) throw new ImportError('No images were found in this comic archive.');

  let title = fallbackTitle;
  let author = '';
  const info = zip.file(/ComicInfo\.xml$/i)[0];
  if (info) {
    const xml = new DOMParser().parseFromString(await info.async('string'), 'application/xml');
    const get = (tag: string) => xml.getElementsByTagName(tag)[0]?.textContent?.trim() ?? '';
    const series = get('Series');
    const t = get('Title');
    const num = get('Number');
    title = [series, num && series ? `#${num}` : '', t].filter(Boolean).join(' ') || title;
    author = get('Writer');
  }

  const images: { path: string; data: Uint8Array; mime: string }[] = [];
  for (let i = 0; i < names.length; i++) {
    ctx.progress((i / names.length) * 0.95, `Reading page ${i + 1} of ${names.length}`);
    const ext = extOf(names[i]) === 'jpeg' ? 'jpg' : extOf(names[i]);
    images.push({
      path: `images/page-${String(i + 1).padStart(4, '0')}.${ext}`,
      data: await zip.files[names[i]].async('uint8array'),
      mime: mimeFromPath(names[i]),
    });
    if (i % 8 === 0) await new Promise((r) => setTimeout(r, 0));
    if (ctx.signal?.aborted) throw new DOMException('Import cancelled', 'AbortError');
  }

  const toc: TocNode[] = [];
  const chapters = images.map((img, i) => {
    if (i % 10 === 0) toc.push({ title: `Page ${i + 1}`, href: `text/ch-${String(i + 1).padStart(4, '0')}.xhtml` });
    return { id: `p-${i}`, title: `Page ${i + 1}`, body: `<div class="pageimg"><img src="../${img.path}" alt="Page ${i + 1}" /></div>` };
  });

  const epub = await buildEpub({
    title,
    author,
    language: 'en',
    identifier: `urn:uuid:${uid()}-${uid()}`,
    cover: { data: images[0].data, mime: images[0].mime },
    chapters,
    images,
    toc,
    css: `body{margin:0}.pageimg{text-align:center}.pageimg img{max-width:100%;max-height:98vh;width:auto;height:auto}`,
  });
  void escapeXml;
  return { epub, warnings: [] };
}
