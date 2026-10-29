import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { agentCollectors } from './agents';
import { age, fakeContext, put, sandbox, type FakeOptions } from '../testing';
import type { ExecResult, Found, ProcessInfo } from '../types';

const collect = (id: string, options: FakeOptions) => {
  const collector = agentCollectors.find((c) => c.id === id);
  if (!collector) throw new Error(`no collector ${id}`);
  return collector.collect(fakeContext(options));
};

const allPaths = (items: Found[]) => items.flatMap((item) => item.paths ?? [item.path]);
const json = (value: unknown) => JSON.stringify(value);
const proc = (exe: string, cwd?: string, args = exe): ProcessInfo => ({ pid: 4242, exe, args, cwd });

describe('agentCollectors', () => {
  let box: Awaited<ReturnType<typeof sandbox>>;

  beforeEach(async () => {
    box = await sandbox();
  });

  afterEach(async () => {
    await box.cleanup();
  });

  it('has one collector per tool, and finds nothing in an empty account', async () => {
    expect(agentCollectors.map((c) => c.id)).toEqual(['opencode', 'aider', 'goose', 'amp', 'qwen-code', 'crush', 'granola', 'npx']);
    const calls: string[] = [];
    const exec = (file: string): ExecResult => {
      calls.push(file);
      return { code: 127, stdout: '', stderr: '' };
    };
    for (const collector of agentCollectors) {
      expect(await collector.collect(fakeContext({ ...box, projects: [join(box.home, 'code/app')], exec }))).toEqual([]);
    }
    expect(calls).toEqual([]);
  });

  describe('opencode', () => {
    const app = () => join(box.home, 'code/app');
    const data = (root = join(box.home, '.local/share')) => join(root, 'opencode');

    async function tree(root?: string) {
      const d = data(root);
      await put(join(d, 'snapshot/prj1/wt1/HEAD'), 'ref: refs/heads/main', 3);
      await put(join(d, 'snapshot/prj1/wt1/index'), 2000, 3);
      await put(join(d, 'snapshot/prj1/wt1/objects/ab/cdef'), 50_000, 3);
      await age(join(d, 'snapshot/prj1/wt1/objects/ab'), 3);
      await age(join(d, 'snapshot/prj1/wt1/objects'), 3);
      await put(join(d, 'storage/project/prj1.json'), json({ id: 'prj1', worktree: app() }));
      await put(join(d, 'storage/session/prj1/ses_old.json'), 500, 30);
      await put(join(d, 'storage/message/ses_old/msg_1.json'), 500, 30);
      await put(join(d, 'storage/part/msg_1/prt_1.json'), 500, 30);
      await put(join(d, 'storage/session_diff/ses_old.json'), 500, 30);
      await put(join(d, 'storage/session/prj1/ses_new.json'), 500, 1);
      await put(join(d, 'storage/message/ses_new/msg_2.json'), 500, 1);
      await put(join(d, 'storage/part/msg_2/prt_2.json'), 500, 1);
      await put(join(d, 'opencode.db'), 8000, 0);
      await put(join(d, 'opencode.db-wal'), 4000, 0);
      await put(join(d, 'auth.json'), json({ anthropic: 'key' }));
      await put(join(d, 'repos/clone/file'), 3000, 40);
      await put(join(d, 'log/2026-10-01.log'), 1000, 28);
      await put(join(box.home, '.config/opencode/opencode.json'), json({}));
      await put(join(box.home, '.local/state/opencode/prompt-history.jsonl'), 100);
    }

    it('lists snapshots per project, sessions split by heat, logs and cache, and only shows the database', async () => {
      await tree();
      await put(join(box.home, '.cache/opencode/models.json'), 4000, 12);
      const items = await collect('opencode', { ...box, projects: [app()] });

      const snapshot = items.find((i) => i.kind === 'checkpoints')!;
      expect(snapshot).toMatchObject({ label: 'app', project: app(), path: join(data(), 'snapshot/prj1/wt1'), safety: 'moderate', removal: 'trash' });
      expect(snapshot.size).toBeGreaterThan(50_000);

      const sessions = items.filter((i) => i.kind === 'sessions' && i.removal === 'trash');
      const cold = sessions.find((i) => i.key === 'cold')!;
      const hot = sessions.find((i) => i.key === 'hot')!;
      expect(cold.paths?.sort()).toEqual(
        [
          'storage/session/prj1/ses_old.json',
          'storage/message/ses_old',
          'storage/part/msg_1',
          'storage/session_diff/ses_old.json',
        ]
          .map((p) => join(data(), p))
          .sort()
      );
      expect(cold).toMatchObject({ label: 'app', project: app(), count: 1, path: join(data(), 'storage/session/prj1') });
      expect(hot.paths).toContain(join(data(), 'storage/part/msg_2'));

      const db = items.find((i) => i.label === 'opencode.db')!;
      expect(db).toMatchObject({ removal: 'none', blocked: 'via-app' });
      expect(db.paths).toEqual([join(data(), 'opencode.db'), join(data(), 'opencode.db-wal')]);

      expect(items.find((i) => i.kind === 'logs')).toMatchObject({ path: join(data(), 'log'), safety: 'safe', removal: 'trash' });
      expect(items.find((i) => i.kind === 'cache')).toMatchObject({ path: join(box.home, '.cache/opencode'), confidence: 'low', hint: 'redownload' });

      const offered = allPaths(items.filter((i) => i.removal !== 'none'));
      expect(offered.some((p) => /auth\.json|opencode\.db|repos|\.config|\.local\/state/.test(p))).toBe(false);
      expect(items.every((i) => !i.blocked || i.blocked === 'via-app')).toBe(true);
    });

    it('follows XDG_DATA_HOME, keeps the session open now apart and blocks the rest while opencode runs', async () => {
      const root = join(box.root, 'xdg');
      await tree(root);
      const running = [proc('/opt/homebrew/bin/opencode', app())];
      const items = await collect('opencode', { ...box, projects: [app()], env: { XDG_DATA_HOME: root }, processes: running });

      expect(items.every((i) => i.path.startsWith(root) || i.path.startsWith(box.home))).toBe(true);
      expect(items.some((i) => i.kind === 'checkpoints' && i.path.startsWith(data(root)))).toBe(true);
      const sessions = items.filter((i) => i.kind === 'sessions' && i.removal === 'trash');
      expect(sessions.map((i) => [i.key, i.blocked]).sort()).toEqual([
        ['cold', 'app-open'],
        ['live', 'live-session'],
      ]);
      expect(sessions.find((i) => i.key === 'live')!.paths).toContain(join(data(root), 'storage/session/prj1/ses_new.json'));

      const snapshot = items.find((i) => i.kind === 'checkpoints')!;
      expect(snapshot.blocked).toBe('app-open');
      expect(await snapshot.recheck!(fakeContext(box))).toBeNull();
      expect(await snapshot.recheck!(fakeContext({ ...box, processes: running }))).toBe('app-open');
    });
  });

  describe('aider', () => {
    it('lists the tag cache and the chat history of a project, and leaves tracked files and config alone', async () => {
      const app = join(box.home, 'code/app');
      await mkdir(join(app, '.git'), { recursive: true });
      await put(join(app, '.aider.tags.cache.v4/cache.db'), 6000, 2);
      await put(join(app, '.aider.chat.history.md'), 3000, 20);
      await put(join(app, '.aider.input.history'), 500, 20);
      await put(join(app, '.aider.conf.yml'), 'model: x');
      await put(join(app, '.env'), 'OPENAI_API_KEY=x');
      await put(join(box.home, '.aider/oauth-keys.env'), 'x');
      await put(join(box.home, '.aider/caches/model_prices.json'), 2000, 40);

      const calls: Array<{ args: string[]; env?: Record<string, string> }> = [];
      const exec = (_file: string, args: string[], options?: { env?: Record<string, string> }): ExecResult => {
        calls.push({ args, env: options?.env });
        return args.at(-1) === '.aider.input.history' ? { code: 0, stdout: '.aider.input.history\n', stderr: '' } : { code: 1, stdout: '', stderr: 'error: pathspec' };
      };
      const items = await collect('aider', { ...box, projects: [app], exec: exec as FakeOptions['exec'] });

      expect(items.find((i) => i.path === join(app, '.aider.tags.cache.v4'))).toMatchObject({ kind: 'cache', safety: 'safe', removal: 'trash', label: 'app' });
      expect(items.find((i) => i.path === join(app, '.aider.chat.history.md'))).toMatchObject({ kind: 'sessions', safety: 'moderate', removal: 'trash', count: 1 });
      expect(items.find((i) => i.path === join(app, '.aider.input.history'))).toMatchObject({ removal: 'none', blocked: 'tracked' });
      expect(items.find((i) => i.path === join(box.home, '.aider/caches'))).toMatchObject({ safety: 'safe', hint: 'redownload' });

      expect(allPaths(items).some((p) => /\.aider\.conf\.yml|\.env$|oauth-keys/.test(p))).toBe(false);
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.args.slice(0, 4)).toEqual(['-C', app, 'ls-files', '--error-unmatch']);
        expect(call.env).toEqual({ GIT_OPTIONAL_LOCKS: '0' });
      }
    });

    it('skips git outside a repository and blocks the project while aider runs in it', async () => {
      const app = join(box.home, 'code/app');
      await put(join(app, '.aider.chat.history.md'), 3000, 20);
      const running = [proc('/usr/bin/python3', join(app, 'src'), '/usr/bin/python3 -m aider --model x')];
      let calls = 0;
      const items = await collect('aider', {
        ...box,
        projects: [app],
        processes: running,
        exec: () => {
          calls++;
          return { code: 0, stdout: '', stderr: '' };
        },
      });
      expect(calls).toBe(0);
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ removal: 'trash', blocked: 'app-open' });
      expect(await items[0].recheck!(fakeContext(box))).toBeNull();
    });
  });

  describe('goose', () => {
    it('only shows the session database, splits the old jsonl sessions by project and heat, and lists logs', async () => {
      const app = join(box.home, 'code/app');
      const api = join(box.home, 'code/api');
      const sessions = join(box.home, '.local/share/goose/sessions');
      await put(join(sessions, 'sessions.db'), 9000, 0);
      await put(join(sessions, 'a.jsonl'), `${json({ working_dir: app, description: 'x' })}\n{"role":"user"}\n`, 20);
      await put(join(sessions, 'b.jsonl'), `${json({ working_dir: app })}\n`, 1);
      await put(join(sessions, 'c.jsonl'), `${json({ working_dir: api })}\n`, 20);
      await put(join(box.home, '.local/state/goose/logs/cli/2026-10-28/goose.log'), 1000, 1);
      await put(join(box.home, '.config/goose/config.yaml'), 'x');
      await put(join(box.home, '.config/goose/secrets.yaml'), 'x');
      await put(join(box.home, '.config/goose/history.txt'), 'x');

      const items = await collect('goose', { ...box });
      expect(items.find((i) => i.label === 'sessions.db')).toMatchObject({ removal: 'none', blocked: 'via-app', hint: 'tool-command' });
      const legacy = items.filter((i) => i.kind === 'sessions' && i.removal === 'trash');
      expect(legacy.map((i) => [i.label, i.key, i.count]).sort()).toEqual([
        ['api', 'cold', 1],
        ['app', 'cold', 1],
        ['app', 'hot', 1],
      ]);
      expect(legacy.find((i) => i.label === 'api')!.project).toBe(api);
      expect(items.find((i) => i.kind === 'logs')).toMatchObject({ label: 'cli', safety: 'safe' });
      expect(allPaths(items).some((p) => p.includes('.config/goose'))).toBe(false);
    });
  });

  describe('amp', () => {
    it('splits the local threads by heat and never touches the secrets', async () => {
      const data = join(box.home, '.local/share/amp');
      await put(join(data, 'threads/T-old.json'), 2000, 30);
      await put(join(data, 'threads/T-new.json'), 2000, 1);
      await put(join(data, 'secrets.json'), json({ apiKey: 'x' }));
      await put(join(box.home, '.cache/amp/logs/cli.log'), 1000, 2);
      await put(join(box.home, '.config/amp/settings.json'), json({}));

      const items = await collect('amp', { ...box });
      const threads = items.filter((i) => i.kind === 'sessions');
      expect(threads.map((i) => [i.key, i.paths])).toEqual(
        expect.arrayContaining([
          ['cold', [join(data, 'threads/T-old.json')]],
          ['hot', [join(data, 'threads/T-new.json')]],
        ])
      );
      expect(threads).toHaveLength(2);
      expect(items.find((i) => i.kind === 'logs')).toMatchObject({ path: join(box.home, '.cache/amp/logs') });
      expect(allPaths(items).some((p) => /secrets|settings/.test(p))).toBe(false);
    });
  });

  describe('qwen-code', () => {
    const app = () => join(box.home, 'code/my-app');

    it('maps chats and checkpoints to the project and follows QWEN_HOME and QWEN_RUNTIME_DIR', async () => {
      const home = join(box.root, 'qwen-home');
      const runtime = join(box.root, 'qwen-runtime');
      const chats = join(runtime, 'projects', app().replace(/[^a-zA-Z0-9]/g, '-'), 'chats');
      const hash = createHash('sha256').update(app()).digest('hex');
      await put(join(chats, 's1.jsonl'), 3000, 30);
      await put(join(chats, 's1.runtime.json'), 200, 30);
      await put(join(chats, 's2.jsonl'), 3000, 1);
      await put(join(runtime, 'tmp', hash, 'checkpoints/c1.json'), 4000, 10);
      await put(join(runtime, 'tmp/bin/rg'), 9000, 10);
      await put(join(runtime, 'debug/s1.txt'), 1000, 30);
      await put(join(home, 'settings.json'), json({}));
      await put(join(home, 'oauth_creds.json'), json({}));
      await put(join(home, 'memory.md'), 'x');
      await put(join(box.home, '.qwen/projects/-x/chats/decoy.jsonl'), 3000, 30);

      const items = await collect('qwen-code', { ...box, projects: [app()], env: { QWEN_HOME: home, QWEN_RUNTIME_DIR: runtime } });
      const sessions = items.filter((i) => i.kind === 'sessions');
      expect(sessions.map((i) => [i.key, i.label, i.project, i.count]).sort()).toEqual([
        ['cold', 'my-app', app(), 1],
        ['hot', 'my-app', app(), 1],
      ]);
      expect(sessions.find((i) => i.key === 'cold')!.paths?.sort()).toEqual([join(chats, 's1.jsonl'), join(chats, 's1.runtime.json')]);
      expect(items.find((i) => i.kind === 'checkpoints')).toMatchObject({ label: 'my-app', project: app(), safety: 'moderate' });
      expect(items.find((i) => i.kind === 'logs')).toMatchObject({ path: join(runtime, 'debug'), safety: 'safe' });
      const paths = allPaths(items);
      expect(paths.some((p) => p.startsWith(home) || p.includes('/tmp/bin') || p.includes('decoy'))).toBe(false);
    });

    it('takes the project from the cwd in the transcript, and keeps the open chat apart while qwen runs there', async () => {
      const chats = join(box.home, '.qwen/projects/-Users-x-weird-name/chats');
      await put(join(chats, 'old.jsonl'), `${json({ sessionId: 'old', cwd: app() })}\n`, 30);
      await put(join(chats, 'new.jsonl'), `${json({ sessionId: 'new', cwd: app() })}\n`, 0);
      const running = [proc('/opt/homebrew/bin/node', app(), 'node /opt/homebrew/bin/qwen')];
      const items = await collect('qwen-code', { ...box, processes: running });
      expect(items.map((i) => [i.key, i.project, i.blocked]).sort()).toEqual([
        ['cold', app(), 'app-open'],
        ['live', app(), 'live-session'],
      ]);
      expect(items.find((i) => i.key === 'live')!.paths).toEqual([join(chats, 'new.jsonl')]);
    });
  });

  describe('crush', () => {
    it('lists the project database as sessions and the logs as safe, blocked while crush runs there', async () => {
      const app = join(box.home, 'code/app');
      await put(join(app, '.crush/crush.db'), 8000, 15);
      await put(join(app, '.crush/crush.db-wal'), 2000, 15);
      await put(join(app, '.crush/logs/crush.log'), 1000, 15);
      await put(join(app, '.crush.json'), json({}));
      await put(join(box.home, '.local/share/crush/crush.json'), json({ providers: {} }));

      const items = await collect('crush', { ...box, projects: [app] });
      expect(items.find((i) => i.kind === 'sessions')).toMatchObject({
        label: 'app',
        project: app,
        safety: 'moderate',
        removal: 'trash',
        paths: [join(app, '.crush/crush.db'), join(app, '.crush/crush.db-wal')],
      });
      expect(items.find((i) => i.kind === 'logs')).toMatchObject({ path: join(app, '.crush/logs'), safety: 'safe' });
      expect(allPaths(items).some((p) => p.endsWith('crush.json'))).toBe(false);

      const busy = await collect('crush', { ...box, projects: [app], processes: [proc('/opt/homebrew/bin/crush', app)] });
      expect(busy.every((i) => i.blocked === 'app-open')).toBe(true);
      const elsewhere = await collect('crush', { ...box, projects: [app], processes: [proc('/opt/homebrew/bin/crush', join(box.home, 'other'))] });
      expect(elsewhere.every((i) => !i.blocked)).toBe(true);
    });
  });

  describe('granola', () => {
    const support = () => join(box.home, 'Library/Application Support/Granola');
    const pending = () => join(box.home, 'Library/Caches/@granolaelectron-updater/pending');

    async function app(version: string) {
      const dir = join(box.home, 'Applications/Granola.app/Contents');
      await put(
        join(dir, 'Info.plist'),
        `<?xml version="1.0"?><plist><dict><key>CFBundleShortVersionString</key>\n<string>${version}</string></dict></plist>`
      );
      await put(join(dir, 'Resources/app-update.yml'), "provider: github\nupdaterCacheDirName: '@granolaelectron-updater'\n");
    }

    async function update(version: string, extra: Record<string, unknown> = {}) {
      await put(join(pending(), `Granola-${version}-mac-universal.zip`), 50_000, 6);
      await put(join(pending(), 'update-info.json'), json({ fileName: `Granola-${version}-mac-universal.zip`, sha512: 'x', ...extra }), 6);
    }

    it('offers only the Chromium caches, blocked while Granola is open', async () => {
      for (const name of ['Cache/Cache_Data/index', 'Code Cache/js/a', 'GPUCache/data_0', 'DawnGraphiteCache/data_0', 'DawnWebGPUCache/data_0', 'Shared Dictionary/db']) {
        await put(join(support(), name), 2000, 1);
      }
      await put(join(support(), 'DIPS'), 1000, 1);
      await put(join(support(), 'DIPS-wal'), 1000, 1);
      for (const name of ['granola.db', 'granola.db-wal', 'cache-v6.json.enc', 'stored-accounts.json.enc', 'IndexedDB/app_ui_0/1.log', 'Local Storage/leveldb/1.log', 'Cookies', 'Local State']) {
        await put(join(support(), name), 2000, 1);
      }

      const items = await collect('granola', { ...box });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ kind: 'cache', safety: 'safe', removal: 'trash', path: support() });
      expect(items[0].paths?.map((p) => p.slice(support().length + 1)).sort()).toEqual(
        ['Cache', 'Code Cache', 'DIPS', 'DIPS-wal', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GPUCache', 'Shared Dictionary'].sort()
      );
      expect(items[0].blocked).toBeUndefined();

      const running = [proc('/Applications/Granola.app/Contents/MacOS/Granola')];
      const open = await collect('granola', { ...box, processes: running });
      expect(open[0].blocked).toBe('app-open');
      expect(await open[0].recheck!(fakeContext({ ...box, processes: [proc('Granola Helper (Audio)')] }))).toBe('app-open');
    });

    it('offers an update already installed as an orphan, but not one still downloading or newer than the app', async () => {
      await app('7.668.3');
      await update('7.668.3');
      const [item] = await collect('granola', { ...box });
      expect(item).toMatchObject({ kind: 'versions', label: '7.668.3', path: pending(), junk: 'orphan', safety: 'safe', removal: 'trash', confidence: 'low' });
      expect(await item.recheck!(fakeContext(box))).toBeNull();
      expect(await item.recheck!(fakeContext({ ...box, processes: [proc('/Users/x/Library/Caches/com.granola.app.ShipIt/ShipIt')] }))).toBe('in-use');

      await put(join(pending(), 'temp-Granola-7.700.0-mac-universal.zip'), 1000);
      expect(await collect('granola', { ...box })).toEqual([]);
    });

    it('keeps an update that is not installed yet, or marked for the next launch', async () => {
      await app('7.600.0');
      await update('7.668.3');
      expect(await collect('granola', { ...box })).toEqual([]);

      await app('7.668.3');
      await update('7.668.3', { installOnNextLaunch: true });
      expect(await collect('granola', { ...box })).toEqual([]);
    });
  });

  describe('npx', () => {
    const root = () => join(box.home, '.npm/_npx');

    async function entry(hash: string, name: string, version: string, spec: string, daysAgo: number) {
      const dir = join(root(), hash);
      await put(join(dir, 'package.json'), json({ dependencies: { [name]: `^${version}` }, _npx: { packages: [spec] } }), daysAgo);
      await put(join(dir, 'node_modules', name, 'package.json'), json({ name, version }), daysAgo);
      await put(join(dir, 'node_modules', name, 'index.js'), 20_000, daysAgo);
      await age(join(dir, 'node_modules'), daysAgo);
      await age(dir, daysAgo);
      return dir;
    }

    it('lists each entry by its packages, marks older versions and broken entries, and drops empty ones', async () => {
      const old = await entry('2f25a00e8cf5b33f', '@bytebase/dbhub', '0.13.2', '@bytebase/dbhub@0.13.2', 240);
      const current = await entry('e23b069b9efbbb8f', '@bytebase/dbhub', '1.5.0', '@bytebase/dbhub', 2);
      const other = await entry('a3241bba59c344f5', '@modelcontextprotocol/server-filesystem', '2025.8.21', '@modelcontextprotocol/server-filesystem', 360);
      const broken = join(root(), 'e41f203b7505f1fb');
      await put(join(broken, 'node_modules/.package-lock.json'), 5000, 50);
      await age(join(broken, 'node_modules'), 50);
      await age(broken, 50);
      await mkdir(join(root(), 'beb367dfa21eb3f5'));

      const items = await collect('npx', { ...box });
      const byPath = new Map(items.map((i) => [i.path, i]));
      expect(items).toHaveLength(4);
      expect(byPath.get(old)).toMatchObject({ label: '@bytebase/dbhub@0.13.2', junk: 'old-version', kind: 'packages', safety: 'safe', hint: 'redownload', confidence: 'low' });
      expect(byPath.get(current)!.junk).toBeUndefined();
      expect(byPath.get(current)!.label).toBe('@bytebase/dbhub@1.5.0');
      expect(byPath.get(other)!.junk).toBeUndefined();
      expect(byPath.get(broken)).toMatchObject({ junk: 'orphan', label: 'e41f203b7505f1fb' });
      expect(byPath.get(old)!.lastUsed).toBeLessThan(byPath.get(current)!.lastUsed);
    });

    it('blocks an entry touched in the last hour as a possible install in progress, and checks again before removing', async () => {
      const minutes = (n: number) => n / (24 * 60);
      // O npm já criou a pasta e o node_modules, mas o package.json só vem no fim da instalação.
      const installing = join(root(), '8b1e0c2f3a4d5e6f');
      await put(join(installing, 'node_modules/@bytebase/dbhub/index.js'), 20_000, minutes(10));
      await age(join(installing, 'node_modules'), minutes(10));
      await age(installing, minutes(10));
      const stale = join(root(), 'e41f203b7505f1fb');
      await put(join(stale, 'node_modules/.package-lock.json'), 5000, 50);
      await age(join(stale, 'node_modules'), 50);
      await age(stale, 50);

      const items = await collect('npx', { ...box });
      const byPath = new Map(items.map((i) => [i.path, i]));
      expect(byPath.get(installing)).toMatchObject({ blocked: 'recent' });
      expect(byPath.get(installing)!.junk).toBeUndefined();
      expect(byPath.get(stale)).toMatchObject({ junk: 'orphan' });
      expect(byPath.get(stale)!.blocked).toBeUndefined();

      const later = fakeContext({ ...box });
      expect(await byPath.get(stale)!.recheck!(later)).toBeNull();
      // O npx voltou a instalar os mesmos pacotes na pasta parada: o npm 11 segura o lock enquanto isso.
      await mkdir(join(stale, 'concurrency.lock'));
      await age(join(stale, 'concurrency.lock'), minutes(1));
      expect(await byPath.get(stale)!.recheck!(later)).toBe('recent');
    });

    it('keeps an old version that an MCP configuration pins, and never keeps the other arguments', async () => {
      const old = await entry('2f25a00e8cf5b33f', '@bytebase/dbhub', '0.13.2', '@bytebase/dbhub@0.13.2', 240);
      await entry('e23b069b9efbbb8f', '@bytebase/dbhub', '1.5.0', '@bytebase/dbhub', 2);
      const server = { command: 'npx', args: ['-y', '@bytebase/dbhub@0.13.2', '--dsn', 'postgres://u:secret@h/db'], env: { TOKEN: 'secret' } };
      await put(join(box.home, '.claude.json'), json({ projects: { [join(box.home, 'code/app')]: { mcpServers: { db: server } } } }));

      const items = await collect('npx', { ...box });
      expect(items.find((i) => i.path === old)!.junk).toBeUndefined();
      expect(JSON.stringify(items.map(({ recheck: _r, remove: _m, ...rest }) => rest))).not.toContain('secret');
    });

    it('reads the pinned version from the Codex config too', async () => {
      const old = await entry('2f25a00e8cf5b33f', '@bytebase/dbhub', '0.13.2', '@bytebase/dbhub@0.13.2', 240);
      await entry('e23b069b9efbbb8f', '@bytebase/dbhub', '1.5.0', '@bytebase/dbhub', 2);
      const codex = join(box.root, 'codex');
      await put(join(codex, 'config.toml'), '[mcp_servers.db]\ncommand = "npx"\nargs = ["-y", "@bytebase/dbhub@0.13.2"]\n\n[mcp_servers.db.env]\nDSN = "x"\n');
      const items = await collect('npx', { ...box, env: { CODEX_HOME: codex } });
      expect(items.find((i) => i.path === old)!.junk).toBeUndefined();
    });

    it('does not follow a local package link, and honors npm_config_cache', async () => {
      const cache = join(box.root, 'npm-cache');
      const repo = join(box.root, 'outside/tool');
      await put(join(repo, 'package.json'), json({ name: 'tool', version: '9.9.9' }));
      await put(join(repo, 'big.bin'), 100_000);
      const dir = join(cache, '_npx/56831755f0c37b1d');
      await put(join(dir, 'package.json'), json({ dependencies: { tool: `file:${repo}` }, _npx: { packages: [repo] } }));
      await mkdir(join(dir, 'node_modules'), { recursive: true });
      await symlink(repo, join(dir, 'node_modules/tool'));
      await entry('dfcbb843d4bf31c8', 'decoy', '1.0.0', 'decoy', 5);

      const items = await collect('npx', { ...box, env: { npm_config_cache: cache } });
      expect(items).toHaveLength(1);
      expect(items[0]).toMatchObject({ label: 'tool', project: repo, path: dir });
      expect(items[0].junk).toBeUndefined();
      expect(items[0].size).toBeLessThan(100_000);
    });
  });
});
