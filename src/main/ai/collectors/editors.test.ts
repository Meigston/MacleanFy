import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, symlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AI_TOOLS } from '../../../shared/api';
import { measure } from '../measure';
import { DAY, NOW, fakeContext, put, sandbox, type FakeOptions } from '../testing';
import type { AiContext, Found, ProcessInfo } from '../types';
import { createEditorCollectors } from './editors';

const VSCODE: ProcessInfo = { pid: 500, exe: '/Applications/Visual Studio Code.app/Contents/MacOS/Code', args: 'Code' };
const RIDER: ProcessInfo = { pid: 501, exe: '/Applications/Rider.app/Contents/MacOS/rider', args: 'rider' };

const FINDER = '/System/Library/CoreServices/Finder.app';

async function symlinkIn(path: string, target: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await symlink(target, path);
}
const CURSOR_BUNDLE = 'com.todesktop.230313mzl4w4u92';

/**
 * Um Spotlight de mentira que funciona: sempre acha o Finder e acha cada app cuja chave (o id ou
 * o nome do arquivo) a busca cita.
 */
function spotlight(apps: Record<string, string> = {}): NonNullable<FakeOptions['exec']> {
  return (file, args) => {
    if (file !== '/usr/bin/mdfind') return { code: 127, stdout: '', stderr: 'not faked' };
    const query = args[0] ?? '';
    const hits = Object.entries(apps)
      .filter(([key]) => query.includes(`'${key}'`))
      .map(([, path]) => path);
    const probe = query.includes("'com.apple.finder'") ? [FINDER] : [];
    return { code: 0, stdout: [...probe, ...hits].map((line) => `${line}\n`).join(''), stderr: '' };
  };
}

describe('editor collectors', () => {
  let box: Awaited<ReturnType<typeof sandbox>>;
  let apps: string;
  let brew: string;

  beforeEach(async () => {
    box = await sandbox();
    apps = join(box.root, 'Applications');
    brew = join(box.root, 'homebrew/bin');
    await mkdir(apps, { recursive: true });
    await mkdir(brew, { recursive: true });
  });

  afterEach(async () => {
    await box.cleanup();
  });

  const h = (relative: string) => join(box.home, relative);
  const support = (relative: string) => h(join('Library/Application Support', relative));
  const ctxWith = (options: Partial<FakeOptions> = {}) => fakeContext({ ...box, ...options });
  const editorCollectors = () => createEditorCollectors({ appDirs: () => [apps], binDirs: () => [brew] });

  /** Junta o que os coletores com esse id acharam, como o scanner faria. */
  async function collect(id: string, options: Partial<FakeOptions> = {}, patch: Partial<AiContext> = {}): Promise<Found[]> {
    const ctx = { ...ctxWith(options), ...patch };
    const collectors = editorCollectors().filter((collector) => collector.id === id);
    return (await Promise.all(collectors.map((collector) => collector.collect(ctx)))).flat();
  }

  const allPaths = (found: Found[]) => found.flatMap((item) => [item.path, ...(item.paths ?? [])]);
  const find = (found: Found[], kind: Found['kind'], label: string, key?: string) =>
    found.find((item) => item.kind === kind && item.label === label && (key === undefined || item.key === key));

  it('names every collector after a tool the screen knows', () => {
    for (const collector of createEditorCollectors()) expect(Object.keys(AI_TOOLS)).toContain(collector.id);
  });

  describe('Copilot in VS Code', () => {
    const storage = (relative: string) => support(join('Code/User/workspaceStorage', relative));
    const project = () => h('code/my app');

    async function workspaces() {
      // Duas pastas de workspace para o mesmo projeto (aberto como pasta e recriado).
      await put(storage('aaa/workspace.json'), JSON.stringify({ folder: pathToFileURL(project()).href }));
      await put(storage('aaa/chatSessions/s1.jsonl'), 4000, 30);
      await put(storage('aaa/chatSessions/s1.json'), 4000, 31);
      await put(storage('aaa/chatSessions/s2.jsonl'), 4000, 1);
      await put(storage('aaa/chatEditingSessions/s1/state.json'), 2000, 30);
      await put(storage('aaa/GitHub.copilot-chat/chat-session-resources/s1/tool/content.txt'), 500, 30);
      await put(storage('aaa/GitHub.copilot-chat/memory-tool/memories/notes.md'), 100, 30);
      await put(storage('aaa/GitHub.copilot-chat/local-index.1.db'), 8000, 40);
      await put(storage('aaa/GitHub.copilot-chat/local-index.1.db-wal'), 1000, 40);
      await put(storage('aaa/state.vscdb'), 5000, 1);
      await put(storage('bbb/workspace.json'), JSON.stringify({ folder: pathToFileURL(project()).href }));
      await put(storage('bbb/chatSessions/s3.jsonl'), 4000, 40);
      await put(storage('ccc/workspace.json'), JSON.stringify({ workspace: pathToFileURL(h('code/portal.code-workspace')).href }));
      await put(storage('ccc/chatSessions/s4.jsonl'), 4000, 50);
      await put(support('Code/User/globalStorage/state.vscdb'), 5000, 1);
      await put(support('Code/User/globalStorage/storage.json'), 500, 1);
      await put(support('Code/User/settings.json'), 500, 1);
    }

    it('groups chat sessions by project and heat, with the edit snapshots apart', async () => {
      await workspaces();
      const found = await collect('copilot');

      const cold = find(found, 'sessions', 'my app', 'cold')!;
      expect(cold.project).toBe(project());
      expect(cold.count).toBe(2);
      expect(cold.paths).toEqual(
        expect.arrayContaining([
          storage('aaa/chatSessions/s1.jsonl'),
          storage('aaa/chatSessions/s1.json'),
          storage('aaa/GitHub.copilot-chat/chat-session-resources/s1'),
          storage('bbb/chatSessions/s3.jsonl'),
        ])
      );
      expect(cold.lastUsed).toBeCloseTo(NOW - 30 * DAY, -3);
      expect(cold.safety).toBe('moderate');

      const hot = find(found, 'sessions', 'my app', 'hot')!;
      expect(hot.count).toBe(1);
      expect(hot.paths).toEqual([storage('aaa/chatSessions/s2.jsonl')]);

      // .code-workspace: o nome do arquivo, sem pasta de projeto.
      expect(find(found, 'sessions', 'portal', 'cold')).toMatchObject({ project: null, count: 1 });

      expect(find(found, 'checkpoints', 'my app', 'cold')).toMatchObject({ paths: [storage('aaa/chatEditingSessions/s1')], safety: 'moderate' });
    });

    it('offers the search index as safe, with its WAL, and never memory, state or settings', async () => {
      await workspaces();
      const found = await collect('copilot');
      expect(find(found, 'index', 'my app')).toMatchObject({
        safety: 'safe',
        paths: [storage('aaa/GitHub.copilot-chat/local-index.1.db'), storage('aaa/GitHub.copilot-chat/local-index.1.db-wal')],
      });
      const paths = allPaths(found);
      expect(paths.some((path) => path.includes('memory-tool'))).toBe(false);
      expect(paths.some((path) => /state\.vscdb|storage\.json|settings\.json/.test(path))).toBe(false);
    });

    it('blocks everything while VS Code is open, and lets it go once it closes', async () => {
      await workspaces();
      const found = await collect('copilot', { processes: [VSCODE] });
      expect(found.length).toBeGreaterThan(0);
      for (const item of found) expect(item.blocked).toBe('app-open');
      expect(await found[0].recheck!(ctxWith({ processes: [VSCODE] }))).toBe('app-open');
      expect(await found[0].recheck!(ctxWith())).toBeNull();
    });
  });

  describe('Copilot CLI', () => {
    const root = () => join(box.root, 'copilot-home');
    const session = (id: string, relative: string) => join(root(), 'session-state', id, relative);
    const yaml = (cwd: string, daysAgo: number) =>
      [
        `id: x`,
        `cwd: ${cwd}`,
        `summary: |`,
        `  cwd: /never/this`,
        `updated_at: ${new Date(NOW - daysAgo * DAY).toISOString()}`,
        '',
      ].join('\n');

    async function sessions() {
      const app = h('code/app');
      await put(session('a', 'workspace.yaml'), yaml(app, 20), 20);
      await put(session('a', 'events.jsonl'), 8000, 20);
      await put(session('b', 'workspace.yaml'), yaml(app, 2), 2);
      await put(session('b', 'events.jsonl'), 8000, 2);
      await put(session('c', 'workspace.yaml'), yaml(app, 40), 40);
      await put(session('c', 'events.jsonl'), 8000, 40);
      await put(session('c', 'inuse.4242.lock'), '', 40);
      await put(session('d', 'workspace.yaml'), yaml(h('code/other'), 30), 30);
      await put(session('d', 'events.jsonl'), 8000, 30);
      await put(session('d', 'inuse.999.lock'), '', 30);
      for (const name of ['settings.json', 'config.json', 'permissions-config.json', 'session-store.db']) await put(join(root(), name), 500, 30);
      await put(join(root(), 'ide/abc.lock'), 100, 30);
      await put(join(root(), 'logs/process-1-4242.log'), 3000, 30);
      await put(join(root(), 'logs/process-2-77.log'), 3000, 10);
      await put(join(root(), 'logs/process-3-78.log'), 3000, 1);
      await put(join(root(), 'jb/conv1/partition-1.jsonl'), 3000, 20);
      await put(join(root(), 'jb/conv2/partition-1.jsonl'), 3000, 1);
    }

    const cli = () => collect('copilot', { env: { COPILOT_HOME: root() }, processes: [{ pid: 4242, exe: '/opt/homebrew/bin/copilot', args: 'copilot' }] });

    it('reads sessions under COPILOT_HOME by cwd and update time, keeping the open one apart', async () => {
      await sessions();
      const found = await cli();
      const app = h('code/app');
      expect(find(found, 'sessions', 'app', 'cold')).toMatchObject({ project: app, count: 1, paths: [join(root(), 'session-state/a')] });
      expect(find(found, 'sessions', 'app', 'hot')).toMatchObject({ count: 1, paths: [join(root(), 'session-state/b')] });
      expect(find(found, 'sessions', 'app', 'live')).toMatchObject({ blocked: 'live-session', paths: [join(root(), 'session-state/c')] });
      // Trava de PID morto não conta.
      expect(find(found, 'sessions', 'other', 'cold')?.blocked).toBeUndefined();
      expect(found.some((item) => item.project === '/never/this')).toBe(false);
    });

    it('takes the newest of updated_at and what the session wrote since', async () => {
      const app = h('code/app');
      // Criada há 20 dias e usada ontem: o updated_at ficou na criação, o events.jsonl andou.
      await put(session('a', 'workspace.yaml'), yaml(app, 20), 20);
      await put(session('a', 'events.jsonl'), 8000, 1);
      // O contrário: o updated_at é de ontem e os arquivos estão parados.
      await put(session('b', 'workspace.yaml'), yaml(app, 1), 30);
      await put(session('b', 'events.jsonl'), 8000, 30);
      await put(session('c', 'workspace.yaml'), yaml(app, 30), 30);
      await put(session('c', 'events.jsonl'), 8000, 30);

      const found = await collect('copilot', { env: { COPILOT_HOME: root() } });
      const hot = find(found, 'sessions', 'app', 'hot')!;
      expect(hot.paths!.sort()).toEqual([join(root(), 'session-state/a'), join(root(), 'session-state/b')]);
      expect(hot.lastUsed).toBeCloseTo(NOW - DAY, -3);
      expect(find(found, 'sessions', 'app', 'cold')).toMatchObject({ count: 1, paths: [join(root(), 'session-state/c')] });
    });

    it('checks the locks again right before removing', async () => {
      await sessions();
      const other = find(await cli(), 'sessions', 'other', 'cold')!;
      expect(await other.recheck!(ctxWith())).toBeNull();
      expect(await other.recheck!(ctxWith({ processes: [{ pid: 999, exe: '/opt/homebrew/bin/copilot', args: 'copilot' }] }))).toBe('live-session');
    });

    it('offers only old logs of finished processes and cold JetBrains conversations, never settings or ide/', async () => {
      await sessions();
      const found = await cli();
      expect(find(found, 'logs', 'logs')).toMatchObject({ safety: 'safe', paths: [join(root(), 'logs/process-2-77.log')] });
      expect(find(found, 'sessions', 'jb')).toMatchObject({ key: 'cold', paths: [join(root(), 'jb/conv1')] });
      const paths = allPaths(found);
      expect(paths.some((path) => /settings\.json|config\.json|permissions-config|session-store|\/ide\b/.test(path))).toBe(false);
    });

    it('does not read ~/.copilot when COPILOT_HOME points elsewhere', async () => {
      await put(h('.copilot/session-state/z/workspace.yaml'), yaml(h('code/app'), 20), 20);
      await put(h('.copilot/session-state/z/events.jsonl'), 8000, 20);
      expect(await collect('copilot', { env: { COPILOT_HOME: root() } })).toEqual([]);
      expect(await collect('copilot')).toHaveLength(1);
    });
  });

  describe('Copilot in JetBrains IDEs', () => {
    const config = (relative: string) => h(join('.config/github-copilot', relative));
    const shop = () => h('code/Shop');

    async function stores() {
      await put(
        support('JetBrains/Rider2026.1/options/recentSolutions.xml'),
        `<application><component name="RiderRecentProjectsManager"><option name="additionalInfo"><map>
        <entry key="$USER_HOME$/code/Shop/Shop.sln"><value><RecentProjectMetaInfo frameTitle="Shop" projectWorkspaceId="PID1">
        <option name="activationTimestamp" value="1" /></RecentProjectMetaInfo></value></entry></map></option></component></application>`
      );
      // O xd.lck mais novo não esquenta: o sinal é o banco.
      await put(config('rd/chat-agent-sessions/PID1/copilot-agent-sessions-nitrite.db'), 9000, 20);
      await put(config('rd/chat-agent-sessions/PID1/xd.lck'), 100, 1);
      await put(config('rd/bg-agent-sessions/PID1/copilot-agent-snapshots.db'), 3000, 25);
      await put(config('rd/chat-agent-sessions/LOOSE/copilot-agent-sessions-nitrite.db'), 3000, 2);
      for (const name of ['auth.db', 'auth.db-wal', 'apps.json', 'versions.json', 'intellij/mcp.json', 'intellij/images/pasted.png']) await put(config(name), 500, 30);
      await put(h('.cache/github-copilot/project-index/Shop.168ed3bf/workspace-chunks.db'), 4000, 30);
      await put(h('.cache/github-copilot/project-context/Other.abcdef12/a.cs.1234.json'), 4000, 30);
    }

    it('names the agent stores by the IDE recent projects and keeps all store types together', async () => {
      await stores();
      const found = await collect('copilot', { processes: [RIDER], projects: [shop()] });
      const item = find(found, 'sessions', 'Shop')!;
      expect(item).toMatchObject({ key: 'cold', project: shop(), count: 1, blocked: 'app-open' });
      expect(item.paths).toEqual(expect.arrayContaining([config('rd/chat-agent-sessions/PID1'), config('rd/bg-agent-sessions/PID1')]));
      expect(find(found, 'sessions', 'LOOSE')).toMatchObject({ key: 'hot', project: null });
      expect(await item.recheck!(ctxWith())).toBeNull();
    });

    it('offers the context and the index as safe and never touches auth or shared config', async () => {
      await stores();
      // O projeto vem dos recentes do Rider, mesmo sem aparecer em ctx.projects.
      const found = await collect('copilot');
      expect(find(found, 'index', 'Shop')).toMatchObject({ safety: 'safe', project: shop() });
      expect(find(found, 'cache', 'Other')).toMatchObject({ safety: 'safe', project: null });
      expect(allPaths(found).some((path) => /auth\.db|apps\.json|versions\.json|intellij/.test(path))).toBe(false);
    });

    it('flags extracted copies of versions no plugin uses anymore', async () => {
      const copilot = (version: string) => JSON.stringify({ name: '@github/copilot', version });
      await put(h('.cache/pkg/aaa/@github/copilot/package.json'), copilot('1.0.47'), 60);
      await put(h('.cache/pkg/aaa/@github/copilot/index.js'), 9000, 60);
      await put(h('.cache/pkg/bbb/@github/copilot/package.json'), copilot('1.0.56'), 30);
      await put(h('.cache/pkg/ccc/@github/copilot/package.json'), copilot('1.0.60'), 2);
      await put(h('.cache/pkg/ddd/rg'), 9000, 60);
      await put(support('JetBrains/Rider2026.1/plugins/github-copilot-intellij/copilot-agent/dist/node_modules/@github/copilot/package.json'), copilot('1.0.56'));
      const versions = (await collect('copilot')).filter((item) => item.kind === 'versions');
      // A 1.0.56 é a do plugin; a 1.0.60, a mais nova, fica por garantia.
      expect(versions.map((item) => item.label)).toEqual(['@github/copilot 1.0.47']);
      expect(versions[0]).toMatchObject({ junk: 'old-version', safety: 'safe', confidence: 'low' });
    });
  });

  describe('old extension versions', () => {
    const ext = (relative: string) => h(join('.vscode/extensions', relative));

    it('flags old versions of AI extensions in VS Code, by the .obsolete or by a newer copy, and ignores the rest', async () => {
      for (const folder of [
        'anthropic.claude-code-2.1.290-darwin-arm64',
        'anthropic.claude-code-2.1.301-darwin-arm64',
        'ms-dotnettools.upgrade-agent-1.1.685',
        'ms-dotnettools.upgrade-agent-1.1.757',
        'redhat.java-1.40.0',
        'redhat.java-1.50.0',
        'github.copilot-chat-0.30.0',
      ]) {
        await put(ext(`${folder}/package.json`), 4000, 30);
      }
      await put(ext('.obsolete'), JSON.stringify({ 'ms-dotnettools.upgrade-agent-1.1.685': true }));
      await put(
        ext('extensions.json'),
        JSON.stringify(
          ['anthropic.claude-code-2.1.301-darwin-arm64', 'ms-dotnettools.upgrade-agent-1.1.757', 'redhat.java-1.50.0', 'github.copilot-chat-0.30.0'].map(
            (relativeLocation) => ({ identifier: { id: relativeLocation }, relativeLocation })
          )
        )
      );

      const found = (await collect('vscode')).filter((item) => item.kind === 'versions');
      expect(found.map((item) => [item.label, item.tool]).sort()).toEqual([
        ['anthropic.claude-code-2.1.290-darwin-arm64', 'claude-code'],
        ['ms-dotnettools.upgrade-agent-1.1.685', 'copilot'],
      ]);
      for (const item of found) expect(item).toMatchObject({ junk: 'old-version', safety: 'safe', removal: 'trash' });
    });

    it('lists the VS Code agent host sessions by heat', async () => {
      await put(support('Code/agentSessionData/one/session.db'), 9000, 20);
      await put(support('Code/agentSessionData/two/session.db'), 9000, 1);
      const found = (await collect('vscode')).filter((item) => item.kind === 'sessions');
      expect(found.map((item) => [item.key, item.count]).sort()).toEqual([
        ['cold', 1],
        ['hot', 1],
      ]);
    });
  });

  describe('Cursor, Windsurf, Trae and Kiro', () => {
    async function cursor() {
      await put(h('.cursor/extensions/ms-python.python-2024.1.0/package.json'), 9000, 300);
      await put(h('.cursor/extensions/ms-python.python-2025.1.0/package.json'), 9000, 300);
      await put(h('.cursor/extensions/.obsolete'), JSON.stringify({ 'ms-python.python-2024.1.0': true }), 300);
      await put(h('.cursor/extensions/extensions.json'), '[]', 300);
      await put(h('.cursor/mcp.json'), 500, 300);
      await put(h('.cursor/argv.json'), 500, 300);
      await put(h('.cursor/worktrees/app/1/file.ts'), 500, 300);
      await put(support('Cursor/User/globalStorage/state.vscdb'), 9000, 300);
      await put(support('Cursor/User/settings.json'), 500, 300);
      await put(support('Cursor/User/keybindings.json'), 500, 300);
      await put(support('Cursor/Backups/123/file/abc'), 500, 300);
      await put(support('Cursor/Workspaces/1/workspace.json'), 500, 300);
      await put(support('Cursor/CachedData/abc/x.bin'), 9000, 300);
      await put(support('Cursor/Code Cache/js/index'), 9000, 300);
      await put(support('Cursor/logs/20251228/main.log'), 500, 300);
      await put(h('Library/Logs/Cursor/main.log'), 500, 300);
    }

    /** Os restos do Cursor, com o Spotlight ligado e sem achar o app. */
    const uninstalledCursor = (options: Partial<FakeOptions> = {}) => collect('cursor', { exec: spotlight(), ...options });

    it('turns what an uninstalled Cursor left into leftovers, never its configuration or worktrees', async () => {
      await cursor();
      const found = await uninstalledCursor();
      expect(found.map((item) => item.label).sort()).toEqual(['.cursor/extensions', 'Library/Application Support/Cursor', 'Library/Logs/Cursor']);
      for (const item of found) expect(item).toMatchObject({ kind: 'leftovers', safety: 'moderate', removal: 'trash' });
      const paths = allPaths(found);
      expect(paths).not.toContain(h('.cursor'));
      expect(paths.some((path) => /mcp\.json|argv\.json|worktrees/.test(path))).toBe(false);
    });

    it('takes only caches and logs from the Application Support folder of an uninstalled editor', async () => {
      await cursor();
      const item = find(await uninstalledCursor(), 'leftovers', 'Library/Application Support/Cursor')!;
      expect(item.paths).toEqual([support('Cursor/CachedData'), support('Cursor/Code Cache'), support('Cursor/logs')]);
      expect(item.size).toBeGreaterThan(0);
    });

    it('keeps an installed Cursor to its obsolete extension versions', async () => {
      await cursor();
      await mkdir(join(apps, 'Cursor.app'));
      const found = await collect('cursor');
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ kind: 'versions', label: 'ms-python.python-2024.1.0', junk: 'old-version', safety: 'safe', tool: 'cursor' });
    });

    it('finds Cursor in a subfolder of the apps folder', async () => {
      await cursor();
      await mkdir(join(apps, 'AI/Cursor.app'), { recursive: true });
      expect((await uninstalledCursor()).map((item) => item.kind)).toEqual(['versions']);
    });

    it('asks Spotlight for Cursor by bundle id, renamed or outside the apps folders', async () => {
      await cursor();
      const found = await uninstalledCursor({ exec: spotlight({ [CURSOR_BUNDLE]: '/Volumes/External/Editors/Old Editor.app' }) });
      expect(found.map((item) => item.kind)).toEqual(['versions']);
    });

    it('does not count the copy the updater downloaded or the one in the Trash as installed', async () => {
      await cursor();
      const found = await uninstalledCursor({
        exec: spotlight({
          [CURSOR_BUNDLE]: h(`Library/Caches/${CURSOR_BUNDLE}.ShipIt/update.abc/Cursor.app`),
          'Cursor.app': h('.Trash/Cursor.app'),
        }),
      });
      expect(found.every((item) => item.kind === 'leftovers')).toBe(true);
      expect(found.length).toBeGreaterThan(0);
    });

    it.each([
      ['Spotlight is off', { exec: () => ({ code: 0, stdout: '', stderr: '' }) }],
      ['Spotlight fails', { exec: () => ({ code: 1, stdout: '', stderr: 'boom' }) }],
      ['the process list is unknown', { exec: spotlight(), processesKnown: false }],
    ])('counts Cursor as installed when %s', async (_, options: Partial<FakeOptions>) => {
      await cursor();
      const found = await collect('cursor', options);
      expect(found.some((item) => item.kind === 'leftovers')).toBe(false);
    });

    it('finds Windsurf renamed to Devin Desktop through Spotlight by name', async () => {
      await put(h('.windsurf/extensions/a.b-1.0.0/package.json'), 9000, 300);
      await put(support('Devin/User/settings.json'), 500, 300);
      await put(support('Devin/logs/main.log'), 500, 300);
      const left = await collect('windsurf', { exec: spotlight() });
      expect(find(left, 'leftovers', 'Library/Application Support/Devin')?.paths).toEqual([support('Devin/logs')]);
      const found = await collect('windsurf', { exec: spotlight({ 'Devin *.app': join(box.root, 'Downloads/Devin Desktop.app') }) });
      expect(found.some((item) => item.kind === 'leftovers')).toBe(false);
    });

    describe('cursor-agent history in ~/.cursor', () => {
      async function withChats() {
        await cursor();
        await put(h('.cursor/chats/abc/store.db'), 4000, 300);
        await put(h('.cursor/projects/app/agent-transcripts/t.txt'), 4000, 300);
      }
      const cliPaths = (found: Found[]) => [...new Set(allPaths(found))].filter((path) => /\/\.cursor\/(chats|projects|acp-sessions|ai-tracking)/.test(path));

      it.each([
        ['linked as agent', () => symlinkIn(h('.local/bin/agent'), '../share/cursor-agent/versions/2026.10.1/cursor-agent')],
        ['linked as cursor-agent', () => symlinkIn(h('.local/bin/cursor-agent'), '../share/cursor-agent/versions/2026.10.1/cursor-agent')],
        ['installed by Homebrew', () => put(join(brew, 'cursor-agent'), 100)],
        ['linked as agent by Homebrew', () => symlinkIn(join(brew, 'agent'), '../Caskroom/cursor-cli/1.0/agent')],
        ['only in its downloaded versions', () => put(h('.local/share/cursor-agent/versions/2026.10.1/index.js'), 100)],
      ])('never offers it when the CLI is %s', async (_, install) => {
        await withChats();
        await install();
        const found = await uninstalledCursor();
        expect(find(found, 'leftovers', '.cursor/extensions')).toBeDefined();
        expect(cliPaths(found)).toEqual([]);
      });

      it('never offers it while the CLI runs', async () => {
        await withChats();
        const node = { pid: 9, exe: h('.local/share/cursor-agent/versions/2026.10.1/node'), args: 'node index.js' };
        expect(cliPaths(await uninstalledCursor({ processes: [node] }))).toEqual([]);
      });

      it('offers it once the CLI is gone too, and an unrelated agent command does not count', async () => {
        await withChats();
        await symlinkIn(join(brew, 'agent'), '../Cellar/other-agent/1.0/bin/agent');
        expect(cliPaths(await uninstalledCursor()).sort()).toEqual([h('.cursor/chats'), h('.cursor/projects')]);
      });
    });

    it('counts a running Cursor as installed and blocks while it is open', async () => {
      await cursor();
      const found = await collect('cursor', { processes: [{ pid: 7, exe: '/Volumes/Apps/Cursor.app/Contents/MacOS/Cursor', args: 'Cursor' }] });
      expect(found.map((item) => [item.kind, item.blocked])).toEqual([['versions', 'app-open']]);
    });

    it('keeps the Trae AI config out of its leftovers', async () => {
      await put(h('.trae/extensions/x.y-1.0.0/package.json'), 9000, 300);
      await put(h('.trae/user_rules.md'), 200, 300);
      await put(h('.trae-aicc/config.json'), 100, 300);
      await put(h('.trae-aicc/.ripgrep/rg'), 9000, 300);
      await put(h('.trae-aicc/.code_contribution/_code_commit.db'), 9000, 300);
      const found = await collect('trae', { exec: spotlight() });
      const aicc = find(found, 'leftovers', '.trae-aicc')!;
      expect(aicc.paths).toEqual([h('.trae-aicc/.ripgrep'), h('.trae-aicc/.code_contribution')]);
      expect(allPaths(found).some((path) => /user_rules|config\.json/.test(path))).toBe(false);
    });

    it('follows KIRO_HOME for the Kiro extensions', async () => {
      const kiro = join(box.root, 'kiro-home');
      await put(join(kiro, 'extensions/a.b-1.0.0/package.json'), 9000, 300);
      await put(join(kiro, 'settings/mcp.json'), 100, 300);
      const found = await collect('kiro', { env: { KIRO_HOME: kiro }, exec: spotlight() });
      expect(found.map((item) => item.path)).toEqual([join(kiro, 'extensions')]);
    });

    it('shows a big Windsurf chat store only through the app', async () => {
      await mkdir(join(apps, 'Windsurf.app'));
      await put(h('.codeium/windsurf/cascade/a.pb'), 4000, 2);
      await put(h('.codeium/windsurf/memories/global_rules.md'), 100, 2);
      // Uma medida de mentira: gravar 600 MB de verdade só deixaria o teste lento.
      const big = async (path: string) => ({ ...(await measure(path)), ...(path.endsWith('/cascade') ? { size: 600 * 1024 * 1024 } : {}) });
      const found = await collect('windsurf', {}, { measure: big });
      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({ kind: 'sessions', removal: 'none', blocked: 'via-app' });
    });
  });

  describe('Cline, Roo Code and Kilo Code', () => {
    const storage = (editor: string, extension: string, relative: string) => support(join(editor, 'User/globalStorage', extension, relative));

    it('lists tasks per editor by heat and keeps the MCP settings out', async () => {
      await put(storage('Code', 'saoudrizwan.claude-dev', 'tasks/t1/ui_messages.json'), 4000, 30);
      await put(storage('Code', 'saoudrizwan.claude-dev', 'tasks/t1/api_conversation_history.json'), 4000, 30);
      await put(storage('Code', 'saoudrizwan.claude-dev', 'tasks/t2/ui_messages.json'), 4000, 1);
      await put(storage('Code', 'saoudrizwan.claude-dev', 'checkpoints/123/.git/index'), 4000, 30);
      await put(storage('Code', 'saoudrizwan.claude-dev', 'checkpoints/123/.git/objects/ab/cd'), 4000, 30);
      await put(storage('Code', 'saoudrizwan.claude-dev', 'settings/cline_mcp_settings.json'), 100, 30);
      await put(storage('Code', 'saoudrizwan.claude-dev', 'state/taskHistory.json'), 100, 30);
      await put(h('.cline/data/tasks/c1/ui_messages.json'), 4000, 15);

      const found = await collect('cline');
      expect(find(found, 'sessions', 'Code', 'cold')).toMatchObject({ count: 1, paths: [storage('Code', 'saoudrizwan.claude-dev', 'tasks/t1')] });
      expect(find(found, 'sessions', 'Code', 'hot')).toMatchObject({ count: 1 });
      expect(find(found, 'checkpoints', 'Code', 'cold')).toMatchObject({ paths: [storage('Code', 'saoudrizwan.claude-dev', 'checkpoints/123')] });
      expect(find(found, 'sessions', '.cline', 'cold')).toMatchObject({ count: 1 });
      expect(allPaths(found).some((path) => /settings|taskHistory/.test(path))).toBe(false);
    });

    it('finds Roo in Cursor and Kilo in VS Code, blocked while their editor is open', async () => {
      await put(storage('Cursor', 'rooveterinaryinc.roo-cline', 'tasks/r1/ui_messages.json'), 4000, 10);
      await put(storage('Cursor', 'rooveterinaryinc.roo-cline', 'tasks/r1/checkpoints/.git/HEAD'), 100, 10);
      await put(storage('Cursor', 'rooveterinaryinc.roo-cline', 'settings/mcp_settings.json'), 100, 10);
      await put(storage('Code', 'kilocode.kilo-code', 'tasks/k1/ui_messages.json'), 4000, 10);

      const roo = await collect('roo-code');
      expect(roo.map((item) => [item.label, item.key, item.tool])).toEqual([['Cursor', 'cold', 'roo-code']]);
      const kilo = await collect('kilo-code', { processes: [VSCODE] });
      expect(kilo.map((item) => [item.label, item.blocked])).toEqual([['Code', 'app-open']]);
    });
  });

  it('reads Continue from CONTINUE_GLOBAL_DIR, without its index of sessions or its config', async () => {
    const root = join(box.root, 'continue');
    await put(join(root, 'sessions/a.json'), 4000, 20);
    await put(join(root, 'sessions/sessions.json'), 400, 1);
    await put(join(root, 'config.yaml'), 400, 1);
    await put(join(root, '.env'), 100, 1);
    await put(join(root, 'index/index.sqlite'), 9000, 5);
    await put(join(root, 'index/lancedb/t/data.lance'), 9000, 5);
    await put(join(root, 'index/globalContext.json'), 100, 5);
    await put(join(root, 'logs/core.log'), 900, 5);

    const found = await collect('continue', { env: { CONTINUE_GLOBAL_DIR: root } });
    expect(find(found, 'sessions', 'continue', 'cold')).toMatchObject({ count: 1, paths: [join(root, 'sessions/a.json')] });
    expect(find(found, 'index', 'index')!.paths!.sort()).toEqual([join(root, 'index/index.sqlite'), join(root, 'index/lancedb')]);
    expect(find(found, 'logs', 'logs')).toMatchObject({ safety: 'safe' });
    expect(allPaths(found).some((path) => /sessions\.json|config\.yaml|\.env|globalContext/.test(path))).toBe(false);
  });

  it('shows the Zed threads only through the app, and offers the LMDB left from before the migration', async () => {
    await put(support('Zed/threads/threads.db'), 9000, 1);
    await put(support('Zed/threads/threads-db.1.mdb/data.mdb'), 9000, 200);
    const found = await collect('zed');
    expect(find(found, 'sessions', 'threads.db')).toMatchObject({ removal: 'none', blocked: 'via-app' });
    expect(find(found, 'sessions', 'threads-db.1.mdb')).toMatchObject({ junk: 'old-version', removal: 'trash', safety: 'moderate' });
  });

  it('groups the JetBrains AI Assistant agent tasks per IDE folder and never offers the workspace or options', async () => {
    const history = (name: string) => support(join('JetBrains/Rider2026.1/aia-task-history', name));
    await put(history('u1.agentsession'), 4000, 20);
    await put(history('u1.events'), 4000, 20);
    await put(history('u2.agentsession'), 4000, 1);
    await put(support('JetBrains/Rider2026.1/workspace/PID1.xml'), 4000, 20);
    await put(support('JetBrains/Rider2026.1/options/llm.xml'), 400, 20);

    const found = await collect('jetbrains', { processes: [RIDER] });
    expect(find(found, 'sessions', 'Rider2026.1', 'cold')).toMatchObject({ count: 1, paths: [history('u1.agentsession'), history('u1.events')], blocked: 'app-open' });
    expect(find(found, 'sessions', 'Rider2026.1', 'hot')).toMatchObject({ count: 1 });
    expect(allPaths(found).some((path) => /workspace|options/.test(path))).toBe(false);
  });

  it('finds nothing in an empty account', async () => {
    const ctx = ctxWith();
    for (const collector of editorCollectors()) expect(await collector.collect(ctx)).toEqual([]);
  });
});
