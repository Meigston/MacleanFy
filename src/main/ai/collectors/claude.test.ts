import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DAY, NOW, fakeContext, put, sandbox, type FakeOptions } from '../testing';
import type { AiContext, Found } from '../types';
import { claudeCollectors, compareVersions, encodeProject } from './claude';

const id = (digit: string) => `${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const COLD = id('1');
const COLD_TOO = id('2');
const HOT = id('3');
const BY_SUBAGENT = id('4');
const LIVE = id('5');
const OTHER = id('6');

const PROJECT = '/Users/ana/code/app';
const header = (cwd: string, sessionId = 'x') => JSON.stringify({ type: 'user', cwd, sessionId }) + '\n';
const covers = (item: Found, path: string) =>
  (item.paths ?? [item.path]).some((outer) => path === outer || path.startsWith(outer + '/'));

describe('claude-code collector', () => {
  let box: Awaited<ReturnType<typeof sandbox>>;
  let claude: string;
  let folder: string;

  beforeEach(async () => {
    box = await sandbox();
    claude = join(box.home, '.claude');
    folder = join(claude, 'projects', encodeProject(PROJECT));
  });

  afterEach(async () => {
    await box.cleanup();
  });

  // O scratchpad sempre vai para a caixa de areia: o /private/tmp de verdade nunca é lido nos testes.
  const context = (options: Partial<FakeOptions> = {}) =>
    fakeContext({ ...box, ...options, env: { CLAUDE_CODE_TMPDIR: box.tmp, ...options.env } });
  const collect = (ctx: AiContext, tool = 'claude-code') => claudeCollectors.find((c) => c.id === tool)!.collect(ctx);
  const live = (sessionId: string, pid = 100) => ({ pid, sessionId, cwd: PROJECT });

  it('groups sessions by project and heat, with their sibling folder and per-session data', async () => {
    await put(join(folder, `${COLD}.jsonl`), header(PROJECT), 20);
    await put(join(folder, COLD, 'tool-results', 'out.txt'), 5000, 20);
    await put(join(claude, 'file-history', COLD, 'app.ts@v1'), 3000, 20);
    await put(join(claude, 'uploads', COLD, 'shot.png'), 3000, 20);
    await put(join(folder, `${COLD_TOO}.orphaned-1790000000000-ab.jsonl`), header(PROJECT), 25);
    await put(join(folder, `${HOT}.jsonl`), header(PROJECT), 2);
    // A transcrição principal parou há um mês, mas um subagente escreveu ontem.
    await put(join(folder, `${BY_SUBAGENT}.jsonl`), header(PROJECT), 30);
    await put(join(folder, BY_SUBAGENT, 'subagents', 'agent-a1.jsonl'), 4000, 1);
    await put(join(folder, `${LIVE}.jsonl`), header(PROJECT), 15);
    await put(join(folder, 'memory', 'MEMORY.md'), 'notes', 40);

    const items = (await collect(context({ claudeSessions: [live(LIVE)] }))).filter((item) => item.kind === 'sessions');
    const byKey = Object.fromEntries(items.map((item) => [item.key, item]));

    expect(Object.keys(byKey).sort()).toEqual(['cold', 'hot', 'live']);
    for (const item of items) {
      expect(item.path).toBe(folder);
      expect(item.label).toBe('app');
      expect(item.project).toBe(PROJECT);
      expect(item.safety).toBe('moderate');
      expect(item.paths!.some((path) => path.includes('/memory'))).toBe(false);
    }

    expect(byKey.cold.count).toBe(2);
    expect(byKey.cold.lastUsed).toBe(NOW - 20 * DAY);
    expect(byKey.cold.hint).toBe('cleanup-period');
    expect(byKey.cold.paths!.sort()).toEqual(
      [
        join(folder, `${COLD}.jsonl`),
        join(folder, COLD),
        join(claude, 'file-history', COLD),
        join(claude, 'uploads', COLD),
        join(folder, `${COLD_TOO}.orphaned-1790000000000-ab.jsonl`),
      ].sort()
    );

    expect(byKey.hot.count).toBe(2);
    expect(byKey.hot.lastUsed).toBe(NOW - DAY);
    expect(byKey.hot.hint).toBeUndefined();
    expect(byKey.hot.paths).toContain(join(folder, BY_SUBAGENT));

    expect(byKey.live.blocked).toBe('live-session');
    expect(byKey.live.paths).toEqual([join(folder, `${LIVE}.jsonl`)]);
  });

  it('checks again whether a listed session was reopened', async () => {
    await put(join(folder, `${COLD}.jsonl`), header(PROJECT), 20);
    const [item] = await collect(context());
    expect(item.blocked).toBeUndefined();
    expect(await item.recheck!(context())).toBeNull();
    expect(await item.recheck!(context({ claudeSessions: [live(COLD)] }))).toBe('live-session');
  });

  it('keeps the workflow pieces a session leaves in other project folders with that session', async () => {
    const other = '/Users/ana/code/other';
    const elsewhere = join(claude, 'projects', encodeProject(other));
    await put(join(folder, `${LIVE}.jsonl`), header(PROJECT), 1);
    await put(join(elsewhere, LIVE, 'workflows', 'wf_1.json'), 2000, 12);
    await put(join(folder, `${COLD}.jsonl`), header(PROJECT), 20);
    await put(join(elsewhere, COLD, 'workflows', 'wf_2.json'), 2000, 20);
    await put(join(claude, 'file-history', COLD, 'v1'), 2000, 20);

    const items = (await collect(context({ claudeSessions: [live(LIVE)], projects: [PROJECT, other] }))).filter(
      (item) => item.path === elsewhere
    );
    const byKey = Object.fromEntries(items.map((item) => [item.key, item]));

    // Sem transcrição na pasta, o nome vem do projeto conhecido cuja codificação bate.
    expect(byKey.live).toMatchObject({ label: 'other', project: other, blocked: 'live-session', paths: [join(elsewhere, LIVE)] });
    // file-history vai com a pasta que tem a transcrição, não com o pedaço.
    expect(byKey.cold.paths).toEqual([join(elsewhere, COLD)]);
  });

  it('reads the sessions from CLAUDE_CONFIG_DIR', async () => {
    const custom = join(box.root, 'custom-claude');
    const customFolder = join(custom, 'projects', encodeProject(PROJECT));
    await put(join(customFolder, `${COLD}.jsonl`), header(PROJECT), 20);
    await put(join(folder, `${HOT}.jsonl`), header(PROJECT), 1);

    const items = await collect(context({ env: { CLAUDE_CONFIG_DIR: custom } }));
    expect(items.map((item) => item.path)).toEqual([customFolder]);
  });

  it('lists only the scratch folder of each background job, blocked while its session lives', async () => {
    const job = (name: string) => join(claude, 'jobs', name);
    const state = (name: string, value: object) => put(join(job(name), 'state.json'), JSON.stringify(value), 20);
    await state('aaaa1111', { state: 'done', sessionId: LIVE, cwd: PROJECT, updatedAt: new Date(NOW - 20 * DAY).toISOString() });
    await put(join(job('aaaa1111'), 'adopt.json'), JSON.stringify({ writtenAtMs: NOW - 11 * DAY }), 11);
    await put(join(job('aaaa1111'), 'tmp', 'shot.png'), 3000, 20);
    // "working" desde julho, com o supervisor morto: o state mente.
    await state('bbbb2222', { state: 'working', sessionId: OTHER, cwd: PROJECT, worktreePath: `${PROJECT}/.claude/worktrees/feat` });
    await put(join(job('bbbb2222'), 'tmp', 'DerivedData', 'big.o'), 9000, 90);
    await put(join(job('bbbb2222'), 'timeline.jsonl'), 500, 90);
    await state('cccc3333', { state: 'done', sessionId: HOT, cwd: PROJECT });
    await mkdir(join(job('cccc3333'), 'tmp'), { recursive: true });
    await put(join(claude, 'jobs', 'pins.json'), '[]', 1);
    await put(join(claude, 'daemon', 'roster.json'), JSON.stringify({ supervisorPid: 777, workers: [] }), 11);

    const items = (await collect(context({ claudeSessions: [live(LIVE)] }))).filter((item) => item.kind === 'jobs');
    const byLabel = Object.fromEntries(items.map((item) => [item.label, item]));

    expect(items).toHaveLength(2);
    expect(byLabel.app).toMatchObject({ path: join(job('aaaa1111'), 'tmp'), project: PROJECT, blocked: 'live-session', safety: 'moderate' });
    expect(byLabel.app.lastUsed).toBe(NOW - 11 * DAY);
    expect(byLabel.feat).toMatchObject({ path: join(job('bbbb2222'), 'tmp'), project: PROJECT, removal: 'trash' });
    expect(byLabel.feat.blocked).toBeUndefined();
    expect(byLabel.feat.paths).toBeUndefined();
    expect(await byLabel.feat.recheck!(context({ claudeSessions: [live(OTHER)] }))).toBe('live-session');
  });

  it('treats a job the supervisor still runs as live, and its session too', async () => {
    const dir = join(claude, 'jobs', 'bbbb2222');
    await put(join(dir, 'state.json'), JSON.stringify({ state: 'working', sessionId: OTHER, cwd: PROJECT }), 1);
    await put(join(dir, 'tmp', 'x.bin'), 3000, 1);
    await put(join(claude, 'jobs', 'dddd4444', 'state.json'), JSON.stringify({ state: 'done', sessionId: COLD, cwd: PROJECT }), 20);
    await put(join(claude, 'jobs', 'dddd4444', 'tmp', 'y.bin'), 3000, 20);
    await put(join(claude, 'daemon', 'roster.json'), JSON.stringify({ supervisorPid: 888, workers: [] }), 1);
    await put(join(folder, `${OTHER}.jsonl`), header(PROJECT), 1);

    const ctx = context({ processes: [{ pid: 888, exe: 'claude', args: 'claude daemon' }] });
    const items = await collect(ctx);
    const jobs = Object.fromEntries(items.filter((item) => item.kind === 'jobs').map((item) => [item.path, item.blocked]));
    expect(jobs).toEqual({ [join(dir, 'tmp')]: 'live-session', [join(claude, 'jobs', 'dddd4444', 'tmp')]: undefined });
    expect(items.find((item) => item.kind === 'sessions')).toMatchObject({ key: 'live', blocked: 'live-session' });
  });

  it('marks old native versions as junk and keeps the launcher target and the ones in use', async () => {
    const versions = join(box.home, '.local/share/claude/versions');
    for (const version of ['2.1.300', '2.1.305', '2.1.310', '2.1.312']) await put(join(versions, version), 8000, 10);
    await mkdir(join(box.home, '.local/bin'), { recursive: true });
    await symlink(join(versions, '2.1.312'), join(box.home, '.local/bin/claude'));
    await put(join(box.home, '.local/state/claude/locks/2.1.305.lock'), JSON.stringify({ pid: 9360, acquiredAt: NOW - 3 * DAY }), 3);
    // O `ps` mostra só "claude": quem usa a 2.1.310 aparece no lsof.
    const lsof = (args: string[]) => ({
      code: 0,
      stdout: args.includes(join(versions, '2.1.310')) ? `p4242\nftxt\nn${join(versions, '2.1.310')}\n` : '',
      stderr: '',
    });
    const ctx = context({ processes: [{ pid: 9360, exe: 'claude', args: 'claude --resume' }], exec: (_file, args) => lsof(args) });

    const byLabel = Object.fromEntries((await collect(ctx)).filter((item) => item.kind === 'versions').map((item) => [item.label, item]));

    expect(byLabel['2.1.312']).toMatchObject({ removal: 'none', blocked: 'current' });
    expect(byLabel['2.1.312'].junk).toBeUndefined();
    expect(byLabel['2.1.300']).toMatchObject({ junk: 'old-version', safety: 'safe', removal: 'trash', confidence: 'low' });
    expect(byLabel['2.1.300'].blocked).toBeUndefined();
    expect(byLabel['2.1.305']).toMatchObject({ junk: 'old-version', blocked: 'in-use' });
    expect(byLabel['2.1.310']).toMatchObject({ junk: 'old-version', blocked: 'in-use' });

    const now = context({ exec: (_file, args) => (args.includes(join(versions, '2.1.300')) ? { code: 0, stdout: `p1\nn${join(versions, '2.1.300')}\n`, stderr: '' } : lsof(args)) });
    expect(await byLabel['2.1.300'].recheck!(now)).toBe('in-use');
    expect(await byLabel['2.1.300'].recheck!(context())).toBeNull();
  });

  it('lists the small leftovers and never configuration, credentials or tool state', async () => {
    const start = NOW - 2 * DAY;
    await put(join(claude, 'downloads', 'claude-2.0.0-darwin-arm64'), 6000, 300);
    await put(join(claude, 'cache', 'changelog.md'), 3000, 1);
    await put(join(claude, 'paste-cache', 'a.txt'), 2000, 20);
    await put(join(claude, 'telemetry', `1p_failed_events.${OTHER}.e1.json`), 2000, 9);
    await put(join(claude, 'telemetry', `1p_failed_events.${LIVE}.e2.json`), 2000, 1);
    await put(join(claude, 'shell-snapshots', `snapshot-zsh-${NOW - 10 * DAY}-abc.sh`), 2000, 10);
    await put(join(claude, 'shell-snapshots', `snapshot-zsh-${start + 60_000}-def.sh`), 2000, 2);
    await put(join(claude, 'sessions', '100.json'), JSON.stringify({ pid: 100, sessionId: LIVE, cwd: PROJECT, startedAt: start }), 2);

    const never = [
      'settings.json',
      'settings.local.json',
      'CLAUDE.md',
      '.credentials.json',
      '.claude.json',
      'history.jsonl',
      'plugins/installed_plugins.json',
      'skills/mine/SKILL.md',
      'agents/reviewer.md',
      'backups/.claude.json.backup.1',
      'daemon/roster.json',
      'daemon/control.key',
      'state/mcp-discover-verdicts.json',
      'feedback/drafts/a.md',
      'teams/session-d710bf21/x.json',
    ].map((relative) => join(claude, relative));
    for (const path of never) await put(path, 2000, 30);
    await put(join(box.home, '.claude.json'), 2000, 30);
    await put(join(box.home, '.local/state/claude/locks/2.1.312.lock'), '{}', 30);

    const items = await collect(context({ claudeSessions: [live(LIVE)] }));
    const byLabel = Object.fromEntries(items.map((item) => [item.label, item]));

    expect(byLabel.downloads).toMatchObject({ kind: 'versions', junk: 'old-version', safety: 'safe', confidence: 'low' });
    expect(byLabel.cache).toMatchObject({ kind: 'cache', safety: 'safe' });
    expect(byLabel['paste-cache'].safety).toBe('moderate');
    expect(byLabel.telemetry.paths).toEqual([join(claude, 'telemetry', `1p_failed_events.${OTHER}.e1.json`)]);
    // Criado depois que a sessão viva começou: pode ser dela.
    expect(byLabel['shell-snapshots'].paths).toEqual([join(claude, 'shell-snapshots', `snapshot-zsh-${NOW - 10 * DAY}-abc.sh`)]);

    for (const path of [...never, join(box.home, '.claude.json'), join(claude, 'sessions', '100.json')]) {
      expect(items.filter((item) => covers(item, path)).map((item) => item.label)).toEqual([]);
    }
  });

  it('lists MCP server logs older than a week, one item per project', async () => {
    const logs = join(box.home, 'Library/Caches/claude-cli-nodejs', encodeProject(PROJECT));
    await put(join(logs, 'mcp-logs-github', '2026-10-01T10-00-00-000Z.jsonl'), 2000, 28);
    await put(join(logs, 'mcp-logs-github', '2026-10-28T10-00-00-000Z.jsonl'), 2000, 1);
    await put(join(logs, 'mcp-logs-db', '2026-09-29T10-00-00-000Z.jsonl'), 2000, 30);

    const [item] = await collect(context({ projects: [PROJECT] }));

    expect(item).toMatchObject({ kind: 'logs', key: 'old', label: 'app', project: PROJECT, path: logs, count: 2, safety: 'safe' });
    expect(item.lastUsed).toBe(NOW - 28 * DAY);
    expect(item.paths!.sort()).toEqual([join(logs, 'mcp-logs-db'), join(logs, 'mcp-logs-github', '2026-10-01T10-00-00-000Z.jsonl')].sort());
  });

  it('only shows the scratchpads in /tmp, dated by the session, under CLAUDE_CODE_TMPDIR', async () => {
    const scratch = join(box.tmp, 'claude-501');
    await put(join(scratch, encodeProject(PROJECT), LIVE, 'scratchpad', 'build.tar'), 9000, 5);
    await put(join(scratch, encodeProject(PROJECT), COLD, 'scratchpad', 'old.png'), 3000, 5);
    await put(join(scratch, encodeProject('/Users/ana/code/gone'), OTHER, 'scratchpad', 'x.bin'), 3000, 2);
    await put(join(scratch, 'bash-edit-diff', '123-456', 'index'), 3000, 2);
    await put(join(folder, `${COLD}.jsonl`), header(PROJECT), 20);

    const items = await collect(context({ claudeSessions: [live(LIVE)] }));
    const scratches = items.filter((item) => item.kind === 'scratch');
    const byLabel = Object.fromEntries(scratches.map((item) => [item.label, item]));

    expect(scratches).toHaveLength(3);
    for (const item of scratches) {
      expect(item).toMatchObject({ removal: 'none', blocked: 'self-cleaning', hint: 'tmp-cleaner' });
      expect(item.size).toBeGreaterThan(0);
    }
    expect(byLabel.app).toMatchObject({ path: join(scratch, encodeProject(PROJECT)), project: PROJECT, count: 2, lastUsed: NOW });
    // Sessão sem transcrição: data desconhecida, e a das pastas não vale.
    expect(byLabel.gone).toMatchObject({ lastUsed: 0, confidence: 'low', project: null });
    expect(byLabel['bash-edit-diff']).toMatchObject({ lastUsed: NOW - 2 * DAY, count: 1 });
  });

  it('finds nothing when Claude Code is not installed', async () => {
    expect(await collect(context())).toEqual([]);
  });
});

describe('claude-desktop collector', () => {
  let box: Awaited<ReturnType<typeof sandbox>>;
  let app: string;
  let logs: string;

  beforeEach(async () => {
    box = await sandbox();
    app = join(box.home, 'Library/Application Support/Claude');
    logs = join(box.home, 'Library/Logs/Claude');
  });

  afterEach(async () => {
    await box.cleanup();
  });

  const OPEN = { pid: 49483, exe: '/Applications/Claude.app/Contents/MacOS/Claude', args: '/Applications/Claude.app/Contents/MacOS/Claude' };
  const collect = (options: Partial<FakeOptions> = {}) => claudeCollectors.find((c) => c.id === 'claude-desktop')!.collect(fakeContext({ ...box, ...options }));

  it('shows the Cowork VM disk dated by its logs, to be removed through the app', async () => {
    // O rootfs.img foi reescrito numa atualização; o Cowork não roda desde 18 dias atrás.
    await put(join(app, 'vm_bundles/claudevm.bundle/rootfs.img'), 9000, 7);
    await put(join(app, 'vm_bundles/claudevm.bundle/sessiondata.img'), 2000, 18);
    await put(join(logs, 'coworkd.log'), 1000, 18);

    const [vm] = await collect();
    expect(vm).toMatchObject({ kind: 'vm', label: 'claudevm.bundle', path: join(app, 'vm_bundles'), removal: 'none', blocked: 'via-app', hint: 'cowork-vm' });
    expect(vm.lastUsed).toBe(NOW - 18 * DAY);
    expect(vm.confidence).toBe('high');
  });

  it('blocks the Chromium caches while the app is open and checks again before removing', async () => {
    await put(join(app, 'Cache/Cache_Data/f_000001'), 9000, 1);
    await put(join(app, 'Code Cache/js/index'), 3000, 1);
    await put(join(box.home, 'Library/Caches/com.anthropic.claudefordesktop/Cache.db'), 3000, 1);

    const caches = await collect({ processes: [OPEN] });
    expect(caches.map((item) => item.label).sort()).toEqual(['Cache', 'Code Cache', 'com.anthropic.claudefordesktop']);
    for (const item of caches) {
      expect(item).toMatchObject({ kind: 'cache', safety: 'safe', removal: 'trash', blocked: 'app-open' });
      expect(await item.recheck!(fakeContext(box))).toBeNull();
      expect(await item.recheck!(fakeContext({ ...box, processes: [OPEN] }))).toBe('app-open');
    }
    expect((await collect())[0].blocked).toBeUndefined();
  });

  it('marks the Claude Code copies that are not current as junk', async () => {
    const binary = (root: string, version: string) => join(app, root, version, '5af865b9901c/claude.app/Contents/MacOS/claude');
    await put(binary('claude-code', '2.1.307'), 4000, 12);
    await put(binary('claude-code', '2.1.308'), 4000, 7);
    await put(binary('claude-code', '2.1.309'), 4000, 2);
    await put(join(app, 'claude-code-vm/.sdk-version'), '2.1.300\n', 2);
    await put(join(app, 'claude-code-vm/2.1.300/claude'), 4000, 20);
    await put(join(app, 'claude-code-vm/2.1.309/claude'), 4000, 2);
    const running = { pid: 33773, exe: binary('claude-code', '2.1.308'), args: 'claude' };

    const byLabel = Object.fromEntries((await collect({ processes: [running] })).map((item) => [item.label, item]));

    expect(byLabel['claude-code/2.1.309']).toMatchObject({ removal: 'none', blocked: 'current' });
    expect(byLabel['claude-code/2.1.308']).toMatchObject({ junk: 'old-version', blocked: 'in-use' });
    expect(byLabel['claude-code/2.1.307']).toMatchObject({ junk: 'old-version', safety: 'safe', removal: 'trash', confidence: 'low' });
    expect(byLabel['claude-code/2.1.307'].blocked).toBeUndefined();
    // Na VM vale o .sdk-version, não a mais nova.
    expect(byLabel['claude-code-vm/2.1.300']).toMatchObject({ blocked: 'current' });
    expect(byLabel['claude-code-vm/2.1.309']).toMatchObject({ junk: 'old-version' });
  });

  it('lists only rotated logs and never the app state, configuration or tokens', async () => {
    await put(join(logs, 'main.log'), 3000, 0);
    await put(join(logs, 'main1.log'), 3000, 5);
    await put(join(logs, 'main2.log'), 3000, 16);
    await put(join(logs, 'mcp.log'), 3000, 2);
    await put(join(logs, 'coworkd.log'), 3000, 18);
    const never = [
      'vm_bundles/claudevm.bundle/sessiondata.img',
      'git-worktrees.json',
      'git-shadow/a/index',
      'config.json',
      'claude_desktop_config.json',
      'buddy-tokens.json',
      'Cookies',
      'IndexedDB/https_claude.ai_0.indexeddb.leveldb/000003.log',
      'Local Storage/leveldb/000003.log',
      'claude-code-sessions/org/acct/local_1.json',
      'local-agent-mode-sessions/x.json',
    ].map((relative) => join(app, relative));
    for (const path of never) await put(path, 3000, 30);

    const items = await collect();
    const removable = items.filter((item) => item.removal !== 'none');

    expect(removable.map((item) => [...item.paths!].sort())).toEqual([[join(logs, 'main1.log'), join(logs, 'main2.log')]]);
    expect(removable[0]).toMatchObject({ kind: 'logs', key: 'rotated', safety: 'safe', lastUsed: NOW - 5 * DAY });
    for (const path of never) expect(removable.filter((item) => covers(item, path))).toEqual([]);
  });

  it('finds nothing when the app was never installed', async () => {
    await writeFile(join(box.home, 'unrelated'), 'x');
    expect(await collect()).toEqual([]);
  });
});

describe('compareVersions', () => {
  it('orders by number, not by text', () => {
    expect(['2.1.10', '2.1.9', '2.0.100', '10.0.0'].sort(compareVersions)).toEqual(['2.0.100', '2.1.9', '2.1.10', '10.0.0']);
  });
});
