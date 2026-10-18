import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { deleteAnnotation, getBook, getBookFile, listAnnotations, saveAnnotation, saveBook } from '../lib/db';
import { EpubBook, type FlatTocItem } from '../lib/epub';
import { indexBook, searchBook, type SearchHit } from '../lib/indexer';
import { BookRenderer, type LinkTarget, type MarkSpec, type RelocateInfo, type SelectionInfo } from '../lib/renderer';
import { FONT_SIZE_MAX, FONT_SIZE_MIN, type Settings } from '../lib/settings';
import type { Annotation, BookRecord, Bookmark, Highlight, HighlightColor, Location } from '../lib/types';
import { clamp, sanitizeFileName, uid } from '../lib/util';
import { Drawer, type DrawerTab } from './Drawer';
import { Icon } from './Icon';
import { SettingsPanel } from './SettingsPanel';

interface Props {
  id: string;
  settings: Settings;
  updateSettings: (p: Partial<Settings>) => void;
  onExit: () => void;
}

const COLORS: HighlightColor[] = ['yellow', 'blue', 'pink', 'orange'];
const CHARS_PER_MINUTE = 1300;
const FOOTER_KEY = 'bookreader.footerMode';

type FooterMode = 'location' | 'chapter' | 'book' | 'page';
const LOCATION_CHARS = 150;

function formatTime(chars: number): string {
  const mins = Math.max(0, Math.round(chars / CHARS_PER_MINUTE));
  if (mins < 1) return 'Less than a minute';
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function loadFooterMode(): FooterMode {
  try {
    const v = localStorage.getItem(FOOTER_KEY);
    if (v === 'location' || v === 'page' || v === 'chapter' || v === 'book') return v;
  } catch {
    /* ignore */
  }
  return 'location';
}

function isEditable(el: EventTarget | null): boolean {
  const t = el as HTMLElement | null;
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
}

export function Reader({ id, settings, updateSettings, onExit }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<BookRenderer | null>(null);
  const bookRef = useRef<EpubBook | null>(null);
  const recordRef = useRef<BookRecord | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(true);
  const [info, setInfo] = useState<RelocateInfo | null>(null);
  const [indexed, setIndexed] = useState(false);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [chrome, setChrome] = useState(true);
  const [panel, setPanel] = useState<DrawerTab | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [selection, setSelection] = useState<SelectionInfo | null>(null);
  const [activeHighlight, setActiveHighlight] = useState<{ id: string; rect: { left: number; top: number; width: number; height: number } } | null>(null);
  const [noteEditor, setNoteEditor] = useState<Highlight | null>(null);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [backStack, setBackStack] = useState<Location[]>([]);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [toast, setToast] = useState('');
  const [footerMode, setFooterMode] = useState<FooterMode>(loadFooterMode);
  const [drag, setDrag] = useState<number | null>(null);
  const [backVisible, setBackVisible] = useState(false);
  const debugOn = useMemo(() => new URLSearchParams(location.search).has('debug'), []);
  const [debugLines, setDebugLines] = useState<string[]>([]);
  const backTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [fullscreen, setFullscreen] = useState(false);

  const infoRef = useRef<RelocateInfo | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const annotationsRef = useRef<Annotation[]>([]);
  annotationsRef.current = annotations;

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2200);
  }, []);

  const flatToc = useMemo<FlatTocItem[]>(() => (bookRef.current ? bookRef.current.flatToc() : []), [status, indexed]);

  // ---- persistence -------------------------------------------------------------------------

  const persistLocation = useCallback((i: RelocateInfo, immediate = false) => {
    const write = () => {
      const rec = recordRef.current;
      if (!rec) return;
      const next: BookRecord = {
        ...rec,
        lastOpenedAt: Date.now(),
        progress: i.bookFraction,
        location: { spine: i.spine, offset: i.offset, fraction: i.chapterFraction },
      };
      recordRef.current = next;
      void saveBook(next);
    };
    clearTimeout(saveTimer.current);
    if (immediate) write();
    else saveTimer.current = setTimeout(write, 600);
  }, []);

  // ---- load the book and create the renderer ---------------------------------------------

  useEffect(() => {
    let cancelled = false;
    let renderer: BookRenderer | null = null;
    let book: EpubBook | null = null;

    (async () => {
      try {
        const record = await getBook(id);
        const blob = await getBookFile(id);
        if (!record || !blob) throw new Error('This book is no longer in your library.');
        book = await EpubBook.open(blob);
        const anns = await listAnnotations(id);
        if (cancelled || !stageRef.current) return;

        recordRef.current = record;
        bookRef.current = book;
        setTitle(record.title);
        setAnnotations(anns);
        setStatus('ready');

        renderer = new BookRenderer(stageRef.current, book, settingsRef.current, {
          onRelocate: (i) => {
            infoRef.current = i;
            setInfo(i);
            persistLocation(i);
          },
          onToggleChrome: () => {
            setChrome((c) => !c);
            setShowSettings(false);
          },
          onSelection: (s) => {
            setSelection(s);
            if (s) setActiveHighlight(null);
          },
          onHighlightClick: (hid, rect) => {
            setActiveHighlight({ id: hid, rect });
            setSelection(null);
          },
          onLink: (t) => handleLink.current(t),
          onImage: (src) => setLightbox(src),
          onKey: (e) => handleKey.current(e),
          // The toolbar stays until the first page turn, so a first-time reader can always find the controls.
          onPageTurn: () => setChrome(false),
          onDebug: (line) => setDebugLines((l) => [...l.slice(-14), line]),
          onInteract: () => {
            setShowSettings(false);
            setActiveHighlight(null);
          },
          onLoading: setBusy,
          onError: (m) => {
            setError(m);
            setStatus('error');
          },
        });
        rendererRef.current = renderer;

        const loc = record.location;
        await renderer.display(loc ? { spine: loc.spine, offset: loc.offset, fraction: loc.fraction } : { spine: 0, offset: 0 });
        if (cancelled) return;

        await indexBook(book, undefined, () => cancelled);
        if (cancelled) return;
        setIndexed(true);
        const latest = infoRef.current;
        if (latest) {
          const refreshed = { ...latest, bookFraction: book.bookFraction(latest.spine, latest.offset) };
          infoRef.current = refreshed;
          setInfo(refreshed);
          persistLocation(refreshed);
        }
      } catch (err) {
        if (cancelled) return;
        console.error(err);
        setError(err instanceof Error ? err.message : 'This book could not be opened.');
        setStatus('error');
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(saveTimer.current);
      if (infoRef.current) {
        const rec = recordRef.current;
        const i = infoRef.current;
        if (rec) {
          void saveBook({ ...rec, lastOpenedAt: Date.now(), progress: i.bookFraction, location: { spine: i.spine, offset: i.offset, fraction: i.chapterFraction } });
        }
      }
      renderer?.destroy();
      book?.dispose();
      rendererRef.current = null;
      bookRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // ---- settings & annotations flow into the renderer -------------------------------------

  useEffect(() => {
    rendererRef.current?.updateSettings(settings);
  }, [settings]);

  useEffect(() => {
    const marks: MarkSpec[] = annotations
      .filter((a): a is Highlight => a.kind === 'highlight')
      .map((h) => ({ id: h.id, spine: h.spine, start: h.start, end: h.end, color: h.color, hasNote: !!h.note }));
    rendererRef.current?.setMarks(marks);
  }, [annotations, status]);

  useEffect(() => {
    document.title = title ? `${title} · Bookreader` : 'Bookreader';
    return () => {
      document.title = 'Bookreader';
    };
  }, [title]);

  // ---- search ----------------------------------------------------------------------------

  useEffect(() => {
    const book = bookRef.current;
    if (!book || !indexed) return;
    const t = setTimeout(() => setHits(searchBook(book, query)), 220);
    return () => clearTimeout(t);
  }, [query, indexed]);

  // ---- navigation helpers ----------------------------------------------------------------

  const pushBack = useCallback(() => {
    const i = infoRef.current;
    if (!i) return;
    setBackStack((s) => [...s.slice(-9), { spine: i.spine, offset: i.offset, fraction: i.chapterFraction }]);
    setBackVisible(true);
    clearTimeout(backTimer.current);
    backTimer.current = setTimeout(() => setBackVisible(false), 9000);
  }, []);

  const goToc = useCallback(
    (item: FlatTocItem) => {
      void rendererRef.current?.display({ spine: item.spine, fragment: item.fragment, offset: item.fragment ? undefined : 0 });
      setPanel(null);
    },
    [],
  );

  const handleLink = useRef<(t: LinkTarget) => void>(() => undefined);
  handleLink.current = (t) => {
    if (t.external) {
      window.open(t.external, '_blank', 'noopener,noreferrer');
      return;
    }
    const book = bookRef.current;
    if (!book || !t.path) return;
    const spine = book.spineIndexOf(t.path);
    if (spine === undefined) return;
    pushBack();
    void rendererRef.current?.display({ spine, fragment: t.fragment, offset: t.fragment ? undefined : 0 });
  };

  const goBack = () => {
    const prev = backStack[backStack.length - 1];
    if (!prev) return;
    setBackStack((s) => s.slice(0, -1));
    setBackVisible(false);
    void rendererRef.current?.display({ spine: prev.spine, offset: prev.offset });
  };

  // ---- bookmarks, highlights, notes ------------------------------------------------------

  const pageBookmark = useMemo(() => {
    if (!info) return undefined;
    return annotations.find(
      (a): a is Bookmark => a.kind === 'bookmark' && a.spine === info.spine && a.offset >= info.offset && a.offset < Math.max(info.endOffset, info.offset + 1),
    );
  }, [annotations, info]);

  const upsert = useCallback(async (a: Annotation) => {
    await saveAnnotation(a);
    setAnnotations((list) => (list.some((x) => x.id === a.id) ? list.map((x) => (x.id === a.id ? a : x)) : [...list, a]));
  }, []);

  const remove = useCallback(async (a: Annotation) => {
    await deleteAnnotation(a.id);
    setAnnotations((list) => list.filter((x) => x.id !== a.id));
  }, []);

  const toggleBookmark = useCallback(async () => {
    const i = infoRef.current;
    const book = bookRef.current;
    if (!i || !book) return;
    const existing = annotationsRef.current.find(
      (a): a is Bookmark => a.kind === 'bookmark' && a.spine === i.spine && a.offset >= i.offset && a.offset < Math.max(i.endOffset, i.offset + 1),
    );
    if (existing) {
      await remove(existing);
      showToast('Bookmark removed');
      return;
    }
    const snippet = (book.chapterText[i.spine] ?? '').slice(i.offset, i.offset + 80).replace(/\s+/g, ' ').trim();
    await upsert({
      id: uid(),
      bookId: id,
      kind: 'bookmark',
      spine: i.spine,
      offset: i.offset,
      label: snippet ? `${snippet}…` : book.chapterTitle(i.spine, i.offset),
      created: Date.now(),
    });
    showToast('Bookmark added');
  }, [id, remove, showToast, upsert]);

  const addHighlight = useCallback(
    async (color: HighlightColor) => {
      const sel = selection;
      if (!sel) return;
      const h: Highlight = {
        id: uid(),
        bookId: id,
        kind: 'highlight',
        spine: sel.spine,
        start: sel.start,
        end: sel.end,
        text: sel.text.length > 600 ? `${sel.text.slice(0, 600)}…` : sel.text,
        color,
        created: Date.now(),
      };
      rendererRef.current?.clearSelection();
      await upsert(h);
      return h;
    },
    [id, selection, upsert],
  );

  const exportNotes = () => {
    const book = bookRef.current;
    const rec = recordRef.current;
    if (!book || !rec) return;
    const sorted = [...annotations].sort((a, b) => {
      const pa = a.kind === 'highlight' ? a.start : a.offset;
      const pb = b.kind === 'highlight' ? b.start : b.offset;
      return a.spine - b.spine || pa - pb;
    });
    const lines = [`# Notes: ${rec.title}`, rec.author ? `*${rec.author}*` : '', ''];
    let lastChapter = '';
    for (const a of sorted) {
      const chapter = book.chapterTitle(a.spine, a.kind === 'highlight' ? a.start : a.offset);
      if (chapter !== lastChapter) {
        lines.push(`## ${chapter}`, '');
        lastChapter = chapter;
      }
      if (a.kind === 'highlight') {
        lines.push(`> ${a.text.replace(/\n+/g, ' ')}`, '');
        if (a.note) lines.push(`**Note:** ${a.note}`, '');
      } else lines.push(`- 🔖 Bookmark: ${a.label}`, '');
    }
    const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${sanitizeFileName(rec.title)} - notes.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  };

  const goAnnotation = (a: Annotation) => {
    pushBack();
    void rendererRef.current?.display({ spine: a.spine, offset: a.kind === 'highlight' ? a.start : a.offset });
    if (window.innerWidth < 800) setPanel(null);
  };

  const goHit = (hit: SearchHit) => {
    pushBack();
    const r = rendererRef.current;
    if (!r) return;
    void r.display({ spine: hit.spine, offset: hit.start }).then(() => r.showSearchMark({ spine: hit.spine, start: hit.start, end: hit.end }));
    if (window.innerWidth < 800) setPanel(null);
  };

  // ---- keyboard --------------------------------------------------------------------------

  const handleKey = useRef<(e: KeyboardEvent) => void>(() => undefined);
  handleKey.current = (e) => {
    if (isEditable(e.target) || e.altKey || e.metaKey) return;
    const r = rendererRef.current;
    if (!r) return;
    const scroll = settings.layout === 'scroll';
    switch (e.key) {
      case 'ArrowRight':
      case 'PageDown':
        e.preventDefault();
        r.next();
        break;
      case 'ArrowLeft':
      case 'PageUp':
        e.preventDefault();
        r.prev();
        break;
      case ' ':
        e.preventDefault();
        if (e.shiftKey) r.prev();
        else r.next();
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (scroll) r.scrollBy(70);
        else r.next();
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (scroll) r.scrollBy(-70);
        else r.prev();
        break;
      case 'Home':
        e.preventDefault();
        void r.display({ spine: 0, offset: 0 });
        break;
      case 'End':
        e.preventDefault();
        r.goToFraction(1);
        break;
      case 'Escape':
        if (lightbox) setLightbox(null);
        else if (noteEditor) setNoteEditor(null);
        else if (panel) setPanel(null);
        else if (showSettings) setShowSettings(false);
        else if (selection || activeHighlight) {
          r.clearSelection();
          setActiveHighlight(null);
        } else setChrome((c) => !c);
        break;
      case '+':
      case '=':
        updateSettings({ fontSize: clamp(settings.fontSize + 1, FONT_SIZE_MIN, FONT_SIZE_MAX) });
        break;
      case '-':
      case '_':
        updateSettings({ fontSize: clamp(settings.fontSize - 1, FONT_SIZE_MIN, FONT_SIZE_MAX) });
        break;
      case 'b':
        void toggleBookmark();
        break;
      case 't':
        setPanel((p) => (p === 'toc' ? null : 'toc'));
        break;
      case '/':
        e.preventDefault();
        setPanel('search');
        break;
      case 'f':
        toggleFullscreen();
        break;
    }
  };

  useEffect(() => {
    const on = (e: KeyboardEvent) => handleKey.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  useEffect(() => {
    const on = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => undefined);
  };

  // ---- derived display values ------------------------------------------------------------

  const book = bookRef.current;
  const chapterTitle = info && book ? book.chapterTitle(info.spine, info.offset, flatToc) : '';
  const percent = info ? Math.round(info.bookFraction * 100) : 0;
  let footerLabel = '';
  if (info) {
    if (footerMode === 'chapter' && indexed) footerLabel = `${formatTime(info.chapterLength - info.endOffset)} left in chapter`;
    else if (footerMode === 'book' && indexed && book) {
      footerLabel = `${formatTime(book.totalChars - (book.chapterStart[info.spine] ?? 0) - info.endOffset)} left in book`;
    } else if (footerMode === 'page' && settings.layout === 'paged') {
      footerLabel = `Page ${info.page + 1} of ${info.pageCount} in chapter`;
    } else if (book && indexed && book.totalChars >= 500) {
      // Kindle-style locations: fixed-size slices of the text, stable across font and layout changes.
      const at = (book.chapterStart[info.spine] ?? 0) + info.offset;
      footerLabel = `Location ${Math.floor(at / LOCATION_CHARS) + 1} of ${Math.ceil(book.totalChars / LOCATION_CHARS)}`;
    } else if (book && indexed && book.totalChars < 500) {
      footerLabel = `Page ${info.spine + 1} of ${book.spine.length}`;
    } else footerLabel = settings.layout === 'paged' ? `Page ${info.page + 1} of ${info.pageCount}` : '';
  }
  const cycleFooter = () => {
    const order: FooterMode[] = ['location', 'chapter', 'book', 'page'];
    const next = order[(order.indexOf(footerMode) + 1) % order.length];
    setFooterMode(next);
    try {
      localStorage.setItem(FOOTER_KEY, next);
    } catch {
      /* ignore */
    }
  };

  const sliderValue = drag ?? (info ? Math.round(info.bookFraction * 1000) : 0);
  const sliderChapter = useMemo(() => {
    if (drag === null || !book) return '';
    const at = book.locate(drag / 1000);
    return book.chapterTitle(at.spine, at.offset, flatToc);
  }, [drag, book, flatToc]);
  const chapterTicks = useMemo(() => {
    if (!book || !indexed || !book.totalChars) return [];
    return flatToc.filter((t) => t.depth === 0).map((t) => (book.chapterStart[t.spine] ?? 0) / book.totalChars);
  }, [book, flatToc, indexed]);

  const highlight = activeHighlight ? annotations.find((a): a is Highlight => a.id === activeHighlight.id && a.kind === 'highlight') : undefined;
  const lookupWord = selection && /^[\p{L}'’-]+$/u.test(selection.text) ? selection.text : null;

  const popupStyle = (rect: { left: number; top: number; width: number; height: number }): React.CSSProperties => {
    const cw = stageRef.current?.clientWidth ?? 800;
    const x = clamp(rect.left + rect.width / 2, 150, Math.max(150, cw - 150));
    const above = rect.top > 64;
    return { left: x, top: above ? rect.top - 8 : rect.top + rect.height + 8, transform: `translate(-50%, ${above ? '-100%' : '0'})` };
  };

  const brightnessStyle: React.CSSProperties = settings.brightness < 100 ? { filter: `brightness(${settings.brightness / 100})` } : {};

  return (
    <div className={`reader ${chrome ? 'chrome-on' : 'chrome-off'} layout-${settings.layout}`}>
      <header className="toolbar">
        <button className="icon-btn" onClick={onExit} aria-label="Back to library" title="Library">
          <Icon name="back" />
        </button>
        <div className="toolbar-title" title={title}>{title}</div>
        <div className="toolbar-actions">
          <button className="icon-btn" onClick={() => setPanel(panel === 'toc' ? null : 'toc')} aria-label="Contents" title="Contents (T)" aria-pressed={panel === 'toc'}>
            <Icon name="list" />
          </button>
          <button className="icon-btn" onClick={() => setPanel(panel === 'search' ? null : 'search')} aria-label="Search" title="Search (/)" aria-pressed={panel === 'search'}>
            <Icon name="search" />
          </button>
          <button className="icon-btn" onClick={() => setPanel(panel === 'notes' ? null : 'notes')} aria-label="Notes and highlights" title="Notes & highlights" aria-pressed={panel === 'notes'}>
            <Icon name="pen" />
          </button>
          <button className={`icon-btn aa ${showSettings ? 'active' : ''}`} onClick={() => setShowSettings((s) => !s)} aria-label="Display settings" title="Display settings" aria-expanded={showSettings}>
            <span aria-hidden="true">Aa</span>
          </button>
          <button className={`icon-btn ${pageBookmark ? 'marked' : ''}`} onClick={() => void toggleBookmark()} aria-label={pageBookmark ? 'Remove bookmark' : 'Add bookmark'} title="Bookmark (B)" aria-pressed={!!pageBookmark}>
            <Icon name="bookmark" fill={!!pageBookmark} />
          </button>
          <button className="icon-btn hide-narrow" onClick={toggleFullscreen} aria-label={fullscreen ? 'Exit full screen' : 'Full screen'} title="Full screen (F)">
            <Icon name="fullscreen" />
          </button>
        </div>
        {showSettings && <SettingsPanel settings={settings} update={updateSettings} />}
      </header>

      <div className="page-area" style={brightnessStyle}>
        <div className="stage" ref={stageRef} />
        {pageBookmark && <div className="ribbon" aria-hidden="true" />}
        {/* Always available, in the parent document: a way to get the toolbar back that cannot depend on taps inside the book. */}
        {!chrome && status === 'ready' && (
          <button className="chrome-handle" onClick={() => setChrome(true)} aria-label="Show toolbar" />
        )}
        {settings.layout === 'paged' && status === 'ready' && (
          <>
            <button className="side-nav prev" onClick={() => rendererRef.current?.prev()} aria-label="Previous page">
              <Icon name="back" size={22} />
            </button>
            <button className="side-nav next" onClick={() => rendererRef.current?.next()} aria-label="Next page">
              <span style={{ display: 'inline-flex', transform: 'scaleX(-1)' }}><Icon name="back" size={22} /></span>
            </button>
          </>
        )}

        {selection && (
          <div className="popup" style={popupStyle(selection.rect)} role="toolbar" aria-label="Selection actions" onPointerDown={(e) => e.preventDefault()}>
            {COLORS.map((c) => (
              <button key={c} className={`swatch c-${c}`} aria-label={`Highlight ${c}`} title={`Highlight ${c}`} onClick={() => void addHighlight(c)} />
            ))}
            <span className="popup-sep" />
            <button
              className="popup-btn"
              onClick={async () => {
                const h = await addHighlight('yellow');
                if (h) setNoteEditor(h);
              }}
            >
              <Icon name="note" size={16} /> Note
            </button>
            <button
              className="popup-btn"
              onClick={() => {
                void navigator.clipboard?.writeText(selection.text).then(() => showToast('Copied'));
                rendererRef.current?.clearSelection();
              }}
            >
              <Icon name="copy" size={16} /> Copy
            </button>
            {lookupWord && (
              <a
                className="popup-btn"
                target="_blank"
                rel="noopener noreferrer"
                href={`https://${(recordRef.current?.language ?? 'en').slice(0, 2).toLowerCase()}.wiktionary.org/wiki/${encodeURIComponent(lookupWord.toLowerCase())}`}
              >
                <Icon name="external" size={16} /> Look up
              </a>
            )}
          </div>
        )}

        {highlight && activeHighlight && (
          <div className="popup" style={popupStyle(activeHighlight.rect)} role="toolbar" aria-label="Highlight actions">
            {COLORS.map((c) => (
              <button
                key={c}
                className={`swatch c-${c} ${highlight.color === c ? 'on' : ''}`}
                aria-label={`Change to ${c}`}
                onClick={() => {
                  void upsert({ ...highlight, color: c });
                  setActiveHighlight(null);
                }}
              />
            ))}
            <span className="popup-sep" />
            <button className="popup-btn" onClick={() => { setNoteEditor(highlight); setActiveHighlight(null); }}>
              <Icon name="note" size={16} /> {highlight.note ? 'Edit note' : 'Note'}
            </button>
            <button className="popup-btn danger" onClick={() => { void remove(highlight); setActiveHighlight(null); }}>
              <Icon name="trash" size={16} /> Delete
            </button>
          </div>
        )}


        {busy && status === 'ready' && <div className="spinner" aria-label="Loading chapter" />}
      </div>

      {status === 'loading' && (
        <div className="overlay-msg"><div className="spinner" /><p>Opening book…</p></div>
      )}
      {status === 'error' && (
        <div className="overlay-msg">
          <Icon name="alert" size={36} />
          <p>{error || 'This book could not be opened.'}</p>
          <button className="btn primary" onClick={onExit}>Back to library</button>
        </div>
      )}

      <footer className="footer">
        <div className="slider-row">
          <div className="slider-wrap">
            <div className="ticks" aria-hidden="true">
              {chapterTicks.map((t, i) => (
                <span key={i} className="tick" style={{ left: `${t * 100}%` }} />
              ))}
            </div>
            <input
              className="slider"
              type="range"
              min={0}
              max={1000}
              value={sliderValue}
              onChange={(e) => setDrag(Number(e.target.value))}
              onPointerUp={() => {
                if (drag !== null) rendererRef.current?.goToFraction(drag / 1000);
                setDrag(null);
              }}
              onKeyUp={(e) => {
                if (drag !== null && (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End')) {
                  rendererRef.current?.goToFraction(drag / 1000);
                  setDrag(null);
                }
              }}
              aria-label="Reading progress"
              aria-valuetext={`${Math.round(sliderValue / 10)} percent`}
            />
            {drag !== null && (
              <div className="slider-tip" style={{ left: `${drag / 10}%` }}>
                {sliderChapter && <div>{sliderChapter}</div>}
                <strong>{Math.round(drag / 10)}%</strong>
              </div>
            )}
          </div>
        </div>
        <div className="status">
          <span className="status-chapter" title={chapterTitle}>{chapterTitle}</span>
          <button className="status-right" onClick={cycleFooter} title="Click to change what is shown">
            {[footerLabel, info ? `${percent}%` : ''].filter(Boolean).join(' · ')}
          </button>
        </div>
      </footer>

      {backStack.length > 0 && backVisible && (
        <button className="back-chip" onClick={goBack}>
          <Icon name="undo" size={16} /> Back to previous spot
        </button>
      )}

      {panel && book && status === 'ready' && (
        <Drawer
          tab={panel}
          onTab={setPanel}
          onClose={() => setPanel(null)}
          book={book}
          toc={flatToc}
          indexed={indexed}
          currentSpine={info?.spine ?? 0}
          currentOffset={info?.offset ?? 0}
          onGoToc={goToc}
          query={query}
          onQuery={setQuery}
          hits={hits}
          onGoHit={goHit}
          annotations={annotations}
          onGoAnnotation={goAnnotation}
          onDeleteAnnotation={(a) => void remove(a)}
          onEditNote={setNoteEditor}
          onExport={exportNotes}
        />
      )}

      {noteEditor && (
        <NoteDialog
          highlight={noteEditor}
          onCancel={() => setNoteEditor(null)}
          onSave={(text) => {
            void upsert({ ...noteEditor, note: text.trim() || undefined });
            setNoteEditor(null);
          }}
        />
      )}

      {lightbox && (
        <div className="lightbox" onClick={() => setLightbox(null)} role="dialog" aria-label="Image viewer">
          <img src={lightbox} alt="" />
          <button className="icon-btn lightbox-close" aria-label="Close image"><Icon name="close" /></button>
        </div>
      )}

      {toast && <div className="toast" role="status">{toast}</div>}
      {debugOn && <pre className="debug-log">{debugLines.join('\n') || 'debug: touch the page'}</pre>}
    </div>
  );
}

function NoteDialog({ highlight, onSave, onCancel }: { highlight: Highlight; onSave: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(highlight.note ?? '');
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" role="dialog" aria-label="Note" onClick={(e) => e.stopPropagation()}>
        <blockquote className={`note-quote c-${highlight.color}`}>{highlight.text}</blockquote>
        <textarea
          autoFocus
          rows={5}
          placeholder="Write a note…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') onSave(text);
            if (e.key === 'Escape') onCancel();
          }}
        />
        <div className="modal-actions">
          <button className="btn" onClick={onCancel}>Cancel</button>
          <button className="btn primary" onClick={() => onSave(text)}>Save note</button>
        </div>
      </div>
    </div>
  );
}
