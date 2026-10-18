import { listDriveRecords, saveDriveRecord, type DriveRecord } from './db';
import { downloadFile, type DriveFile } from './drive';
import { importFile } from './importer';
import type { BookRecord } from './types';

/** Splits Drive files into those not yet imported (or changed since) and those already in the library. */
export function planSync(files: DriveFile[], records: DriveRecord[]): { fresh: DriveFile[]; known: number } {
  const byId = new Map(records.map((r) => [r.fileId, r]));
  const fresh: DriveFile[] = [];
  for (const f of files) {
    const r = byId.get(f.id);
    const unchanged = r && (f.md5Checksum ? r.md5Checksum === f.md5Checksum : r.modifiedTime === f.modifiedTime);
    if (!unchanged) fresh.push(f);
  }
  return { fresh, known: files.length - fresh.length };
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

/** Downloads and imports files one at a time (so memory stays bounded), recording each success. */
export async function importFromDrive(
  files: DriveFile[],
  token: string,
  hooks: {
    onProgress: (p: SyncProgress) => void;
    onBook?: (book: BookRecord) => void;
    signal?: AbortSignal;
    fetch?: typeof fetch;
  },
): Promise<SyncSummary> {
  const summary: SyncSummary = { added: 0, duplicates: 0, failed: 0 };
  for (let i = 0; i < files.length; i++) {
    if (hooks.signal?.aborted) break;
    const f = files[i];
    try {
      hooks.onProgress({ index: i, status: 'downloading', fraction: 0 });
      const blob = await downloadFile(f, token, {
        fetch: hooks.fetch,
        signal: hooks.signal,
        onProgress: (fraction) => hooks.onProgress({ index: i, status: 'downloading', fraction }),
      });
      const result = await importFile(new File([blob], f.name, { lastModified: Date.parse(f.modifiedTime) || Date.now() }), {
        fileName: f.name,
        signal: hooks.signal,
        progress: (fraction, message) => hooks.onProgress({ index: i, status: 'converting', fraction, message }),
      });
      await saveDriveRecord({ fileId: f.id, bookId: result.book.id, modifiedTime: f.modifiedTime, md5Checksum: f.md5Checksum });
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

export async function currentPlan(files: DriveFile[]) {
  return planSync(files, await listDriveRecords());
}
