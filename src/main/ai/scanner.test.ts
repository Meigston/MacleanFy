import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { AiScanner, refuse } from './scanner';
import { DAY, NOW, fakeContext, put, sandbox } from './testing';
import type { AiContext, Collector, Found } from './types';

describe('AiScanner', () => {
  let box: Awaited<ReturnType<typeof sandbox>>;

  beforeEach(async () => {
    box = await sandbox();
  });

  afterEach(async () => {
    await box.cleanup();
  });

  const item = (path: string, extra: Partial<Found> = {}): Found => ({
    tool: 'claude-code',
    kind: 'cache',
    label: 'x',
    project: null,
    path,
    size: 1000,
    count: 1,
    lastUsed: NOW - 30 * DAY,
    safety: 'safe',
    removal: 'trash',
    ...extra,
  });

  const scanner = (found: Found[], ctx: AiContext = fakeContext(box)) => {
    const collector: Collector = { id: 'fixture', collect: async () => found };
    return new AiScanner([collector], async () => ctx);
  };

  it('marks cold by the last use, and junk as cold whatever its age', async () => {
    const result = await scanner([
      item(join(box.home, 'a'), { lastUsed: NOW - 30 * DAY }),
      item(join(box.home, 'b'), { lastUsed: NOW - 2 * DAY }),
      item(join(box.home, 'c'), { lastUsed: NOW - 60_000, junk: 'orphan' }),
    ]).scan();
    const heat = Object.fromEntries(result.items.map((i) => [i.label === 'x' ? i.path.slice(-1) : '', i.heat]));
    expect(heat).toEqual({ a: 'cold', b: 'hot', c: 'cold' });
  });

  it('keeps two items with the same path apart by key, and drops what sits inside another item', async () => {
    const folder = join(box.home, '.claude/projects/-p');
    const result = await scanner([
      item(folder, { key: 'cold', kind: 'sessions', paths: [join(folder, 'a.jsonl')] }),
      item(folder, { key: 'hot', kind: 'sessions', paths: [join(folder, 'b.jsonl')] }),
      item(join(box.home, 'big')),
      item(join(box.home, 'big/inner')),
    ]).scan();
    expect(result.items.map((i) => i.id).sort()).toEqual([`${folder}#cold`, `${folder}#hot`, join(box.home, 'big')].sort());
  });

  it('blocks what a live process uses and treats it as hot', async () => {
    const path = join(box.home, '.local/share/claude/versions/2.1.300');
    const ctx = fakeContext({ ...box, processes: [{ pid: 9, exe: path, args: path }] });
    const [only] = (await scanner([item(path, { kind: 'versions', junk: 'old-version' })], ctx).scan()).items;
    expect(only.blocked).toBe('in-use');
    expect(only.heat).toBe('hot');
  });

  it('removes only what the last scan listed, to the Trash, and skips blocked items', async () => {
    const ctx = fakeContext(box);
    const free = await put(join(box.home, '.claude/downloads/setup.bin'), 2000, 20);
    const held = await put(join(box.home, '.claude/jobs/1/tmp/x'), 2000, 20);
    const s = scanner([item(free), item(join(box.home, '.claude/jobs/1/tmp'), { blocked: 'live-session' })], ctx);
    await s.scan();

    const result = await s.remove([free, join(box.home, '.claude/jobs/1/tmp'), join(box.home, 'never-listed')]);

    expect(result.removed).toBe(1);
    expect(result.failed).toEqual([
      { id: join(box.home, '.claude/jobs/1/tmp'), blocked: 'live-session' },
      { id: join(box.home, 'never-listed') },
    ]);
    expect(ctx.trashed).toEqual([free]);
    expect(await lstat(held)).toBeTruthy();
  });

  it('asks the item to check again right before removing it', async () => {
    const path = await put(join(box.home, 'wt/file'), 10);
    const s = scanner([item(join(box.home, 'wt'), { removal: 'git', recheck: async () => 'uncommitted', remove: async () => {} })]);
    await s.scan();
    expect((await s.remove([join(box.home, 'wt')])).failed).toEqual([{ id: join(box.home, 'wt'), blocked: 'uncommitted' }]);
    expect(await lstat(path)).toBeTruthy();
  });

  it('reports the collector that failed and keeps the others', async () => {
    const broken: Collector = { id: 'broken', collect: async () => Promise.reject(new Error('boom')) };
    const fine: Collector = { id: 'fine', collect: async () => [item(join(box.home, 'ok'))] };
    const result = await new AiScanner([broken, fine], async () => fakeContext(box)).scan();
    expect(result.failed).toEqual(['broken']);
    expect(result.items).toHaveLength(1);
  });
});

describe('refuse', () => {
  const ctx = fakeContext({ home: '/Users/ana', tmp: '/var/folders/xy/T', projects: ['/Users/ana/code/app', '/Users/ana/code/app/.claude/worktrees/feat'] });

  it('lets through a session, a cache and a worktree', () => {
    expect(refuse('/Users/ana/.claude/projects/-Users-ana-code-app/1234.jsonl', ctx)).toBeNull();
    expect(refuse('/Users/ana/Library/Caches/claude-cli-nodejs/x/mcp-logs-a', ctx)).toBeNull();
    expect(refuse('/Users/ana/code/app/.claude/worktrees/feat', ctx)).toBeNull();
    expect(refuse('/var/folders/xy/T/remotion-v4-assets-1', ctx)).toBeNull();
  });

  it('refuses configuration, memory, whole tool folders and project roots', () => {
    expect(refuse('/Users/ana/.claude/settings.json', ctx)).not.toBeNull();
    expect(refuse('/Users/ana/.claude/projects/-Users-ana-code-app', ctx)).not.toBeNull();
    expect(refuse('/Users/ana/.claude/projects/-Users-ana-code-app/memory/notes.md', ctx)).not.toBeNull();
    expect(refuse('/Users/ana/.claude', ctx)).not.toBeNull();
    expect(refuse('/Users/ana/.codex/auth.json', ctx)).not.toBeNull();
    expect(refuse('/Users/ana/code/app', ctx)).not.toBeNull();
    expect(refuse('/Users/ana/code', ctx)).not.toBeNull();
    expect(refuse('/Users/ana/Library/Group Containers/x/y', ctx)).not.toBeNull();
    expect(refuse('/var/folders/xy/T', ctx)).not.toBeNull();
  });

  it('refuses the state that Claude Code, Codex and Gemini keep alive', () => {
    expect(refuse('/Users/ana/.claude/jobs', ctx)).not.toBeNull();
    expect(refuse('/Users/ana/.claude/jobs/1/state.json', ctx)).not.toBeNull();
    expect(refuse('/Users/ana/.claude/sessions/123.json', ctx)).not.toBeNull();
    expect(refuse('/Users/ana/.claude/plugins/cache/x', ctx)).not.toBeNull();
    expect(refuse('/Users/ana/.claude/history.jsonl', ctx)).not.toBeNull();
    expect(refuse('/Users/ana/.local/share/claude/versions', ctx)).not.toBeNull();
    expect(refuse('/Users/ana/Library/Application Support/Claude', ctx)).not.toBeNull();
    expect(refuse('/Users/ana/Library/Application Support/Claude/vm_bundles/claudevm.bundle/sessiondata.img', ctx)).not.toBeNull();
    expect(refuse('/Users/ana/.codex/memories_1.sqlite', ctx)).not.toBeNull();
    expect(refuse('/Users/ana/.gemini/oauth_creds.json', ctx)).not.toBeNull();
  });

  it('still lets through the pieces those tools leave behind', () => {
    expect(refuse('/Users/ana/.claude/jobs/1/tmp', ctx)).toBeNull();
    expect(refuse('/Users/ana/.local/share/claude/versions/2.1.300', ctx)).toBeNull();
    expect(refuse('/Users/ana/Library/Application Support/Claude/Cache', ctx)).toBeNull();
    expect(refuse('/Users/ana/Library/Application Support/Google/Chrome/OptGuideOnDeviceModel', ctx)).toBeNull();
  });

  it('treats the orchestrators’ hidden folders as worktrees, not projects', () => {
    const withConductor = fakeContext({ home: '/Users/ana', tmp: '/var/folders/xy/T', projects: ['/Users/ana/code/app/.conductor/feat'] });
    expect(refuse('/Users/ana/code/app/.conductor/feat', withConductor)).toBeNull();
  });

  it('refuses anything outside the account or not absolute', () => {
    expect(refuse('/Applications/Claude.app', ctx)).not.toBeNull();
    expect(refuse('relative/path', ctx)).not.toBeNull();
    expect(refuse('/Users/ana/x/../.claude', ctx)).not.toBeNull();
  });
});

describe('safety checks added after review', () => {
  let box: Awaited<ReturnType<typeof sandbox>>;

  beforeEach(async () => {
    box = await sandbox();
  });

  afterEach(async () => {
    await box.cleanup();
  });

  const found = (path: string, extra: Partial<Found> = {}): Found => ({
    tool: 'cursor',
    kind: 'leftovers',
    label: 'x',
    project: null,
    path,
    size: 1000,
    count: 1,
    lastUsed: NOW - 30 * DAY,
    safety: 'moderate',
    removal: 'trash',
    ...extra,
  });

  it('keeps an app folder that still holds its settings out of the Trash', async () => {
    const app = join(box.home, 'Library/Application Support/Cursor');
    await put(join(app, 'User/settings.json'), '{}');
    await put(join(app, 'Cache/data'), 10);
    const ctx = fakeContext(box);
    const s = new AiScanner([{ id: 'c', collect: async () => [found(app)] }], async () => ctx);
    await s.scan();
    expect((await s.remove([app])).removed).toBe(0);
    expect(ctx.trashed).toEqual([]);
  });

  it('still lets a plain cache folder of an app go', async () => {
    const cache = join(box.home, 'Library/Application Support/Claude/Cache');
    await put(join(cache, 'Cache_Data/f_1'), 10);
    const ctx = fakeContext(box);
    const s = new AiScanner([{ id: 'c', collect: async () => [found(cache, { tool: 'claude-desktop', kind: 'cache' })] }], async () => ctx);
    await s.scan();
    expect((await s.remove([cache])).removed).toBe(1);
  });

  it('blocks everything when the process list could not be read', async () => {
    const path = await put(join(box.home, '.claude/downloads/x.bin'), 10, 20);
    const ctx = fakeContext({ ...box, processesKnown: false });
    const s = new AiScanner([{ id: 'c', collect: async () => [found(path, { tool: 'claude-code', kind: 'cache' })] }], async () => ctx);
    const [only] = (await s.scan()).items;
    expect(only.blocked).toBe('unverified');
    expect((await s.remove([path])).removed).toBe(0);
  });

  it('only treats the orchestrators’ own folders as worktrees', () => {
    const ctx = fakeContext({ home: '/Users/ana', tmp: '/var/folders/xy/T', projects: ['/Users/ana/workspaces/acme/app'] });
    expect(refuse('/Users/ana/workspaces/acme/app', ctx)).not.toBeNull();
    expect(refuse('/Users/ana/workspaces', ctx)).not.toBeNull();
  });
});
