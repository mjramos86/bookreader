import { describe, expect, it } from 'vitest';
import { planSync, type CloudItem } from './cloudSync';

const item = (key: string, extra: Partial<CloudItem> = {}): CloudItem => ({
  key,
  name: `${key}.epub`,
  path: '',
  modifiedTime: 't1',
  download: async () => new Blob(),
  ...extra,
});

describe('planSync', () => {
  it('only fetches new or changed items', () => {
    const items = [item('a'), item('b'), item('c', { hash: 'new' }), item('d', { modifiedTime: 't2' })];
    const records = [
      { key: 'a', bookId: '1', modifiedTime: 't1' },
      { key: 'c', bookId: '2', modifiedTime: 't1', hash: 'old' },
      { key: 'd', bookId: '3', modifiedTime: 't1' },
    ];
    const { fresh, known } = planSync(items, records);
    expect(fresh.map((x) => x.key)).toEqual(['b', 'c', 'd']);
    expect(known).toBe(1);
  });

  it('treats a matching content hash as unchanged even if the modified time moved', () => {
    const { fresh } = planSync([item('a', { hash: 'same', modifiedTime: 't9' })], [{ key: 'a', bookId: '1', modifiedTime: 't1', hash: 'same' }]);
    expect(fresh).toHaveLength(0);
  });

  it('keeps services apart even when file ids collide', () => {
    const { fresh } = planSync([item('dropbox:1')], [{ key: 'gdrive:1', bookId: 'x', modifiedTime: 't1' }]);
    expect(fresh).toHaveLength(1);
  });
});
