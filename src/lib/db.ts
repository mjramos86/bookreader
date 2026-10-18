import type { Annotation, BookRecord } from './types';

const DB_NAME = 'bookreader';
const DB_VERSION = 2;

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        // Each store is created only if missing, so upgrading from an older version keeps its data.
        if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
        if (!db.objectStoreNames.contains('annotations')) {
          const ann = db.createObjectStore('annotations', { keyPath: 'id' });
          ann.createIndex('bookId', 'bookId');
        }
        if (!db.objectStoreNames.contains('drive')) db.createObjectStore('drive', { keyPath: 'fileId' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });
  }
  return dbPromise;
}

function wrap<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function listBooks(): Promise<BookRecord[]> {
  const db = await open();
  return wrap(db.transaction('books').objectStore('books').getAll());
}

export async function getBook(id: string): Promise<BookRecord | undefined> {
  const db = await open();
  return wrap(db.transaction('books').objectStore('books').get(id));
}

/** Saves the book record and, when given, its EPUB file in one transaction. */
export async function saveBook(book: BookRecord, file?: Blob): Promise<void> {
  const db = await open();
  const tx = db.transaction(['books', 'files'], 'readwrite');
  tx.objectStore('books').put(book);
  if (file) tx.objectStore('files').put(file, book.id);
  await done(tx);
}

export async function getBookFile(id: string): Promise<Blob | undefined> {
  const db = await open();
  return wrap(db.transaction('files').objectStore('files').get(id));
}

export async function deleteBook(id: string): Promise<void> {
  const db = await open();
  const tx = db.transaction(['books', 'files', 'annotations', 'drive'], 'readwrite');
  tx.objectStore('books').delete(id);
  tx.objectStore('files').delete(id);
  const store = tx.objectStore('annotations');
  const keys = await wrap(store.index('bookId').getAllKeys(id));
  for (const k of keys) store.delete(k);
  // Forget where the book came from, so syncing the Drive folder brings it back if it is still there.
  const drive = tx.objectStore('drive');
  for (const r of await wrap(drive.getAll() as IDBRequest<DriveRecord[]>)) if (r.bookId === id) drive.delete(r.fileId);
  await done(tx);
}

export async function listAnnotations(bookId: string): Promise<Annotation[]> {
  const db = await open();
  return wrap(db.transaction('annotations').objectStore('annotations').index('bookId').getAll(bookId));
}

export async function saveAnnotation(a: Annotation): Promise<void> {
  const db = await open();
  const tx = db.transaction('annotations', 'readwrite');
  tx.objectStore('annotations').put(a);
  await done(tx);
}

export async function deleteAnnotation(id: string): Promise<void> {
  const db = await open();
  const tx = db.transaction('annotations', 'readwrite');
  tx.objectStore('annotations').delete(id);
  await done(tx);
}

/** What was imported from Google Drive, so a later sync only fetches what is new. */
export interface DriveRecord {
  fileId: string;
  bookId: string;
  modifiedTime: string;
  md5Checksum?: string;
}

export async function listDriveRecords(): Promise<DriveRecord[]> {
  const db = await open();
  return wrap(db.transaction('drive').objectStore('drive').getAll());
}

export async function saveDriveRecord(r: DriveRecord): Promise<void> {
  const db = await open();
  const tx = db.transaction('drive', 'readwrite');
  tx.objectStore('drive').put(r);
  await done(tx);
}

/** Asks the browser not to evict our storage. Best effort. */
export async function requestPersistence(): Promise<void> {
  try {
    await navigator.storage?.persist?.();
  } catch {
    /* ignore */
  }
}
