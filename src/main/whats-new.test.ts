import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { firstLaunchOf } from './whats-new';

describe('firstLaunchOf', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'macleanfy-whats-new-'));
    file = join(dir, 'data', 'last-version');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('answers the version on a first install, and nothing on the next launch', async () => {
    expect(await firstLaunchOf('0.1.4', file)).toBe('0.1.4');
    expect(await readFile(file, 'utf-8')).toBe('0.1.4');
    expect(await firstLaunchOf('0.1.4', file)).toBeNull();
  });

  it('answers again after an update, beta included', async () => {
    await firstLaunchOf('0.1.4-beta.1', file);
    expect(await firstLaunchOf('0.1.4', file)).toBe('0.1.4');
    expect(await firstLaunchOf('0.1.5', file)).toBe('0.1.5');
  });

  it('ignores a trailing newline left by hand', async () => {
    await firstLaunchOf('0.1.4', file);
    await writeFile(file, '0.1.4\n');
    expect(await firstLaunchOf('0.1.4', file)).toBeNull();
  });

  it('stays quiet when it cannot write down the version', async () => {
    const blocked = join(dir, 'not-a-folder');
    await writeFile(blocked, '');
    expect(await firstLaunchOf('0.1.4', join(blocked, 'last-version'))).toBeNull();
  });
});
