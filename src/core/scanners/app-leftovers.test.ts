import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  AppLeftoversScanner,
  bundleIdOf,
  distinctiveWords,
  isNeverDeleted,
  normalizeName,
  vendorOf,
  type InstalledApps,
} from './app-leftovers.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-14T12:00:00Z');

/** A full-looking Mac: the scanner refuses to judge with fewer than ten apps. */
const SYSTEM_APPS = Array.from({ length: 12 }, (_, i) => ({ id: `com.apple.app${i}`, name: `System App ${i}` }));

/** Installed apps as `id` or `id=Name`. */
function apps(installed: string[], resolvable: string[] = []): InstalledApps {
  const listed = installed.map((entry) => {
    const [id, name] = entry.split('=');
    return { id, name: name ?? id.split('.').pop() ?? id };
  });
  return {
    list: async () => [...SYSTEM_APPS, ...listed],
    resolvable: async (ids) => new Set(ids.filter((id) => resolvable.includes(id))),
  };
}

describe('bundleIdOf', () => {
  it('reads the identifier from every way Library names an entry', () => {
    expect(bundleIdOf('com.DanPristupov.Fork')).toBe('com.DanPristupov.Fork');
    expect(bundleIdOf('com.DanPristupov.Fork.plist')).toBe('com.DanPristupov.Fork');
    expect(bundleIdOf('com.DanPristupov.Fork.binarycookies')).toBe('com.DanPristupov.Fork');
    expect(bundleIdOf('com.sublimetext.4.savedState')).toBe('com.sublimetext.4');
    expect(bundleIdOf('com.vendor.app.0F3B2C1D-1111-2222-3333-444455556666.plist')).toBe('com.vendor.app');
  });

  it('refuses names that are not bundle identifiers', () => {
    expect(bundleIdOf('Google')).toBeNull();
    expect(bundleIdOf('chrome_crashpad_handler')).toBeNull();
    expect(bundleIdOf('com.vendor')).toBeNull();
    expect(bundleIdOf('.DS_Store')).toBeNull();
  });
});

describe('vendorOf', () => {
  it('takes the first two parts, or three on hosts shared by many developers', () => {
    expect(vendorOf('com.microsoft.OneDrive')).toBe('com.microsoft');
    expect(vendorOf('com.github.someone.Tool')).toBe('com.github.someone');
    expect(vendorOf('com.electron.dockerdesktop')).toBe('com.electron.dockerdesktop');
  });
});

describe('distinctiveWords', () => {
  it('keeps the words that could name an app folder', () => {
    expect(distinctiveWords('com.trae.app')).toEqual(['trae']);
    expect(distinctiveWords('com.lemonmojo.RoyalTSX.App')).toEqual(['lemonmojo', 'royaltsx']);
    expect(distinctiveWords('com.sublimetext.4')).toEqual(['sublimetext']);
    expect(distinctiveWords('com.vendor.mac.helper')).toEqual(['vendor']);
  });

  it('meets folder names halfway', () => {
    expect(normalizeName('Royal TSX')).toBe('royaltsx');
    expect(normalizeName('Sublime Text')).toBe('sublimetext');
  });
});

describe('isNeverDeleted', () => {
  it('protects Apple, password managers and the Electron default', () => {
    expect(isNeverDeleted('com.apple.Safari')).toBe(true);
    expect(isNeverDeleted('com.agilebits.onepassword7')).toBe(true);
    expect(isNeverDeleted('com.github.Electron')).toBe(true);
    expect(isNeverDeleted('com.DanPristupov.Fork')).toBe(false);
  });
});

describe('AppLeftoversScanner', () => {
  let home: string;
  let library: string;
  let empty: string;

  async function entry(relative: string, ageDays: number, directory = false): Promise<string> {
    const path = join(library, relative);
    if (directory) {
      await mkdir(path, { recursive: true });
      await writeFile(join(path, 'data'), 'x'.repeat(100));
      await utimes(join(path, 'data'), new Date(NOW - ageDays * DAY), new Date(NOW - ageDays * DAY));
    } else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, 'x'.repeat(10));
    }
    await utimes(path, new Date(NOW - ageDays * DAY), new Date(NOW - ageDays * DAY));
    return path;
  }

  function scanner(installed: InstalledApps, vendorFolders: string[] = [empty]) {
    return new AppLeftoversScanner({ home, apps: installed, vendorFolders, now: () => NOW });
  }

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'leftovers-'));
    library = join(home, 'Library');
    empty = join(home, 'no-agents');
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('lists every entry of an app that is gone', async () => {
    await entry('HTTPStorages/com.DanPristupov.Fork', 200, true);
    await entry('WebKit/com.DanPristupov.Fork', 200, true);
    await entry('Preferences/com.DanPristupov.Fork.plist', 200);
    await entry('Caches/com.DanPristupov.Fork', 300, true);
    await entry('Application Support/com.DanPristupov.Fork', 300, true);

    const result = await scanner(apps([])).scan();

    expect(result.error).toBeUndefined();
    expect(result.items.map((item) => item.path.slice(library.length + 1)).sort()).toEqual([
      'Application Support/com.DanPristupov.Fork',
      'Caches/com.DanPristupov.Fork',
      'HTTPStorages/com.DanPristupov.Fork',
      'Preferences/com.DanPristupov.Fork.plist',
      'WebKit/com.DanPristupov.Fork',
    ]);
    expect(result.items.every((item) => item.name === 'com.DanPristupov.Fork')).toBe(true);
    expect(result.totalSize).toBeGreaterThan(0);
  });

  it('takes the folder an app named after itself', async () => {
    await entry('HTTPStorages/com.trae.app', 200, true);
    await entry('Application Support/Trae', 250, true);
    await entry('HTTPStorages/com.lemonmojo.RoyalTSX.App', 400, true);
    await entry('Application Support/Royal TSX', 400, true);

    const result = await scanner(apps([])).scan();
    const found = Object.fromEntries(result.items.map((item) => [item.path.slice(library.length + 1), item.name]));
    expect(found).toEqual({
      'HTTPStorages/com.trae.app': 'com.trae.app',
      'Application Support/Trae': 'com.trae.app',
      'HTTPStorages/com.lemonmojo.RoyalTSX.App': 'com.lemonmojo.RoyalTSX.App',
      'Application Support/Royal TSX': 'com.lemonmojo.RoyalTSX.App',
    });
  });

  it('never takes a folder whose name belongs to an installed app', async () => {
    await entry('HTTPStorages/com.oldvendor.Notes', 200, true);
    await entry('HTTPStorages/com.oldvendor.Postman', 200, true);
    await entry('Application Support/Postman', 200, true);
    await entry('Application Support/Notes', 200, true);

    const result = await scanner(apps(['com.postmanlabs.mac=Postman'])).scan();
    expect(result.items.map((item) => item.path.slice(library.length + 1)).sort()).toEqual([
      'HTTPStorages/com.oldvendor.Notes',
      'HTTPStorages/com.oldvendor.Postman',
    ]);
  });

  it('skips the whole app when its named folder changed recently', async () => {
    await entry('HTTPStorages/com.trae.app', 200, true);
    await entry('Application Support/Trae', 3, true);

    expect((await scanner(apps([])).scan()).items).toEqual([]);
  });

  it('keeps the data of installed apps', async () => {
    await entry('HTTPStorages/com.lwouis.alt-tab-macos', 200, true);
    await entry('Preferences/com.lwouis.alt-tab-macos.plist', 200);

    expect((await scanner(apps(['com.lwouis.alt-tab-macos'])).scan()).items).toEqual([]);
  });

  it('keeps an identifier whose vendor still has an app installed', async () => {
    await entry('HTTPStorages/com.microsoft.OneDriveStandaloneUpdater', 200, true);

    expect((await scanner(apps(['com.microsoft.edgemac'])).scan()).items).toEqual([]);
  });

  it('keeps an identifier whose vendor still runs a launchd job', async () => {
    const agents = join(home, 'agents');
    await mkdir(agents);
    await writeFile(join(agents, 'com.wmsystem.printagent.plist'), '');
    await entry('HTTPStorages/com.wmsystem.console', 200, true);

    expect((await scanner(apps([]), [agents]).scan()).items).toEqual([]);
  });

  it('keeps what Launch Services still finds, like apps nested in other apps', async () => {
    await entry('HTTPStorages/com.electron.dockerdesktop', 200, true);

    expect((await scanner(apps([], ['com.electron.dockerdesktop'])).scan()).items).toEqual([]);
  });

  it('never trusts folder names alone', async () => {
    // Java preferences and analytics SDKs: no app ever had these identifiers.
    await entry('Preferences/serpro.ppgd.irpf.plist', 200);
    await entry('Preferences/com.firebase.FIRInstallations.plist', 300);
    await entry('Caches/io.branch.network.cache', 300, true);

    expect((await scanner(apps([])).scan()).items).toEqual([]);
  });

  it('skips an app touched in the last 30 days, all of its entries together', async () => {
    await entry('HTTPStorages/lo.cafe.NotchNook', 12, true);
    await entry('Preferences/lo.cafe.NotchNook.plist', 11);
    await entry('WebKit/lo.cafe.NotchNook', 110, true);

    expect((await scanner(apps([])).scan()).items).toEqual([]);
  });

  it('looks inside folders for the latest change', async () => {
    const cache = await entry('HTTPStorages/com.trae.app', 200, true);
    await utimes(join(cache, 'data'), new Date(NOW - 2 * DAY), new Date(NOW - 2 * DAY));

    expect((await scanner(apps([])).scan()).items).toEqual([]);
  });

  it('never lists what is on the never-delete list', async () => {
    await entry('HTTPStorages/com.agilebits.onepassword7', 400, true);
    await entry('Preferences/com.agilebits.onepassword7.plist', 400);

    expect((await scanner(apps([])).scan()).items).toEqual([]);
  });

  it('reports nothing when it cannot see the installed apps', async () => {
    await entry('HTTPStorages/com.DanPristupov.Fork', 200, true);
    const blind: InstalledApps = { list: async () => [], resolvable: async () => new Set() };

    const result = await scanner(blind).scan();
    expect(result.items).toEqual([]);
    expect(result.error).toBeDefined();
  });

  it('keeps everything when Launch Services cannot be asked', async () => {
    await entry('HTTPStorages/com.DanPristupov.Fork', 200, true);
    const failing: InstalledApps = {
      list: async () => SYSTEM_APPS,
      resolvable: async () => {
        throw new Error('osascript failed');
      },
    };

    expect((await scanner(failing).scan()).items).toEqual([]);
  });
});
