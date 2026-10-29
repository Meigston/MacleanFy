import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { AiScanner, refuse } from '../scanner';
import { DAY, NOW, age, fakeContext, put, sandbox } from '../testing';
import type { AiContext, Found, ProcessInfo } from '../types';
import { createOpenaiGoogleCollectors } from './openai-google';

let box: Awaited<ReturnType<typeof sandbox>>;

beforeEach(async () => {
  box = await sandbox();
});

afterEach(async () => {
  await box.cleanup();
});

const collectors = () => createOpenaiGoogleCollectors({ applications: join(box.root, 'Applications') });
const collect = (id: string, ctx: AiContext = fakeContext(box)) => collectors().find((c) => c.id === id)!.collect(ctx);
const pathsOf = (items: Found[]) => items.flatMap((item) => item.paths ?? [item.path]);
const proc = (exe: string, extra: Partial<ProcessInfo> = {}): ProcessInfo => ({ pid: 4242, exe, args: exe, ...extra });

const thread = (n: number) => `01a00000-0000-7000-8000-${String(n).padStart(12, '0')}`;
/** A primeira linha de um rollout do Codex, seguida de uma conversa que o coletor não deve ler. */
const rollout = (cwd: string) =>
  `${JSON.stringify({ timestamp: '2026-10-01T10:00:00Z', type: 'session_meta', payload: { id: 'x', cwd, originator: 'codex_cli' } })}\n` +
  `${JSON.stringify({ type: 'response_item', payload: { content: 'segredo' } })}\n`;
const geminiChat = (sessionId: string) =>
  `${JSON.stringify({ sessionId, projectHash: 'h', startTime: '2026-10-01T10:00:00Z', lastUpdated: '2026-10-01T10:00:00Z', kind: 'main' })}\n` +
  `${JSON.stringify({ type: 'user', content: 'segredo' })}\n`;

describe('codex', () => {
  const codex = () => join(box.home, '.codex');

  it('groups sessions by project and heat, with their images and shell snapshots', async () => {
    const c = codex();
    const cold = await put(join(c, `sessions/2026/09/01/rollout-2026-09-01T10-00-00-${thread(1)}.jsonl`), rollout('/Users/ana/code/app'), 30);
    const hot = await put(join(c, `sessions/2026/10/27/rollout-2026-10-27T10-00-00-${thread(2)}.jsonl`), rollout('/Users/ana/code/app'), 2);
    const zst = await put(join(c, `sessions/2026/08/01/rollout-2026-08-01T10-00-00-${thread(3)}.jsonl.zst`), 4096, 40);
    const archived = await put(join(c, `archived_sessions/rollout-2026-03-30T09-32-48-${thread(4)}.jsonl.zst`), 4096, 50);
    await put(join(c, `sessions/2026/08/01/rollout-2026-08-01T11-00-00-${thread(5)}.jsonl.zst.tmp`), 4096, 40);
    await put(join(c, `generated_images/${thread(1)}/call_1.png`), 5000, 30);
    await put(join(c, `shell_snapshots/${thread(2)}.abc.sh`), 100, 2);

    const sessions = (await collect('codex')).filter((i) => i.kind === 'sessions');
    const byId = Object.fromEntries(sessions.map((i) => [`${i.project}#${i.key}`, i]));

    expect(Object.keys(byId).sort()).toEqual(['/Users/ana/code/app#cold', '/Users/ana/code/app#hot', 'null#cold']);
    expect(byId['/Users/ana/code/app#cold']).toMatchObject({ label: 'app', count: 1, path: cold, safety: 'moderate', removal: 'trash' });
    expect(byId['/Users/ana/code/app#cold'].paths).toEqual([cold, join(c, `generated_images/${thread(1)}`)]);
    expect(byId['/Users/ana/code/app#hot'].paths).toEqual([hot, join(c, `shell_snapshots/${thread(2)}.abc.sh`)]);
    expect(byId['/Users/ana/code/app#hot'].lastUsed).toBe(NOW - 2 * DAY);
    // O .zst não se lê sem descomprimir: fica sem projeto, mas entra.
    expect(byId['null#cold']).toMatchObject({ count: 2, label: 'sessions' });
    expect(byId['null#cold'].paths!.sort()).toEqual([archived, zst].sort());
    expect(byId['null#cold'].blocked).toBeUndefined();
  });

  it('keeps the images of a conversation that is gone apart, as moderate and not junk', async () => {
    await put(join(codex(), `generated_images/${thread(9)}/call_1.png`), 5000, 20);
    const [images] = (await collect('codex')).filter((i) => i.kind === 'sessions');
    expect(images).toMatchObject({ label: 'generated_images', safety: 'moderate', count: 1 });
    expect(images.junk).toBeUndefined();
  });

  it('blocks while the app or the CLI runs, and checks again right before removing', async () => {
    await put(join(codex(), `sessions/2026/09/01/rollout-2026-09-01T10-00-00-${thread(1)}.jsonl.zst`), 4096, 30);
    await put(join(codex(), 'cache/remote_plugin_catalog/catalog.json'), 5000, 3);
    await put(join(box.home, 'Library/Logs/com.openai.codex/2026/10/10/codex-desktop-a.log'), 3000, 19);
    const app = fakeContext({ ...box, processes: [proc('/Applications/ChatGPT.app/Contents/MacOS/ChatGPT')] });

    const items = await collect('codex', app);
    expect(items.filter((i) => i.kind !== 'logs').every((i) => i.blocked === 'app-open')).toBe(true);
    expect(items.find((i) => i.kind === 'logs')!.blocked).toBeUndefined();

    const session = items.find((i) => i.kind === 'sessions')!;
    expect(await session.recheck!(fakeContext(box))).toBeNull();
    expect(await session.recheck!(fakeContext({ ...box, processes: [proc('/opt/homebrew/bin/codex')] }))).toBe('app-open');
    expect(await session.recheck!(fakeContext({ ...box, processes: [proc('/Users/ana/.vscode/extensions/openai.chatgpt-1/bin/codex')] }))).toBe('app-open');
  });

  it('notices a conversation written to after the scan', async () => {
    const file = await put(join(codex(), `sessions/2026/09/01/rollout-2026-09-01T10-00-00-${thread(1)}.jsonl`), rollout('/p'), 30);
    const [session] = await collect('codex');
    await age(file, 0);
    expect(await session.recheck!(fakeContext(box))).toBe('in-use');
  });

  it('lists the safe leftovers: plugin backup, marketplace clone, catalog cache and arg0 links', async () => {
    const c = codex();
    await put(join(c, '.tmp/plugins-backup-bnU5gQ/plugins/README.md'), 5000, 190);
    await put(join(c, '.tmp/plugins/README.md'), 5000, 2);
    await put(join(c, '.tmp/plugins.sha'), 'abc', 160);
    await put(join(c, 'cache/remote_plugin_catalog/catalog.json'), 5000, 3);
    await mkdir(join(c, 'tmp/path/codex-arg0AAA'), { recursive: true });
    await symlink(join(box.home, 'gone/codex'), join(c, 'tmp/path/codex-arg0AAA/apply_patch'));
    const binary = await put(join(box.home, 'bin/codex'), 100);
    await mkdir(join(c, 'tmp/path/codex-arg0BBB'), { recursive: true });
    await symlink(binary, join(c, 'tmp/path/codex-arg0BBB/apply_patch'));
    await put(join(c, 'tmp/arg0/codex-arg0CCC/x'), 100, 30);

    const items = await collect('codex');
    const byLabel = (label: string, key?: string) => items.find((i) => i.label === label && (key === undefined || i.key === key))!;

    expect(byLabel('plugins-backup-bnU5gQ')).toMatchObject({ kind: 'temp', junk: 'orphan', safety: 'safe' });
    expect(byLabel('.tmp/plugins')).toMatchObject({ kind: 'cache', safety: 'safe', lastUsed: NOW - 160 * DAY });
    expect(byLabel('cache')).toMatchObject({ kind: 'cache', safety: 'safe', lastUsed: NOW - 3 * DAY });
    expect(byLabel('tmp/path', 'orphan')).toMatchObject({ kind: 'temp', junk: 'orphan', count: 1, paths: [join(c, 'tmp/path/codex-arg0AAA')] });
    expect(byLabel('tmp/path', 'linked')).toMatchObject({ kind: 'temp', count: 1, paths: [join(c, 'tmp/path/codex-arg0BBB')] });
    expect(byLabel('tmp/path', 'linked').junk).toBeUndefined();
    // O janitor do próprio Codex cuida de tmp/arg0.
    expect(pathsOf(items).some((p) => p.includes('/tmp/arg0/'))).toBe(false);
  });

  it('offers only the app logs older than a week, and takes the runtime last use from them', async () => {
    const logs = join(box.home, 'Library/Logs/com.openai.codex/2026/10');
    const old = await put(join(logs, '10/codex-desktop-a.log'), 3000, 19);
    await put(join(logs, '28/codex-desktop-b.log'), 3000, 1);
    const runtime = join(box.home, '.cache/codex-runtimes/codex-primary-runtime');
    await put(join(runtime, 'runtime.json'), JSON.stringify({ bundleVersion: '26.1025.11240' }), 4);
    await put(join(runtime, 'dependencies/python/bin/python3'), 100_000, 4);

    const items = await collect('codex');
    expect(items.find((i) => i.kind === 'logs')).toMatchObject({ safety: 'safe', paths: [old], count: 1, lastUsed: NOW - 19 * DAY });
    expect(items.find((i) => i.kind === 'runtime')).toMatchObject({
      label: 'codex-primary-runtime 26.1025.11240',
      safety: 'moderate',
      confidence: 'low',
      hint: 'redownload',
      lastUsed: NOW - 1 * DAY,
    });
  });

  it('lists the Chromium caches of the app and never its profiles', async () => {
    const support = join(box.home, 'Library/Application Support/Codex');
    await put(join(support, 'component_crx_cache/a.crx3'), 5000, 2);
    await put(join(support, 'Default/GPUCache/data_0'), 5000, 2);
    await put(join(support, 'Default/Cookies'), 5000, 1);
    await put(join(support, 'Default/Local Storage/leveldb/000003.log'), 5000, 1);
    await put(join(support, 'codex-browser-app/Login Data'), 5000, 1);
    await put(join(support, 'Local State'), 100, 1);

    const caches = (await collect('codex')).filter((i) => i.kind === 'cache');
    expect(caches).toHaveLength(1);
    expect(caches[0]).toMatchObject({ label: 'Codex', safety: 'safe', path: support });
    expect(caches[0].paths).toEqual([join(support, 'component_crx_cache'), join(support, 'Default/GPUCache')]);
  });

  it('never offers configuration, credentials, indexes, memories or worktrees', async () => {
    const c = codex();
    await put(join(c, `sessions/2026/09/01/rollout-2026-09-01T10-00-00-${thread(1)}.jsonl`), rollout('/p'), 30);
    const never = [
      'config.toml',
      'auth.json',
      'state_5.sqlite',
      'state_5.sqlite-wal',
      'session_index.jsonl',
      'history.jsonl',
      'memories/MEMORY.md',
      'memories_1.sqlite',
      'sqlite/codex-dev.db',
      'logs_2.sqlite',
      'thread_history_1.sqlite',
      '.codex-global-state.json',
      '.tmp/rollout-compression.lock',
      '.tmp/bundled-marketplaces/openai-bundled/x.json',
      'plugins/cache/openai-bundled/chrome/1.0/manifest.json',
      'skills/.system/a.md',
      'rules/default.rules',
      'thread-writer-locks/a.lock',
      'worktrees/a1b2/app/package.json',
    ].map((name) => join(c, name));
    for (const path of never) await put(path, 2000, 60);

    const paths = pathsOf(await collect('codex'));
    expect(paths.length).toBeGreaterThan(0);
    for (const path of never) expect(paths.some((p) => path === p || path.startsWith(p + '/'))).toBe(false);
  });

  it('reads CODEX_HOME instead of ~/.codex', async () => {
    const elsewhere = join(box.root, 'codex-home');
    const kept = await put(join(elsewhere, `sessions/2026/09/01/rollout-2026-09-01T10-00-00-${thread(1)}.jsonl.zst`), 4096, 30);
    await put(join(codex(), `sessions/2026/09/02/rollout-2026-09-02T10-00-00-${thread(2)}.jsonl.zst`), 4096, 30);
    const items = await collect('codex', fakeContext({ ...box, env: { CODEX_HOME: elsewhere } }));
    expect(pathsOf(items)).toEqual([kept]);
  });
});

describe('chatgpt', () => {
  it('lists nothing when there is nothing safe to offer', async () => {
    await put(join(box.home, 'Library/Application Support/com.openai.chat/conversations-v3-x/a.data'), 5000, 90);
    await put(join(box.home, 'Library/HTTPStorages/com.openai.chat/httpstorages.sqlite'), 5000, 90);
    expect(await collect('chatgpt')).toEqual([]);
  });

  it('lists the caches of both apps, each blocked while its own app is open', async () => {
    await put(join(box.home, 'Library/Caches/Codex/Default/Cache/Cache_Data/f_000001'), 5000, 2);
    await put(join(box.home, 'Library/Caches/com.openai.chat/Cache.db'), 5000, 90);
    await put(join(box.home, 'Library/Application Support/com.openai.chat/conversations-v3-x/a.data'), 5000, 90);
    const classic = fakeContext({ ...box, processes: [proc('/Applications/.ChatGPT Classic-codex-replacement-1234.app/Contents/MacOS/ChatGPT')] });

    const items = await collect('chatgpt', classic);
    expect(items.map((i) => [i.label, i.kind, i.safety, i.blocked])).toEqual([
      ['Codex', 'cache', 'safe', undefined],
      ['com.openai.chat', 'cache', 'safe', 'app-open'],
    ]);
    expect(pathsOf(items).some((p) => p.includes('Application Support'))).toBe(false);
  });
});

describe('gemini-cli', () => {
  const gemini = () => join(box.home, '.gemini');
  const app = '/Users/ana/code/app';

  async function project(id: string, root: string | null = app) {
    const dir = join(gemini(), 'tmp', id);
    if (root) await put(join(dir, '.project_root'), root, 60);
    return dir;
  }

  it('groups sessions by project and heat, with what the CLI deletes along with each one', async () => {
    const dir = await project('app');
    const id = 'aaaaaaaa-1111-4111-8111-111111111111';
    const cold = await put(join(dir, 'chats/session-2026-09-01T10-00-aaaaaaaa.jsonl'), geminiChat(id), 30);
    const log = await put(join(dir, `logs/session-${id}.jsonl`), 500, 30);
    await put(join(dir, `tool-outputs/session-${id}/out.txt`), 500, 30);
    await put(join(dir, `${id}/plans/plan.md`), 500, 30);
    await put(join(dir, `chats/${id}/sub-1.jsonl`), 500, 30);
    await put(join(dir, 'logs/session-sub-1.jsonl'), 500, 30);
    const hot = await put(join(dir, 'chats/session-2026-10-27T10-00-bbbbbbbb.jsonl'), geminiChat('bbbbbbbb-2222'), 2);

    const items = await collect('gemini-cli');
    const coldItem = items.find((i) => i.key === 'cold')!;
    expect(coldItem).toMatchObject({ kind: 'sessions', label: 'app', project: app, count: 1, path: cold, safety: 'moderate' });
    expect(coldItem.paths!.sort()).toEqual(
      [cold, log, join(dir, `chats/${id}`), join(dir, `tool-outputs/session-${id}`), join(dir, id), join(dir, 'logs/session-sub-1.jsonl')].sort()
    );
    expect(items.find((i) => i.key === 'hot')).toMatchObject({ count: 1, path: hot, paths: [hot], lastUsed: NOW - 2 * DAY });
  });

  it('finds the project by the registry or by the legacy hash of its path', async () => {
    await put(join(gemini(), 'projects.json'), JSON.stringify({ projects: { '/Users/ana/code/site': 'site' } }), 60);
    await put(join(await project('site', null), 'chats/session-2026-09-01T10-00-cccccccc.jsonl'), geminiChat('cccccccc'), 30);
    const hash = createHash('sha256').update('/Users/ana/code/api').digest('hex');
    await put(join(await project(hash, null), 'chats/session-2026-09-01T10-00-dddddddd.json'), geminiChat('dddddddd'), 30);
    await put(join(await project('loose', null), 'chats/session-2026-09-01T10-00-eeeeeeee.jsonl'), geminiChat('eeeeeeee'), 30);

    const items = await collect('gemini-cli', fakeContext({ ...box, projects: ['/Users/ana/code/api'] }));
    expect(items.map((i) => [i.label, i.project]).sort()).toEqual([
      ['api', '/Users/ana/code/api'],
      ['loose', null],
      ['site', '/Users/ana/code/site'],
    ]);
  });

  it('lists checkpoints and the shadow git apart, as kind checkpoints', async () => {
    const dir = await project('app');
    await put(join(dir, 'checkpoints/2026-09-01T10-00-00_000Z-file.ts-write_file.json'), 800, 20);
    const tag = await put(join(dir, 'checkpoint-before-refactor.json'), 800, 20);
    await put(join(gemini(), 'history/app/.git/index'), 4000, 20);

    const [item] = await collect('gemini-cli');
    expect(item).toMatchObject({ kind: 'checkpoints', label: 'app', project: app, count: 2, safety: 'moderate' });
    expect(item.paths).toEqual([join(dir, 'checkpoints'), tag, join(gemini(), 'history/app')]);
  });

  it('keeps the session a running CLI writes to apart and blocked', async () => {
    const dir = await project('app');
    await put(join(dir, 'chats/session-2026-10-26T10-00-aaaaaaaa.jsonl'), geminiChat('aaaaaaaa'), 3);
    const newest = await put(join(dir, 'chats/session-2026-10-29T10-00-bbbbbbbb.jsonl'), geminiChat('bbbbbbbb'), 0);
    await put(join(dir, 'checkpoints/a.json'), 800, 0);
    const running = fakeContext({ ...box, processes: [proc('/opt/homebrew/bin/node', { args: 'node /opt/homebrew/bin/gemini', cwd: app })] });

    const items = await collect('gemini-cli', running);
    expect(items.find((i) => i.key === 'live')).toMatchObject({ blocked: 'live-session', count: 1, path: newest });
    expect(items.find((i) => i.key === 'hot')!.blocked).toBeUndefined();
    expect(items.find((i) => i.kind === 'checkpoints')!.blocked).toBe('in-use');
    expect(await items.find((i) => i.key === 'hot')!.recheck!(running)).toBe('live-session');
    expect(await items.find((i) => i.key === 'hot')!.recheck!(fakeContext(box))).toBeNull();
  });

  it('reads GEMINI_CLI_HOME, which takes the place of the home folder', async () => {
    const base = join(box.root, 'gemini-base');
    const kept = await put(join(base, '.gemini/tmp/app/chats/session-2026-09-01T10-00-aaaaaaaa.jsonl'), geminiChat('aaaaaaaa'), 30);
    await put(join(await project('other'), 'chats/session-2026-09-01T10-00-bbbbbbbb.jsonl'), geminiChat('bbbbbbbb'), 30);
    const items = await collect('gemini-cli', fakeContext({ ...box, env: { GEMINI_CLI_HOME: base } }));
    expect(pathsOf(items)).toEqual([kept]);
  });
});

describe('antigravity', () => {
  const extensions = () => join(box.home, '.antigravity/extensions');
  const support = () => join(box.home, 'Library/Application Support/Antigravity');

  async function installExtensions() {
    const ext = extensions();
    await put(join(ext, 'redhat.java-1.12.0-darwin-arm64/package.json'), 9000, 200);
    await put(join(ext, 'meta.pyrefly-0.9.0-darwin-arm64/package.json'), 9000, 200);
    await put(join(ext, 'redhat.java-1.54.0-darwin-arm64/package.json'), 9000, 150);
    await put(join(ext, 'golang.go-0.52.2-universal/package.json'), 9000, 200);
    await put(
      join(ext, '.obsolete'),
      JSON.stringify({ 'redhat.java-1.12.0-darwin-arm64': true, 'meta.pyrefly-0.9.0-darwin-arm64': true, 'golang.go-0.52.2-universal': true, '../escape': true }),
      150
    );
    await put(
      join(ext, 'extensions.json'),
      JSON.stringify([
        { identifier: { id: 'redhat.java' }, version: '1.54.0', relativeLocation: 'redhat.java-1.54.0-darwin-arm64' },
        { identifier: { id: 'golang.go' }, version: '0.52.2', location: { path: join(ext, 'golang.go-0.52.2-universal') } },
      ]),
      150
    );
  }

  it('offers obsolete extensions as old versions, and skips one still registered', async () => {
    await installExtensions();
    await mkdir(join(box.root, 'Applications/Antigravity.app'), { recursive: true });
    const items = await collect('antigravity');
    expect(items.map((i) => [i.label, i.kind, i.junk, i.safety]).sort()).toEqual([
      ['meta.pyrefly-0.9.0-darwin-arm64', 'versions', 'old-version', 'safe'],
      ['redhat.java-1.12.0-darwin-arm64', 'versions', 'old-version', 'safe'],
    ]);
  });

  it('treats the active extensions as leftovers only when the app is gone', async () => {
    await installExtensions();
    const gone = (await collect('antigravity')).find((i) => i.kind === 'leftovers');
    expect(gone).toMatchObject({ label: 'extensions', safety: 'moderate', confidence: 'low', count: 2 });
    expect(gone!.paths).toEqual([join(extensions(), 'golang.go-0.52.2-universal'), join(extensions(), 'redhat.java-1.54.0-darwin-arm64')]);

    await mkdir(join(box.home, 'Applications/Antigravity.app'), { recursive: true });
    expect((await collect('antigravity')).some((i) => i.kind === 'leftovers')).toBe(false);
  });

  it('offers the discarded VSIX, the caches and old logs, closed', async () => {
    await put(join(support(), 'CachedExtensionVSIXs/.trash/redhat.java-1.54.0-darwin-arm64'), 50_000, 150);
    await put(join(support(), 'CachedData/abc/chrome/js/index'), 5000, 150);
    await put(join(support(), 'GPUCache/data_0'), 5000, 150);
    await put(join(support(), 'logs/20260324T083827/main.log'), 5000, 200);
    await put(join(support(), 'logs/20261029T100000/main.log'), 5000, 0);
    const open = fakeContext({ ...box, processes: [proc('/Applications/Antigravity.app/Contents/MacOS/Electron')] });

    const items = await collect('antigravity', open);
    const byLabel = Object.fromEntries(items.map((i) => [i.label, i]));
    expect(byLabel.CachedExtensionVSIXs).toMatchObject({ kind: 'cache', safety: 'safe', junk: 'orphan', blocked: 'app-open' });
    expect(byLabel.Antigravity).toMatchObject({ kind: 'cache', safety: 'safe', blocked: 'app-open', paths: [join(support(), 'CachedData'), join(support(), 'GPUCache')] });
    expect(byLabel.logs).toMatchObject({ kind: 'logs', paths: [join(support(), 'logs/20260324T083827')] });
    expect(await byLabel.Antigravity.recheck!(fakeContext(box))).toBeNull();
  });

  it('groups conversations by heat, each with its brain folder and annotations', async () => {
    const data = join(box.home, '.gemini/antigravity');
    const old = await put(join(data, 'conversations/c1.pb'), 5000, 30);
    await put(join(data, 'brain/c1/task.md'), 500, 30);
    await put(join(data, 'annotations/c1.pbtxt'), 100, 30);
    await put(join(data, 'conversations/c2.pb'), 5000, 1);

    const sessions = (await collect('antigravity')).filter((i) => i.kind === 'sessions');
    expect(sessions.map((i) => [i.key, i.count]).sort()).toEqual([
      ['cold', 1],
      ['hot', 1],
    ]);
    expect(sessions.find((i) => i.key === 'cold')!.paths).toEqual([old, join(data, 'brain/c1'), join(data, 'annotations/c1.pbtxt')]);
  });
});

describe('the shared ~/.gemini and the tool settings', () => {
  it('never offers settings, credentials, memory, the registry or the Antigravity user folder', async () => {
    const g = join(box.home, '.gemini');
    await put(join(g, 'tmp/app/.project_root'), '/Users/ana/code/app', 60);
    await put(join(g, 'tmp/app/chats/session-2026-09-01T10-00-aaaaaaaa.jsonl'), geminiChat('aaaaaaaa'), 30);
    await put(join(box.home, '.gemini/antigravity/conversations/c1.pb'), 5000, 30);
    const never = [
      join(g, 'settings.json'),
      join(g, 'oauth_creds.json'),
      join(g, 'google_accounts.json'),
      join(g, 'GEMINI.md'),
      join(g, 'projects.json'),
      join(g, 'trustedFolders.json'),
      join(g, 'tmp/app/logs.json'),
      join(g, 'tmp/app/shell_history'),
      join(g, 'antigravity/knowledge/k.md'),
      join(g, 'antigravity/user_settings.pb'),
      join(g, 'config/mcp_config.json'),
      join(g, 'antigravity-backup/brain/x/task.md'),
      join(box.home, '.antigravity/argv.json'),
      join(box.home, 'Library/Application Support/Antigravity/User/settings.json'),
      join(box.home, 'Library/Application Support/Antigravity/User/globalStorage/state.vscdb'),
      join(box.home, 'Library/Application Support/Antigravity/Cookies'),
    ];
    for (const path of never) await put(path, 2000, 60);
    await symlink(join(g, 'config/mcp_config.json'), join(g, 'antigravity/mcp_config.json'));

    const items = [...(await collect('gemini-cli')), ...(await collect('antigravity'))];
    const paths = pathsOf(items);
    expect(items.map((i) => i.tool).sort()).toEqual(['antigravity', 'gemini-cli']);
    for (const path of [...never, join(g, 'antigravity/mcp_config.json')]) {
      expect(paths.some((p) => path === p || path.startsWith(p + '/'))).toBe(false);
    }
    expect(paths).not.toContain(g);
    expect(paths).not.toContain(join(g, 'tmp/app'));
  });
});

describe('all four tools through the scanner', () => {
  it('lists every item once, and every path passes the last check before the Trash', async () => {
    const h = box.home;
    await put(join(h, `.codex/sessions/2026/09/01/rollout-2026-09-01T10-00-00-${thread(1)}.jsonl`), rollout('/Users/ana/code/app'), 30);
    await put(join(h, `.codex/sessions/2026/09/02/rollout-2026-09-02T10-00-00-${thread(2)}.jsonl.zst`), 4096, 30);
    await put(join(h, `.codex/generated_images/${thread(1)}/a.png`), 5000, 30);
    await put(join(h, `.codex/generated_images/${thread(8)}/a.png`), 5000, 30);
    await put(join(h, '.codex/.tmp/plugins-backup-x/a'), 5000, 100);
    await put(join(h, '.codex/cache/a.json'), 5000, 1);
    await put(join(h, '.cache/codex-runtimes/codex-primary-runtime/runtime.json'), '{}', 4);
    await put(join(h, 'Library/Logs/com.openai.codex/2026/10/01/a.log'), 3000, 28);
    await put(join(h, 'Library/Application Support/Codex/WasmTtsEngine/a'), 5000, 5);
    await put(join(h, 'Library/Caches/com.openai.codex/Cache.db'), 5000, 5);
    await put(join(h, '.gemini/tmp/app/.project_root'), '/Users/ana/code/app', 60);
    await put(join(h, '.gemini/tmp/app/chats/session-2026-09-01T10-00-aaaaaaaa.jsonl'), geminiChat('aaaaaaaa'), 30);
    await put(join(h, '.gemini/tmp/app/checkpoints/a.json'), 800, 30);
    await put(join(h, '.gemini/history/app/.git/index'), 800, 30);
    await put(join(h, '.gemini/antigravity/conversations/c1.pb'), 5000, 30);
    await put(join(h, '.antigravity/extensions/a.b-1.0.0-universal/package.json'), 5000, 200);
    await put(join(h, '.antigravity/extensions/.obsolete'), JSON.stringify({ 'a.b-1.0.0-universal': true }), 200);
    await put(join(h, 'Library/Application Support/Antigravity/CachedExtensionVSIXs/.trash/a'), 5000, 150);

    const ctx = fakeContext({ ...box, projects: ['/Users/ana/code/app'] });
    const found = (await Promise.all(collectors().map((c) => c.collect(ctx)))).flat();
    const scan = await new AiScanner(collectors(), async () => ctx).scan();

    expect(scan.failed).toEqual([]);
    expect(scan.items).toHaveLength(found.length);
    expect(new Set(scan.items.map((i) => i.tool))).toEqual(new Set(['codex', 'chatgpt', 'gemini-cli', 'antigravity']));
    for (const path of pathsOf(found)) expect([path, refuse(path, ctx)]).toEqual([path, null]);
  });
});
