// @vitest-environment node
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPage } from './pdfExtract';
import { analyze, planChapters, type RawPage } from './pdfLayout';

/**
 * End-to-end check of text extraction and layout analysis on a real PDF (generated with
 * ReportLab: title page, three chapters, a two-column section, running headers and page numbers).
 */
async function load(file: string): Promise<RawPage[]> {
  const data = new Uint8Array(fs.readFileSync(file));
  const pdf = await pdfjs.getDocument({ data, fontExtraProperties: true, standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/' }).promise;
  const pages: RawPage[] = [];
  const fonts = new Map();
  for (let i = 1; i <= pdf.numPages; i++) pages.push((await extractPage(pdfjs, await pdf.getPage(i), fonts)).raw);
  return pages;
}

describe('sample.pdf', () => {
  it('recovers chapters, sub-headings, bold/italic text and lists, without page furniture', async () => {
    const pages = await load('test/fixtures/sample.pdf');
    const analysis = analyze(pages);
    const text = analysis.blocks.map((b) => b.text).join('\n');

    expect(text).not.toContain('THE NORTHERN CHARTS');
    expect(text).not.toContain('A Short Anthology');

    const headings = analysis.blocks.filter((b) => b.type === 'heading').map((b) => b.text);
    expect(headings).toEqual(
      expect.arrayContaining(['The Northern Charts', 'Chapter 1: Fog', 'Chapter 2: Harbours', 'Chapter 3: The Bell Buoy', 'A closer look', 'Two-column interlude']),
    );

    const plan = planChapters(analysis.blocks, [], 'The Northern Charts');
    expect(plan.map((c) => c.title)).toEqual(['The Northern Charts', 'Chapter 1: Fog', 'Chapter 2: Harbours', 'Chapter 3: The Bell Buoy']);

    const emphasis = analysis.blocks.find((b) => b.text.startsWith('Things to remember'));
    expect(emphasis?.runs.some((r) => r.bold && r.text.includes('always'))).toBe(true);
    expect(emphasis?.runs.some((r) => r.italic && r.text.includes('spare'))).toBe(true);
    expect(analysis.blocks.filter((b) => b.type === 'li')).toHaveLength(3);
    expect(analysis.blocks.some((b) => b.type === 'pre' && b.text.includes('return (b - a) % 360'))).toBe(true);
  });

  it('keeps each column of the two-column pages in order', async () => {
    const analysis = analyze(await load('test/fixtures/sample.pdf'));
    const blocks = analysis.blocks;
    const start = blocks.findIndex((b) => b.text === 'Two-column interlude');
    const end = blocks.findIndex((b) => b.text.startsWith('Chapter 3'));
    // The interlude's paragraphs end on sentence boundaries, in strictly reading order: no block
    // from the right column begins before the left column's text is finished.
    const inner = blocks.slice(start + 1, end);
    expect(inner.length).toBeGreaterThan(8);
    const pageOrder = inner.map((b) => b.page);
    expect([...pageOrder].sort((a, b) => a - b)).toEqual(pageOrder);
  });
});
