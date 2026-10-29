import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { cwdOfTranscript, discoverProjects, isInUse, liveClaudeSessions, mentions, parseLsofCwd, parsePs } from './context';
import { put, sandbox } from './testing';
import type { ProcessInfo } from './types';

describe('parsePs', () => {
  it('reads the pid and keeps the rest of the line, spaces included', () => {
    const output = [
      '    1 /sbin/launchd',
      '49537 /Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)',
      '27280 claude --resume',
      '',
      'not a row',
    ].join('\n');
    expect(parsePs(output)).toEqual(
      new Map([
        [1, '/sbin/launchd'],
        [49537, '/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)'],
        [27280, 'claude --resume'],
      ])
    );
  });
});

describe('parseLsofCwd', () => {
  it('pairs each process with the folder it works in', () => {
    const output = ['n/before/any/process', 'p12', 'fcwd', 'n/Users/ana/code/app', 'p13', 'fcwd', 'n/private/tmp'].join('\n');
    expect(parseLsofCwd(output)).toEqual(
      new Map([
        [12, '/Users/ana/code/app'],
        [13, '/private/tmp'],
      ])
    );
  });

  it('keeps only the first name of each process, which for -d txt is the executable', () => {
    const output = ['p9', 'ftxt', 'n/Users/ana/.local/share/claude/versions/2.1.3', 'ftxt', 'n/usr/lib/dyld'].join('\n');
    expect(parseLsofCwd(output)).toEqual(new Map([[9, '/Users/ana/.local/share/claude/versions/2.1.3']]));
  });

  it('gives nothing for empty output', () => {
    expect(parseLsofCwd('')).toEqual(new Map());
  });
});

describe('mentions', () => {
  it('finds the path as itself or as a parent folder', () => {
    expect(mentions('node /a/b', '/a/b')).toBe(true);
    expect(mentions('node /a/b/server.js --port 3', '/a/b')).toBe(true);
    expect(mentions('tool --dir=/a/b', '/a/b')).toBe(true);
    expect(mentions('tool "/a/b" x', '/a/b')).toBe(true);
    expect(mentions("tool '/a/b'", '/a/b')).toBe(true);
    expect(mentions('tool /a/b:/c', '/a/b')).toBe(true);
    expect(mentions('tool /a/b,/c', '/a/b')).toBe(true);
  });

  it('does not take the path as the start of another name', () => {
    expect(mentions('node /a/bc/server.js', '/a/b')).toBe(false);
    expect(mentions('node /a/b.js', '/a/b')).toBe(false);
    expect(mentions('node /a/b-old', '/a/b')).toBe(false);
  });

  it('does not take the path as the end of another one', () => {
    expect(mentions('node /z/a/b/x', '/a/b')).toBe(false);
    expect(mentions('node /z/a/b', '/a/b')).toBe(false);
  });

  it('treats the characters of the path literally', () => {
    expect(mentions('open /x/a+b (1)/f', '/x/a+b (1)')).toBe(true);
    expect(mentions('open /x/aab (1)/f', '/x/a+b (1)')).toBe(false);
    expect(mentions('open /x/a.b', '/x/a.b')).toBe(true);
    expect(mentions('open /x/axb', '/x/a.b')).toBe(false);
  });
});

describe('isInUse', () => {
  const processes: ProcessInfo[] = [
    { pid: 1, exe: '/opt/tool/bin/server', args: '/opt/tool/bin/server' },
    { pid: 2, exe: '/usr/bin/git', args: 'git status', cwd: '/w/repo/sub' },
    { pid: 3, exe: '/usr/local/bin/node', args: 'node /srv/npx/abc/index.js' },
    { pid: 4, exe: 'claude', args: 'claude --resume' },
  ];

  it('sees the executable, the working folder and the arguments', () => {
    expect(isInUse(processes, '/opt/tool')).toBe(true);
    expect(isInUse(processes, '/opt/tool/bin/server')).toBe(true);
    expect(isInUse(processes, '/w/repo')).toBe(true);
    expect(isInUse(processes, '/w/repo/sub')).toBe(true);
    expect(isInUse(processes, '/srv/npx/abc')).toBe(true);
  });

  it('does not confuse a sibling that starts with the same name', () => {
    expect(isInUse(processes, '/opt/to')).toBe(false);
    expect(isInUse(processes, '/w/rep')).toBe(false);
    expect(isInUse(processes, '/srv/npx/ab')).toBe(false);
    expect(isInUse(processes, '/w/repo/sub/deeper')).toBe(false);
    expect(isInUse([], '/opt/tool')).toBe(false);
  });
});

describe('with files', () => {
  let box: Awaited<ReturnType<typeof sandbox>>;

  beforeEach(async () => {
    box = await sandbox();
  });

  afterEach(async () => {
    await box.cleanup();
  });

  describe('cwdOfTranscript', () => {
    const transcript = (lines: string[]) => put(join(box.home, 't.jsonl'), lines.join('\n') + '\n');

    it('takes the first top-level absolute cwd of the first lines', async () => {
      const path = await transcript([
        JSON.stringify({ type: 'summary' }),
        JSON.stringify({ type: 'tool', input: { cwd: '/nested' } }),
        JSON.stringify({ type: 'user', cwd: 'relative/dir' }),
        '{"type":"user","cwd":"/broken',
        JSON.stringify({ type: 'user', cwd: '/Users/ana/code/app' }),
        JSON.stringify({ type: 'user', cwd: '/Users/ana/code/later' }),
      ]);
      expect(await cwdOfTranscript(path)).toBe('/Users/ana/code/app');
    });

    it('gives up beyond the head of the file instead of reading it whole', async () => {
      const path = await transcript([JSON.stringify({ type: 'big', text: 'a'.repeat(300 * 1024) }), JSON.stringify({ cwd: '/late' })]);
      expect(await cwdOfTranscript(path)).toBeNull();
    });

    it('gives null for a missing file or one without cwd', async () => {
      expect(await cwdOfTranscript(join(box.home, 'missing.jsonl'))).toBeNull();
      expect(await cwdOfTranscript(await transcript([JSON.stringify({ type: 'summary' })]))).toBeNull();
    });
  });

  describe('liveClaudeSessions', () => {
    const claude = () => join(box.home, '.claude');
    const session = (name: string, value: object | string) =>
      put(join(claude(), 'sessions', name), typeof value === 'string' ? value : JSON.stringify(value));

    it('keeps only sessions whose owner process is alive and is Claude', async () => {
      await session('100.json', { pid: 100, sessionId: 's-live', cwd: '/a' });
      await session('100.9ae291bf.key', 'secret');
      // PID reaproveitado por outro programa.
      await session('200.json', { pid: 200, sessionId: 's-reused', cwd: '/b' });
      await session('300.json', { pid: 300, sessionId: 's-dead', cwd: '/c' });
      // Sem o campo pid, vale o do nome do arquivo.
      await session('400.json', { sessionId: 's-by-name', cwd: '/d' });
      await session('500.json', { pid: 500, cwd: '/e' });
      await session('600.json', '{ not json');
      const processes: ProcessInfo[] = [
        { pid: 100, exe: 'claude', args: 'claude --resume' },
        { pid: 200, exe: '/usr/bin/vim', args: 'vim notes.txt' },
        { pid: 400, exe: '/Users/ana/Library/Application Support/Claude/claude-code/2.1.309/x/claude.app/Contents/MacOS/claude', args: 'claude' },
        { pid: 500, exe: 'claude', args: 'claude' },
        { pid: 600, exe: 'claude', args: 'claude' },
      ];

      const live = await liveClaudeSessions(claude(), processes);

      expect(live.sort((a, b) => a.pid - b.pid)).toEqual([
        { pid: 100, sessionId: 's-live', cwd: '/a' },
        { pid: 400, sessionId: 's-by-name', cwd: '/d' },
      ]);
    });

    it('gives nothing without a sessions folder', async () => {
      expect(await liveClaudeSessions(claude(), [{ pid: 1, exe: 'claude', args: 'claude' }])).toEqual([]);
    });
  });

  describe('discoverProjects', () => {
    it('joins live sessions, transcripts, jobs and VS Code workspaces, without the home folder', async () => {
      const claude = join(box.home, '.claude');
      const projects = join(claude, 'projects');
      const code = join(box.home, 'code');
      const line = (cwd: string) => JSON.stringify({ cwd }) + '\n';
      // A mais nova não tem cwd; vale a próxima da mesma pasta.
      await put(join(projects, '-code-app', 'new.jsonl'), JSON.stringify({ type: 'summary' }) + '\n', 1);
      await put(join(projects, '-code-app', 'old.jsonl'), line(join(code, 'app')), 5);
      await put(join(projects, '-code-api', 'a.jsonl'), line(join(code, 'api')), 2);
      await put(join(projects, '-code-api', 'b.jsonl'), line(join(code, 'api-other')), 3);
      await put(join(projects, '-code-only-memory', 'memory', 'MEMORY.md'), 'notes');
      await put(join(projects, '-home', 'h.jsonl'), line(box.home));
      await put(join(claude, 'jobs', 'j1', 'state.json'), JSON.stringify({ cwd: join(code, 'job') }));
      await put(join(claude, 'jobs', 'j2', 'state.json'), JSON.stringify({ cwd: 'relative' }));
      await put(join(claude, 'jobs', 'pins.json'), '[]');
      const workspaces = join(box.home, 'Library/Application Support/Code/User/workspaceStorage');
      await put(join(workspaces, 'w1', 'workspace.json'), JSON.stringify({ folder: `file://${code}/vs%20code` }));
      await put(join(workspaces, 'w2', 'workspace.json'), JSON.stringify({ folder: 'vscode-remote://ssh-remote+box/code' }));
      await put(join(workspaces, 'w3', 'workspace.json'), JSON.stringify({ workspace: `file://${code}/x.code-workspace` }));
      // Projetos no iCloud, num disco externo ou fora da conta não são lidos.
      await put(join(workspaces, 'w4', 'workspace.json'), JSON.stringify({ folder: `file://${box.home}/Library/CloudStorage/OneDrive/p` }));
      await put(join(workspaces, 'w5', 'workspace.json'), JSON.stringify({ folder: 'file:///Volumes/NAS/p' }));
      for (const name of ['app', 'api', 'job', 'vs code']) await put(join(code, name, '.git', 'HEAD'), 'ref: refs/heads/main');

      const found = await discoverProjects(box.home, claude, [{ pid: 1, sessionId: 's', cwd: join(box.home, 'live/proj') }]);

      expect(found).toEqual([...['api', 'app', 'job', 'vs code'].map((name) => join(code, name)), join(box.home, 'live/proj')]);
    });

    it('adds the repositories inside a folder that only gathers them', async () => {
      const claude = join(box.home, '.claude');
      const repos = join(box.home, 'Repositorios');
      await put(join(claude, 'projects', '-r', 'a.jsonl'), JSON.stringify({ cwd: repos }) + '\n');
      await put(join(repos, 'one', '.git', 'HEAD'), 'ref: refs/heads/main');
      await put(join(repos, 'notes', 'todo.md'), 'x');

      expect(await discoverProjects(box.home, claude, [])).toEqual([repos, join(repos, 'one')]);
    });

    it('gives nothing when no tool left a trace', async () => {
      expect(await discoverProjects(box.home, join(box.home, '.claude'), [])).toEqual([]);
    });
  });
});
