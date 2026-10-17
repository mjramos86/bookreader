/**
 * Safari (including every browser on iOS) cannot iterate a ReadableStream with `for await`,
 * which pdf.js does when reading page text and when inflating compressed data. Add it.
 */
const proto = typeof ReadableStream !== 'undefined' ? (ReadableStream.prototype as unknown as Record<symbol, unknown>) : null;

if (proto && !(Symbol.asyncIterator in proto)) {
  async function* iterate(this: ReadableStream<unknown>): AsyncGenerator<unknown> {
    const reader = this.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  }
  proto[Symbol.asyncIterator] = iterate;
  if (!('values' in proto)) (proto as Record<string, unknown>).values = iterate;
}

export {};
