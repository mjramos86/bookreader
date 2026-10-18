import { describe, expect, it } from 'vitest';
import { DriveError, downloadFile, isBookName, listBooks, parseFolderId, type DriveFile } from './drive';
import { planSync } from './driveSync';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fake Drive: folders keyed by id, each with files. Honours pageSize by splitting into pages of 2. */
function fakeDrive(tree: Record<string, { name: string; mimeType: string; id: string; size?: string; md5Checksum?: string }[]>, rootName = 'Books') {
  const calls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.pathname + url.search);
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const m = /\/files\/([^/]+)$/.exec(url.pathname);
    if (m) return json(m[1] === 'missing' ? { error: { message: 'File not found' } } : { name: rootName, mimeType: m[1] === 'afile' ? 'text/plain' : 'application/vnd.google-apps.folder' }, m[1] === 'missing' ? 404 : 200);
    const parent = /'([^']+)' in parents/.exec(url.searchParams.get('q') ?? '')![1];
    const all = (tree[parent] ?? []).map((f) => ({ modifiedTime: '2026-01-01T00:00:00Z', ...f }));
    const start = Number(url.searchParams.get('pageToken') ?? 0);
    const page = all.slice(start, start + 2);
    return json({ files: page, nextPageToken: start + 2 < all.length ? String(start + 2) : undefined });
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe('parseFolderId', () => {
  it('reads ids from links and bare ids', () => {
    expect(parseFolderId('https://drive.google.com/drive/folders/1AbC_dEf-GhIjKlMnOp?usp=sharing')).toBe('1AbC_dEf-GhIjKlMnOp');
    expect(parseFolderId('https://drive.google.com/drive/u/0/folders/1AbC_dEf-GhIjKlMnOp')).toBe('1AbC_dEf-GhIjKlMnOp');
    expect(parseFolderId('https://drive.google.com/open?id=1AbC_dEf-GhIjKlMnOp')).toBe('1AbC_dEf-GhIjKlMnOp');
    expect(parseFolderId('  1AbC_dEf-GhIjKlMnOp  ')).toBe('1AbC_dEf-GhIjKlMnOp');
    expect(parseFolderId('not a folder')).toBeNull();
    expect(parseFolderId('')).toBeNull();
  });
  it('knows which names are books', () => {
    expect(['a.epub', 'B.PDF', 'c.fb2', 'd.md'].every(isBookName)).toBe(true);
    expect(['a.jpg', 'b.mobi', 'noext'].some(isBookName)).toBe(false);
  });
});

describe('listBooks', () => {
  const tree = {
    root: [
      { id: 'f1', name: 'one.epub', mimeType: 'application/epub+zip', size: '1000' },
      { id: 'f2', name: 'cover.jpg', mimeType: 'image/jpeg' },
      { id: 'sub', name: 'Fiction', mimeType: 'application/vnd.google-apps.folder' },
      { id: 'f3', name: 'two.pdf', mimeType: 'application/pdf', md5Checksum: 'abc' },
      { id: 'doc', name: 'Notes', mimeType: 'application/vnd.google-apps.document' },
    ],
    sub: [
      { id: 'f4', name: 'three.txt', mimeType: 'text/plain' },
      { id: 'deep', name: 'Old', mimeType: 'application/vnd.google-apps.folder' },
    ],
    deep: [{ id: 'f5', name: 'four.docx', mimeType: 'x' }],
  };

  it('walks subfolders, pages through results, filters by type and names Google Docs', async () => {
    const { fetchFn } = fakeDrive(tree);
    const r = await listBooks('root', 'tok', { fetch: fetchFn });
    expect(r.folderName).toBe('Books');
    expect(r.files.map((f) => f.path + f.name)).toEqual(['Fiction/Old/four.docx', 'Fiction/three.txt', 'Notes.docx', 'one.epub', 'two.pdf']);
    expect(r.ignored).toBe(1);
    expect(r.files.find((f) => f.name === 'one.epub')?.size).toBe(1000);
  });

  it('stops at the depth and size limits', async () => {
    const { fetchFn } = fakeDrive(tree);
    expect((await listBooks('root', 'tok', { fetch: fetchFn, maxDepth: 1 })).files.map((f) => f.name)).not.toContain('four.docx');
    await expect(listBooks('root', 'tok', { fetch: fetchFn, maxFiles: 2 })).rejects.toThrow(/more than 2 books/);
  });

  it('explains common failures', async () => {
    const { fetchFn } = fakeDrive(tree);
    await expect(listBooks('afile', 'tok', { fetch: fetchFn })).rejects.toThrow(/file, not a folder/);
    await expect(listBooks('missing', 'tok', { fetch: fetchFn })).rejects.toThrow(/not found/);
    const api403 = (async () => json({ error: { message: 'Drive API has not been used', errors: [{ reason: 'accessNotConfigured' }] } }, 403)) as typeof fetch;
    await expect(listBooks('root', 'tok', { fetch: api403 })).rejects.toThrow(/not enabled/);
    const expired = (async () => json({}, 401)) as typeof fetch;
    await expect(listBooks('root', 'tok', { fetch: expired })).rejects.toBeInstanceOf(DriveError);
  });
});

describe('downloadFile', () => {
  const file: DriveFile = { id: 'f1', name: 'a.epub', mimeType: 'application/epub+zip', modifiedTime: 't', path: '', size: 6 };

  it('downloads and reports progress', async () => {
    const fetchFn = (async (url: string) => {
      expect(url).toContain('alt=media');
      return new Response(new Uint8Array([1, 2, 3, 4, 5, 6]), { headers: { 'content-length': '6' } });
    }) as unknown as typeof fetch;
    const seen: number[] = [];
    const blob = await downloadFile(file, 'tok', { fetch: fetchFn, onProgress: (f) => seen.push(f) });
    expect(blob.size).toBe(6);
    expect(seen.at(-1)).toBe(1);
  });

  it('exports Google Docs as .docx', async () => {
    let requested = '';
    const fetchFn = (async (url: string) => {
      requested = url;
      return new Response(new Uint8Array([120]));
    }) as unknown as typeof fetch;
    await downloadFile({ ...file, mimeType: 'application/vnd.google-apps.document' }, 'tok', { fetch: fetchFn });
    expect(requested).toMatch(/\/export\?mimeType=application%2Fvnd\.openxmlformats/);
  });

  it('surfaces HTTP errors', async () => {
    const fetchFn = (async () => json({}, 404)) as unknown as typeof fetch;
    await expect(downloadFile(file, 'tok', { fetch: fetchFn })).rejects.toThrow(/not found/);
  });
});

describe('planSync', () => {
  const f = (id: string, extra: Partial<DriveFile> = {}): DriveFile => ({ id, name: `${id}.epub`, mimeType: 'x', modifiedTime: 't1', path: '', ...extra });

  it('only fetches new or changed files', () => {
    const files = [f('a'), f('b'), f('c', { md5Checksum: 'new' }), f('d', { modifiedTime: 't2' })];
    const records = [
      { fileId: 'a', bookId: '1', modifiedTime: 't1' },
      { fileId: 'c', bookId: '2', modifiedTime: 't1', md5Checksum: 'old' },
      { fileId: 'd', bookId: '3', modifiedTime: 't1' },
    ];
    const { fresh, known } = planSync(files, records);
    expect(fresh.map((x) => x.id)).toEqual(['b', 'c', 'd']);
    expect(known).toBe(1);
  });

  it('treats a matching checksum as unchanged even if the modified time moved', () => {
    const { fresh } = planSync([f('a', { md5Checksum: 'same', modifiedTime: 't9' })], [{ fileId: 'a', bookId: '1', modifiedTime: 't1', md5Checksum: 'same' }]);
    expect(fresh).toHaveLength(0);
  });
});
