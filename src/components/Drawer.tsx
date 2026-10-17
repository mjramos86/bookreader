import { useMemo } from 'react';
import type { EpubBook, FlatTocItem } from '../lib/epub';
import type { SearchHit } from '../lib/indexer';
import type { Annotation, Highlight } from '../lib/types';
import { Icon } from './Icon';

export type DrawerTab = 'toc' | 'search' | 'notes';

interface Props {
  tab: DrawerTab;
  onTab: (t: DrawerTab) => void;
  onClose: () => void;
  book: EpubBook;
  toc: FlatTocItem[];
  indexed: boolean;
  currentSpine: number;
  currentOffset: number;
  onGoToc: (item: FlatTocItem) => void;
  query: string;
  onQuery: (q: string) => void;
  hits: SearchHit[];
  onGoHit: (hit: SearchHit) => void;
  annotations: Annotation[];
  onGoAnnotation: (a: Annotation) => void;
  onDeleteAnnotation: (a: Annotation) => void;
  onEditNote: (h: Highlight) => void;
  onExport: () => void;
}

export function Drawer(p: Props) {
  const tabs: { id: DrawerTab; label: string }[] = [
    { id: 'toc', label: 'Contents' },
    { id: 'search', label: 'Search' },
    { id: 'notes', label: 'Notes' },
  ];
  return (
    <>
      <div className="drawer-backdrop" onClick={p.onClose} />
      <aside className="drawer" role="dialog" aria-label="Book panel">
        <div className="drawer-head">
          <div className="tabs" role="tablist">
            {tabs.map((t) => (
              <button key={t.id} role="tab" aria-selected={p.tab === t.id} className={p.tab === t.id ? 'on' : ''} onClick={() => p.onTab(t.id)}>
                {t.label}
                {t.id === 'notes' && p.annotations.length > 0 && <span className="count">{p.annotations.length}</span>}
              </button>
            ))}
          </div>
          <button className="icon-btn" onClick={p.onClose} aria-label="Close panel"><Icon name="close" /></button>
        </div>
        <div className="drawer-body">
          {p.tab === 'toc' && <Toc {...p} />}
          {p.tab === 'search' && <Search {...p} />}
          {p.tab === 'notes' && <Notes {...p} />}
        </div>
      </aside>
    </>
  );
}

function Toc({ toc, currentSpine, currentOffset, onGoToc, book }: Props) {
  const currentIndex = book.tocEntryAt(toc, currentSpine, currentOffset);
  if (!toc.length) return <p className="muted pad">This book has no table of contents.</p>;
  return (
    <>
      <div className="book-title-line">{book.metadata.title}</div>
      <ul className="toc">
        {toc.map((t, i) => (
          <li key={i}>
            <button className={i === currentIndex ? 'current' : ''} style={{ paddingLeft: 16 + t.depth * 18 }} onClick={() => onGoToc(t)} aria-current={i === currentIndex ? 'location' : undefined}>
              {t.title}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

function Search({ query, onQuery, hits, onGoHit, indexed, book, toc }: Props) {
  // Group hits by the section they fall in, in reading order.
  const grouped = useMemo(() => {
    const groups: { key: number; title: string; hits: SearchHit[] }[] = [];
    for (const h of hits) {
      const key = book.tocEntryAt(toc, h.spine, h.start);
      const last = groups[groups.length - 1];
      if (last && last.key === key) last.hits.push(h);
      else groups.push({ key, title: book.chapterTitle(h.spine, h.start, toc), hits: [h] });
    }
    return groups;
  }, [hits, book, toc]);
  return (
    <div className="search-panel">
      <div className="search-box">
        <Icon name="search" size={18} />
        <input autoFocus type="search" placeholder="Search in this book" value={query} onChange={(e) => onQuery(e.target.value)} aria-label="Search in this book" />
      </div>
      {!indexed && <p className="muted pad">Indexing the book… results will appear shortly.</p>}
      {indexed && query.trim().length >= 2 && (
        <p className="muted pad small">{hits.length === 0 ? 'No matches' : `${hits.length >= 400 ? '400+' : hits.length} match${hits.length === 1 ? '' : 'es'}`}</p>
      )}
      <div className="results">
        {grouped.map((g, gi) => (
          <div key={gi} className="result-group">
            <div className="result-chapter">{g.title}</div>
            {g.hits.map((h, i) => (
              <button key={i} className="result" onClick={() => onGoHit(h)}>
                …{h.before}<mark>{h.match}</mark>{h.after}…
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function Notes({ annotations, onGoAnnotation, onDeleteAnnotation, onEditNote, onExport, book, toc }: Props) {
  const sorted = useMemo(
    () =>
      [...annotations].sort((a, b) => {
        const pa = a.kind === 'highlight' ? a.start : a.offset;
        const pb = b.kind === 'highlight' ? b.start : b.offset;
        return a.spine - b.spine || pa - pb;
      }),
    [annotations],
  );
  if (!sorted.length) {
    return (
      <p className="muted pad">
        Nothing here yet. Select text to highlight it or add a note, and use the bookmark button to mark a page.
      </p>
    );
  }
  return (
    <>
      <div className="notes-actions">
        <button className="btn small" onClick={onExport}><Icon name="download" size={16} /> Export as Markdown</button>
      </div>
      <ul className="notes">
        {sorted.map((a) => (
          <li key={a.id} className={`note-item ${a.kind}`}>
            <button className="note-main" onClick={() => onGoAnnotation(a)}>
              <span className="note-chapter">{book.chapterTitle(a.spine, a.kind === 'highlight' ? a.start : a.offset, toc)}</span>
              {a.kind === 'highlight' ? (
                <>
                  <span className={`note-quote c-${a.color}`}>{a.text}</span>
                  {a.note && <span className="note-text">{a.note}</span>}
                </>
              ) : (
                <span className="note-bookmark"><Icon name="bookmark" size={14} fill /> {a.label}</span>
              )}
            </button>
            <div className="note-tools">
              {a.kind === 'highlight' && (
                <button className="icon-btn tiny" onClick={() => onEditNote(a)} aria-label={a.note ? 'Edit note' : 'Add note'} title={a.note ? 'Edit note' : 'Add note'}>
                  <Icon name="note" size={16} />
                </button>
              )}
              <button className="icon-btn tiny" onClick={() => onDeleteAnnotation(a)} aria-label="Delete" title="Delete">
                <Icon name="trash" size={16} />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
