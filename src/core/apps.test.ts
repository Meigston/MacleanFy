import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { getBundleId, findRelatedPaths, listInstalledApps, uninstallApps, type AppInfo } from './apps.js';

const plist = (bundleId: string) =>
  `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>${bundleId}</string></dict></plist>`;

describe('apps', () => {
  let root: string;
  let home: string;
  let appsDir: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'macleanfy-apps-')));
    home = join(root, 'home');
    appsDir = join(root, 'Applications');

    await mkdir(join(appsDir, 'Demo App.app', 'Contents'), { recursive: true });
    await writeFile(join(appsDir, 'Demo App.app', 'Contents', 'Info.plist'), plist('com.example.demo'));
    await writeFile(join(appsDir, 'Demo App.app', 'Contents', 'binary'), 'x'.repeat(2048));
    await writeFile(join(appsDir, 'not-an-app.txt'), 'ignored');

    await mkdir(join(home, 'Library', 'Application Support', 'Demo App'), { recursive: true });
    await writeFile(join(home, 'Library', 'Application Support', 'Demo App', 'data.db'), 'y'.repeat(1024));
    await mkdir(join(home, 'Library', 'Caches', 'com.example.demo'), { recursive: true });
    await mkdir(join(home, 'Library', 'Caches', 'com.example.other'), { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads the bundle id from Info.plist', async () => {
    expect(await getBundleId(join(appsDir, 'Demo App.app'))).toBe('com.example.demo');
  });

  it('returns null for a missing or malformed bundle id', async () => {
    expect(await getBundleId(join(appsDir, 'Missing.app'))).toBeNull();

    await mkdir(join(appsDir, 'Bad.app', 'Contents'), { recursive: true });
    await writeFile(join(appsDir, 'Bad.app', 'Contents', 'Info.plist'), plist('../../etc'));
    expect(await getBundleId(join(appsDir, 'Bad.app'))).toBeNull();
  });

  it('finds related paths by app name and bundle id only', async () => {
    const related = await findRelatedPaths('Demo App', 'com.example.demo', home);

    expect(related).toContain(join(home, 'Library', 'Application Support', 'Demo App'));
    expect(related).toContain(join(home, 'Library', 'Caches', 'com.example.demo'));
    expect(related).not.toContain(join(home, 'Library', 'Caches', 'com.example.other'));
  });

  it('lists a folder once even when several name spellings reach it', async () => {
    const related = await findRelatedPaths('Demo App', 'com.example.demo', home);
    const spellings = related.map((path) => path.toLowerCase());

    expect(new Set(spellings).size).toBe(related.length);
    expect(spellings.filter((path) => path.endsWith('application support/demo app'))).toHaveLength(1);
  });

  it('lists apps with sizes and reports progress', async () => {
    const progress: Array<[number, number]> = [];
    const apps = await listInstalledApps({
      appDirs: [appsDir, join(root, 'does-not-exist')],
      home,
      onProgress: (completed, total) => progress.push([completed, total]),
    });

    expect(apps).toHaveLength(1);
    expect(apps[0].name).toBe('Demo App');
    expect(apps[0].bundleId).toBe('com.example.demo');
    expect(apps[0].size).toBeGreaterThanOrEqual(2048);
    expect(apps[0].related.map((r) => r.path)).toContain(join(home, 'Library', 'Application Support', 'Demo App'));
    expect(apps[0].totalSize).toBe(apps[0].size + apps[0].related.reduce((sum, r) => sum + r.size, 0));
    expect(progress).toEqual([[1, 1]]);
  });

  it('removes the bundle and its related files, summing what was freed', async () => {
    const [app] = await listInstalledApps({ appDirs: [appsDir], home });
    const removed: string[] = [];

    const result = await uninstallApps([app], async (path) => {
      removed.push(path);
      return true;
    });

    expect(result.uninstalled).toBe(1);
    expect(result.errors).toEqual([]);
    expect(result.freedSpace).toBe(app.totalSize);
    expect(removed[0]).toBe(app.path);
    expect(removed).toHaveLength(1 + app.related.length);
  });

  it('keeps related files when the bundle itself cannot be removed', async () => {
    const [app] = await listInstalledApps({ appDirs: [appsDir], home });
    const removed: string[] = [];

    const result = await uninstallApps([app], async (path) => {
      removed.push(path);
      return false;
    });

    expect(result.uninstalled).toBe(0);
    expect(result.freedSpace).toBe(0);
    expect(result.errors).toEqual(['Demo App']);
    expect(removed).toEqual([app.path]);
  });

  it('never hands a protected system path to the remover', async () => {
    const systemApp: AppInfo = {
      name: 'Terminal',
      path: '/Applications/Utilities/Terminal.app',
      bundleId: 'com.apple.Terminal',
      size: 10,
      related: [],
      totalSize: 10,
    };
    const removed: string[] = [];

    const result = await uninstallApps([systemApp], async (path) => {
      removed.push(path);
      return true;
    });

    expect(removed).toEqual([]);
    expect(result.errors).toEqual(['Terminal']);
  });
});
