import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { lstat, mkdir, readFile, realpath, rm, stat, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from '../context';
import { AiScanner } from '../scanner';
import { DAY, NOW, age, fakeContext, put, sandbox, type FakeOptions } from '../testing';
import type { AiContext, Found } from '../types';
import { parseStatus, parseWorktreeList, worktreeCollectors } from './worktrees';

/** git sem a configuração da conta de quem roda os testes. */
const GIT_ENV = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await run('git', args, { cwd, env: GIT_ENV });
  if (result.code !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

const exec = (file: string, args: string[], options?: Parameters<AiContext['exec']>[2]) =>
  run(file, args, { ...options, env: { ...options?.env, ...GIT_ENV } });

/** Repositório com um commit, que ignora node_modules e .env*. Devolve o caminho resolvido, como o git o mostra. */
async function repo(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  await git(path, 'init', '-q', '-b', 'main');
  await put(join(path, 'README.md'), 'hello');
  await put(join(path, '.gitignore'), 'node_modules/\n.env*\n');
  await put(join(path, 'CLAUDE.md'), 'instructions');
  await git(path, 'add', '.');
  await git(path, 'commit', '-qm', 'init');
  return realpath(path);
}

/** Uma worktree com um node_modules de 50 kB, para ter tamanho. */
async function worktree(main: string, path: string, ...options: string[]): Promise<string> {
  await mkdir(join(path, '..'), { recursive: true });
  await git(main, 'worktree', 'add', '-q', ...options, path);
  await put(join(path, 'node_modules/pkg/index.js'), 50_000);
  return realpath(path);
}

async function adminOf(path: string): Promise<string> {
  return (await readFile(join(path, '.git'), 'utf8')).replace('gitdir: ', '').trim();
}

/** Recua para `daysAgo` dias o último uso que o git registra para a worktree. */
async function usedAt(path: string, daysAgo: number): Promise<void> {
  const admin = await adminOf(path);
  for (const file of ['index', 'HEAD', 'logs/HEAD', 'COMMIT_EDITMSG', 'ORIG_HEAD', 'FETCH_HEAD']) {
    await age(join(admin, file), daysAgo).catch(() => undefined);
  }
}

const encode = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-');
const collector = (id: string) => worktreeCollectors.find((c) => c.id === id)!;
const byLabel = (items: Found[]) => Object.fromEntries(items.map((item) => [item.label, item]));
const listed = async (main: string) => parseWorktreeList(await git(main, 'worktree', 'list', '--porcelain', '-z')).map((w) => w.path);

describe('worktree collectors', () => {
  let box: Awaited<ReturnType<typeof sandbox>>;

  beforeEach(async () => {
    box = await sandbox();
  });

  afterEach(async () => {
    await box.cleanup();
  });

  const context = (extra: Partial<FakeOptions> = {}) => fakeContext({ ...box, exec, ...extra });

  it('lists a clean Claude Code worktree and removes it to the Trash, then prunes it and keeps the branch', async () => {
    const main = await repo(join(box.home, 'code/app'));
    const wt = await worktree(main, join(main, '.claude/worktrees/feature'), '-b', 'feature-x');
    await usedAt(wt, 20);
    const ctx = context({ projects: [join(box.home, 'code/app')] });

    const scanner = new AiScanner(worktreeCollectors, async () => ctx);
    const { items, failed } = await scanner.scan();

    expect(failed).toEqual([]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      tool: 'claude-code',
      kind: 'worktree',
      label: 'feature · feature-x',
      project: main,
      path: wt,
      count: 1,
      heat: 'cold',
      safety: 'moderate',
      removal: 'git',
      hint: 'branch-kept',
    });
    expect(items[0].size).toBeGreaterThanOrEqual(50_000);
    expect(items[0].blocked).toBeUndefined();

    const result = await scanner.remove([items[0].id]);

    expect(result).toMatchObject({ removed: 1, failed: [] });
    expect(ctx.trashed).toEqual([wt]);
    expect(await listed(main)).toEqual([main]);
    expect(await git(main, 'branch', '--list', 'feature-x')).toContain('feature-x');
  });

  it('blocks a worktree with uncommitted or untracked changes, also when it changes after the scan', async () => {
    const main = await repo(join(box.home, 'code/app'));
    const edited = await worktree(main, join(main, '.claude/worktrees/edited'), '-b', 'edited');
    const untracked = await worktree(main, join(main, '.claude/worktrees/untracked'), '-b', 'untracked');
    const later = await worktree(main, join(main, '.claude/worktrees/later'), '-b', 'later');
    await put(join(edited, 'README.md'), 'changed');
    await put(join(untracked, 'notes.txt'), 'draft');
    const ctx = context({ projects: [main] });

    const scanner = new AiScanner(worktreeCollectors, async () => ctx);
    const { items } = await scanner.scan();
    const blocked = Object.fromEntries(items.map((item) => [item.label, item.blocked]));
    expect(blocked).toEqual({ edited: 'uncommitted', untracked: 'uncommitted', later: undefined });

    await put(join(later, 'src/new.ts'), 'export {}');
    const result = await scanner.remove([later]);

    expect(result.failed).toEqual([{ id: later, blocked: 'uncommitted' }]);
    expect(ctx.trashed).toEqual([]);
    expect(await lstat(join(later, 'src/new.ts'))).toBeTruthy();
  });

  it('blocks a detached worktree only when it holds commits that no branch has', async () => {
    const main = await repo(join(box.home, 'code/app'));
    const loose = await worktree(main, join(main, '.claude/worktrees/loose'), '--detach');
    await worktree(main, join(main, '.claude/worktrees/at-main'), '--detach');
    await git(loose, 'commit', '-q', '--allow-empty', '-m', 'only here');

    const items = byLabel(await collector('claude-code').collect(context({ projects: [main] })));

    expect(items.loose.blocked).toBe('detached');
    expect(items['at-main'].blocked).toBeUndefined();
  });

  it('blocks a worktree with a .env that the main checkout does not have the same', async () => {
    const main = await repo(join(box.home, 'code/app'));
    await put(join(main, '.env'), 'TOKEN=1');
    const same = await worktree(main, join(main, '.claude/worktrees/same'), '-b', 'same');
    const extra = await worktree(main, join(main, '.claude/worktrees/extra'), '-b', 'extra');
    const changed = await worktree(main, join(main, '.claude/worktrees/changed'), '-b', 'changed');
    const venv = await worktree(main, join(main, '.claude/worktrees/venv'), '-b', 'venv');
    const linked = await worktree(main, join(main, '.claude/worktrees/linked'), '-b', 'linked');
    await put(join(same, '.env'), 'TOKEN=1');
    await put(join(extra, '.env.local'), 'TOKEN=2');
    await put(join(changed, '.env'), 'TOKEN=3');
    await put(join(venv, '.env/bin/activate'), 'venv');
    await symlink(join(box.root, 'elsewhere.env'), join(linked, '.env.production'));

    const items = byLabel(await collector('claude-code').collect(context({ projects: [main] })));

    expect(items.same.blocked).toBeUndefined();
    expect(items.extra.blocked).toBe('env-only');
    expect(items.changed.blocked).toBe('env-only');
    expect(items.venv.blocked).toBeUndefined();
    expect(items.linked.blocked).toBeUndefined();
  });

  it('releases a lock whose process is gone and keeps the ones a live process or the user holds', async () => {
    const main = await repo(join(box.home, 'code/app'));
    const dead = await worktree(main, join(main, '.claude/worktrees/dead'), '-b', 'dead');
    const reused = await worktree(main, join(main, '.claude/worktrees/reused'), '-b', 'reused');
    await worktree(main, join(main, '.claude/worktrees/alive'), '-b', 'alive');
    await worktree(main, join(main, '.claude/worktrees/manual'), '-b', 'manual');
    await git(main, 'worktree', 'lock', '--reason', 'claude session dead (pid 999999 start Fri Oct  2 13:44:26 2026)', dead);
    await git(main, 'worktree', 'lock', '--reason', 'claude session reused (pid 4343 start Fri Oct  2 13:44:26 2026)', reused);
    await git(main, 'worktree', 'lock', '--reason', 'claude session alive (pid 4242 start Fri Oct  2 13:44:26 2026)', join(main, '.claude/worktrees/alive'));
    await git(main, 'worktree', 'lock', join(main, '.claude/worktrees/manual'));
    const ctx = context({
      projects: [main],
      processes: [
        { pid: 4242, exe: '/Users/ana/.local/share/claude/versions/2.1.300', args: 'claude' },
        { pid: 4343, exe: '/usr/sbin/cron', args: '/usr/sbin/cron' },
      ],
    });

    const scanner = new AiScanner(worktreeCollectors, async () => ctx);
    const { items } = await scanner.scan();
    const blocked = Object.fromEntries(items.map((item) => [item.label, item.blocked]));
    expect(blocked).toEqual({ dead: undefined, reused: undefined, alive: 'locked', manual: 'locked' });

    const result = await scanner.remove([dead]);

    expect(result.removed).toBe(1);
    expect(ctx.trashed).toEqual([dead]);
    expect(await listed(main)).not.toContain(dead);
    expect(await listed(main)).toContain(join(main, '.claude/worktrees/alive'));
  });

  it('blocks the worktrees a live Claude Code session owns, by cwd, workflow, subagent and job', async () => {
    const main = await repo(join(box.home, 'code/app'));
    const named = await worktree(main, join(main, '.claude/worktrees/named'), '-b', 'named');
    const flow = await worktree(main, join(main, '.claude/worktrees/wf_0a1b2c3d-4e5-2'), '-b', 'flow');
    const agent = await worktree(main, join(main, '.claude/worktrees/agent-a0123456789abcdef'), '-b', 'agent');
    const job = await worktree(main, join(main, '.claude/worktrees/job'), '-b', 'job');
    const finished = await worktree(main, join(main, '.claude/worktrees/wf_99999999-fff-1'), '-b', 'finished');
    for (const path of [named, flow, agent, job, finished]) await usedAt(path, 20);
    const sessions = join(box.home, '.claude/projects', encode(main));
    await put(join(sessions, 'live-id/workflows/wf_0a1b2c3d-4e5.json'), '{}');
    await put(join(sessions, 'live-id/subagents/agent-a0123456789abcdef.meta.json'), '{}');
    await put(join(sessions, 'gone-id/workflows/wf_99999999-fff.json'), '{}');
    await put(join(box.home, '.claude/jobs/1a2b3c4d/state.json'), JSON.stringify({ sessionId: 'job-id', worktreePath: job }));
    const ctx = context({
      projects: [main],
      claudeSessions: [
        { pid: 10, sessionId: 'live-id', cwd: main },
        { pid: 11, sessionId: 'named-id', cwd: join(named, 'src') },
        { pid: 12, sessionId: 'job-id', cwd: main },
      ],
    });

    const { items } = await new AiScanner(worktreeCollectors, async () => ctx).scan();
    const state = Object.fromEntries(items.map((item) => [item.label.split(' · ')[0], [item.blocked, item.heat]]));

    expect(state).toEqual({
      named: ['live-session', 'hot'],
      'wf_0a1b2c3d-4e5-2': ['live-session', 'hot'],
      'agent-a0123456789abcdef': ['live-session', 'hot'],
      job: ['live-session', 'hot'],
      'wf_99999999-fff-1': [undefined, 'cold'],
    });
  });

  it('ignores worktrees outside the orchestrator folders and never lists the main checkout', async () => {
    const main = await repo(join(box.home, 'code/app'));
    await worktree(main, join(box.home, 'code/app-hotfix'), '-b', 'hotfix');
    await worktree(main, join(main, 'other/worktrees/mine'), '-b', 'mine');
    const agentWt = await worktree(main, join(main, '.claude/worktrees/agent'), '-b', 'agent');
    // Sem ~/.crystal, <projeto>/worktrees é costume do usuário.
    await worktree(main, join(main, 'worktrees/by-hand'), '-b', 'by-hand');
    const ctx = context({ projects: [main, join(box.home, 'code/app-hotfix')] });

    const found = (await Promise.all(worktreeCollectors.map((c) => c.collect(ctx)))).flat();

    expect(found.map((item) => item.path)).toEqual([agentWt]);
    expect(found[0].tool).toBe('claude-code');
  });

  it('splits cold from hot by the git index and the Claude Code transcript, without touching the index', async () => {
    const main = await repo(join(box.home, 'code/app'));
    const old = await worktree(main, join(main, '.claude/worktrees/old'), '-b', 'old');
    const resumed = await worktree(main, join(main, '.claude/worktrees/resumed'), '-b', 'resumed');
    const fresh = await worktree(main, join(main, '.claude/worktrees/fresh'), '-b', 'fresh');
    await usedAt(old, 20);
    await usedAt(resumed, 20);
    await usedAt(fresh, 2);
    // Pasta e arquivos novos não esquentam: o mtime deles não diz uso.
    await put(join(old, 'node_modules/.cache/x'), 100);
    const config = join(box.home, 'claude-config');
    await put(join(config, 'projects', encode(resumed), 'session.jsonl'), '{}', 1);
    const ctx = context({ projects: [main], env: { CLAUDE_CONFIG_DIR: config } });

    const { items } = await new AiScanner(worktreeCollectors, async () => ctx).scan();
    const heat = Object.fromEntries(items.map((item) => [item.label.split(' · ')[0], item.heat]));

    expect(heat).toEqual({ old: 'cold', resumed: 'hot', fresh: 'hot' });
    expect(items.find((item) => item.path === resumed)?.lastUsed).toBe(NOW - DAY);
    expect((await stat(join(await adminOf(old), 'index'))).mtimeMs).toBe(NOW - 20 * DAY);
  });

  it('reads the other orchestrators, finding the repository from their folders, and leaves Codex to its app', async () => {
    const main = await repo(join(box.home, 'code/app'));
    await mkdir(join(box.home, '.crystal'));
    const codexHome = join(box.home, 'codex-home');
    const paths = {
      cursor: await worktree(main, join(box.home, '.cursor/worktrees/app/k3j9'), '-b', 'cursor-1'),
      conductor: await worktree(main, join(box.home, 'conductor/workspaces/app/tokyo'), '-b', 'tokyo'),
      'claude-squad': await worktree(main, join(box.home, '.claude-squad/worktrees/fix_18a2b4c'), '-b', 'ana/fix'),
      'vibe-kanban': await worktree(main, join(box.tmp, 'vibe-kanban/worktrees/a1-task'), '-b', 'vk/a1'),
      crystal: await worktree(main, join(main, 'worktrees/session-1'), '-b', 'crystal-1'),
      codex: await worktree(main, join(codexHome, 'worktrees/7f3a/app'), '--detach'),
    };
    await worktree(main, join(box.home, '.codex/worktrees/1b2c/app'), '--detach');
    // Nenhuma sessão citou o repositório: ele aparece pelas pastas dos orquestradores.
    const ctx = context({ env: { CODEX_HOME: codexHome } });

    for (const [tool, path] of Object.entries(paths)) {
      const items = await collector(tool).collect(ctx);
      expect(items.map((item) => [item.tool, item.path, item.project])).toEqual([[tool, path, main]]);
    }
    const [codex] = await collector('codex').collect(ctx);
    expect(codex).toMatchObject({ removal: 'none', blocked: 'via-app' });
    expect(codex.remove).toBeUndefined();
  });

  it('keeps other vanished worktrees registered when it prunes', async () => {
    const main = await repo(join(box.home, 'code/app'));
    const external = await worktree(main, join(box.home, 'external/drive-wt'), '--detach');
    await git(external, 'commit', '-q', '--allow-empty', '-m', 'only on the external drive');
    await rm(external, { recursive: true, force: true });
    const done = await worktree(main, join(main, '.claude/worktrees/done'), '-b', 'done');
    const ctx = context({ projects: [main] });

    const scanner = new AiScanner(worktreeCollectors, async () => ctx);
    await scanner.scan();
    expect((await scanner.remove([done])).removed).toBe(1);

    const after = parseWorktreeList(await git(main, 'worktree', 'list', '--porcelain', '-z'));
    expect(after.map((w) => w.path)).toEqual([main, external]);
    expect(after[1]).toMatchObject({ prunable: true, locked: null });
  });
});

describe('git output parsing', () => {
  it('reads the porcelain worktree list with locks, detached heads and prunable entries', () => {
    const output = [
      'worktree /r', 'HEAD a', 'branch refs/heads/main', '',
      'worktree /r/.claude/worktrees/x', 'HEAD b', 'detached', 'locked claude session x (pid 1 start …)', '',
      'worktree /tmp/gone', 'HEAD c', 'branch refs/heads/gone', 'prunable gitdir file points to non-existent location', '',
    ].join('\0');
    expect(parseWorktreeList(output)).toEqual([
      { path: '/r', branch: 'main', detached: false, bare: false, locked: null, prunable: false },
      { path: '/r/.claude/worktrees/x', branch: null, detached: true, bare: false, locked: 'claude session x (pid 1 start …)', prunable: false },
      { path: '/tmp/gone', branch: 'gone', detached: false, bare: false, locked: null, prunable: true },
    ]);
  });

  it('tells changes from ignored paths in the porcelain status, skipping the source of a rename', () => {
    expect(parseStatus(['!! node_modules/', '!! .env.local', ''].join('\0'))).toEqual({ changed: false, ignored: ['node_modules/', '.env.local'] });
    expect(parseStatus(['R  new.ts', '!! old.ts', '!! .env', ''].join('\0'))).toEqual({ changed: true, ignored: ['.env'] });
  });
});
