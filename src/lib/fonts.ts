/** Bundled reading fonts. URLs are resolved by Vite so the app works fully offline. */

const literata = import.meta.glob('/node_modules/@fontsource/literata/files/literata-latin*-{400,700}-{normal,italic}.woff2', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;
const atkinson = import.meta.glob(
  '/node_modules/@fontsource/atkinson-hyperlegible/files/atkinson-hyperlegible-latin*-{400,700}-{normal,italic}.woff2',
  { query: '?url', import: 'default', eager: true },
) as Record<string, string>;
const dyslexic = import.meta.glob('/node_modules/@fontsource/opendyslexic/files/opendyslexic-latin-{400,700}-{normal,italic}.woff2', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT =
  'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';

function faces(family: string, files: Record<string, string>): string {
  return Object.entries(files)
    .map(([path, url]) => {
      const m = /-(latin(?:-ext)?)-(400|700)-(normal|italic)\.woff2$/.exec(path);
      if (!m) return '';
      const abs = new URL(url, document.baseURI).href;
      const range = m[1] === 'latin-ext' ? LATIN_EXT : LATIN;
      return `@font-face{font-family:'${family}';font-style:${m[3]};font-weight:${m[2]};font-display:swap;src:url("${abs}") format("woff2");unicode-range:${range};}`;
    })
    .join('\n');
}

let cached: string | null = null;

/** @font-face rules for every bundled family; injected into the app and into each chapter frame. */
export function fontFaceCss(): string {
  cached ??= [faces('Literata', literata), faces('Atkinson Hyperlegible', atkinson), faces('OpenDyslexic', dyslexic)].join('\n');
  return cached;
}

export interface FontOption {
  id: string;
  label: string;
  stack: string;
}

export const FONTS: FontOption[] = [
  { id: 'literata', label: 'Literata', stack: "'Literata', Georgia, 'Times New Roman', serif" },
  { id: 'georgia', label: 'Georgia', stack: "Georgia, 'Times New Roman', Times, serif" },
  { id: 'palatino', label: 'Palatino', stack: "'Palatino Linotype', Palatino, 'Book Antiqua', 'URW Palladio L', serif" },
  { id: 'sans', label: 'Atkinson Sans', stack: "'Atkinson Hyperlegible', system-ui, 'Segoe UI', Roboto, sans-serif" },
  { id: 'dyslexic', label: 'OpenDyslexic', stack: "'OpenDyslexic', 'Comic Sans MS', sans-serif" },
];

export function fontStack(id: string): string {
  return (FONTS.find((f) => f.id === id) ?? FONTS[0]).stack;
}
