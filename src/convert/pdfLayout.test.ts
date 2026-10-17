import { describe, expect, it } from 'vitest';
import { analyze, joinRuns, planChapters, type RawItem, type RawPage } from './pdfLayout';

const W = 612;
const H = 792;

interface LineSpec {
  y: number;
  x?: number;
  text: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  mono?: boolean;
  width?: number;
}

/** A line of text as one positioned item; width is estimated at half an em per character. */
function line(spec: LineSpec): RawItem {
  const size = spec.size ?? 11;
  return {
    str: spec.text,
    x: spec.x ?? 72,
    y: spec.y,
    width: spec.width ?? spec.text.length * size * 0.48,
    size,
    bold: !!spec.bold,
    italic: !!spec.italic,
    mono: !!spec.mono,
  };
}

function page(index: number, items: RawItem[], extra: Partial<RawPage> = {}): RawPage {
  return { index, width: W, height: H, items, figures: [], ...extra };
}

/** Justified-looking body lines filling the text width. */
function bodyLines(startY: number, texts: string[], x = 72, pitch = 14): RawItem[] {
  return texts.map((t, i) => line({ y: startY + i * pitch, x, text: t, width: 468 - (x - 72) }));
}

const para = (n: number, seed: string) => Array.from({ length: n }, (_, i) => `${seed} line ${i + 1} of text that runs the full width`);

describe('analyze: paragraphs', () => {
  it('joins wrapped lines and splits paragraphs on blank space', () => {
    const p = page(0, [
      ...bodyLines(100, para(4, 'First')),
      ...bodyLines(100 + 4 * 14 + 12, para(3, 'Second')),
    ]);
    const { blocks } = analyze([p]);
    expect(blocks.map((b) => b.type)).toEqual(['para', 'para']);
    expect(blocks[0].text).toContain('First line 1');
    expect(blocks[0].text).toContain('First line 4');
  });

  it('starts a paragraph at a first-line indent after a sentence end', () => {
    const lines = [
      line({ y: 100, text: 'The first paragraph fills the width of the column here.', width: 468 }),
      line({ y: 114, text: 'It ends with a short last line.', width: 150 }),
      line({ y: 128, x: 90, text: 'The second paragraph is indented on its first line only.', width: 450 }),
      line({ y: 142, text: 'and continues flush left across the full width of text', width: 468 }),
      ...bodyLines(156, para(6, 'Filler')),
    ];
    const { blocks } = analyze([page(0, lines)]);
    expect(blocks[0].text).toBe('The first paragraph fills the width of the column here. It ends with a short last line.');
    expect(blocks[1].text.startsWith('The second paragraph is indented')).toBe(true);
  });

  it('removes line-end hyphens before lowercase continuations', () => {
    const lines = [
      line({ y: 100, text: 'This sentence is broken in the middle of a recon-', width: 468 }),
      line({ y: 114, text: 'struction of the word and continues here.', width: 300 }),
      ...bodyLines(140, para(5, 'Filler')),
    ];
    const { blocks } = analyze([page(0, lines)]);
    expect(blocks[0].text).toContain('reconstruction of the word');
  });

  it('keeps a hyphen when the next line starts a capital', () => {
    expect(joinRuns([{ text: 'Cross-' }], [{ text: 'Examination begins' }]).map((r) => r.text).join('')).toBe('Cross- Examination begins');
  });

  it('merges a paragraph that runs across a page break', () => {
    const p1 = page(0, bodyLines(600, ['A sentence that does not finish before the page ends and so', 'it goes on without a full stop at the bottom of page one']));
    const p2 = page(1, [
      line({ y: 100, text: 'continues at the top of the next page and ends here.', width: 300 }),
      ...bodyLines(130, para(6, 'Filler')),
    ]);
    const { blocks } = analyze([p1, p2]);
    expect(blocks[0].text).toMatch(/does not finish.*continues at the top of the next page/);
  });
});

describe('analyze: page furniture', () => {
  it('drops running headers and page numbers', () => {
    const pages = Array.from({ length: 6 }, (_, i) =>
      page(i, [
        line({ y: 36, text: 'THE BOOK TITLE', size: 8 }),
        line({ y: 36, x: 470, text: `Chapter ${i + 1}`, size: 8 }),
        ...bodyLines(100, para(8, `Page${i}`)),
        line({ y: 750, x: 300, text: String(i + 1), size: 8 }),
      ]),
    );
    const { blocks } = analyze(pages);
    const all = blocks.map((b) => b.text).join('\n');
    expect(all).not.toMatch(/THE BOOK TITLE/);
    expect(all).not.toMatch(/Chapter \d/);
    expect(blocks.every((b) => !/^\d$/.test(b.text))).toBe(true);
  });

  it('still removes a header that is split between two columns', () => {
    const colLines = (x: number, seed: string) => para(14, seed).map((t, i) => line({ y: 100 + i * 14, x, text: t, width: 220 }));
    const pages = Array.from({ length: 5 }, (_, i) =>
      page(i, [line({ y: 36, text: 'LEFT HEAD', size: 8 }), line({ y: 36, x: 470, text: 'RIGHT HEAD', size: 8 }), ...colLines(72, 'L'), ...colLines(320, 'R')]),
    );
    const { blocks } = analyze(pages);
    expect(blocks.map((b) => b.text).join(' ')).not.toMatch(/HEAD/);
  });
});

describe('analyze: columns', () => {
  it('reads the left column before the right', () => {
    const left = Array.from({ length: 16 }, (_, i) => line({ y: 100 + i * 14, x: 72, text: `Left column sentence number ${i} ends here.`, width: 220 }));
    const right = Array.from({ length: 16 }, (_, i) => line({ y: 100 + i * 14, x: 320, text: `Right column sentence number ${i} ends here.`, width: 220 }));
    const { blocks } = analyze([page(0, [...right, ...left])]);
    const text = blocks.map((b) => b.text).join(' ');
    expect(text.indexOf('Left column sentence number 15')).toBeLessThan(text.indexOf('Right column sentence number 0'));
  });

  it('keeps a full-width heading above both columns', () => {
    const colLines = (x: number, seed: string) => Array.from({ length: 14 }, (_, i) => line({ y: 130 + i * 14, x, text: `${seed} sentence ${i} ends here.`, width: 220 }));
    const title = line({ y: 90, x: 72, text: 'A Title That Spans Both Columns Fully', size: 20, width: 468, bold: true });
    const { blocks } = analyze([page(0, [title, ...colLines(72, 'Left'), ...colLines(320, 'Right')])]);
    expect(blocks[0].type).toBe('heading');
    expect(blocks[0].text).toContain('A Title');
  });
});

describe('analyze: neighbouring columns', () => {
  it('does not merge lines of one column because a large heading sits beside them', () => {
    // A 22pt heading in the left column falls between two baselines of the right column.
    const right = Array.from({ length: 14 }, (_, i) => line({ y: 200 + i * 16.5, x: 320, text: `Right line ${i} runs on and on`, width: 235 }));
    const left = Array.from({ length: 10 }, (_, i) => line({ y: 300 + i * 16.5, x: 57, text: `Left line ${i} runs on and on`, width: 235 }));
    const heading = line({ y: 258.7, x: 57, text: 'Chapter 1: Beacon Light', size: 22, bold: true, width: 235 });
    const { blocks } = analyze([page(0, [...right, ...left, heading])]);
    const text = blocks.map((b) => b.text).join(' ');
    expect(text).toContain('Right line 3 runs on and on Right line 4');
    expect(blocks.some((b) => b.type === 'heading' && b.text.includes('Beacon'))).toBe(true);
  });

  it('keeps a superscript marker on the line it belongs to', () => {
    const items = [
      line({ y: 100, text: 'A sentence with a marker', width: 150 }),
      { ...line({ y: 96.5, x: 222, text: '1', size: 7 }), width: 4 },
      line({ y: 100, x: 228, text: ' and the rest of it continues across the line.', width: 300 }),
      ...bodyLines(130, para(5, 'Filler')),
    ];
    const { blocks } = analyze([page(0, items)]);
    expect(blocks[0].text).toContain('A sentence with a marker');
    expect(blocks[0].runs.some((r) => r.sup && r.text.includes('1'))).toBe(true);
  });
});

describe('analyze: column detection', () => {
  it('finds columns whose baselines are offset by half a line', () => {
    const left = Array.from({ length: 16 }, (_, i) => line({ y: 100 + i * 16.5, x: 57, text: `Left sentence ${i} fills this narrow column`, width: 235 }));
    const right = Array.from({ length: 16 }, (_, i) => line({ y: 108.25 + i * 16.5, x: 320, text: `Right sentence ${i} fills this narrow column`, width: 235 }));
    const { blocks } = analyze([page(0, [...right, ...left])]);
    const text = blocks.map((b) => b.text).join(' ');
    expect(text.indexOf('Left sentence 15')).toBeLessThan(text.indexOf('Right sentence 0'));
  });

  it('does not treat a short-celled table as two columns of text', () => {
    const row = (y: number, a: string, b: string) => [line({ y, x: 72, text: a, width: 60 }), line({ y, x: 380, text: b, width: 50 })];
    const items = Array.from({ length: 12 }, (_, i) => row(100 + i * 16, `Name ${i}`, `${i * 3}`)).flat();
    const { blocks } = analyze([page(0, items)]);
    const table = blocks.find((b) => b.type === 'table');
    expect(table?.rows).toHaveLength(12);
  });
});

describe('analyze: headings, lists and code', () => {
  it('ranks heading levels by size', () => {
    const items = [
      line({ y: 80, text: 'Chapter One', size: 24, bold: true }),
      ...bodyLines(110, para(5, 'Body')),
      line({ y: 200, text: 'A subsection', size: 15, bold: true }),
      ...bodyLines(225, para(5, 'More')),
    ];
    const items2 = [line({ y: 80, text: 'Chapter Two', size: 24, bold: true }), ...bodyLines(110, para(5, 'Again'))];
    const { blocks } = analyze([page(0, items), page(1, items2)]);
    const headings = blocks.filter((b) => b.type === 'heading');
    expect(headings.map((h) => [h.text, h.level])).toEqual([
      ['Chapter One', 1],
      ['A subsection', 2],
      ['Chapter Two', 1],
    ]);
  });

  it('treats a short bold line at body size as a sub-heading', () => {
    const items = [...bodyLines(100, para(5, 'Body')), line({ y: 190, text: 'Method', bold: true }), ...bodyLines(212, para(5, 'After'))];
    const { blocks } = analyze([page(0, items)]);
    expect(blocks.find((b) => b.text === 'Method')?.type).toBe('heading');
  });

  it('builds list items from bullets and keeps wrapped lines together', () => {
    const items = [
      ...bodyLines(100, para(5, 'Intro')),
      line({ y: 190, x: 90, text: '• First item that wraps onto a second', width: 300 }),
      line({ y: 204, x: 100, text: 'line of its own text', width: 200 }),
      line({ y: 218, x: 90, text: '• Second item', width: 100 }),
      ...bodyLines(250, para(4, 'Outro')),
    ];
    const { blocks } = analyze([page(0, items)]);
    const li = blocks.filter((b) => b.type === 'li');
    expect(li).toHaveLength(2);
    expect(li[0].text).toBe('First item that wraps onto a second line of its own text');
  });

  it('keeps code lines in a preformatted block', () => {
    const items = [
      ...bodyLines(100, para(5, 'Intro')),
      line({ y: 200, x: 72, text: 'function f(a) {', mono: true, size: 9 }),
      line({ y: 211, x: 90, text: 'return a * 2;', mono: true, size: 9 }),
      line({ y: 222, x: 72, text: '}', mono: true, size: 9 }),
    ];
    const { blocks } = analyze([page(0, items)]);
    const pre = blocks.find((b) => b.type === 'pre');
    expect(pre?.text.split('\n')).toHaveLength(3);
    expect(pre?.text.split('\n')[1].startsWith('   ')).toBe(true);
  });
});

describe('analyze: tables and notes', () => {
  it('detects a table from aligned cells', () => {
    const row = (y: number, a: string, b: string, c: string, bold = false) => [
      line({ y, x: 72, text: a, width: 70, bold }),
      line({ y, x: 220, text: b, width: 60, bold }),
      line({ y, x: 360, text: c, width: 60, bold }),
    ];
    const items = [...bodyLines(100, para(4, 'Intro')), ...row(180, 'Port', 'Depth', 'Range', true), ...row(196, 'Alpha', '12', '3.1'), ...row(212, 'Beta', '9', '2.4'), ...bodyLines(250, para(4, 'Outro'))];
    const { blocks } = analyze([page(0, items)]);
    const table = blocks.find((b) => b.type === 'table');
    expect(table?.rows).toHaveLength(3);
    expect(table?.rows?.[0].map((c) => c.map((r) => r.text).join(''))).toEqual(['Port', 'Depth', 'Range']);
    expect(table?.header).toBe(true);
  });

  it('attaches a footnote to the block above it instead of the flow', () => {
    const items = [
      ...bodyLines(100, para(6, 'Body')),
      line({ y: 700, text: '1', size: 7 }),
      line({ y: 702, x: 78, text: 'The footnote text sits at the bottom of the page.', size: 9, width: 300 }),
    ];
    const { blocks } = analyze([page(0, items)]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].notes?.[0].text).toContain('The footnote text');
  });

  it('does not mistake a figure caption for a footnote', () => {
    const items = [...bodyLines(100, para(6, 'Body')), line({ y: 700, text: 'Figure 1. A caption below the figure.', size: 9, italic: true, width: 300 })];
    const { blocks } = analyze([page(0, items)]);
    expect(blocks.some((b) => b.notes?.length)).toBe(false);
  });
});

describe('analyze: figures and scans', () => {
  it('places figures in reading order and drops text inside them', () => {
    const items = [
      ...bodyLines(100, para(4, 'Before')),
      line({ y: 260, x: 120, text: 'label inside the figure', size: 8, width: 100 }),
      ...bodyLines(400, para(4, 'After')),
    ];
    const p = page(0, items, { figures: [{ x0: 72, y0: 180, x1: 400, y1: 340, imageId: 7 }] });
    const { blocks } = analyze([p]);
    expect(blocks.map((b) => b.type)).toEqual(['para', 'figure', 'para']);
    expect(blocks.map((b) => b.text).join(' ')).not.toContain('label inside');
  });

  it('emits a page image for pages kept as rasters', () => {
    const { blocks } = analyze([page(0, [], { rasterImageId: 3 }), page(1, bodyLines(100, para(6, 'Text')))]);
    expect(blocks[0]).toMatchObject({ type: 'pageimage', imageId: 3 });
  });
});

describe('planChapters', () => {
  const manyHeadings = () => {
    const pages: RawPage[] = [];
    for (let i = 0; i < 4; i++) {
      pages.push(page(i, [line({ y: 80, text: `Chapter ${i + 1}`, size: 22, bold: true }), ...bodyLines(110, para(8, `Ch${i}`))]));
    }
    return pages;
  };

  it('splits at the top-level headings', () => {
    const { blocks } = analyze(manyHeadings());
    const plan = planChapters(blocks, [], 'Book');
    expect(plan.map((c) => c.title)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3', 'Chapter 4']);
    expect(plan.every((c) => c.kind === 'heading')).toBe(true);
  });

  it('prefers the PDF outline, using its position on the page', () => {
    const pages = manyHeadings();
    const { blocks } = analyze(pages);
    const plan = planChapters(
      blocks,
      [
        { title: 'Opening', page: 0, y: 70, depth: 0 },
        { title: 'Middle', page: 2, y: 70, depth: 0 },
      ],
      'Book',
    );
    expect(plan.map((c) => [c.title, c.kind])).toEqual([
      ['Opening', 'outline'],
      ['Middle', 'outline'],
    ]);
    expect(blocks[plan[1].start].page).toBe(2);
  });

  it('falls back to evenly sized parts when there is no structure', () => {
    const pages = Array.from({ length: 24 }, (_, i) => page(i, bodyLines(100, Array.from({ length: 40 }, (_, j) => `Plain page ${i} line ${j} with enough words to add up to a large amount of text here`))));
    const { blocks } = analyze(pages);
    const plan = planChapters(blocks, [], 'Plain');
    expect(plan.length).toBeGreaterThan(1);
    expect(plan[0].title).toMatch(/^Part 1 \(pages 1/);
    expect(plan[plan.length - 1].end).toBe(blocks.length);
  });
});
