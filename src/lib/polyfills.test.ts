// @vitest-environment node
import { describe, expect, it } from 'vitest';

describe('ReadableStream async iteration polyfill', () => {
  it('adds for-await support where the browser lacks it', async () => {
    const proto = ReadableStream.prototype as unknown as Record<symbol, unknown>;
    const original = proto[Symbol.asyncIterator];
    delete proto[Symbol.asyncIterator]; // behave like Safari
    delete (proto as Record<string, unknown>).values;
    await import('./polyfills');
    try {
      const stream = new ReadableStream<number>({
        start(c) {
          c.enqueue(1);
          c.enqueue(2);
          c.enqueue(3);
          c.close();
        },
      });
      const seen: number[] = [];
      for await (const n of stream as unknown as AsyncIterable<number>) seen.push(n);
      expect(seen).toEqual([1, 2, 3]);
    } finally {
      proto[Symbol.asyncIterator] = original;
    }
  });
});
