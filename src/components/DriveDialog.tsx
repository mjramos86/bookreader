import { useEffect, useMemo, useState } from 'react';
import {
  BUILT_IN_CLIENT_ID,
  DriveError,
  forgetToken,
  getAccessToken,
  preloadGoogleSignIn,
  driveItems,
  listBooks,
  loadDriveConfig,
  parseFolderId,
  saveDriveConfig,
  type DriveFile,
} from '../lib/drive';
import { currentPlan, type CloudItem } from '../lib/cloudSync';
import type { BookRecord } from '../lib/types';
import { CloudRunner } from './CloudRunner';
import { Icon } from './Icon';

interface Props {
  onClose: () => void;
  onImported: (book: BookRecord) => void;
}

type Phase = 'setup' | 'scanning' | 'ready';

export function DriveDialog({ onClose, onImported }: Props) {
  const saved = useMemo(loadDriveConfig, []);
  const [clientId, setClientId] = useState(BUILT_IN_CLIENT_ID || saved?.clientId || '');
  const [folderInput, setFolderInput] = useState(saved?.folderId ?? '');
  const [phase, setPhase] = useState<Phase>('setup');
  const [error, setError] = useState('');
  const [folderName, setFolderName] = useState(saved?.folderName ?? '');
  const [files, setFiles] = useState<DriveFile[]>([]);
  const [fresh, setFresh] = useState<CloudItem[]>([]);
  const [known, setKnown] = useState(0);
  const [ignored, setIgnored] = useState(0);
  const [showGuide, setShowGuide] = useState(!BUILT_IN_CLIENT_ID && !saved?.clientId);

  useEffect(() => preloadGoogleSignIn(), []);

  const folderId = parseFolderId(folderInput);
  const canConnect = clientId.trim().length > 10 && !!folderId;

  const scan = async () => {
    if (!folderId) return;
    setError('');
    setPhase('scanning');
    try {
      const token = await getAccessToken(clientId.trim());
      const result = await listBooks(folderId, token);
      saveDriveConfig({ clientId: clientId.trim(), folderId, folderName: result.folderName });
      setFolderName(result.folderName);
      setIgnored(result.ignored);
      const plan = await currentPlan(driveItems(result.files, token));
      setFiles(result.files);
      setKnown(plan.known);
      setFresh(plan.fresh);
      setPhase('ready');
    } catch (err) {
      forgetToken();
      setError(err instanceof DriveError || err instanceof Error ? err.message : 'Something went wrong.');
      setPhase('setup');
    }
  };

  /** A token from the scan may have expired while the list was on screen: get a fresh one, rebuild the items. */
  const prepare = async (items: CloudItem[]) => {
    const token = await getAccessToken(clientId.trim());
    const keep = new Set(items.map((i) => i.key));
    return driveItems(files, token).filter((i) => keep.has(i.key));
  };

  const disconnect = () => {
    saveDriveConfig(null);
    forgetToken();
    setFolderInput('');
    setFolderName('');
    setFresh([]);
    setPhase('setup');
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal drive" role="dialog" aria-label="Google Drive" onClick={(e) => e.stopPropagation()}>
        <div className="drive-head">
          <h2>Google Drive</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
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
          <CloudRunner
            folderName={folderName}
            items={fresh}
            known={known}
            ignored={ignored}
            prepare={prepare}
            onBook={onImported}
            onClose={onClose}
            onDisconnect={disconnect}
            onChangeFolder={() => setPhase('setup')}
          />
        )}
      </div>
    </div>
  );
}
