import { execFile } from 'node:child_process';
import { access, open, readdir, readFile, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AI_COLD_DAYS } from '../../shared/api';
import { measure } from './measure';
import type { AiContext, ExecResult, LiveSession, ProcessInfo } from './types';

const DAY = 24 * 60 * 60 * 1000;
/** O começo de uma transcrição já traz o cwd; não vale ler o resto. */
const HEAD_BYTES = 256 * 1024;

export function run(
  file: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 30_000,
        maxBuffer: 64 * 1024 * 1024,
        env: options.env ? { ...process.env, ...options.env } : process.env,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}

/** Linhas `pid resto` do `ps -o pid=,<campo>=`. */
export function parsePs(output: string): Map<number, string> {
  const rows = new Map<number, string>();
  for (const line of output.split('\n')) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    if (match) rows.set(Number(match[1]), match[2].trim());
  }
  return rows;
}

/** A saída `-Fpn` do `lsof -d cwd`: `p<pid>`, depois `n<caminho>`. */
export function parseLsofCwd(output: string): Map<number, string> {
  const cwds = new Map<number, string>();
  let pid = 0;
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    // Só o primeiro nome de cada processo: com -d txt, o executável vem antes das bibliotecas.
    else if (line.startsWith('n') && pid > 0 && !cwds.has(pid)) cwds.set(pid, line.slice(1));
  }
  return cwds;
}

export async function listProcesses(): Promise<ProcessInfo[]> {
  const [exes, args, lsof] = await Promise.all([
    run('/bin/ps', ['-axo', 'pid=,comm=']),
    run('/bin/ps', ['-axww', '-o', 'pid=,args=']),
    run('/usr/sbin/lsof', ['-nP', '-d', 'cwd', '-Fpn'], { timeoutMs: 15_000 }),
  ]);
  const commandLines = parsePs(args.stdout);
  const cwds = parseLsofCwd(lsof.stdout);
  const commands = parsePs(exes.stdout);

  // O binário nativo do Claude Code aparece no ps só como "claude". O executável de verdade
  // (~/.local/share/claude/versions/<v>) é o primeiro arquivo de texto que o lsof mostra.
  const bare = [...commands].filter(([, exe]) => !exe.startsWith('/')).map(([pid]) => pid);
  if (bare.length > 0) {
    const texts = await run('/usr/sbin/lsof', ['-nP', '-a', '-p', bare.join(','), '-d', 'txt', '-Fpn'], { timeoutMs: 15_000 });
    for (const [pid, exe] of parseLsofCwd(texts.stdout)) commands.set(pid, exe);
  }

  return [...commands].map(([pid, exe]) => ({
    pid,
    exe,
    args: commandLines.get(pid) ?? exe,
    cwd: cwds.get(pid),
  }));
}

/** O primeiro `"cwd"` das primeiras linhas de uma transcrição, sem ler o resto dela. */
export async function cwdOfTranscript(path: string): Promise<string | null> {
  const handle = await open(path, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    for (const line of buffer.subarray(0, bytesRead).toString('utf8').split('\n')) {
      if (!line.includes('"cwd"')) continue;
      try {
        const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd;
        if (typeof cwd === 'string' && cwd.startsWith('/')) return cwd;
      } catch {
        // Linha cortada no fim do pedaço lido.
      }
    }
    return null;
  } finally {
    await handle.close();
  }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const entries = (dir: string) => readdir(dir, { withFileTypes: true }).catch(() => []);

/** As sessões do Claude Code com o processo dono vivo; PID reaproveitado por outro programa não conta. */
export async function liveClaudeSessions(claudeDir: string, processes: readonly ProcessInfo[]): Promise<LiveSession[]> {
  const byPid = new Map(processes.map((p) => [p.pid, p]));
  const sessions: LiveSession[] = [];
  for (const entry of await entries(join(claudeDir, 'sessions'))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const json = await readJson(join(claudeDir, 'sessions', entry.name));
    const pid = typeof json?.pid === 'number' ? json.pid : Number(entry.name.split('.')[0]);
    const owner = byPid.get(pid);
    if (!owner || !/claude/i.test(`${owner.exe} ${owner.args}`)) continue;
    if (typeof json?.sessionId === 'string' && typeof json.cwd === 'string') {
      sessions.push({ pid, sessionId: json.sessionId, cwd: json.cwd });
    }
  }
  return sessions;
}

/**
 * Os projetos em que as ferramentas trabalharam: o cwd gravado nas transcrições e nos jobs do
 * Claude Code e a pasta de cada workspace do VS Code. O nome codificado da pasta em
 * ~/.claude/projects perde informação (barra e hífen viram a mesma coisa), por isso o cwd.
 */
export async function discoverProjects(home: string, claudeDir: string, live: readonly LiveSession[]): Promise<string[]> {
  const found = new Set<string>(live.map((session) => session.cwd));

  for (const project of await entries(join(claudeDir, 'projects'))) {
    if (!project.isDirectory()) continue;
    const dir = join(claudeDir, 'projects', project.name);
    const transcripts = await Promise.all(
      (await entries(dir))
        .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
        .map(async (entry) => ({ path: join(dir, entry.name), mtime: (await stat(join(dir, entry.name)).catch(() => null))?.mtimeMs ?? 0 }))
    );
    transcripts.sort((a, b) => b.mtime - a.mtime);
    // A primeira que tiver cwd basta; as outras sessões da pasta são do mesmo projeto.
    for (const transcript of transcripts.slice(0, 5)) {
      const cwd = await cwdOfTranscript(transcript.path);
      if (cwd) {
        found.add(cwd);
        break;
      }
    }
  }

  for (const job of await entries(join(claudeDir, 'jobs'))) {
    const state = job.isDirectory() ? await readJson(join(claudeDir, 'jobs', job.name, 'state.json')) : null;
    if (typeof state?.cwd === 'string') found.add(state.cwd);
  }

  const workspaces = join(home, 'Library/Application Support/Code/User/workspaceStorage');
  for (const workspace of await entries(workspaces)) {
    const json = workspace.isDirectory() ? await readJson(join(workspaces, workspace.name, 'workspace.json')) : null;
    if (typeof json?.folder === 'string' && json.folder.startsWith('file://')) {
      try {
        found.add(fileURLToPath(json.folder));
      } catch {
        // URI malformada.
      }
    }
  }

  // Sessão aberta numa pasta que junta repositórios (~/Repositorios) não diz em qual deles
  // trabalhou: os repositórios filhos entram, para as worktrees deles aparecerem.
  for (const path of [...found]) {
    if (!path.startsWith(home + '/') || (await inRepository(path, home))) continue;
    for (const child of await entries(path)) {
      const repo = join(path, child.name);
      if (child.isDirectory() && (await exists(join(repo, '.git')))) found.add(repo);
    }
  }

  return [...found].filter((path) => path.startsWith('/') && path !== home).sort();
}

const exists = (path: string) => access(path).then(
  () => true,
  () => false
);

/** A pasta, ou uma acima dela até a pessoal, tem .git. */
async function inRepository(path: string, home: string): Promise<boolean> {
  for (let dir = path; dir.startsWith(home + '/'); dir = dirname(dir)) {
    if (await exists(join(dir, '.git'))) return true;
  }
  return false;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** O caminho aparece nos argumentos como ele mesmo ou como pasta-mãe, nunca como pedaço de outro nome. */
export function mentions(args: string, path: string): boolean {
  return new RegExp(`(?<=^|[\\s"'=:,])${escape(path)}(?=$|[/\\s"'=:,])`).test(args);
}

export function isInUse(processes: readonly ProcessInfo[], path: string): boolean {
  const inside = (candidate: string | undefined) => !!candidate && (candidate === path || candidate.startsWith(path + '/'));
  return processes.some((p) => inside(p.exe) || inside(p.cwd) || mentions(p.args, path));
}

export async function duSize(path: string): Promise<number> {
  const { stdout } = await run('/usr/bin/du', ['-sk', path], { timeoutMs: 10 * 60_000 });
  const match = /^(\d+)\t/.exec(stdout);
  return match ? Number(match[1]) * 1024 : 0;
}

/**
 * O git de verdade: o das Command Line Tools, o do Xcode ou o do Homebrew. O /usr/bin/git é só
 * um atalho que, num Mac sem as ferramentas, abre o instalador na tela; nesse caso não há git.
 */
export async function findGit(): Promise<string | null> {
  const developer = (await run('/usr/bin/xcode-select', ['-p'], { timeoutMs: 5_000 })).stdout.trim();
  const candidates = [
    '/Library/Developer/CommandLineTools/usr/bin/git',
    ...(developer.startsWith('/') ? [join(developer, 'usr/bin/git')] : []),
    '/opt/homebrew/bin/git',
    '/usr/local/bin/git',
  ];
  for (const candidate of candidates) if (await exists(candidate)) return candidate;
  return null;
}

export interface ContextOptions {
  trash(path: string): Promise<void>;
  home?: string;
  tmp?: string;
  now?: number;
}

export async function createContext(options: ContextOptions): Promise<AiContext> {
  const home = options.home ?? homedir();
  const now = options.now ?? Date.now();
  const env = process.env;
  const claudeDir = env.CLAUDE_CONFIG_DIR || join(home, '.claude');
  const [processes, git] = await Promise.all([listProcesses(), findGit()]);
  const claudeSessions = await liveClaudeSessions(claudeDir, processes);
  const projects = await discoverProjects(home, claudeDir, claudeSessions);

  return {
    home,
    tmp: options.tmp ?? tmpdir(),
    uid: process.getuid?.() ?? 501,
    now,
    env,
    processes,
    claudeSessions,
    projects,
    isCold: (ms) => ms <= 0 || now - ms > AI_COLD_DAYS * DAY,
    inUse: (path) => isInUse(processes, path),
    running: (exe) => processes.some((p) => exe.test(p.exe)),
    measure,
    du: duSize,
    // Os coletores chamam 'git'; ele vira o git de verdade, ou falha sem abrir nada.
    exec: (file, args, execOptions) =>
      file === 'git' || file === '/usr/bin/git'
        ? git
          ? run(git, args, execOptions)
          : Promise.resolve({ code: 127, stdout: '', stderr: 'git not installed' })
        : run(file, args, execOptions),
    trash: options.trash,
  };
}
