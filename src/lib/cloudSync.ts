import { listSyncRecords, saveSyncRecord, type SyncRecord } from './db';
import { importFile } from './importer';
import type { BookRecord } from './types';

/** A book in a cloud folder, independent of which service it lives in. */
export interface CloudItem {
  /** Stable id including the service, e.g. `dropbox:id:abc`. */
  key: string;
  name: string;
  /** Folder path inside the chosen folder, for display. */
  path: string;
  size?: number;
  modifiedTime: string;
  /** Content hash from the service, when it provides one; preferred over the modified time. */
  hash?: string;
  download(opts: { signal?: AbortSignal; onProgress?: (fraction: number) => void }): Promise<Blob>;
}

/** Splits items into those not yet imported (or changed since) and those already in the library. */
export function planSync(items: CloudItem[], records: SyncRecord[]): { fresh: CloudItem[]; known: number } {
  const byKey = new Map(records.map((r) => [r.key, r]));
  const fresh: CloudItem[] = [];
  for (const item of items) {
    const r = byKey.get(item.key);
    const unchanged = r && (item.hash ? r.hash === item.hash : r.modifiedTime === item.modifiedTime);
    if (!unchanged) fresh.push(item);
  }
  return { fresh, known: items.length - fresh.length };
}

export async function currentPlan(items: CloudItem[]) {
  return planSync(items, await listSyncRecords());
}

export type ItemStatus = 'waiting' | 'downloading' | 'converting' | 'done' | 'duplicate' | 'error';

export interface SyncProgress {
  index: number;
  status: ItemStatus;
  /** 0..1 within the current step. */
  fraction: number;
  message?: string;
}

export interface SyncSummary {
  added: number;
  duplicates: number;
  failed: number;
}

/** Downloads and imports items one at a time (so memory stays bounded), recording each success. */
export async function importFromCloud(
  items: CloudItem[],
  hooks: { onProgress: (p: SyncProgress) => void; onBook?: (book: BookRecord) => void; signal?: AbortSignal },
): Promise<SyncSummary> {
  const summary: SyncSummary = { added: 0, duplicates: 0, failed: 0 };
  for (let i = 0; i < items.length; i++) {
    if (hooks.signal?.aborted) break;
    const item = items[i];
    try {
      hooks.onProgress({ index: i, status: 'downloading', fraction: 0 });
      const blob = await item.download({
        signal: hooks.signal,
        onProgress: (fraction) => hooks.onProgress({ index: i, status: 'downloading', fraction }),
      });
      const result = await importFile(new File([blob], item.name, { lastModified: Date.parse(item.modifiedTime) || Date.now() }), {
        fileName: item.name,
        signal: hooks.signal,
        progress: (fraction, message) => hooks.onProgress({ index: i, status: 'converting', fraction, message }),
      });
      await saveSyncRecord({ key: item.key, bookId: result.book.id, modifiedTime: item.modifiedTime, hash: item.hash });
      if (result.duplicate) summary.duplicates++;
      else summary.added++;
      hooks.onBook?.(result.book);
      hooks.onProgress({ index: i, status: result.duplicate ? 'duplicate' : 'done', fraction: 1, message: result.warnings[0] });
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') break;
      summary.failed++;
      hooks.onProgress({ index: i, status: 'error', fraction: 1, message: err instanceof Error ? err.message : String(err) });
    }
  }
  return summary;
}
