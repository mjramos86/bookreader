/** Reading position inside a book. `offset` is a character offset into the chapter's text. */
export interface Location {
  spine: number;
  offset: number;
  /** offset / chapter length, used as a fallback when the chapter's text changes. */
  fraction: number;
}

export interface BookRecord {
  id: string;
  title: string;
  author: string;
  language: string;
  cover?: Blob;
  addedAt: number;
  lastOpenedAt: number;
  /** 0..1 over the whole book. */
  progress: number;
  location?: Location;
  /** Extension of the file the user uploaded (epub, pdf, docx, ...). */
  sourceFormat: string;
  /** True when the stored EPUB was generated from another format. */
  converted: boolean;
  /** Size of the stored EPUB in bytes. */
  size: number;
  /** Suggested file name when downloading the EPUB. */
  fileName: string;
}

export type HighlightColor = 'yellow' | 'blue' | 'pink' | 'orange';

export interface Highlight {
  id: string;
  bookId: string;
  kind: 'highlight';
  spine: number;
  start: number;
  end: number;
  text: string;
  color: HighlightColor;
  note?: string;
  created: number;
}

export interface Bookmark {
  id: string;
  bookId: string;
  kind: 'bookmark';
  spine: number;
  offset: number;
  label: string;
  created: number;
}

export type Annotation = Highlight | Bookmark;
