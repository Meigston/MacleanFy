import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, utimes, realpath, access } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BaseScanner } from '../core/scanners/base-scanner';
import { CATEGORIES, type CategoryId, type CleanableItem, type ScanResult } from '../core/types';
import { getDirectoryItems } from '../core/utils';
import { Engine } from './engine';

const DAY = 24 * 60 * 60 * 1000;

/** Scanner de verdade (apaga pelo caminho do núcleo), só que apontado para uma pasta de teste. */
class FolderScanner extends BaseScanner {
  category;

  constructor(
    id: CategoryId,
    private readonly dir: string,
    private readonly extra: CleanableItem[] = []
  ) {
    super();
    this.category = CATEGORIES[id];
  }

  async scan(): Promise<ScanResult> {
    return this.createResult([...(await getDirectoryItems(this.dir)), ...this.extra]);
  }
}

class BrokenScanner extends BaseScanner {
  category = CATEGORIES['docker'];

  async scan(): Promise<ScanResult> {
    throw new Error('docker is not running');
  }
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false
  );

async function age(path: string, ms: number): Promise<void> {
  const when = new Date(Date.now() - ms);
  await utimes(path, when, when);
}

describe('Engine', () => {
  let root: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'mfy-engine-')));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('scans the requested categories and reports each one as it finishes', async () => {
    await writeFile(join(root, 'a.log'), 'x'.repeat(100));
    const engine = new Engine({
      'system-logs': new FolderScanner('system-logs', root),
      trash: new FolderScanner('trash', root),
    });

    const progress: string[] = [];
    const results = await engine.scan(['system-logs'], (p) => progress.push(`${p.completed}/${p.total}`));

    expect(results).toHaveLength(1);
    expect(results[0].categoryId).toBe('system-logs');
    expect(results[0].items.map((item) => item.name)).toEqual(['a.log']);
    expect(results[0].totalSize).toBe(100);
    expect(typeof results[0].items[0].modifiedAt).toBe('number');
    expect(progress).toEqual(['1/1']);
  });

  it('turns a scanner failure into an empty result with the error attached', async () => {
    const engine = new Engine({ docker: new BrokenScanner() });

    const [result] = await engine.scan(undefined);

    expect(result.items).toEqual([]);
    expect(result.error).toBe('docker is not running');
  });

  it('drops items in protected system paths from the result', async () => {
    await writeFile(join(root, 'ok.log'), 'x');
    const protectedItem: CleanableItem = { path: '/var/log/system.log', name: 'system.log', size: 5000, isDirectory: false };
    const engine = new Engine({ 'system-logs': new FolderScanner('system-logs', root, [protectedItem]) });

    const [result] = await engine.scan(undefined);

    expect(result.items.map((item) => item.name)).toEqual(['ok.log']);
    expect(result.totalSize).toBe(1);
  });

  describe('temporary files', () => {
    it('offers only what has been idle for over a day', async () => {
      await writeFile(join(root, 'stale.tmp'), 'old');
      await age(join(root, 'stale.tmp'), 3 * DAY);
      await writeFile(join(root, 'fresh.tmp'), 'new');

      const engine = new Engine({ 'temp-files': new FolderScanner('temp-files', root) });
      const [result] = await engine.scan(undefined);

      expect(result.items.map((item) => item.name)).toEqual(['stale.tmp']);
    });

    it('keeps an old folder that still has recent activity inside', async () => {
      const dir = join(root, 'session');
      await mkdir(join(dir, 'deep'), { recursive: true });
      await writeFile(join(dir, 'deep', 'in-use.txt'), 'now');
      await age(join(dir, 'deep'), 5 * DAY);
      await age(dir, 5 * DAY);

      const engine = new Engine({ 'temp-files': new FolderScanner('temp-files', root) });
      const [result] = await engine.scan(undefined);

      expect(result.items).toEqual([]);
    });

    it('never offers a socket, however old the folder around it is', async () => {
      const dir = join(root, 'agent');
      await mkdir(dir);
      // Caminho de soquete tem limite de ~104 bytes no macOS; daí o nome curto.
      const socketPath = join(dir, 's.sock');

      const server: Server = createServer();
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      try {
        // O soquete também é envelhecido: só o tipo dele pode tirá-lo da lista.
        await age(socketPath, 5 * DAY);
        await age(dir, 5 * DAY);

        const engine = new Engine({ 'temp-files': new FolderScanner('temp-files', root) });
        const [result] = await engine.scan(undefined);

        expect(result.items).toEqual([]);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  describe('clean', () => {
    it('removes exactly the selected items and reports the space freed', async () => {
      await writeFile(join(root, 'remove.log'), 'x'.repeat(300));
      await writeFile(join(root, 'keep.log'), 'y'.repeat(200));
      const engine = new Engine({ 'system-logs': new FolderScanner('system-logs', root) });
      await engine.scan(undefined);

      const progress: Array<string | undefined> = [];
      const summary = await engine.clean(
        [{ categoryId: 'system-logs', paths: [join(root, 'remove.log')] }],
        {},
        (p) => progress.push(p.categoryId)
      );

      expect(summary.totalCleanedItems).toBe(1);
      expect(summary.totalFreedSpace).toBe(300);
      expect(summary.totalErrors).toBe(0);
      expect(summary.dryRun).toBe(false);
      expect(await exists(join(root, 'remove.log'))).toBe(false);
      expect(await exists(join(root, 'keep.log'))).toBe(true);
      expect(progress[0]).toBe('system-logs');
      expect(progress.at(-1)).toBeUndefined();
    });

    it('reports the bytes removed as it goes, from zero to the whole selection', async () => {
      const logs = join(root, 'logs');
      const caches = join(root, 'caches');
      await mkdir(join(logs, 'old', 'deep'), { recursive: true });
      await mkdir(caches);
      await writeFile(join(logs, 'old', 'a.log'), 'x'.repeat(3000));
      await writeFile(join(logs, 'old', 'deep', 'b.log'), 'x'.repeat(2000));
      await writeFile(join(caches, 'c.bin'), 'x'.repeat(1000));
      const engine = new Engine({
        'system-logs': new FolderScanner('system-logs', logs),
        'system-cache': new FolderScanner('system-cache', caches),
      });
      const scanned = await engine.scan(undefined);
      const selection = scanned.map((result) => ({
        categoryId: result.categoryId,
        paths: result.items.map((item) => item.path),
      }));
      const expected = scanned.reduce((sum, result) => sum + result.totalSize, 0);

      const seen: Array<{ doneBytes: number; totalBytes: number }> = [];
      const summary = await engine.clean(selection, {}, (p) => seen.push(p));

      expect(summary.totalFreedSpace).toBe(expected);
      expect(seen.every((p) => p.totalBytes === expected)).toBe(true);
      expect(seen[0].doneBytes).toBe(0);
      expect(seen.at(-1)?.doneBytes).toBe(expected);
      // Nunca volta, e passa por pelo menos um ponto no meio do caminho.
      expect(seen.map((p) => p.doneBytes)).toEqual([...seen.map((p) => p.doneBytes)].sort((a, b) => a - b));
      expect(seen.some((p) => p.doneBytes > 0 && p.doneBytes < expected)).toBe(true);
      expect(await exists(join(logs, 'old'))).toBe(false);
      expect(await exists(join(caches, 'c.bin'))).toBe(false);
    });

    it('reports the selection whole on a dry run without deleting it', async () => {
      await writeFile(join(root, 'stay.log'), 'x'.repeat(700));
      const engine = new Engine({ 'system-logs': new FolderScanner('system-logs', root) });
      await engine.scan(undefined);

      const seen: number[] = [];
      await engine.clean(
        [{ categoryId: 'system-logs', paths: [join(root, 'stay.log')] }],
        { dryRun: true },
        (p) => seen.push(p.doneBytes)
      );

      expect(seen[0]).toBe(0);
      expect(seen.at(-1)).toBe(700);
      expect(await exists(join(root, 'stay.log'))).toBe(true);
    });

    it('ignores paths that did not come from the last scan', async () => {
      await writeFile(join(root, 'listed.log'), 'x');
      const outside = await realpath(await mkdtemp(join(tmpdir(), 'macleanfy-outside-')));
      await writeFile(join(outside, 'precious.txt'), 'do not delete');

      try {
        const engine = new Engine({ 'system-logs': new FolderScanner('system-logs', root) });
        await engine.scan(undefined);

        const summary = await engine.clean([
          { categoryId: 'system-logs', paths: [join(outside, 'precious.txt'), outside] },
        ]);

        expect(summary.totalCleanedItems).toBe(0);
        expect(await exists(join(outside, 'precious.txt'))).toBe(true);
        expect(engine.knows(join(outside, 'precious.txt'))).toBe(false);
        expect(engine.knows(join(root, 'listed.log'))).toBe(true);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });

    it('does nothing for a category that was never scanned', async () => {
      await writeFile(join(root, 'a.log'), 'x');
      const engine = new Engine({ 'system-logs': new FolderScanner('system-logs', root) });

      const summary = await engine.clean([{ categoryId: 'system-logs', paths: [join(root, 'a.log')] }]);

      expect(summary.totalCleanedItems).toBe(0);
      expect(await exists(join(root, 'a.log'))).toBe(true);
    });

    it('walks through a dry run without deleting, and lets the real run follow', async () => {
      const file = join(root, 'a.log');
      await writeFile(file, 'x'.repeat(50));
      const engine = new Engine({ 'system-logs': new FolderScanner('system-logs', root) });
      await engine.scan(undefined);
      const selection = [{ categoryId: 'system-logs' as const, paths: [file] }];

      const simulated = await engine.clean(selection, { dryRun: true });
      expect(simulated.dryRun).toBe(true);
      expect(simulated.totalFreedSpace).toBe(50);
      expect(await exists(file)).toBe(true);

      const real = await engine.clean(selection);
      expect(real.totalCleanedItems).toBe(1);
      expect(await exists(file)).toBe(false);
    });

    it('requires a new scan after a real clean', async () => {
      await writeFile(join(root, 'a.log'), 'x');
      await writeFile(join(root, 'b.log'), 'y');
      const engine = new Engine({ 'system-logs': new FolderScanner('system-logs', root) });
      await engine.scan(undefined);

      await engine.clean([{ categoryId: 'system-logs', paths: [join(root, 'a.log')] }]);
      const second = await engine.clean([{ categoryId: 'system-logs', paths: [join(root, 'b.log')] }]);

      expect(second.totalCleanedItems).toBe(0);
      expect(await exists(join(root, 'b.log'))).toBe(true);
    });
  });
});
