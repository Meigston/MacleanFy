import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { HistoryStore } from './history';

describe('HistoryStore', () => {
  let root: string;
  let file: string;
  let clock: number;
  const now = () => clock;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'macleanfy-history-'));
    file = join(root, 'nested', 'history.json');
    clock = 1_000;
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('starts empty, counting from now', async () => {
    expect(await new HistoryStore(file, now).read()).toEqual({
      since: 1_000,
      totalFreedSpace: 0,
      totalItems: 0,
      entries: [],
    });
  });

  it('accumulates totals and lists the newest entry first', async () => {
    const store = new HistoryStore(file, now);

    await store.add({ kind: 'clean', freedSpace: 500, items: 3, labels: ['trash'] });
    clock = 2_000;
    const history = await store.add({ kind: 'uninstall', freedSpace: 1_500, items: 1, labels: ['Demo App'] });

    expect(history.since).toBe(1_000);
    expect(history.totalFreedSpace).toBe(2_000);
    expect(history.totalItems).toBe(4);
    expect(history.entries.map((entry) => entry.at)).toEqual([2_000, 1_000]);
    expect(JSON.parse(await readFile(file, 'utf-8'))).toEqual(history);
  });

  it('keeps the totals when the entry list is trimmed', async () => {
    const store = new HistoryStore(file, now);

    for (let i = 0; i < 55; i++) {
      await store.add({ kind: 'clean', freedSpace: 10, items: 1, labels: ['trash'] });
    }
    const history = await store.read();

    expect(history.entries).toHaveLength(50);
    expect(history.totalFreedSpace).toBe(550);
    expect(history.totalItems).toBe(55);
  });

  it('treats a corrupted file as an empty history', async () => {
    const flat = join(root, 'history.json');
    await writeFile(flat, '{ not json');

    expect((await new HistoryStore(flat, now).read()).entries).toEqual([]);
  });
});
