import type { ImportJob } from '../lib/useImporter';
import { Icon } from './Icon';

interface Props {
  jobs: ImportJob[];
  onCancel: (id: number) => void;
  onDismiss: (id: number) => void;
  onClear: () => void;
  onOpen: (id: string) => void;
}

export function ImportQueue({ jobs, onCancel, onDismiss, onClear, onOpen }: Props) {
  if (!jobs.length) return null;
  const finished = jobs.some((j) => j.status !== 'queued' && j.status !== 'working');
  return (
    <aside className="queue" aria-label="Imports" aria-live="polite">
      <div className="queue-head">
        <strong>Imports</strong>
        {finished && (
          <button className="link-btn" onClick={onClear}>Clear finished</button>
        )}
      </div>
      <ul>
        {jobs.map((j) => {
          const active = j.status === 'working' || j.status === 'queued';
          return (
            <li key={j.id} className={`job ${j.status}`}>
              <div className="job-row">
                <span className="job-name" title={j.name}>{j.name}</span>
                {active ? (
                  <button className="icon-btn tiny" onClick={() => onCancel(j.id)} aria-label={`Cancel ${j.name}`}><Icon name="close" size={14} /></button>
                ) : (
                  <button className="icon-btn tiny" onClick={() => onDismiss(j.id)} aria-label={`Dismiss ${j.name}`}><Icon name="close" size={14} /></button>
                )}
              </div>
              {active && (
                <div className="progress"><div className="progress-fill" style={{ width: `${Math.round(j.progress * 100)}%` }} /></div>
              )}
              <div className="job-status">
                {j.status === 'error' ? <span className="err">{j.error}</span> : j.message}
                {j.status === 'working' && ` · ${Math.round(j.progress * 100)}%`}
                {(j.status === 'done' || j.status === 'duplicate') && j.book && (
                  <button className="link-btn" onClick={() => onOpen(j.book!.id)}>Open</button>
                )}
              </div>
              {j.warnings.map((w, i) => (
                <div key={i} className="job-warn"><Icon name="alert" size={14} /> {w}</div>
              ))}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
