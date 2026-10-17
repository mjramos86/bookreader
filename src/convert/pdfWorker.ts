// Runs inside the pdf.js web worker: install the polyfills, then load pdf.js's own worker code.
import '../lib/polyfills';
import 'pdfjs-dist/legacy/build/pdf.worker.min.mjs';
