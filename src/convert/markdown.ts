import { marked } from 'marked';
import type { ConvertContext, ConvertResult } from '../lib/importer';
import { assembleEpub, chaptersFromBody, cleanDom, draftsFromSources, fixInternalLinks, ImageStore } from './common';
import { decodePlainText } from './text';

function frontMatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1].toLowerCase()] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return { meta, body: text.slice(m[0].length) };
}

export async function convertMarkdown(bytes: Uint8Array, fallbackTitle: string, ctx: ConvertContext): Promise<ConvertResult> {
  ctx.progress(0.1, 'Reading Markdown');
  const { meta, body } = frontMatter(decodePlainText(bytes).replace(/\r\n?/g, '\n'));
  const html = await marked.parse(body, { gfm: true, async: true });
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html');
  const images = new ImageStore();
  cleanDom(doc.body, images);

  let title = meta.title || fallbackTitle;
  const h1s = doc.body.querySelectorAll('h1');
  if (!meta.title && h1s.length === 1 && doc.body.firstElementChild === h1s[0]) {
    title = h1s[0].textContent?.trim() || title;
  }
  ctx.progress(0.5, 'Splitting chapters');
  const sources = chaptersFromBody(doc.body, title);
  fixInternalLinks(sources);
  const epub = await assembleEpub({ title, author: meta.author ?? '', language: meta.lang || meta.language || 'en' }, draftsFromSources(sources), images);
  return { epub, warnings: [] };
}
