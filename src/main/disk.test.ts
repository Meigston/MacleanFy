import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskMap, parseDuLine } from './disk';

describe('parseDuLine', () => {
  it('reads the size in KiB and the path, spaces included', () => {
    expect(parseDuLine('298167092\t/Users/ana/Library')).toEqual({ path: '/Users/ana/Library', size: 298167092 * 1024 });
    expect(parseDuLine('8\t/Users/ana/Library/Application Support')).toEqual({
      path: '/Users/ana/Library/Application Support',
      size: 8192,
    });
  });

  it('skips what is not a measurement', () => {
    expect(parseDuLine('du: /Users/ana/Library/Mail: Operation not permitted')).toBeNull();
    expect(parseDuLine('')).toBeNull();
    expect(parseDuLine('12\trelative/path')).toBeNull();
  });
});

describe('DiskMap', () => {
  let home: string;

  async function file(relative: string, bytes: number) {
    await mkdir(join(home, relative, '..'), { recursive: true });
    await writeFile(join(home, relative), Buffer.alloc(bytes, 1));
  }

  beforeEach(async () => {
    home = await realpath(await mkdtemp(join(tmpdir(), 'macleanfy-disk-')));
    await file('Documents/report.pdf', 200_000);
    await file('Library/Caches/com.vendor.app/blob', 600_000);
    await file('Library/Caches/com.vendor.app/deep/er/still/data', 100_000);
    await file('notes.txt', 50_000);
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('lists a folder from the largest down, files included', async () => {
    const map = new DiskMap(home);
    const folder = await map.list();

    expect(folder?.path).toBe(home);
    expect(folder?.crumbs).toEqual([{ name: '~', path: home }]);
    expect(folder?.entries.map((entry) => [entry.name, entry.directory])).toEqual([
      ['Library', true],
      ['Documents', true],
      ['notes.txt', false],
    ]);
    expect(folder!.entries[0].size).toBeGreaterThanOrEqual(700_000);
    expect(folder!.size).toBeGreaterThanOrEqual(950_000);
    expect(folder!.home).toBe(folder!.size);
  });

  it('answers from memory inside the measured depth, and measures deeper folders on demand', async () => {
    const map = new DiskMap(home);
    await map.list();

    const caches = join(home, 'Library', 'Caches');
    expect(await map.list(caches, { cachedOnly: true })).not.toBeNull();

    const deep = join(home, 'Library', 'Caches', 'com.vendor.app', 'deep', 'er');
    expect(await map.list(deep, { cachedOnly: true })).toBeNull();
    const folder = await map.list(deep);
    expect(folder?.entries.map((entry) => entry.name)).toEqual(['still']);
    expect(folder?.crumbs.map((crumb) => crumb.name)).toEqual(['~', 'Library', 'Caches', 'com.vendor.app', 'deep', 'er']);
  });

  it('measures nothing before being asked', async () => {
    expect(await new DiskMap(home).list(home, { cachedOnly: true })).toBeNull();
  });

  it('refuses anything outside the home folder', async () => {
    const map = new DiskMap(home);
    await expect(map.list('/etc')).rejects.toThrow();
    await expect(map.list(join(home, '..'))).rejects.toThrow();
    await expect(map.list(home + '-other')).rejects.toThrow();
  });

  it('takes a trashed item out and shrinks every folder above it', async () => {
    const map = new DiskMap(home);
    const before = await map.list(join(home, 'Library'));
    const app = join(home, 'Library', 'Caches', 'com.vendor.app');
    const appSize = (await map.list(join(home, 'Library', 'Caches')))!.entries[0].size;

    map.remove(app, appSize);

    const caches = await map.list(join(home, 'Library', 'Caches'));
    expect(caches?.entries).toEqual([]);
    expect((await map.list(join(home, 'Library')))!.size).toBe(before!.size - appSize);
  });

  it('never lets a top-level folder of the account or of Library go to the Trash', () => {
    const map = new DiskMap(home);
    expect(map.canTrash(home)).toBe(false);
    expect(map.canTrash(join(home, 'Documents'))).toBe(false);
    expect(map.canTrash(join(home, 'Library'))).toBe(false);
    expect(map.canTrash(join(home, 'Library', 'Application Support'))).toBe(false);
    expect(map.canTrash(join(home, 'Library', 'Caches', 'com.vendor.app'))).toBe(true);
    expect(map.canTrash(join(home, 'Documents', 'report.pdf'))).toBe(true);
    expect(map.canTrash('/Applications/Xcode.app')).toBe(false);
  });
});
