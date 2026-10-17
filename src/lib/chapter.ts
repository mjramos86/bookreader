import type { EpubBook } from './epub';
import { fragmentOf, isExternalUrl, resolvePath } from './util';

export interface PreparedChapter {
  /** Sanitised <body>, owned by a detached document. Import it into the page's document. */
  body: HTMLElement;
  /** Author stylesheets, in document order, with resource URLs rewritten. */
  styles: string[];
  lang: string | null;
  htmlClass: string | null;
  bodyClass: string | null;
  bodyId: string | null;
  /** Canonical text of the chapter: `body.textContent`. All offsets refer to it. */
  text: string;
  firstHeading: string;
}

const REMOVE_SELECTOR =
  'script,noscript,iframe,frame,frameset,object,embed,applet,base,meta,template,audio,video,input,button,select,textarea,title';
const STRIP_ATTRS = ['color', 'bgcolor', 'text', 'link', 'vlink', 'alink', 'background', 'face'];
const XLINK = 'http://www.w3.org/1999/xlink';

/** Character offset (into `body.textContent`) of the element with the given id or name. */
export function fragmentOffset(body: HTMLElement, id: string): number | undefined {
  const esc = id.replace(/["\\]/g, '\\$&');
  const el = body.querySelector(`[id="${esc}"], a[name="${esc}"]`);
  if (!el) return undefined;
  const range = body.ownerDocument.createRange();
  range.setStart(body, 0);
  range.setEndBefore(el);
  return range.toString().length;
}

export function parseChapterMarkup(raw: string): Document {
  const xml = new DOMParser().parseFromString(raw, 'application/xhtml+xml');
  if (!xml.getElementsByTagName('parsererror').length && xml.documentElement?.localName === 'html') return xml;
  return new DOMParser().parseFromString(raw, 'text/html');
}

function urlRefs(css: string): string[] {
  const out: string[] = [];
  css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_m, _q, u: string) => {
    out.push(u);
    return '';
  });
  return out;
}

async function inlineCss(
  book: EpubBook,
  css: string,
  cssPath: string,
  withResources: boolean,
  depth = 0,
): Promise<string> {
  // @import: inline the referenced sheet (bounded depth, local files only).
  const imports = [...css.matchAll(/@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?[^;]*;/gi)];
  for (const m of imports) {
    let replacement = '';
    if (depth < 3 && !isExternalUrl(m[2])) {
      const path = resolvePath(cssPath, m[2]);
      const text = await book.readText(path);
      if (text) replacement = await inlineCss(book, text, path, withResources, depth + 1);
    }
    css = css.replace(m[0], replacement);
  }
  if (!withResources) return css;

  const resolved = new Map<string, string>();
  for (const ref of new Set(urlRefs(css))) {
    if (!ref || ref.startsWith('data:')) continue;
    if (isExternalUrl(ref) || ref.startsWith('//')) {
      resolved.set(ref, '');
      continue;
    }
    const url = await book.resourceUrl(resolvePath(cssPath, ref));
    resolved.set(ref, url ?? '');
  }
  return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, _q, u: string) => {
    if (!resolved.has(u)) return m;
    const target = resolved.get(u);
    return target ? `url("${target}")` : 'url("")';
  });
}

/**
 * Reads a chapter, strips anything that could run code or reach the network, and rewrites
 * resource references to blob URLs. With `withResources: false` it is cheap enough to run
 * over the whole book for indexing.
 */
export async function prepareChapter(book: EpubBook, spine: number, withResources: boolean): Promise<PreparedChapter> {
  const item = book.spine[spine];
  const raw = (await book.readText(item.path)) ?? '';
  const doc = parseChapterMarkup(raw);
  const root = doc.documentElement;
  const body = (doc.body ?? root) as HTMLElement;

  // Collect stylesheets before removing their elements.
  const styles: string[] = [];
  if (withResources) {
    for (const el of Array.from(doc.querySelectorAll('link, style'))) {
      if (el.localName === 'style') {
        styles.push(await inlineCss(book, el.textContent ?? '', item.path, true));
      } else if (/stylesheet/i.test(el.getAttribute('rel') ?? '')) {
        const href = el.getAttribute('href');
        if (href && !isExternalUrl(href)) {
          const path = resolvePath(item.path, href);
          const text = await book.readText(path);
          if (text) styles.push(await inlineCss(book, text, path, true));
        }
      }
    }
  }
  doc.querySelectorAll('style, link').forEach((el) => el.remove());
  body.querySelectorAll(REMOVE_SELECTOR).forEach((el) => el.remove());

  // Unwrap forms, keeping their content.
  body.querySelectorAll('form').forEach((form) => form.replaceWith(...Array.from(form.childNodes)));

  for (const el of Array.from(body.querySelectorAll('*'))) {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on') || STRIP_ATTRS.includes(name) || name === 'srcset' || name === 'ping') {
        el.removeAttribute(attr.name);
      }
    }
    const tag = el.localName.toLowerCase();
    if (tag === 'a') rewriteLink(el, item.path, spine);
    else if (tag === 'img') await rewriteImage(book, el, item.path, 'src', withResources);
    else if (tag === 'image') {
      const name = el.hasAttribute('href') ? 'href' : 'xlink:href';
      await rewriteImage(book, el, item.path, name, withResources);
    } else if (tag === 'svg') {
      el.removeAttribute('onload');
    }
  }

  const text = body.textContent ?? '';
  const heading = body.querySelector('h1, h2, h3');
  return {
    body,
    styles,
    lang: root.getAttribute('lang') || root.getAttribute('xml:lang') || root.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'lang'),
    htmlClass: root.getAttribute('class'),
    bodyClass: doc.body ? doc.body.getAttribute('class') : null,
    bodyId: doc.body ? doc.body.getAttribute('id') : null,
    text,
    firstHeading: (heading?.textContent ?? '').replace(/\s+/g, ' ').trim(),
  };
}

function rewriteLink(el: Element, chapterPath: string, spine: number): void {
  const href = el.getAttribute('href');
  el.removeAttribute('target');
  if (href == null) return;
  const trimmed = href.trim();
  if (/^\s*(javascript|vbscript|data):/i.test(trimmed)) {
    el.removeAttribute('href');
    return;
  }
  if (isExternalUrl(trimmed)) {
    if (/^(https?|mailto|tel):/i.test(trimmed)) el.setAttribute('data-ext', trimmed);
  } else if (trimmed.startsWith('#')) {
    el.setAttribute('data-path', chapterPath);
    el.setAttribute('data-spine', String(spine));
    const frag = fragmentOf(trimmed);
    if (frag) el.setAttribute('data-frag', frag);
  } else {
    el.setAttribute('data-path', resolvePath(chapterPath, trimmed));
    const frag = fragmentOf(trimmed);
    if (frag) el.setAttribute('data-frag', frag);
  }
  el.setAttribute('href', '#');
}

async function rewriteImage(
  book: EpubBook,
  el: Element,
  chapterPath: string,
  attr: string,
  withResources: boolean,
): Promise<void> {
  const src = el.getAttribute(attr) ?? el.getAttributeNS(XLINK, 'href');
  if (!src) return;
  if (src.startsWith('data:image/')) return;
  if (!withResources) return;
  if (isExternalUrl(src) || src.startsWith('//') || /^(javascript|data):/i.test(src)) {
    el.removeAttribute(attr);
    return;
  }
  const url = await book.resourceUrl(resolvePath(chapterPath, src));
  if (url) el.setAttribute(attr, url);
  else el.removeAttribute(attr);
}

// ---------------------------------------------------------------------------
// Style filtering: keep the publisher's structure and emphasis, drop what fights the reader's
// theme, font, spacing and pagination settings.
// ---------------------------------------------------------------------------

export interface FilterOptions {
  /** Keep the publisher's font-family declarations. */
  publisherFonts: boolean;
}

const ALWAYS_REMOVE = [
  'color',
  'background',
  'background-color',
  'line-height',
  'caret-color',
  'column-count',
  'column-width',
  'columns',
  'column-gap',
  'column-fill',
  'page-break-before',
  'page-break-after',
  'break-before',
  'break-after',
  'widows',
  'orphans',
  'hyphens',
  '-webkit-hyphens',
  'word-break',
  'overflow-wrap',
  'min-height',
  'zoom',
];

const ROOT_REMOVE = [
  'margin',
  'margin-left',
  'margin-right',
  'margin-top',
  'margin-bottom',
  'padding',
  'padding-left',
  'padding-right',
  'padding-top',
  'padding-bottom',
  'width',
  'max-width',
  'min-width',
  'height',
  'max-height',
  'overflow',
  'overflow-x',
  'overflow-y',
  'position',
  'display',
  'float',
  'text-indent',
  'border',
  'text-align',
];

const ABSOLUTE_UNITS = /(\d)(px|pt|pc|cm|mm|in|vh|vw|vmin|vmax)\b/i;

export function filterDeclarations(style: CSSStyleDeclaration, isRoot: boolean, opts: FilterOptions): void {
  // Out-of-flow positioning would let content escape the page, so drop it along with its offsets.
  if (/fixed|absolute|sticky/i.test(style.getPropertyValue('position'))) {
    style.removeProperty('position');
    for (const p of ['top', 'left', 'right', 'bottom']) style.removeProperty(p);
  }
  for (const prop of ALWAYS_REMOVE) style.removeProperty(prop);
  if (isRoot) for (const prop of ROOT_REMOVE) style.removeProperty(prop);

  const fontSize = style.getPropertyValue('font-size');
  if (fontSize && ABSOLUTE_UNITS.test(fontSize)) style.removeProperty('font-size');
  const font = style.getPropertyValue('font');
  // The `font` shorthand carries a family and size, so it is dropped unless it is fully relative.
  if (font && (ABSOLUTE_UNITS.test(font) || !opts.publisherFonts)) style.removeProperty('font');

  if (!opts.publisherFonts) {
    const family = style.getPropertyValue('font-family');
    // Keep monospace, so code stays code.
    if (family && !/mono|courier|consolas|menlo/i.test(family)) style.removeProperty('font-family');
  }

  const align = style.getPropertyValue('text-align');
  if (align && /^(justify|left|start)$/i.test(align.trim())) style.removeProperty('text-align');

  for (const p of ['height', 'width', 'max-height']) {
    const v = style.getPropertyValue(p);
    if (v && /v[hw]\b|vmin|vmax/i.test(v)) style.removeProperty(p);
  }
  if (style.getPropertyValue('text-indent') && ABSOLUTE_UNITS.test(style.getPropertyValue('text-indent'))) {
    style.removeProperty('text-indent');
  }
}

function isRootSelector(selector: string): boolean {
  return selector.split(',').some((s) => /^\s*(html|body|:root)\s*$/i.test(s));
}

export function filterRules(rules: CSSRuleList, sheetOwner: CSSStyleSheet | CSSGroupingRule, opts: FilterOptions): void {
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i];
    const type = rule.constructor.name;
    if (type === 'CSSImportRule' || type === 'CSSPageRule' || type === 'CSSNamespaceRule') {
      sheetOwner.deleteRule(i);
      continue;
    }
    if (type === 'CSSStyleRule') {
      const r = rule as CSSStyleRule;
      filterDeclarations(r.style, isRootSelector(r.selectorText), opts);
      if (r.cssRules?.length) filterRules(r.cssRules, r, opts);
    } else if ('cssRules' in rule && type !== 'CSSFontFaceRule' && type !== 'CSSKeyframesRule') {
      filterRules((rule as CSSGroupingRule).cssRules, rule as CSSGroupingRule, opts);
    }
  }
}

export function filterStyleSheet(sheet: CSSStyleSheet, opts: FilterOptions): void {
  try {
    filterRules(sheet.cssRules, sheet, opts);
  } catch {
    /* unreadable sheet: leave as is */
  }
}
