import { useEffect, useMemo, useRef, useState } from 'react';
import {
  BUILT_IN_CLIENT_ID,
  DriveError,
  forgetToken,
  getAccessToken,
  preloadGoogleSignIn,
  listBooks,
  loadDriveConfig,
  parseFolderId,
  saveDriveConfig,
  type DriveFile,
} from '../lib/drive';
import { currentPlan, importFromDrive, type ItemStatus } from '../lib/driveSync';
import type { BookRecord } from '../lib/types';
import { Icon } from './Icon';

interface Props {
  onClose: () => void;
  onImported: (book: BookRecord) => void;
}

interface Row {
  file: DriveFile;
  status: ItemStatus;
  fraction: number;
  message?: string;
}

type Phase = 'setup' | 'scanning' | 'ready' | 'importing' | 'finished';

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

export function DriveDialog({ onClose, onImported }: Props) {
  const saved = useMemo(loadDriveConfig, []);
  const [clientId, setClientId] = useState(BUILT_IN_CLIENT_ID || saved?.clientId || '');
  const [folderInput, setFolderInput] = useState(saved?.folderId ?? '');
  const [phase, setPhase] = useState<Phase>('setup');
  const [error, setError] = useState('');
  const [folderName, setFolderName] = useState(saved?.folderName ?? '');
  const [rows, setRows] = useState<Row[]>([]);
  const [known, setKnown] = useState(0);
  const [ignored, setIgnored] = useState(0);
  const [showGuide, setShowGuide] = useState(!BUILT_IN_CLIENT_ID && !saved?.clientId);
  const tokenRef = useRef('');
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    preloadGoogleSignIn();
    return () => abortRef.current?.abort();
  }, []);

  const folderId = parseFolderId(folderInput);
  const canConnect = clientId.trim().length > 10 && !!folderId;

  const scan = async () => {
    if (!folderId) return;
    setError('');
    setPhase('scanning');
    try {
      const token = await getAccessToken(clientId.trim());
      tokenRef.current = token;
      const result = await listBooks(folderId, token);
      saveDriveConfig({ clientId: clientId.trim(), folderId, folderName: result.folderName });
      setFolderName(result.folderName);
      setIgnored(result.ignored);
      const plan = await currentPlan(result.files);
      setKnown(plan.known);
      setRows(plan.fresh.map((file) => ({ file, status: 'waiting', fraction: 0 })));
      setPhase('ready');
    } catch (err) {
      forgetToken();
      setError(err instanceof DriveError || err instanceof Error ? err.message : 'Something went wrong.');
      setPhase('setup');
    }
  };

  const startImport = async () => {
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('importing');
    // A token from the scan may have expired while waiting on this screen.
    let token = tokenRef.current;
    try {
      token = await getAccessToken(clientId.trim());
    } catch {
      /* keep the previous token; the import reports per-file errors if it is stale */
    }
    const files = rows.map((r) => r.file);
    await importFromDrive(files, token, {
      signal: controller.signal,
      onBook: onImported,
      onProgress: (p) =>
        setRows((rs) => rs.map((r, i) => (i === p.index ? { ...r, status: p.status, fraction: p.fraction, message: p.message ?? r.message } : r))),
    });
    setPhase('finished');
  };

  const disconnect = () => {
    saveDriveConfig(null);
    forgetToken();
    setFolderInput('');
    setFolderName('');
    setRows([]);
    setPhase('setup');
  };

  const done = rows.filter((r) => r.status === 'done' || r.status === 'duplicate').length;
  const failed = rows.filter((r) => r.status === 'error').length;

  return (
    <div className="modal-backdrop" onClick={phase === 'importing' ? undefined : onClose}>
      <div className="modal drive" role="dialog" aria-label="Google Drive" onClick={(e) => e.stopPropagation()}>
        <div className="drive-head">
          <h2>Google Drive</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close" disabled={phase === 'importing'}>
            <Icon name="close" />
          </button>
        </div>

        {(phase === 'setup' || phase === 'scanning') && (
          <>
            <p className="muted">
              Pick a Drive folder and its books (EPUB, PDF, DOCX, TXT, Markdown, HTML, FB2, CBZ, and Google Docs) are added to your library on this
              device. Subfolders are included. The app only asks for read-only access and talks to Google directly; nothing goes through a server.
            </p>

            <label className="field">
              <span>Folder link</span>
              <input
                type="url"
                inputMode="url"
                placeholder="https://drive.google.com/drive/folders/…"
                value={folderInput}
                onChange={(e) => setFolderInput(e.target.value)}
                disabled={phase === 'scanning'}
              />
              <small>In Drive, right-click the folder, Share, Copy link. Your Google account must be able to open it.</small>
            </label>

            {!BUILT_IN_CLIENT_ID && (
              <>
                <label className="field">
                  <span>Google client ID</span>
                  <input
                    type="text"
                    placeholder="123456789-abc….apps.googleusercontent.com"
                    value={clientId}
                    onChange={(e) => setClientId(e.target.value)}
                    disabled={phase === 'scanning'}
                    autoCapitalize="off"
                    autoCorrect="off"
                  />
                </label>
                <button className="link-btn left" onClick={() => setShowGuide((s) => !s)}>
                  {showGuide ? 'Hide' : 'How do I get a client ID?'}
                </button>
                {showGuide && (
                  <ol className="guide">
                    <li>
                      Open <a href="https://console.cloud.google.com/projectcreate" target="_blank" rel="noopener noreferrer">Google Cloud Console</a> and
                      create a project (free).
                    </li>
                    <li>
                      <a href="https://console.cloud.google.com/apis/library/drive.googleapis.com" target="_blank" rel="noopener noreferrer">Enable the Google Drive API</a>.
                    </li>
                    <li>
                      Under <strong>APIs &amp; Services → OAuth consent screen</strong>, choose External, fill in an app name and your email, and add your own
                      Google account as a test user.
                    </li>
                    <li>
                      Under <strong>Credentials → Create credentials → OAuth client ID</strong>, choose <em>Web application</em> and add{' '}
                      <code>{location.origin}</code> to <em>Authorized JavaScript origins</em>.
                    </li>
                    <li>Copy the client ID it shows and paste it above. It is not a secret.</li>
                  </ol>
                )}
              </>
            )}

            {error && <p className="err" role="alert">{error}</p>}
            <div className="modal-actions">
              {saved && <button className="btn" onClick={disconnect}>Disconnect</button>}
              <button className="btn primary" onClick={() => void scan()} disabled={!canConnect || phase === 'scanning'}>
                {phase === 'scanning' ? 'Connecting…' : 'Connect and scan'}
              </button>
            </div>
          </>
        )}

        {phase === 'ready' && (
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
                  <li key={r.file.id}>
                    <span className="drive-name" title={r.file.path + r.file.name}>{r.file.path}{r.file.name}</span>
                    <span className="muted">{formatSize(r.file.size)}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="modal-actions">
              <button className="btn" onClick={disconnect}>Disconnect</button>
              <button className="btn" onClick={() => setPhase('setup')}>Change folder</button>
              {rows.length > 0 ? (
                <button className="btn primary" onClick={() => void startImport()}>Import {rows.length} book{rows.length === 1 ? '' : 's'}</button>
              ) : (
                <button className="btn primary" onClick={onClose}>Done</button>
              )}
            </div>
          </>
        )}

        {(phase === 'importing' || phase === 'finished') && (
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
                <li key={r.file.id} className={`row ${r.status}`}>
                  <span className="drive-name" title={r.file.name}>{r.file.name}</span>
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
        )}
      </div>
    </div>
  );
}
