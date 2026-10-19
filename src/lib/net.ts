/** Reads a response body, reporting progress when the total size is known. */
export async function readWithProgress(res: Response, knownSize: number | undefined, onProgress?: (fraction: number) => void): Promise<Blob> {
  const total = Number(res.headers.get('content-length')) || knownSize || 0;
  if (!res.body || !onProgress || !total) return res.blob();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(Math.min(1, received / total));
  }
  return new Blob(chunks as BlobPart[]);
}
