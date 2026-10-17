import type { ConvertContext, ConvertResult } from '../lib/importer';
import { decodeText } from '../lib/epub';
import { assembleEpub, chaptersFromBody, cleanDom, draftsFromSources, fixInternalLinks, ImageStore } from './common';

export async function convertHtml(bytes: Uint8Array, fallbackTitle: string, ctx: ConvertContext): Promise<ConvertResult> {
  ctx.progress(0.1, 'Reading HTML');
  const doc = new DOMParser().parseFromString(decodeText(bytes), 'text/html');
  const title = doc.querySelector('title')?.textContent?.trim() || doc.querySelector('h1')?.textContent?.trim() || fallbackTitle;
  const author = doc.querySelector('meta[name="author" i]')?.getAttribute('content')?.trim() ?? '';
  const language = doc.documentElement.getAttribute('lang') || 'en';
  const images = new ImageStore();
  cleanDom(doc.body, images);
  ctx.progress(0.5, 'Splitting chapters');
  const sources = chaptersFromBody(doc.body, title);
  fixInternalLinks(sources);
  const epub = await assembleEpub({ title, author, language }, draftsFromSources(sources), images);
  return { epub, warnings: [] };
}
