import { useEffect, useMemo, useState } from 'react';
import type { CloudItem } from '../lib/cloudSync';
import { currentPlan } from '../lib/cloudSync';
import {
  BUILT_IN_APP_KEY,
  beginLogin,
  disconnect as disconnectDropbox,
  listBooks,
  loadDropbox,
  normalizeFolder,
  redirectUri,
  RETURN_FLAG,
  saveDropbox,
} from '../lib/dropbox';
import type { BookRecord } from '../lib/types';
import { CloudRunner } from './CloudRunner';
import { Icon } from './Icon';

interface Props {
  onClose: () => void;
  onImported: (book: BookRecord) => void;
}

type Phase = 'setup' | 'scanning' | 'ready';

/** Outcome of a sign-in redirect that just finished, if any (recorded at start-up). */
function peekReturnResult(): { ok: boolean; error?: string } | null {
  try {
    const raw = sessionStorage.getItem(RETURN_FLAG);
    return raw ? (JSON.parse(raw) as { ok: boolean; error?: string }) : null;
  } catch {
    return null;
  }
}

export function DropboxDialog({ onClose, onImported }: Props) {
  const returned = useMemo(peekReturnResult, []);
  const [connection, setConnection] = useState(loadDropbox);
  const connected = !!connection?.refreshToken;
  const [appKey, setAppKey] = useState(BUILT_IN_APP_KEY || connection?.appKey || '');
  const [folder, setFolder] = useState(connection?.folder ?? '');
  const [phase, setPhase] = useState<Phase>(connected && returned?.ok !== false ? 'scanning' : 'setup');
  const [error, setError] = useState(returned && !returned.ok ? (returned.error ?? 'Sign-in failed.') : '');
  const [folderName, setFolderName] = useState('');
  const [fresh, setFresh] = useState<CloudItem[]>([]);
  const [known, setKnown] = useState(0);
  const [ignored, setIgnored] = useState(0);
  const [showGuide, setShowGuide] = useState(!BUILT_IN_APP_KEY && !connection?.appKey);
  const [copied, setCopied] = useState(false);

  const scan = async () => {
    setError('');
    setPhase('scanning');
    try {
      const path = normalizeFolder(folder);
      const result = await listBooks(path);
      const c = loadDropbox();
      if (c) {
        saveDropbox({ ...c, folder: path });
        setConnection({ ...c, folder: path });
      }
      const plan = await currentPlan(result.items);
      setFolderName(result.folderName);
      setIgnored(result.ignored);
      setKnown(plan.known);
      setFresh(plan.fresh);
      setPhase('ready');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
      setPhase('setup');
    }
  };

  // Right after signing in, list the folder straight away. The outcome is shown once, then forgotten.
  useEffect(() => {
    try {
      sessionStorage.removeItem(RETURN_FLAG);
    } catch {
      /* ignore */
    }
    if (phase === 'scanning' && connected) void scan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const connect = async () => {
    setError('');
    try {
      await beginLogin(appKey.trim(), normalizeFolder(folder));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start sign-in.');
    }
  };

  const disconnect = async () => {
    await disconnectDropbox();
    setConnection(null);
    setFresh([]);
    setPhase('setup');
  };

  const copyRedirect = () => {
    void navigator.clipboard?.writeText(redirectUri()).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal drive" role="dialog" aria-label="Dropbox" onClick={(e) => e.stopPropagation()}>
        <div className="drive-head">
          <h2>Dropbox</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>

        {phase === 'scanning' && <p className="muted">Looking through your Dropbox folder…</p>}

        {phase === 'setup' && (
          <>
            <p className="muted">
              Books in a Dropbox folder (EPUB, PDF, DOCX, TXT, Markdown, HTML, FB2, CBZ; subfolders included) are added to your library on this
              device. Access is read-only and goes straight between your browser and Dropbox. You stay signed in, and syncing later fetches only
              what is new.
            </p>

            {!connected && !BUILT_IN_APP_KEY && (
              <>
                <label className="field">
                  <span>Dropbox app key</span>
                  <input type="text" value={appKey} onChange={(e) => setAppKey(e.target.value)} placeholder="e.g. a1b2c3d4e5f6g7h" autoCapitalize="off" autoCorrect="off" />
                </label>
                <button className="link-btn left" onClick={() => setShowGuide((s) => !s)}>
                  {showGuide ? 'Hide' : 'How do I get an app key?'}
                </button>
                {showGuide && (
                  <ol className="guide">
                    <li>
                      Open the <a href="https://www.dropbox.com/developers/apps/create" target="_blank" rel="noopener noreferrer">Dropbox App Console</a> and
                      choose <em>Create app</em> (free, no card). Pick <em>Scoped access</em>, then <em>App folder</em>, and name it (the name must be unique,
                      for example <code>bookreader-yourname</code>).
                    </li>
                    <li>
                      On the <strong>Permissions</strong> tab tick <code>files.metadata.read</code> and <code>files.content.read</code>, then press{' '}
                      <strong>Submit</strong>.
                    </li>
                    <li>
                      On the <strong>Settings</strong> tab, under <em>Redirect URIs</em>, add exactly this address and press <em>Add</em>:
                      <br />
                      <code>{redirectUri()}</code>{' '}
                      <button className="link-btn" onClick={copyRedirect}>{copied ? 'Copied' : 'Copy'}</button>
                    </li>
                    <li>Copy the <strong>App key</strong> from the top of the Settings tab and paste it above. It is not a secret.</li>
                    <li>
                      Put your books in the <code>Apps/&lt;your app name&gt;</code> folder in Dropbox, then press Connect.
                    </li>
                  </ol>
                )}
              </>
            )}

            <label className="field">
              <span>Folder (optional)</span>
              <input type="text" value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Leave empty for the whole app folder, or e.g. /Fiction" autoCapitalize="off" autoCorrect="off" />
              <small>Only needed for a full-access app, or to read one subfolder.</small>
            </label>

            {error && <p className="err" role="alert">{error}</p>}
            <div className="modal-actions">
              {connected && <button className="btn" onClick={() => void disconnect()}>Disconnect</button>}
              {connected ? (
                <button className="btn primary" onClick={() => void scan()}>Scan folder</button>
              ) : (
                <button className="btn primary" onClick={() => void connect()} disabled={appKey.trim().length < 8 && !BUILT_IN_APP_KEY}>
                  Connect to Dropbox
                </button>
              )}
            </div>
          </>
        )}

        {phase === 'ready' && (
          <CloudRunner
            folderName={folderName}
            items={fresh}
            known={known}
            ignored={ignored}
            onBook={onImported}
            onClose={onClose}
            onDisconnect={() => void disconnect()}
            onChangeFolder={() => setPhase('setup')}
          />
        )}
      </div>
    </div>
  );
}
