import { useCallback, useEffect, useRef, useState } from 'react';
import { importFile } from './importer';
import type { BookRecord } from './types';
import { ImportError } from './util';

export type JobStatus = 'queued' | 'working' | 'done' | 'duplicate' | 'error' | 'cancelled';

export interface ImportJob {
  id: number;
  name: string;
  status: JobStatus;
  progress: number;
  message: string;
  warnings: string[];
  error?: string;
  book?: BookRecord;
}

let nextId = 1;

/** Sequential import queue that converts files to EPUB and stores them. */
export function useImporter(onImported: (book: BookRecord) => void) {
  const [jobs, setJobs] = useState<ImportJob[]>([]);
  const files = useRef(new Map<number, File>());
  const controllers = useRef(new Map<number, AbortController>());
  const running = useRef(false);
  const onImportedRef = useRef(onImported);
  onImportedRef.current = onImported;

  const patch = useCallback((id: number, p: Partial<ImportJob>) => {
    setJobs((js) => js.map((j) => (j.id === id ? { ...j, ...p } : j)));
  }, []);

  const pump = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    try {
      for (;;) {
        const next = Array.from(files.current.keys())[0];
        if (next === undefined) break;
        const file = files.current.get(next)!;
        files.current.delete(next);
        const controller = controllers.current.get(next)!;
        if (controller.signal.aborted) continue;
        patch(next, { status: 'working', message: 'Starting' });
        try {
          const result = await importFile(file, {
            fileName: file.name,
            signal: controller.signal,
            progress: (fraction, message) => patch(next, { progress: fraction, message }),
          });
          patch(next, {
            status: result.duplicate ? 'duplicate' : 'done',
            progress: 1,
            message: result.duplicate ? 'Already in your library' : 'Added to library',
            warnings: result.warnings,
            book: result.book,
          });
          onImportedRef.current(result.book);
        } catch (err) {
          if ((err as { name?: string })?.name === 'AbortError') patch(next, { status: 'cancelled', message: 'Cancelled' });
          else {
            const message = err instanceof ImportError ? err.message : `Could not import this file. ${err instanceof Error ? err.message : ''}`.trim();
            if (!(err instanceof ImportError)) console.error(err);
            patch(next, { status: 'error', error: message, message: 'Failed' });
          }
        } finally {
          controllers.current.delete(next);
        }
      }
    } finally {
      running.current = false;
    }
  }, [patch]);

  const add = useCallback(
    (list: File[]) => {
      const added: ImportJob[] = list.map((f) => ({
        id: nextId++,
        name: f.name,
        status: 'queued',
        progress: 0,
        message: 'Waiting',
        warnings: [],
      }));
      added.forEach((job, i) => {
        files.current.set(job.id, list[i]);
        controllers.current.set(job.id, new AbortController());
      });
      setJobs((js) => [...js, ...added]);
    },
    [],
  );

  useEffect(() => {
    if (jobs.some((j) => j.status === 'queued')) void pump();
  }, [jobs, pump]);

  const cancel = useCallback(
    (id: number) => {
      controllers.current.get(id)?.abort();
      files.current.delete(id);
      setJobs((js) => js.map((j) => (j.id === id && (j.status === 'queued' || j.status === 'working') ? { ...j, status: 'cancelled', message: 'Cancelled' } : j)));
    },
    [],
  );

  const dismiss = useCallback((id: number) => setJobs((js) => js.filter((j) => j.id !== id)), []);
  const clearFinished = useCallback(
    () => setJobs((js) => js.filter((j) => j.status === 'queued' || j.status === 'working')),
    [],
  );

  return { jobs, add, cancel, dismiss, clearFinished };
}
