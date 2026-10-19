import { beforeEach, describe, expect, it } from 'vitest';
import {
  completeLoginIfReturning,
  disconnect,
  downloadFile,
  getAccessToken,
  listBooks,
  loadDropbox,
  normalizeFolder,
  pkceChallenge,
  RETURN_FLAG,
  saveDropbox,
} from './dropbox';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  history.replaceState(null, '', '/');
});

describe('PKCE and paths', () => {
  it('matches the RFC 7636 test vector', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('normalises folder paths', () => {
    expect(normalizeFolder('')).toBe('');
    expect(normalizeFolder('  ')).toBe('');
    expect(normalizeFolder('Books')).toBe('/Books');
    expect(normalizeFolder('/Books/Fiction/')).toBe('/Books/Fiction');
    expect(normalizeFolder('\\Books')).toBe('/Books');
  });
});

describe('completeLoginIfReturning', () => {
  const pending = (over: Record<string, string> = {}) =>
    sessionStorage.setItem('bookreader.dropbox.pending', JSON.stringify({ verifier: 'v'.repeat(43), state: 'S1', appKey: 'appkey123', folder: '/Books', redirect: 'http://localhost:3000/', ...over }));

  it('ignores ordinary page loads and foreign ?code= links', async () => {
    expect(await completeLoginIfReturning()).toBeNull();
    history.replaceState(null, '', '/?code=zzz&state=other');
    expect(await completeLoginIfReturning()).toBeNull();
    expect(location.search).toContain('code=zzz');
  });

  it('exchanges the code, stores a refresh token and cleans the URL', async () => {
    pending();
    history.replaceState(null, '', '/?code=abc&state=S1');
    let body: URLSearchParams | undefined;
    const fetchFn = (async (_url: string, init: RequestInit) => {
      body = init.body as URLSearchParams;
      return json({ access_token: 'AT', refresh_token: 'RT', expires_in: 14400 });
    }) as unknown as typeof fetch;
    const result = await completeLoginIfReturning(fetchFn);
    expect(result).toEqual({ ok: true });
    expect(Object.fromEntries(body!)).toMatchObject({ grant_type: 'authorization_code', code: 'abc', client_id: 'appkey123', code_verifier: 'v'.repeat(43) });
    expect(body!.has('client_secret')).toBe(false);
    expect(loadDropbox()).toMatchObject({ appKey: 'appkey123', refreshToken: 'RT', accessToken: 'AT', folder: '/Books' });
    expect(location.search).toBe('');
    expect(JSON.parse(sessionStorage.getItem(RETURN_FLAG)!)).toEqual({ ok: true });
  });

  it('rejects a mismatched state and a denied request', async () => {
    pending();
    history.replaceState(null, '', '/?code=abc&state=WRONG');
    expect((await completeLoginIfReturning())?.ok).toBe(false);
    expect(loadDropbox()).toBeNull();

    pending();
    history.replaceState(null, '', '/?error=access_denied&state=S1');
    expect(await completeLoginIfReturning()).toEqual({ ok: false, error: 'Access was not granted.' });
  });

  it('reports a failed exchange', async () => {
    pending();
    history.replaceState(null, '', '/?code=abc&state=S1');
    const fetchFn = (async () => json({ error: 'invalid_grant', error_description: 'code has expired' }, 400)) as unknown as typeof fetch;
    expect(await completeLoginIfReturning(fetchFn)).toEqual({ ok: false, error: 'code has expired' });
  });
});

describe('getAccessToken', () => {
  it('reuses a valid token and refreshes an expired one without a secret', async () => {
    saveDropbox({ appKey: 'k', refreshToken: 'RT', accessToken: 'old', expires: Date.now() + 3_600_000, folder: '' });
    expect(await getAccessToken((() => Promise.reject(new Error('no network'))) as unknown as typeof fetch)).toBe('old');

    saveDropbox({ appKey: 'k', refreshToken: 'RT', accessToken: 'old', expires: Date.now() - 1000, folder: '' });
    let body: URLSearchParams | undefined;
    const fetchFn = (async (_u: string, init: RequestInit) => {
      body = init.body as URLSearchParams;
      return json({ access_token: 'fresh', expires_in: 14400 });
    }) as unknown as typeof fetch;
    expect(await getAccessToken(fetchFn)).toBe('fresh');
    expect(Object.fromEntries(body!)).toEqual({ grant_type: 'refresh_token', refresh_token: 'RT', client_id: 'k' });
    expect(loadDropbox()?.accessToken).toBe('fresh');
  });

  it('forgets the connection when the refresh token is no longer valid', async () => {
    saveDropbox({ appKey: 'k', refreshToken: 'RT', expires: 0, folder: '' });
    const fetchFn = (async () => json({ error: 'invalid_grant' }, 400)) as unknown as typeof fetch;
    await expect(getAccessToken(fetchFn)).rejects.toThrow(/expired/);
    expect(loadDropbox()).toBeNull();
  });

  it('disconnect clears the connection and revokes best-effort', async () => {
    saveDropbox({ appKey: 'k', refreshToken: 'RT', accessToken: 'AT', expires: Date.now() + 1e6, folder: '' });
    const calls: string[] = [];
    await disconnect((async (u: string) => { calls.push(u); return json({}); }) as unknown as typeof fetch);
    expect(loadDropbox()).toBeNull();
    expect(calls[0]).toContain('/auth/token/revoke');
    saveDropbox({ appKey: 'k', refreshToken: 'RT', accessToken: 'AT', expires: 1, folder: '' });
    await disconnect((async () => { throw new Error('offline'); }) as unknown as typeof fetch);
    expect(loadDropbox()).toBeNull();
  });
});

describe('listBooks', () => {
  const file = (id: string, name: string, dir: string) => ({ '.tag': 'file' as const, id: `id:${id}`, name, path_display: `${dir}/${name}`, size: 100, server_modified: '2026-01-01T00:00:00Z', content_hash: `h-${id}` });

  function fakeDropbox() {
    const calls: { url: string; body: any }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ url, body });
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer TOKEN');
      if (body.path === '/missing') return json({ error_summary: 'path/not_found/..' }, 409);
      if (url.endsWith('/list_folder')) {
        return json({
          entries: [file('1', 'one.epub', '/Books'), { '.tag': 'folder', name: 'Fiction', path_display: '/Books/Fiction' }, file('2', 'cover.jpg', '/Books')],
          cursor: 'C1',
          has_more: true,
        });
      }
      return json({ entries: [file('3', 'Two.PDF', '/Books/Fiction'), { '.tag': 'deleted', name: 'gone.epub' }], cursor: 'C2', has_more: false });
    }) as unknown as typeof fetch;
    return { fetchFn, calls };
  }

  it('pages through results, recurses, filters, and gives relative paths', async () => {
    const { fetchFn, calls } = fakeDropbox();
    const r = await listBooks('Books', { fetch: fetchFn, token: async () => 'TOKEN' });
    expect(calls[0].body).toMatchObject({ path: '/Books', recursive: true });
    expect(calls[1].url).toContain('/list_folder/continue');
    expect(calls[1].body).toEqual({ cursor: 'C1' });
    expect(r.folderName).toBe('Books');
    expect(r.ignored).toBe(1);
    expect(r.items.map((i) => i.path + i.name)).toEqual(['Fiction/Two.PDF', 'one.epub']);
    expect(r.items[1]).toMatchObject({ key: 'dropbox:id:1', hash: 'h-1', size: 100 });
  });

  it('an empty folder means the whole app folder', async () => {
    const { fetchFn, calls } = fakeDropbox();
    const r = await listBooks('', { fetch: fetchFn, token: async () => 'TOKEN' });
    expect(calls[0].body.path).toBe('');
    expect(r.folderName).toBe('Dropbox');
    expect(r.items.map((i) => i.path)).toEqual(['Books/Fiction/', 'Books/']);
  });

  it('explains common failures', async () => {
    const { fetchFn } = fakeDropbox();
    await expect(listBooks('/missing', { fetch: fetchFn, token: async () => 'TOKEN' })).rejects.toThrow(/not found/);
    const scope = (async () => json({ error_summary: 'missing_scope/.' }, 401 + 8)) as unknown as typeof fetch;
    await expect(listBooks('', { fetch: scope, token: async () => 'T' })).rejects.toThrow(/permissions/);
    const expired = (async () => json({}, 401)) as unknown as typeof fetch;
    await expect(listBooks('', { fetch: expired, token: async () => 'T' })).rejects.toThrow(/expired/);
    await expect(listBooks('', { fetch: fakeDropbox().fetchFn, token: async () => 'TOKEN', maxFiles: 1 })).rejects.toThrow(/more than 1 books/);
  });

  it('downloads by file id through the content endpoint', async () => {
    let seen: { url: string; arg: string } | undefined;
    const fetchFn = (async (url: string, init: RequestInit) => {
      seen = { url, arg: (init.headers as Record<string, string>)['Dropbox-API-Arg'] };
      return new Response(new Uint8Array([1, 2, 3, 4]), { headers: { 'content-length': '4' } });
    }) as unknown as typeof fetch;
    const progress: number[] = [];
    const blob = await downloadFile('id:abc', 4, { fetch: fetchFn, token: async () => 'T', onProgress: (f) => progress.push(f) });
    expect(blob.size).toBe(4);
    expect(seen).toEqual({ url: 'https://content.dropboxapi.com/2/files/download', arg: '{"path":"id:abc"}' });
    expect(progress.at(-1)).toBe(1);
  });
});
