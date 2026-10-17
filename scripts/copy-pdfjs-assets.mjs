// Copies the pdf.js data files (CMaps, standard fonts, wasm decoders, ICC profiles) into
// public/pdfjs so the PDF converter works offline and without a CDN.
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const from = join(root, 'node_modules', 'pdfjs-dist');
const to = join(root, 'public', 'pdfjs');

await rm(to, { recursive: true, force: true });
await mkdir(to, { recursive: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  await cp(join(from, dir), join(to, dir), { recursive: true });
}
console.log('pdf.js assets copied to public/pdfjs');
