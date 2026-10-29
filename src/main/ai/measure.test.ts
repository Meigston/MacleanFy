import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { measure } from './measure';

describe('measure', () => {
  let root: string;

  async function file(relative: string, bytes: number, days = 0) {
    const path = join(root, relative);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, Buffer.alloc(bytes, 1));
    const when = new Date(Date.UTC(2026, 9, 29) - days * 86_400_000);
    await utimes(path, when, when);
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'macleanfy-measure-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('adds up a folder, counts its files and finds the newest one', async () => {
    await file('a/old.jsonl', 40_000, 30);
    await file('a/b/c/new.jsonl', 20_000, 2);
    await file('top.log', 10_000, 9);

    const result = await measure(root);

    expect(result.files).toBe(3);
    expect(result.size).toBeGreaterThanOrEqual(70_000);
    expect(result.newest).toBe(Date.UTC(2026, 9, 29) - 2 * 86_400_000);
  });

  it('measures a single file', async () => {
    await file('one.bin', 8_192, 1);
    const result = await measure(join(root, 'one.bin'));
    expect(result).toEqual({ size: expect.any(Number), newest: Date.UTC(2026, 9, 28), files: 1 });
    expect(result.size).toBeGreaterThanOrEqual(8_192);
  });

  it('does not follow links out of what it measures', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'macleanfy-outside-'));
    try {
      await writeFile(join(outside, 'big.bin'), Buffer.alloc(500_000, 1));
      await mkdir(join(root, 'dir'));
      await symlink(outside, join(root, 'dir', 'link'));
      const result = await measure(root);
      expect(result.size).toBeLessThan(10_000);
      expect(result.files).toBe(1);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('reports nothing for a path that is not there', async () => {
    expect(await measure(join(root, 'missing'))).toEqual({ size: 0, newest: 0, files: 0 });
  });
});
