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
    const related = (await findRelatedPaths('Demo App', 'com.example.demo', home)).map((entry) => entry.path);

    expect(related).toContain(join(home, 'Library', 'Application Support', 'Demo App'));
    expect(related).toContain(join(home, 'Library', 'Caches', 'com.example.demo'));
    expect(related).not.toContain(join(home, 'Library', 'Caches', 'com.example.other'));
  });

  it('lists a folder once even when several name spellings reach it', async () => {
    const related = await findRelatedPaths('Demo App', 'com.example.demo', home);
    const spellings = related.map((entry) => entry.path.toLowerCase());

    expect(new Set(spellings).size).toBe(related.length);
    expect(spellings.filter((path) => path.endsWith('application support/demo app'))).toHaveLength(1);
  });

  it('also finds per-host preferences, cookies and the login agent', async () => {
    const library = join(home, 'Library');
    await mkdir(join(library, 'Preferences', 'ByHost'), { recursive: true });
    await writeFile(join(library, 'Preferences', 'ByHost', 'com.example.demo.0F3B2C1D-1111-2222-3333-444455556666.plist'), '');
    await writeFile(join(library, 'Preferences', 'ByHost', 'com.example.other.0F3B2C1D-1111-2222-3333-444455556666.plist'), '');
    await mkdir(join(library, 'HTTPStorages'), { recursive: true });
    await writeFile(join(library, 'HTTPStorages', 'com.example.demo.binarycookies'), '');
    await mkdir(join(library, 'LaunchAgents'), { recursive: true });
    await writeFile(join(library, 'LaunchAgents', 'com.example.demo.plist'), '');
    await writeFile(join(library, 'LaunchAgents', 'com.example.demo.updater.plist'), '');
    await writeFile(join(library, 'LaunchAgents', 'com.example.demolition.plist'), '');

    const related = (await findRelatedPaths('Demo App', 'com.example.demo', home)).map((entry) =>
      entry.path.slice(library.length + 1)
    );

    expect(related).toEqual(
      expect.arrayContaining([
        'Preferences/ByHost/com.example.demo.0F3B2C1D-1111-2222-3333-444455556666.plist',
        'HTTPStorages/com.example.demo.binarycookies',
        'LaunchAgents/com.example.demo.plist',
        'LaunchAgents/com.example.demo.updater.plist',
      ])
    );
    expect(related).not.toContain('Preferences/ByHost/com.example.other.0F3B2C1D-1111-2222-3333-444455556666.plist');
    expect(related).not.toContain('LaunchAgents/com.example.demolition.plist');
  });

  it('tells settings and documents apart from caches', async () => {
    const related = await findRelatedPaths('Demo App', 'com.example.demo', home);
    const personal = Object.fromEntries(related.map((entry) => [entry.path.slice(home.length + 1), entry.personal]));

    expect(personal).toEqual({
      'Library/Application Support/Demo App': true,
      'Library/Caches/com.example.demo': false,
    });
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

  it('can leave settings and documents behind for a reinstall', async () => {
    const [app] = await listInstalledApps({ appDirs: [appsDir], home });
    const removed: string[] = [];

    const result = await uninstallApps(
      [app],
      async (path) => {
        removed.push(path);
        return true;
      },
      { keepPersonal: true }
    );

    const kept = app.related.filter((entry) => entry.personal);
    expect(kept.map((entry) => entry.path)).toEqual([join(home, 'Library', 'Application Support', 'Demo App')]);
    expect(removed).toEqual([app.path, join(home, 'Library', 'Caches', 'com.example.demo')]);
    expect(result.freedSpace).toBe(app.totalSize - kept.reduce((sum, entry) => sum + entry.size, 0));
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
