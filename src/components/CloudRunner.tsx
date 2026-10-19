import { useEffect, useRef, useState } from 'react';
import { importFromCloud, type CloudItem, type ItemStatus } from '../lib/cloudSync';
import type { BookRecord } from '../lib/types';
import { Icon } from './Icon';

interface Props {
  folderName: string;
  /** Items that are new or changed. */
  items: CloudItem[];
  /** Items already in the library. */
  known: number;
  /** Files in the folder that are not books. */
  ignored: number;
  /** Called just before importing, to refresh credentials; may return rebuilt items. */
  prepare?: (items: CloudItem[]) => Promise<CloudItem[]>;
  onBook: (book: BookRecord) => void;
  onClose: () => void;
  onDisconnect: () => void;
  onChangeFolder: () => void;
}

interface Row {
  item: CloudItem;
  status: ItemStatus;
  fraction: number;
  message?: string;
}

const STATUS_LABEL: Record<ItemStatus, string> = {
  waiting: 'Waiting',
  downloading: 'Downloading',
  converting: 'Converting',
  done: 'Added',
  duplicate: 'Already in library',
  error: 'Failed',
};

function formatSize(n?: number): string {
  if (!n) return '';
  return n > 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Lists what is new in a cloud folder, imports it with progress, and reports the result. */
export function CloudRunner({ folderName, items, known, ignored, prepare, onBook, onClose, onDisconnect, onChangeFolder }: Props) {
  const [phase, setPhase] = useState<'ready' | 'importing' | 'finished'>('ready');
  const [rows, setRows] = useState<Row[]>(() => items.map((item) => ({ item, status: 'waiting', fraction: 0 })));
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const start = async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('importing');
    let list = rows.map((r) => r.item);
    try {
      if (prepare) list = await prepare(list);
    } catch (err) {
      setRows((rs) => rs.map((r) => ({ ...r, status: 'error', fraction: 1, message: err instanceof Error ? err.message : 'Could not reconnect.' })));
      setPhase('finished');
      return;
    }
    await importFromCloud(list, {
      signal: controller.signal,
      onBook,
      onProgress: (p) => setRows((rs) => rs.map((r, i) => (i === p.index ? { ...r, status: p.status, fraction: p.fraction, message: p.message ?? r.message } : r))),
    });
    setPhase('finished');
  };

  const done = rows.filter((r) => r.status === 'done' || r.status === 'duplicate').length;
  const failed = rows.filter((r) => r.status === 'error').length;

  if (phase === 'ready') {
    return (
      <>
        <p>
          <strong>{folderName}</strong>
          <br />
          <span className="muted">
            {rows.length + known} book{rows.length + known === 1 ? '' : 's'} found
            {known ? ` · ${known} already in your library` : ''}
            {ignored ? ` · ${ignored} other file${ignored === 1 ? '' : 's'} ignored` : ''}
          </span>
        </p>
        {rows.length === 0 ? (
          <p className="ok"><Icon name="check" size={16} /> Your library is up to date with this folder.</p>
        ) : (
          <ul className="drive-list" aria-label="New books">
            {rows.map((r) => (
              <li key={r.item.key}>
                <span className="drive-name" title={r.item.path + r.item.name}>{r.item.path}{r.item.name}</span>
                <span className="muted">{formatSize(r.item.size)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={onDisconnect}>Disconnect</button>
          <button className="btn" onClick={onChangeFolder}>Change folder</button>
          {rows.length > 0 ? (
            <button className="btn primary" onClick={() => void start()}>Import {rows.length} book{rows.length === 1 ? '' : 's'}</button>
          ) : (
            <button className="btn primary" onClick={onClose}>Done</button>
          )}
        </div>
      </>
    );
  }

  return (
    <>
      <p>
        <strong>{phase === 'importing' ? 'Importing…' : 'Finished'}</strong>{' '}
        <span className="muted">
          {done} of {rows.length}
          {failed ? ` · ${failed} failed` : ''}
        </span>
      </p>
      <ul className="drive-list" aria-live="polite">
        {rows.map((r) => (
          <li key={r.item.key} className={`row ${r.status}`}>
            <span className="drive-name" title={r.item.name}>{r.item.name}</span>
            <span className={r.status === 'error' ? 'err' : 'muted'}>
              {r.status === 'error' ? r.message : r.message && r.status === 'done' ? r.message : STATUS_LABEL[r.status]}
              {(r.status === 'downloading' || r.status === 'converting') && r.fraction > 0 ? ` ${Math.round(r.fraction * 100)}%` : ''}
            </span>
          </li>
        ))}
      </ul>
      <div className="modal-actions">
        {phase === 'importing' ? (
          <button className="btn" onClick={() => abortRef.current?.abort()}>Stop</button>
        ) : (
          <button className="btn primary" onClick={onClose}>Done</button>
        )}
      </div>
    </>
  );
}
