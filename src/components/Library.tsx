import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deleteBook, getBookFile, listBooks, requestPersistence } from '../lib/db';
import { useObjectUrl } from '../lib/hooks';
import { ACCEPT_ATTR } from '../lib/importer';
import type { Settings } from '../lib/settings';
import type { BookRecord } from '../lib/types';
import { useImporter } from '../lib/useImporter';
import { Icon } from './Icon';
import { RETURN_FLAG } from '../lib/dropbox';
import { DriveDialog } from './DriveDialog';
import { DropboxDialog } from './DropboxDialog';
import { ImportQueue } from './ImportQueue';

type Sort = 'recent' | 'added' | 'title' | 'author' | 'progress';

interface Props {
  settings: Settings;
  updateSettings: (p: Partial<Settings>) => void;
  onOpen: (id: string) => void;
}

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

function Cover({ book }: { book: BookRecord }) {
  const url = useObjectUrl(book.cover);
  const hue = hashHue(book.title + book.author);
  if (url) return <img className="cover-img" src={url} alt="" loading="lazy" draggable={false} />;
  return (
    <div
      className="cover-fallback"
      style={{ background: `linear-gradient(155deg, hsl(${hue} 42% 38%), hsl(${(hue + 40) % 360} 46% 24%))` }}
      aria-hidden="true"
    >
      <span className="cover-title">{book.title}</span>
      {book.author && <span className="cover-author">{book.author}</span>}
    </div>
  );
}

function BookCard({ book, onOpen, onDelete, onDownload }: { book: BookRecord; onOpen: () => void; onDelete: () => void; onDownload: () => void }) {
  const [menu, setMenu] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setMenu(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [menu]);

  const pct = Math.round(book.progress * 100);
  return (
    <div className="card" ref={ref}>
      <button className="cover" onClick={onOpen} aria-label={`Open ${book.title}`}>
        <Cover book={book} />
        {book.lastOpenedAt === 0 && <span className="badge new">New</span>}
        {book.converted && <span className="badge conv" title={`Converted from ${book.sourceFormat.toUpperCase()}`}>{book.sourceFormat.toUpperCase()}</span>}
      </button>
      <div className="meta">
        <div className="meta-text">
          <div className="title" title={book.title}>{book.title}</div>
          <div className="author">{book.author || 'Unknown author'}</div>
        </div>
        <button className="icon-btn small" onClick={() => setMenu((m) => !m)} aria-label={`More options for ${book.title}`} aria-expanded={menu}>
          <Icon name="more" size={18} />
        </button>
        {menu && (
          <div className="menu" role="menu">
            <button role="menuitem" onClick={() => { setMenu(false); onDownload(); }}>
              <Icon name="download" size={16} /> Download EPUB
            </button>
            <button role="menuitem" className="danger" onClick={() => { setMenu(false); onDelete(); }}>
              <Icon name="trash" size={16} /> Remove from library
            </button>
          </div>
        )}
      </div>
      <div className="progress" aria-label={`${pct}% read`}>
        <div className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="progress-text">{book.lastOpenedAt === 0 ? 'Not started' : pct >= 99 ? 'Finished' : `${pct}%`}</div>
    </div>
  );
}

export function Library({ settings, updateSettings, onOpen }: Props) {
  const [books, setBooks] = useState<BookRecord[] | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('recent');
  const [dragging, setDragging] = useState(false);
  // After Dropbox's sign-in redirect the page loads fresh: reopen the Dropbox dialog to show the result.
  const [cloud, setCloud] = useState<null | 'choose' | 'dropbox' | 'drive'>(() => {
    try {
      return sessionStorage.getItem(RETURN_FLAG) ? 'dropbox' : null;
    } catch {
      return null;
    }
  });
  const fileInput = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const refresh = useCallback(async () => setBooks(await listBooks()), []);
  const importer = useImporter(() => void refresh());

  useEffect(() => {
    void refresh();
    void requestPersistence();
  }, [refresh]);

  const addFiles = useCallback(
    (list: FileList | File[] | null) => {
      if (!list) return;
      const files = Array.from(list);
      if (files.length) importer.add(files);
    },
    [importer],
  );

  // Drag and drop anywhere on the page.
  useEffect(() => {
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current++;
      setDragging(true);
    };
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragging(false);
    };
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      addFiles(e.dataTransfer?.files ?? null);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, [addFiles]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (books ?? []).filter((b) => !q || `${b.title} ${b.author}`.toLowerCase().includes(q));
    const by: Record<Sort, (a: BookRecord, b: BookRecord) => number> = {
      recent: (a, b) => (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt),
      added: (a, b) => b.addedAt - a.addedAt,
      title: (a, b) => a.title.localeCompare(b.title),
      author: (a, b) => a.author.localeCompare(b.author) || a.title.localeCompare(b.title),
      progress: (a, b) => b.progress - a.progress,
    };
    return list.sort(by[sort]);
  }, [books, query, sort]);

  const continueBook = useMemo(
    () => (books ?? []).filter((b) => b.lastOpenedAt > 0 && b.progress < 0.99).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)[0],
    [books],
  );

  const remove = async (book: BookRecord) => {
    if (!confirm(`Remove “${book.title}” from your library? Your highlights and notes for this book will be deleted too.`)) return;
    await deleteBook(book.id);
    void refresh();
  };

  const download = async (book: BookRecord) => {
    const blob = await getBookFile(book.id);
    if (!blob) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = book.fileName;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };

  const dark = settings.theme === 'dark' || settings.theme === 'black';
  const empty = books !== null && books.length === 0;

  return (
    <div className="library">
      <header className="lib-header">
        <div className="brand">
          <span className="brand-mark"><Icon name="book" size={22} /></span>
          <span className="brand-name">Bookreader</span>
        </div>
        {!empty && (
          <div className="lib-tools">
            <input
              className="search-input"
              type="search"
              placeholder="Search your library"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search your library"
            />
            <select className="select" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Sort books">
              <option value="recent">Recently read</option>
              <option value="added">Recently added</option>
              <option value="title">Title</option>
              <option value="author">Author</option>
              <option value="progress">Progress</option>
            </select>
          </div>
        )}
        <div className="lib-actions">
          <button className="icon-btn" onClick={() => updateSettings({ theme: dark ? 'light' : 'dark' })} aria-label={dark ? 'Switch to light theme' : 'Switch to dark theme'} title="Toggle theme">
            <Icon name={dark ? 'sun' : 'moon'} />
          </button>
          <button className="btn" onClick={() => setCloud('choose')} title="Build your library from a Dropbox or Google Drive folder">
            <Icon name="cloud" size={18} /> <span className="hide-narrow">Cloud</span>
          </button>
          <button className="btn primary" onClick={() => fileInput.current?.click()}>
            <Icon name="plus" size={18} /> Add books
          </button>
        </div>
        <input ref={fileInput} type="file" multiple accept={ACCEPT_ATTR} hidden onChange={(e) => { addFiles(e.target.files); e.target.value = ''; }} />
      </header>

      <main className="lib-main">
        {books === null ? (
          <p className="muted center-text">Loading your library…</p>
        ) : empty ? (
          <section className="empty">
            <div className="empty-art" aria-hidden="true"><Icon name="upload" size={40} /></div>
            <h1>Your library is empty</h1>
            <p>Drop books anywhere on this page, or choose files. PDFs are converted to reflowable EPUB, so you can resize text, change fonts and switch themes just like on an e-reader.</p>
            <button className="btn primary large" onClick={() => fileInput.current?.click()}>
              <Icon name="plus" size={20} /> Choose books
            </button>{' '}
            <button className="btn large" onClick={() => setCloud('choose')}>
              <Icon name="cloud" size={20} /> From the cloud
            </button>
            <p className="formats">EPUB · PDF · DOCX · TXT · Markdown · HTML · FB2 · CBZ</p>
            <p className="privacy">Everything stays in your browser. Nothing is uploaded.</p>
          </section>
        ) : (
          <>
            {continueBook && !query && (
              <section className="continue" aria-label="Continue reading">
                <button className="continue-cover" onClick={() => onOpen(continueBook.id)} aria-label={`Continue ${continueBook.title}`}>
                  <Cover book={continueBook} />
                </button>
                <div className="continue-info">
                  <div className="eyebrow">Continue reading</div>
                  <h2>{continueBook.title}</h2>
                  <div className="author">{continueBook.author || 'Unknown author'}</div>
                  <div className="progress wide"><div className="progress-fill" style={{ width: `${Math.round(continueBook.progress * 100)}%` }} /></div>
                  <div className="progress-text">{Math.round(continueBook.progress * 100)}% complete</div>
                  <button className="btn primary" onClick={() => onOpen(continueBook.id)}>Resume</button>
                </div>
              </section>
            )}
            {visible.length ? (
              <section className="grid" aria-label="Books">
                {visible.map((b) => (
                  <BookCard key={b.id} book={b} onOpen={() => onOpen(b.id)} onDelete={() => void remove(b)} onDownload={() => void download(b)} />
                ))}
              </section>
            ) : (
              <p className="muted center-text">No books match “{query}”.</p>
            )}
          </>
        )}
      </main>

      {cloud === 'choose' && (
        <div className="modal-backdrop" onClick={() => setCloud(null)}>
          <div className="modal drive" role="dialog" aria-label="Choose a cloud service" onClick={(e) => e.stopPropagation()}>
            <div className="drive-head">
              <h2>Build a library from the cloud</h2>
              <button className="icon-btn" onClick={() => setCloud(null)} aria-label="Close"><Icon name="close" /></button>
            </div>
            <button className="choice" onClick={() => setCloud('dropbox')}>
              <strong>Dropbox</strong>
              <span>Free to set up, no card needed. You stay signed in, and an app folder keeps things simple.</span>
            </button>
            <button className="choice" onClick={() => setCloud('drive')}>
              <strong>Google Drive</strong>
              <span>Needs a Google Cloud project for the sign-in; Google may ask for billing details when you create one.</span>
            </button>
          </div>
        </div>
      )}
      {cloud === 'dropbox' && <DropboxDialog onClose={() => setCloud(null)} onImported={() => void refresh()} />}
      {cloud === 'drive' && <DriveDialog onClose={() => setCloud(null)} onImported={() => void refresh()} />}

      <ImportQueue jobs={importer.jobs} onCancel={importer.cancel} onDismiss={importer.dismiss} onClear={importer.clearFinished} onOpen={onOpen} />

      {dragging && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-box">
            <Icon name="upload" size={44} />
            <strong>Drop to add to your library</strong>
            <span>EPUB, PDF, DOCX, TXT, Markdown, HTML, FB2, CBZ</span>
          </div>
        </div>
      )}
    </div>
  );
}
