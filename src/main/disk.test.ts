import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiskMap, parseDuError, parseDuLine } from './disk';

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

describe('parseDuError', () => {
  it('reads the folder macOS refused, and nothing else', () => {
    expect(parseDuError('du: /Users/ana/Library/Mail: Operation not permitted')).toBe('/Users/ana/Library/Mail');
    expect(parseDuError('du: /private/var/db/x y: Permission denied')).toBe('/private/var/db/x y');
    expect(parseDuError('du: /tmp/gone: No such file or directory')).toBeNull();
    expect(parseDuError('12\t/Users/ana')).toBeNull();
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

  it('moves a trashed item into ~/.Trash: the folders above shrink, the home folder does not', async () => {
    const map = new DiskMap(home);
    const before = await map.list(join(home, 'Library'));
    const app = join(home, 'Library', 'Caches', 'com.vendor.app');
    const appSize = (await map.list(join(home, 'Library', 'Caches')))!.entries[0].size;
    const homeBefore = before!.home;

    map.remove(app, appSize);

    const caches = await map.list(join(home, 'Library', 'Caches'));
    expect(caches?.entries).toEqual([]);
    expect((await map.list(join(home, 'Library')))!.size).toBe(before!.size - appSize);
    const top = (await map.list(home))!;
    expect(top.home).toBe(homeBefore);
    expect(top.entries.find((entry) => entry.name === '.Trash')?.size).toBe(appSize);
  });

  it('keeps a snapshot of the last whole pass that later partial passes do not touch', async () => {
    const map = new DiskMap(home);
    expect(map.homeSnapshot()).toBeNull();
    await map.list();
    const snapshot = map.homeSnapshot()!;
    expect(snapshot.sizes.get(home)).toBeGreaterThan(0);
    expect(snapshot.sizes.has(join(home, 'Library', 'Caches', 'com.vendor.app'))).toBe(true);
    expect(snapshot.sizes.has(join(home, 'Library', 'Caches', 'com.vendor.app', 'deep'))).toBe(false);
    const library = snapshot.sizes.get(join(home, 'Library'));

    // Uma pasta abaixo do terceiro nível é medida à parte: isso não entra no retrato.
    await map.list(join(home, 'Library', 'Caches', 'com.vendor.app'));
    expect(map.homeSnapshot()).toBe(snapshot);
    expect(snapshot.sizes.has(join(home, 'Library', 'Caches', 'com.vendor.app', 'deep'))).toBe(false);

    // A Lixeira entra: a pasta sai, as de cima encolhem, a ~/.Trash cresce e a pasta pessoal fica igual.
    const trashBefore = snapshot.sizes.get(join(home, '.Trash')) ?? 0;
    map.remove(join(home, 'Library', 'Caches', 'com.vendor.app'), 600_000);
    const after = map.homeSnapshot()!;
    expect(after).not.toBe(snapshot);
    expect(after.at).toBe(snapshot.at);
    expect(after.sizes.has(join(home, 'Library', 'Caches', 'com.vendor.app'))).toBe(false);
    expect(after.sizes.get(join(home, 'Library'))).toBe(Math.max(0, library! - 600_000));
    expect(after.sizes.get(join(home, '.Trash'))).toBe(trashBefore + 600_000);
    expect(after.sizes.get(home)).toBe(snapshot.sizes.get(home));
    // O retrato de antes não muda: quem já o leu não vê os números mexerem por baixo.
    expect(snapshot.sizes.get(join(home, 'Library'))).toBe(library);
  });

  it('refuses anything inside the Photos library, not only the library itself', () => {
    const map = new DiskMap(home);
    const library = join(home, 'Pictures', 'Photos Library.photoslibrary');
    expect(map.canTrash(library)).toBe(false);
    expect(map.canTrash(join(library, 'originals'))).toBe(false);
    expect(map.canTrash(join(library, 'originals', '0', 'IMG_0001.HEIC'))).toBe(false);
    expect(map.canTrash(join(home, 'Pictures', 'Old.PhotosLibrary', 'database'))).toBe(false);
    expect(map.canTrash(join(home, 'Pictures', 'photoslibrary-notes', 'a.txt'))).toBe(true);
  });

  it('measures a deep folder again after riding along a whole pass of the home folder', async () => {
    const map = new DiskMap(home);
    await map.list();
    const deep = join(home, 'Library', 'Caches', 'com.vendor.app');
    // Uma medida nova da pasta pessoal começa, e o explorador abre uma pasta funda no meio dela.
    const whole = map.list(undefined, { refresh: true });
    const folder = (await map.list(deep))!;
    await whole;
    expect(folder.entries.some((entry) => entry.name === 'deep')).toBe(true);
  });

  it('opens the Trash again after something went into it', async () => {
    await file('.Trash/old.zip', 10_000);
    const map = new DiskMap(home);
    await map.list();
    expect(await map.list(join(home, '.Trash'), { cachedOnly: true })).not.toBeNull();
    map.remove(join(home, 'Library', 'Caches', 'com.vendor.app'), 600_000);
    expect(await map.list(join(home, '.Trash'), { cachedOnly: true })).toBeNull();
  });

  it('notes the folders macOS refused and still measures the rest', async () => {
    const locked = join(home, 'Locked');
    await file('Locked/secret', 10_000);
    await chmod(locked, 0o000);
    try {
      const map = new DiskMap(home);
      const folder = await map.list();
      expect(folder!.entries.some((entry) => entry.name === 'Documents')).toBe(true);
      expect(map.homeSnapshot()!.denied).toContain(locked);
    } finally {
      await chmod(locked, 0o755);
    }
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
    // A fototeca inteira, nunca: o Fotos perderia a biblioteca.
    expect(map.canTrash(join(home, 'Pictures', 'Photos Library.photoslibrary'))).toBe(false);
  });
});
