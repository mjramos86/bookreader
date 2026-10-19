/**
 * Dropbox client for building a library from a folder.
 *
 * Sign-in is OAuth 2 with PKCE (no secret) by full-page redirect; a refresh token is kept so the
 * reader stays connected. Files are listed and downloaded through the Dropbox HTTP API directly from
 * the browser; nothing is sent to any server of ours. Access is read-only.
 */
import type { CloudItem } from './cloudSync';
import { isBookName } from './drive';
import { readWithProgress } from './net';

const AUTH_URL = 'https://www.dropbox.com/oauth2/authorize';
const TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
const RPC = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';

export class DropboxError extends Error {}

type FetchFn = typeof fetch;

// ---------------------------------------------------------------------------------------------
// Saved connection
// ---------------------------------------------------------------------------------------------

export interface DropboxConnection {
  appKey: string;
  refreshToken: string;
  accessToken?: string;
  /** Epoch ms when `accessToken` expires. */
  expires?: number;
  /** Folder to scan; empty means the whole app folder (or whole Dropbox for a full-access app). */
  folder: string;
}

const KEY = 'bookreader.dropbox.v1';
const PENDING = 'bookreader.dropbox.pending';
export const RETURN_FLAG = 'bookreader.dropbox.return';

/**
 * The Dropbox app key this site uses. An app key identifies the app (it is not a secret and ships to
 * every browser); the build can override it with VITE_DROPBOX_APP_KEY, e.g. for a fork with its own app.
 */
export const BUILT_IN_APP_KEY: string = (import.meta.env.VITE_DROPBOX_APP_KEY as string | undefined) || 'oq3d1hz4zd1ajzj';

export function loadDropbox(): DropboxConnection | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as DropboxConnection) : null;
  } catch {
    return null;
  }
}

export function saveDropbox(c: DropboxConnection | null): void {
  try {
    if (c) localStorage.setItem(KEY, JSON.stringify(c));
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------------------------------------
// OAuth with PKCE
// ---------------------------------------------------------------------------------------------

/** Where Dropbox sends the reader back to; must be listed in the app's redirect URIs. */
export function redirectUri(): string {
  return location.origin + location.pathname.replace(/index\.html$/, '');
}

export function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomToken(bytes = 48): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
}

/** Normalises a folder path: leading slash, no trailing slash; empty stays empty. */
export function normalizeFolder(input: string): string {
  const t = input.trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!t) return '';
  return t.startsWith('/') ? t : `/${t}`;
}

/** Leaves the page for Dropbox's consent screen. */
export async function beginLogin(appKey: string, folder: string): Promise<void> {
  const verifier = randomToken();
  const state = randomToken(16);
  sessionStorage.setItem(PENDING, JSON.stringify({ verifier, state, appKey, folder, redirect: redirectUri() }));
  const params = new URLSearchParams({
    client_id: appKey,
    response_type: 'code',
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
    token_access_type: 'offline',
    redirect_uri: redirectUri(),
    state,
  });
  location.assign(`${AUTH_URL}?${params}`);
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

async function tokenRequest(body: Record<string, string>, fetchFn: FetchFn): Promise<TokenResponse> {
  const res = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  let json: TokenResponse = {};
  try {
    json = (await res.json()) as TokenResponse;
  } catch {
    /* not JSON */
  }
  if (!res.ok || !json.access_token) {
    throw new DropboxError(json.error_description || json.error || `Dropbox sign-in failed (${res.status}).`);
  }
  return json;
}

/**
 * Call once at start-up. If the URL is Dropbox's redirect back to us, finishes the sign-in, stores the
 * connection, cleans the URL and records the outcome for the UI. Returns null when not returning.
 */
export async function completeLoginIfReturning(fetchFn: FetchFn = fetch.bind(globalThis)): Promise<{ ok: boolean; error?: string } | null> {
  const params = new URLSearchParams(location.search);
  const code = params.get('code');
  const state = params.get('state');
  const denied = params.get('error');
  if (!(code && state) && !denied) return null;
  const raw = sessionStorage.getItem(PENDING);
  // Not a Dropbox return that we started (some other ?code= link): leave it alone.
  if (!raw) return null;
  sessionStorage.removeItem(PENDING);
  history.replaceState(null, '', location.pathname + location.hash);

  const pending = JSON.parse(raw) as { verifier: string; state: string; appKey: string; folder: string; redirect: string };
  const finish = (result: { ok: boolean; error?: string }) => {
    try {
      sessionStorage.setItem(RETURN_FLAG, JSON.stringify(result));
    } catch {
      /* ignore */
    }
    return result;
  };
  if (denied) return finish({ ok: false, error: denied === 'access_denied' ? 'Access was not granted.' : params.get('error_description') || denied });
  if (state !== pending.state) return finish({ ok: false, error: 'Sign-in could not be verified. Please try again.' });
  try {
    const t = await tokenRequest(
      { grant_type: 'authorization_code', code: code!, client_id: pending.appKey, code_verifier: pending.verifier, redirect_uri: pending.redirect },
      fetchFn,
    );
    if (!t.refresh_token) throw new DropboxError('Dropbox did not provide a lasting sign-in. Check the app settings and try again.');
    saveDropbox({
      appKey: pending.appKey,
      refreshToken: t.refresh_token,
      accessToken: t.access_token,
      expires: Date.now() + (t.expires_in ?? 14400) * 1000,
      folder: pending.folder,
    });
    return finish({ ok: true });
  } catch (err) {
    return finish({ ok: false, error: err instanceof Error ? err.message : 'Sign-in failed.' });
  }
}

/** A valid access token, refreshing it when it is about to expire. */
export async function getAccessToken(fetchFn: FetchFn = fetch.bind(globalThis)): Promise<string> {
  const c = loadDropbox();
  if (!c) throw new DropboxError('Not connected to Dropbox.');
  if (c.accessToken && c.expires && c.expires > Date.now() + 60_000) return c.accessToken;
  try {
    const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: c.refreshToken, client_id: c.appKey }, fetchFn);
    saveDropbox({ ...c, accessToken: t.access_token, expires: Date.now() + (t.expires_in ?? 14400) * 1000 });
    return t.access_token!;
  } catch (err) {
    if (err instanceof DropboxError && /invalid_grant|expired|revoked/i.test(err.message)) {
      saveDropbox(null);
      throw new DropboxError('Your Dropbox sign-in has expired. Please connect again.');
    }
    throw err;
  }
}

/** Forgets the connection and, best effort, revokes the token at Dropbox. */
export async function disconnect(fetchFn: FetchFn = fetch.bind(globalThis)): Promise<void> {
  const c = loadDropbox();
  saveDropbox(null);
  if (c?.accessToken) {
    try {
      await fetchFn(`${RPC}/auth/token/revoke`, { method: 'POST', headers: { Authorization: `Bearer ${c.accessToken}` } });
    } catch {
      /* the local connection is already gone */
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Listing and downloading
// ---------------------------------------------------------------------------------------------

async function failure(res: Response): Promise<DropboxError> {
  let summary = '';
  try {
    const body = (await res.json()) as { error_summary?: string; error?: { '.tag'?: string; retry_after?: number } };
    summary = body.error_summary ?? '';
  } catch {
    /* not JSON */
  }
  if (res.status === 401) return new DropboxError('Dropbox sign-in expired. Please connect again.');
  if (res.status === 429) return new DropboxError('Dropbox is rate-limiting requests. Wait a minute and try again.');
  if (/missing_scope/.test(summary)) {
    return new DropboxError(
      'The Dropbox app is missing permissions. In the app console, Permissions tab, tick files.metadata.read and files.content.read, press Submit, then disconnect and connect again.',
    );
  }
  if (/not_found/.test(summary)) return new DropboxError('That folder was not found in your Dropbox.');
  if (/not_folder/.test(summary)) return new DropboxError('That path is a file, not a folder.');
  return new DropboxError(`Dropbox error ${res.status}${summary ? `: ${summary}` : ''}`);
}

interface Entry {
  '.tag': 'file' | 'folder' | 'deleted';
  id?: string;
  name: string;
  path_display?: string;
  size?: number;
  server_modified?: string;
  content_hash?: string;
}

export interface ListResult {
  folderName: string;
  items: CloudItem[];
  ignored: number;
}

/** Lists supported books in a folder and its subfolders. */
export async function listBooks(
  folder: string,
  opts: { fetch?: FetchFn; signal?: AbortSignal; maxFiles?: number; token?: () => Promise<string> } = {},
): Promise<ListResult> {
  const fetchFn = opts.fetch ?? fetch.bind(globalThis);
  const token = opts.token ?? (() => getAccessToken(fetchFn));
  const maxFiles = opts.maxFiles ?? 3000;
  const base = normalizeFolder(folder);

  const call = async (endpoint: string, body: unknown): Promise<{ entries: Entry[]; cursor: string; has_more: boolean }> => {
    const res = await fetchFn(`${RPC}${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) throw await failure(res);
    return res.json();
  };

  const items: CloudItem[] = [];
  let ignored = 0;
  let page = await call('/files/list_folder', { path: base, recursive: true, include_deleted: false, limit: 2000 });
  for (;;) {
    for (const e of page.entries) {
      if (e['.tag'] !== 'file' || !e.id) continue;
      if (!isBookName(e.name)) {
        ignored++;
        continue;
      }
      if (items.length >= maxFiles) throw new DropboxError(`This folder has more than ${maxFiles} books. Choose a smaller folder.`);
      const full = e.path_display ?? `/${e.name}`;
      const rel = full.toLowerCase().startsWith(base.toLowerCase()) ? full.slice(base.length) : full;
      const dir = rel.slice(0, rel.lastIndexOf('/') + 1).replace(/^\//, '');
      const id = e.id;
      items.push({
        key: `dropbox:${id}`,
        name: e.name,
        path: dir,
        size: e.size,
        modifiedTime: e.server_modified ?? '',
        hash: e.content_hash,
        download: (o) => downloadFile(id, e.size, { fetch: fetchFn, token, ...o }),
      });
    }
    if (!page.has_more) break;
    page = await call('/files/list_folder/continue', { cursor: page.cursor });
  }
  items.sort((a, b) => (a.path + a.name).localeCompare(b.path + b.name));
  const name = base ? base.slice(base.lastIndexOf('/') + 1) : 'Dropbox';
  return { folderName: name, items, ignored };
}

export async function downloadFile(
  id: string,
  size: number | undefined,
  opts: { fetch?: FetchFn; signal?: AbortSignal; token?: () => Promise<string>; onProgress?: (fraction: number) => void } = {},
): Promise<Blob> {
  const fetchFn = opts.fetch ?? fetch.bind(globalThis);
  const token = opts.token ?? (() => getAccessToken(fetchFn));
  // The id is ASCII, so the argument header is safe (file names would need escaping).
  const res = await fetchFn(`${CONTENT}/files/download`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await token()}`, 'Dropbox-API-Arg': JSON.stringify({ path: id }) },
    signal: opts.signal,
  });
  if (!res.ok) throw await failure(res);
  return readWithProgress(res, size, opts.onProgress);
}
