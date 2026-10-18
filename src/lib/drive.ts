/**
 * Minimal Google Drive client for building a library from a folder.
 *
 * Sign-in uses Google Identity Services (a token that lives in memory for about an hour) with
 * read-only access; files are listed and downloaded through the Drive REST API. Nothing is sent to
 * any server of ours: the app talks to Google directly from the browser.
 */
import { extOf } from './util';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const API = 'https://www.googleapis.com/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const GOOGLE_DOC = 'application/vnd.google-apps.document';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const BOOK_EXTENSIONS = new Set(['epub', 'pdf', 'docx', 'txt', 'md', 'markdown', 'html', 'htm', 'xhtml', 'fb2', 'cbz']);

export class DriveError extends Error {}

export interface DriveFile {
  id: string;
  /** Name to import under; Google Docs get a .docx extension. */
  name: string;
  mimeType: string;
  size?: number;
  modifiedTime: string;
  md5Checksum?: string;
  /** Folder path inside the chosen folder, for display. */
  path: string;
}

type FetchFn = typeof fetch;

/** Accepts a Drive folder link or a bare folder id. */
export function parseFolderId(input: string): string | null {
  const text = input.trim();
  const folders = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(text);
  if (folders) return folders[1];
  const query = /[?&]id=([A-Za-z0-9_-]{10,})/.exec(text);
  if (query) return query[1];
  return /^[A-Za-z0-9_-]{10,}$/.test(text) ? text : null;
}

export function isBookName(name: string): boolean {
  return BOOK_EXTENSIONS.has(extOf(name));
}

async function api<T>(url: string, token: string, fetchFn: FetchFn, signal?: AbortSignal): Promise<T> {
  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` }, signal });
  if (res.ok) return (await res.json()) as T;
  throw await toError(res);
}

async function toError(res: Response): Promise<DriveError> {
  let reason = '';
  let message = '';
  try {
    const body = (await res.json()) as { error?: { message?: string; errors?: { reason?: string }[] } };
    message = body.error?.message ?? '';
    reason = body.error?.errors?.[0]?.reason ?? '';
  } catch {
    /* not JSON */
  }
  if (res.status === 401) return new DriveError('Google sign-in expired. Please connect again.');
  if (res.status === 404) return new DriveError('That folder was not found, or your Google account cannot open it.');
  if (res.status === 403 && /accessNotConfigured|SERVICE_DISABLED/i.test(reason + message)) {
    return new DriveError('The Google Drive API is not enabled for your Google Cloud project. Enable it, wait a minute, and try again.');
  }
  if (res.status === 403 && /rateLimit|quota/i.test(reason + message)) {
    return new DriveError('Google is rate-limiting requests. Wait a minute and try again.');
  }
  return new DriveError(`Google Drive error ${res.status}${message ? `: ${message}` : ''}`);
}

export interface ListResult {
  folderName: string;
  files: DriveFile[];
  /** Files in the folder that are not a supported book format. */
  ignored: number;
}

/** Lists supported books in a folder and its subfolders. */
export async function listBooks(
  folderId: string,
  token: string,
  opts: { fetch?: FetchFn; signal?: AbortSignal; maxFiles?: number; maxDepth?: number } = {},
): Promise<ListResult> {
  const fetchFn = opts.fetch ?? fetch.bind(globalThis);
  const maxFiles = opts.maxFiles ?? 3000;
  const maxDepth = opts.maxDepth ?? 6;

  const root = await api<{ name: string; mimeType: string }>(
    `${API}/files/${encodeURIComponent(folderId)}?fields=name,mimeType&supportsAllDrives=true`,
    token,
    fetchFn,
    opts.signal,
  );
  if (root.mimeType !== FOLDER) throw new DriveError('That link points to a file, not a folder.');

  const files: DriveFile[] = [];
  let ignored = 0;
  const queue: { id: string; path: string; depth: number }[] = [{ id: folderId, path: '', depth: 0 }];
  const seen = new Set([folderId]);

  while (queue.length) {
    const dir = queue.shift()!;
    let pageToken: string | undefined;
    do {
      const params = new URLSearchParams({
        q: `'${dir.id}' in parents and trashed = false`,
        fields: 'nextPageToken,files(id,name,mimeType,size,modifiedTime,md5Checksum)',
        pageSize: '1000',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      });
      if (pageToken) params.set('pageToken', pageToken);
      const page = await api<{ nextPageToken?: string; files: Omit<DriveFile, 'path'>[] & { size?: string }[] }>(
        `${API}/files?${params}`,
        token,
        fetchFn,
        opts.signal,
      );
      for (const f of page.files as unknown as (Omit<DriveFile, 'path' | 'size'> & { size?: string })[]) {
        if (f.mimeType === FOLDER) {
          if (dir.depth < maxDepth && !seen.has(f.id)) {
            seen.add(f.id);
            queue.push({ id: f.id, path: `${dir.path}${f.name}/`, depth: dir.depth + 1 });
          }
          continue;
        }
        const isDoc = f.mimeType === GOOGLE_DOC;
        if (!isDoc && !isBookName(f.name)) {
          ignored++;
          continue;
        }
        if (files.length >= maxFiles) throw new DriveError(`This folder has more than ${maxFiles} books. Choose a smaller folder.`);
        files.push({
          id: f.id,
          name: isDoc ? `${f.name}.docx` : f.name,
          mimeType: f.mimeType,
          size: f.size ? Number(f.size) : undefined,
          modifiedTime: f.modifiedTime,
          md5Checksum: f.md5Checksum,
          path: dir.path,
        });
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
  }
  files.sort((a, b) => (a.path + a.name).localeCompare(b.path + b.name));
  return { folderName: root.name, files, ignored };
}

/** Downloads a file (Google Docs are exported as .docx), reporting progress as it streams. */
export async function downloadFile(
  file: DriveFile,
  token: string,
  opts: { fetch?: FetchFn; signal?: AbortSignal; onProgress?: (fraction: number) => void } = {},
): Promise<Blob> {
  const fetchFn = opts.fetch ?? fetch.bind(globalThis);
  const url =
    file.mimeType === GOOGLE_DOC
      ? `${API}/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(DOCX)}`
      : `${API}/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`;
  const res = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` }, signal: opts.signal });
  if (!res.ok) throw await toError(res);
  const total = Number(res.headers.get('content-length')) || file.size || 0;
  if (!res.body || !opts.onProgress || !total) return res.blob();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    opts.onProgress(Math.min(1, received / total));
  }
  return new Blob(chunks as BlobPart[]);
}

// ---------------------------------------------------------------------------------------------
// Sign-in (Google Identity Services)
// ---------------------------------------------------------------------------------------------

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}
interface TokenClient {
  requestAccessToken(overrides?: { prompt?: string }): void;
}
interface GoogleGlobal {
  accounts: {
    oauth2: {
      initTokenClient(config: {
        client_id: string;
        scope: string;
        callback: (r: TokenResponse) => void;
        error_callback?: (e: { type?: string; message?: string }) => void;
      }): TokenClient;
    };
  };
}

let gisPromise: Promise<GoogleGlobal> | null = null;

function loadedGis(): GoogleGlobal | null {
  const g = (window as unknown as { google?: GoogleGlobal }).google;
  return g?.accounts?.oauth2 ? g : null;
}

/** Start loading Google's sign-in script early, so the popup can open straight from a tap (Safari insists). */
export function preloadGoogleSignIn(): void {
  void loadGis().catch(() => undefined);
}

function loadGis(): Promise<GoogleGlobal> {
  const existing = loadedGis();
  if (existing) return Promise.resolve(existing);
  gisPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.onload = () => {
      const g = (window as unknown as { google?: GoogleGlobal }).google;
      if (g?.accounts?.oauth2) resolve(g);
      else reject(new DriveError('Google sign-in did not load.'));
    };
    script.onerror = () => {
      gisPromise = null;
      reject(new DriveError('Could not reach Google. Check your connection (or a content blocker) and try again.'));
    };
    document.head.appendChild(script);
  });
  return gisPromise;
}

let cached: { clientId: string; token: string; expires: number } | null = null;

/** Opens Google's consent popup if needed and resolves with an access token. Call from a click. */
export async function getAccessToken(clientId: string, force = false): Promise<string> {
  if (!force && cached && cached.clientId === clientId && cached.expires > Date.now() + 60_000) return cached.token;
  // When the script is already loaded nothing is awaited here, so the popup opens inside the tap handler.
  const google = loadedGis() ?? (await loadGis());
  return new Promise<string>((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: DRIVE_SCOPE,
      callback: (r) => {
        if (r.error || !r.access_token) {
          reject(new DriveError(r.error === 'access_denied' ? 'Access was not granted.' : r.error_description || r.error || 'Sign-in failed.'));
          return;
        }
        cached = { clientId, token: r.access_token, expires: Date.now() + (r.expires_in ?? 3600) * 1000 };
        resolve(r.access_token);
      },
      error_callback: (e) =>
        reject(new DriveError(e.type === 'popup_closed' ? 'Sign-in was cancelled.' : e.type === 'popup_failed_to_open' ? 'The sign-in window was blocked. Allow pop-ups for this site and try again.' : e.message || 'Sign-in failed.')),
    });
    client.requestAccessToken({ prompt: cached ? '' : 'select_account' });
  });
}

export function forgetToken(): void {
  cached = null;
}

// ---------------------------------------------------------------------------------------------
// Saved connection (client id and folder; never the token)
// ---------------------------------------------------------------------------------------------

export interface DriveConfig {
  clientId: string;
  folderId: string;
  folderName: string;
}

const KEY = 'bookreader.drive.v1';

/** Client id baked in at build time (a public value), used when the user has not entered one. */
export const BUILT_IN_CLIENT_ID: string = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? '';

export function loadDriveConfig(): DriveConfig | null {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as DriveConfig) : null;
  } catch {
    return null;
  }
}

export function saveDriveConfig(config: DriveConfig | null): void {
  try {
    if (config) localStorage.setItem(KEY, JSON.stringify(config));
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
