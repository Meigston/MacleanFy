import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { lstat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AiScanner, refuse } from '../scanner';
import { age, fakeContext, put, sandbox } from '../testing';
import type { AiContext, Found, ProcessInfo } from '../types';
import { automationCollectors } from './automation';

const CHROME_EXE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

describe('automation collectors', () => {
  let box: Awaited<ReturnType<typeof sandbox>>;

  beforeEach(async () => {
    box = await sandbox();
  });

  afterEach(async () => {
    await box.cleanup();
  });

  /** Uma pasta com um arquivo, os dois com a idade pedida em horas. */
  const folder = async (path: string, hoursAgo: number, size = 4096) => {
    await put(join(path, 'data.bin'), size, hoursAgo / 24);
    await age(path, hoursAgo / 24);
    return path;
  };

  const collect = async (id: string, ctx: AiContext) => {
    const collector = automationCollectors.find((c) => c.id === id);
    if (!collector) throw new Error(`no collector ${id}`);
    return collector.collect(ctx);
  };

  const byKey = (items: Found[], label: string, key: string) => items.find((i) => i.label === label && i.key === key);

  describe('remotion', () => {
    it('groups the leftovers of dead renders into one orphan row per kind of folder', async () => {
      const a = await folder(join(box.tmp, 'remotion-v4.0.535-assets04vfbyaqa7'), 5, 10_000);
      const b = await folder(join(box.tmp, 'remotion-v4.0.535-assets0o852pm6b2'), 3, 20_000);
      const c = await folder(join(box.tmp, 'react-motion-render16JF5Z'), 3, 8_000);
      await folder(join(box.tmp, 'node-compile-cache'), 3);
      const ctx = fakeContext(box);

      const items = await collect('remotion', ctx);

      expect(items).toHaveLength(2);
      const assets = byKey(items, 'remotion-v4.0.535-assets', 'orphan')!;
      expect(assets).toMatchObject({ tool: 'remotion', kind: 'temp', junk: 'orphan', safety: 'safe', removal: 'trash', count: 2, project: null, path: b });
      expect(assets.paths?.sort()).toEqual([a, b].sort());
      expect(assets.size).toBeGreaterThanOrEqual(30_000);
      expect(byKey(items, 'react-motion-render', 'orphan')).toMatchObject({ count: 1, paths: [c] });
      for (const path of items.flatMap((i) => i.paths ?? [i.path])) expect(refuse(path, ctx)).toBeNull();
    });

    it('blocks every folder while a render runs, and ignores a shell that only mentions the name', async () => {
      await folder(join(box.tmp, 'remotion-v4.0.535-assetsaaaa'), 5);
      const shell: ProcessInfo = { pid: 8, exe: '/bin/zsh', args: 'zsh -c ls remotion-v4.0.535-assets*' };
      expect((await collect('remotion', fakeContext({ ...box, processes: [shell] })))[0]).toMatchObject({ key: 'orphan', junk: 'orphan' });

      const render: ProcessInfo = { pid: 7, exe: '/opt/homebrew/bin/node', args: 'node /p/video/node_modules/.bin/remotion render src/index.ts' };
      const [only] = await collect('remotion', fakeContext({ ...box, processes: [shell, render] }));
      expect(only).toMatchObject({ key: 'live', blocked: 'in-use' });
      expect(only.junk).toBeUndefined();

      const compositor: ProcessInfo = { pid: 9, exe: '/p/node_modules/@remotion/compositor-darwin-arm64/remotion', args: 'remotion {}' };
      expect((await collect('remotion', fakeContext({ ...box, processes: [compositor] })))[0].blocked).toBe('in-use');
    });

    it('holds back what changed in the last hour even with no render alive', async () => {
      await folder(join(box.tmp, 'remotion-v4.0.535-assetsold'), 2);
      const fresh = await folder(join(box.tmp, 'remotion-v4.0.535-assetsnew'), 0.25);
      const items = await collect('remotion', fakeContext(box));

      expect(byKey(items, 'remotion-v4.0.535-assets', 'orphan')).toMatchObject({ count: 1 });
      expect(byKey(items, 'remotion-v4.0.535-assets', 'live')).toMatchObject({ count: 1, paths: [fresh], blocked: 'recent' });
    });

    it('skips empty leftovers and never looks at outputs or the browser inside a project', async () => {
      const empty = join(box.tmp, 'remotion-v4.0.535-assetsempty');
      await put(join(empty, 'pre-encode/.keep'), 0, 1);
      await age(empty, 1);
      const project = join(box.home, 'code/app/marketing/video');
      await put(join(project, 'node_modules/.remotion/chrome-headless-shell/mac-arm64/chrome-headless-shell'), 50_000, 10);
      await put(join(project, 'saida/horizontal-pt.mp4'), 50_000, 10);
      await put(join(project, 'out/video.mp4'), 50_000, 10);

      const items = await collect('remotion', fakeContext({ ...box, projects: [project] }));
      expect(items).toEqual([]);
    });

    it('checks again for a render right before removing', async () => {
      const dir = await folder(join(box.tmp, 'react-motion-renderAbCdEf'), 4);
      const render: ProcessInfo = { pid: 7, exe: 'node', args: 'node node_modules/@remotion/cli/remotion-cli.js render' };
      let processes: ProcessInfo[] = [];
      const scanner = new AiScanner(automationCollectors, async () => fakeContext({ ...box, processes }));
      const [item] = (await scanner.scan()).items;
      expect(item).toMatchObject({ tool: 'remotion', heat: 'cold', junk: 'orphan' });

      processes = [render];
      expect((await scanner.remove([item.id])).failed).toEqual([{ id: item.id, blocked: 'in-use' }]);
      expect(await lstat(dir)).toBeTruthy();

      processes = [];
      expect((await scanner.remove([item.id])).removed).toBe(1);
      await expect(lstat(dir)).rejects.toThrow();
    });
  });

  describe('chrome-headless', () => {
    const profiles = () => join(box.home, 'Library/Application Support/Google/Chrome-headless');
    const caches = () => join(box.home, 'Library/Caches/Google/Chrome-headless');

    const profile = async (name: string, hoursAgo: number, lockPid?: number) => {
      const dir = join(profiles(), name);
      await put(join(dir, 'Local State'), 30_000, hoursAgo / 24);
      if (lockPid) {
        await symlink(`MacBook-Pro-de-Ana-9.local-${lockPid}`, join(dir, 'SingletonLock'));
        await age(join(dir, 'SingletonLock'), hoursAgo / 24);
      }
      await age(dir, hoursAgo / 24);
      return dir;
    };

    it('joins each profile to its cache by name and keeps caches without a pair', async () => {
      const p1 = await profile('scoped_dirFB00Z1', 48);
      const c1 = await folder(join(caches(), 'scoped_dirFB00Z1'), 48);
      const c2 = await folder(join(caches(), 'scoped_dirdOwgOO'), 300);
      const ctx = fakeContext(box);

      const items = await collect('chrome-headless', ctx);

      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ tool: 'chrome-headless', kind: 'temp', label: 'Chrome-headless', junk: 'orphan', safety: 'safe', count: 2, path: p1 });
      expect(items[0].paths?.sort()).toEqual([p1, c1, c2].sort());
      for (const path of items[0].paths!) expect(refuse(path, ctx)).toBeNull();
    });

    it('holds a profile whose SingletonLock belongs to a live Chrome, not to a reused PID', async () => {
      const held = await profile('scoped_diriJr0tz', 48, 4242);
      const reused = await profile('scoped_dirReused', 48, 5151);
      const chrome: ProcessInfo = { pid: 4242, exe: CHROME_EXE, args: CHROME_EXE };
      const ssh: ProcessInfo = { pid: 5151, exe: '/usr/bin/ssh', args: 'ssh host' };

      const items = await collect('chrome-headless', fakeContext({ ...box, processes: [chrome, ssh] }));

      expect(byKey(items, 'Chrome-headless', 'live')).toMatchObject({ paths: [held], blocked: 'in-use' });
      expect(byKey(items, 'Chrome-headless', 'orphan')).toMatchObject({ paths: [reused], junk: 'orphan' });
    });

    it('holds every scoped_dir while a headless Chrome without --user-data-dir runs', async () => {
      await profile('scoped_dirFB00Z1', 48);
      await folder(join(caches(), 'scoped_dirAAAAAA'), 48);
      const headless: ProcessInfo = { pid: 6, exe: CHROME_EXE, args: `${CHROME_EXE} --headless --screenshot https://example.com` };
      const helper: ProcessInfo = { pid: 7, exe: CHROME_EXE, args: `${CHROME_EXE} --headless --type=renderer` };

      const [only] = await collect('chrome-headless', fakeContext({ ...box, processes: [headless] }));
      expect(only).toMatchObject({ key: 'live', count: 2, blocked: 'in-use' });
      expect((await collect('chrome-headless', fakeContext({ ...box, processes: [helper] })))[0].junk).toBe('orphan');
    });

    it('lists temporary automation profiles by prefix and holds the one a browser has open', async () => {
      const open = await folder(join(box.tmp, 'puppeteer_dev_chrome_profile-Ab12Cd'), 5);
      const left = await folder(join(box.tmp, 'puppeteer_dev_chrome_profile-Zz99Yy'), 5);
      const pw = await folder(join(box.tmp, 'playwright_chromiumdev_profile-x1y2z3'), 30);
      // O navegador recebe o caminho resolvido (/private/var/folders), não o do $TMPDIR.
      const real = open.startsWith('/var/') ? `/private${open}` : open;
      const browser: ProcessInfo = { pid: 3, exe: CHROME_EXE, args: `${CHROME_EXE} --headless=new --user-data-dir=${real} --no-first-run` };

      const items = await collect('chrome-headless', fakeContext({ ...box, processes: [browser] }));

      expect(byKey(items, 'puppeteer_dev_chrome_profile', 'live')).toMatchObject({ paths: [open], blocked: 'in-use' });
      expect(byKey(items, 'puppeteer_dev_chrome_profile', 'orphan')).toMatchObject({ paths: [left], junk: 'orphan' });
      expect(byKey(items, 'playwright_chromiumdev_profile', 'orphan')).toMatchObject({ paths: [pw] });
    });

    it('never offers the Chrome profile, its NativeMessagingHosts or Chrome for Testing', async () => {
      await put(join(box.home, 'Library/Application Support/Google/Chrome/Default/Cookies'), 50_000, 30);
      await put(join(box.home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts/com.anthropic.claude_browser_extension.json'), 400, 30);
      await put(join(box.home, 'Library/Application Support/Google/Chrome for Testing/NativeMessagingHosts/com.openai.codexextension.json'), 400, 30);
      await put(join(box.home, 'Library/Application Support/Google/Chrome for Testing/Crashpad/settings.dat'), 40, 30);
      await put(join(profiles(), 'notes.txt'), 100, 30);

      expect(await collect('chrome-headless', fakeContext(box))).toEqual([]);
    });
  });

  describe('playwright', () => {
    const browsers = () => join(box.home, 'Library/Caches/ms-playwright');

    const revision = async (root: string, name: string, daysAgo = 20) => {
      await put(join(root, name, 'INSTALLATION_COMPLETE'), 10, daysAgo);
      await put(join(root, name, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium'), 100_000, daysAgo);
      return join(root, name);
    };

    it('lists each browser revision and marks the older ones nothing uses as old', async () => {
      const old = await revision(browsers(), 'chromium-1140');
      const current = await revision(browsers(), 'chromium-1148', 2);
      const firefox = await revision(browsers(), 'firefox-1466');
      await put(join(browsers(), 'mcp-chrome-1a2b3c4/Default/Cookies'), 20_000, 1);
      await put(join(browsers(), '.links/0123abcd'), '/nowhere/playwright-core');

      const items = await collect('playwright', fakeContext(box));

      expect(items.map((i) => i.path).sort()).toEqual([old, current, firefox].sort());
      expect(items.find((i) => i.path === old)).toMatchObject({
        tool: 'playwright',
        kind: 'runtime',
        label: 'chromium-1140',
        junk: 'old-version',
        confidence: 'low',
        safety: 'moderate',
        hint: 'redownload',
      });
      expect(items.find((i) => i.path === current)?.junk).toBeUndefined();
      expect(items.find((i) => i.path === firefox)?.junk).toBeUndefined();
    });

    it('keeps an old revision that a linked installation still uses', async () => {
      const old = await revision(browsers(), 'chromium-1140');
      await revision(browsers(), 'chromium-1148');
      const npx = join(box.home, '.npm/_npx/9f8e/node_modules/playwright-core');
      await put(join(npx, 'browsers.json'), JSON.stringify({ browsers: [{ name: 'chromium', revision: '1140' }] }));
      await put(join(browsers(), '.links/9f8e'), npx);

      const items = await collect('playwright', fakeContext(box));
      expect(items.find((i) => i.path === old)?.junk).toBeUndefined();
    });

    it('does not call anything old when an installation sits where reading would ask for permission', async () => {
      const old = await revision(browsers(), 'chromium-1140');
      await revision(browsers(), 'chromium-1148');
      await put(join(browsers(), '.links/aa'), join(box.home, 'Documents/proj/node_modules/playwright-core'));

      expect((await collect('playwright', fakeContext(box))).find((i) => i.path === old)?.junk).toBeUndefined();

      const project = join(box.home, 'Documents/proj');
      await put(join(project, 'node_modules/playwright-core/browsers.json'), JSON.stringify({ browsers: [{ name: 'chromium', revision: '1148' }] }));
      const known = await collect('playwright', fakeContext({ ...box, projects: [project] }));
      expect(known.find((i) => i.path === old)?.junk).toBe('old-version');
    });

    it('follows PLAYWRIGHT_BROWSERS_PATH, and skips browsers kept in node_modules', async () => {
      const custom = join(box.home, 'pw-browsers');
      const inCustom = await revision(custom, 'webkit-2104');
      await revision(browsers(), 'chromium-1148');

      const items = await collect('playwright', fakeContext({ ...box, env: { PLAYWRIGHT_BROWSERS_PATH: `${custom}/` } }));
      expect(items.map((i) => i.path)).toEqual([inCustom]);
      expect(await collect('playwright', fakeContext({ ...box, env: { PLAYWRIGHT_BROWSERS_PATH: '0' } }))).toEqual([]);
    });

    it('treats run artifacts as orphans only with no Playwright alive', async () => {
      const artifacts = await folder(join(box.tmp, 'playwright-artifacts-QwErTy'), 3);
      const [orphan] = await collect('playwright', fakeContext(box));
      expect(orphan).toMatchObject({ kind: 'temp', label: 'playwright-artifacts', paths: [artifacts], junk: 'orphan', safety: 'moderate' });

      const mcp: ProcessInfo = { pid: 4, exe: 'node', args: 'node /Users/ana/.npm/_npx/9f8e/node_modules/@playwright/mcp/cli.js' };
      const [held] = await collect('playwright', fakeContext({ ...box, processes: [mcp] }));
      expect(held).toMatchObject({ key: 'live', blocked: 'in-use' });
    });
  });

  describe('puppeteer', () => {
    const cache = () => join(box.home, '.cache/puppeteer');

    const build = async (root: string, browser: string, name: string, daysAgo = 20) => {
      await put(join(root, browser, name, 'chrome-mac-arm64/binary'), 50_000, daysAgo);
      return join(root, browser, name);
    };

    it('marks every build but the newest of each browser as old', async () => {
      const old = await build(cache(), 'chrome', 'mac_arm-127.0.6533.88');
      const current = await build(cache(), 'chrome', 'mac_arm-131.0.6778.85');
      const shell = await build(cache(), 'chrome-headless-shell', 'mac_arm-127.0.6533.88');
      await writeFile(join(cache(), 'chrome', '.metadata'), '{}');

      const items = await collect('puppeteer', fakeContext(box));

      expect(items.map((i) => i.path).sort()).toEqual([old, current, shell].sort());
      expect(items.find((i) => i.path === old)).toMatchObject({
        tool: 'puppeteer',
        kind: 'runtime',
        label: 'chrome 127.0.6533.88',
        junk: 'old-version',
        confidence: 'low',
        hint: 'redownload',
      });
      expect(items.find((i) => i.path === current)?.junk).toBeUndefined();
      expect(items.find((i) => i.path === shell)?.junk).toBeUndefined();
    });

    it('follows PUPPETEER_CACHE_DIR and ignores one outside the account', async () => {
      const custom = join(box.home, 'pptr');
      const only = await build(custom, 'firefox', 'mac_arm-stable_133.0.3');
      await build(cache(), 'chrome', 'mac_arm-131.0.6778.85');

      expect((await collect('puppeteer', fakeContext({ ...box, env: { PUPPETEER_CACHE_DIR: custom } }))).map((i) => i.path)).toEqual([only]);
      expect(await collect('puppeteer', fakeContext({ ...box, env: { PUPPETEER_CACHE_DIR: '/opt/pptr' } }))).toEqual([]);
    });
  });

  it('reports nothing on an empty account', async () => {
    const result = await new AiScanner(automationCollectors, async () => fakeContext(box)).scan();
    expect(result).toMatchObject({ items: [], failed: [] });
  });
});
