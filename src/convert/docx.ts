import JSZip from 'jszip';
import mammoth from 'mammoth/mammoth.browser';
import type { ConvertContext, ConvertResult } from '../lib/importer';
import { assembleEpub, chaptersFromBody, cleanDom, draftsFromSources, fixInternalLinks, ImageStore } from './common';
import { ImportError } from '../lib/util';

/** Title, author and language from docProps/core.xml, when the document has them. */
async function readCoreProperties(buffer: ArrayBuffer): Promise<{ title: string; author: string; language: string }> {
  try {
    const zip = await JSZip.loadAsync(buffer);
    const xml = await zip.file('docProps/core.xml')?.async('string');
    if (!xml) return { title: '', author: '', language: '' };
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const get = (name: string) => doc.getElementsByTagNameNS('*', name)[0]?.textContent?.trim() ?? '';
    const language = get('language');
    return { title: get('title'), author: get('creator'), language: /^[a-z]{2,3}(-[A-Za-z]+)?$/.test(language) ? language : '' };
  } catch {
    return { title: '', author: '', language: '' };
  }
}

export async function convertDocx(buffer: ArrayBuffer, fallbackTitle: string, ctx: ConvertContext): Promise<ConvertResult> {
  ctx.progress(0.1, 'Reading Word document');
  let html: string;
  const warnings: string[] = [];
  try {
    const result = await mammoth.convertToHtml(
      { arrayBuffer: buffer },
      {
        styleMap: ["p[style-name='Title'] => h1.title:fresh", "p[style-name='Subtitle'] => p.subtitle:fresh"],
        convertImage: mammoth.images.imgElement(async (image) => {
          const data = await image.read('base64');
          return { src: `data:${image.contentType};base64,${data}` };
        }),
      },
    );
    html = result.value;
  } catch {
    throw new ImportError('This Word document could not be read.');
  }
  ctx.progress(0.5, 'Splitting chapters');
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html');
  const images = new ImageStore();
  cleanDom(doc.body, images);

  const props = await readCoreProperties(buffer);
  const h1s = doc.body.querySelectorAll('h1');
  const onlyH1 = h1s.length === 1 ? h1s[0].textContent?.trim() : '';
  const bookTitle = props.title || onlyH1 || fallbackTitle;
  const sources = chaptersFromBody(doc.body, bookTitle);
  fixInternalLinks(sources);
  const epub = await assembleEpub(
    { title: bookTitle, author: props.author, language: props.language || 'en' },
    draftsFromSources(sources),
    images,
  );
  return { epub, warnings };
}
