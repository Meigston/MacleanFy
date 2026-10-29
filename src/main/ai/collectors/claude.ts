import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { AiBlock, AiKind } from '../../../shared/api';
import { cwdOfTranscript } from '../context';
import type { AiContext, Collector, Found } from '../types';

/**
 * Claude Code e Claude Desktop. Só lê: sessões, jobs, versões e caches vêm de
 * caminhos conhecidos, e das transcrições só se lê o cwd do começo do arquivo.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A transcrição e as variantes que a própria ferramenta põe de lado (`.orphaned-*`, `.superseded-*`). */
const TRANSCRIPT = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl|\.orphaned-.+\.jsonl|\.jsonl\.superseded-.+)$/;
/** O que fica fora da pasta do projeto, numa pasta com o id da sessão, e sai junto com ela. */
const PER_SESSION = ['file-history', 'session-env', 'uploads', 'tasks'];
const HOUR = 60 * 60 * 1000;
/** O executável do app; o `claude` da aba Code tem outro caminho e outra caixa. */
const DESKTOP_EXE = /\/Claude\.app\/Contents\/MacOS\/Claude$/;
/** Caches do Chromium que o app refaz sozinho. Cookies, IndexedDB e Local Storage ficam: são o login. */
const CHROMIUM_CACHES = [
  'Cache',
  'Code Cache',
  'GPUCache',
  'GPUPersistentCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GraphiteDawnCache',
  'Shared Dictionary',
  'VideoDecodeStats',
];

type Json = Record<string, unknown>;

const list = (dir: string) => readdir(dir, { withFileTypes: true }).catch(() => []);
const mtimeOf = async (path: string) => (await lstat(path).catch(() => null))?.mtimeMs ?? 0;
const exists = async (path: string) => !!(await lstat(path).catch(() => null));
const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
const timeOf = (value: unknown) => (typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) || 0 : 0);

async function readJson(path: string): Promise<Json | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return value && typeof value === 'object' ? (value as Json) : null;
  } catch {
    return null;
  }
}

async function files(dir: string): Promise<string[]> {
  return (await list(dir)).filter((entry) => entry.isFile()).map((entry) => join(dir, entry.name));
}

/** Como o Claude Code nomeia a pasta de um cwd: todo caractere que não é letra nem dígito vira hífen. */
export const encodeProject = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-');

const claudeDir = (ctx: AiContext) => ctx.env.CLAUDE_CONFIG_DIR || join(ctx.home, '.claude');

const liveIds = (ctx: AiContext) => new Set(ctx.claudeSessions.map((session) => session.sessionId));

export function compareVersions(a: string, b: string): number {
  const left = a.split(/[.-]/);
  const right = b.split(/[.-]/);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] ?? '';
    const y = right[i] ?? '';
    const diff = /^\d+$/.test(x) && /^\d+$/.test(y) ? Number(x) - Number(y) : x.localeCompare(y);
    if (diff) return diff;
  }
  return 0;
}

const newestVersion = (names: string[]) => [...names].sort(compareVersions).at(-1) ?? null;

async function measureAll(ctx: AiContext, paths: string[]) {
  const parts = await Promise.all(paths.map((path) => ctx.measure(path)));
  return parts.reduce(
    (total, part) => ({ size: total.size + part.size, newest: Math.max(total.newest, part.newest), files: total.files + part.files }),
    { size: 0, newest: 0, files: 0 }
  );
}

/** Quem está com cada arquivo aberto ou mapeado, numa chamada só do `lsof`. */
async function openBy(ctx: AiContext, paths: string[]): Promise<Map<string, number[]>> {
  const users = new Map<string, number[]>();
  if (paths.length === 0) return users;
  const { stdout } = await ctx.exec('/usr/sbin/lsof', ['-nP', '-F', 'pn', '--', ...paths], { timeoutMs: 20_000 });
  let pid = 0;
  for (const line of stdout.split('\n')) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid > 0) users.set(line.slice(1), [...(users.get(line.slice(1)) ?? []), pid]);
  }
  return users;
}

const claudeAlive = (ctx: AiContext, pid: unknown) =>
  typeof pid === 'number' && ctx.processes.some((p) => p.pid === pid && /claude/i.test(`${p.exe} ${p.args}`));

// ---------------------------------------------------------------------------
// Sessões

interface SessionPart {
  id: string;
  transcripts: string[];
  /** A pasta irmã `<id>/`: subagentes, saídas de ferramenta, workflows. */
  dir: string | null;
  size: number;
}

interface SessionIndex {
  root: string;
  /** Pedaços de cada sessão, por pasta de `projects/`. Workflows deixam pedaços em pastas de outros projetos. */
  folders: Map<string, SessionPart[]>;
  /** Último uso de cada sessão, somando todas as pastas onde ela aparece. */
  lastUsed: Map<string, number>;
  /** O cwd de cada pasta; a mesma codificação vale para os logs de MCP e o /tmp. */
  cwd: Map<string, string>;
}

/** O `.jsonl` mais novo de uma árvore: os subagentes escrevem nela, e a data da pasta não acompanha. */
async function newestJsonl(dir: string): Promise<number> {
  let newest = 0;
  for (const entry of await list(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, await newestJsonl(path));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) newest = Math.max(newest, await mtimeOf(path));
  }
  return newest;
}

async function indexSessions(ctx: AiContext, claude: string): Promise<SessionIndex> {
  const root = join(claude, 'projects');
  const index: SessionIndex = { root, folders: new Map(), lastUsed: new Map(), cwd: new Map() };

  for (const folder of await list(root)) {
    if (!folder.isDirectory()) continue;
    const path = join(root, folder.name);
    const byId = new Map<string, SessionPart>();
    const part = (id: string) => {
      const known = byId.get(id) ?? { id, transcripts: [], dir: null, size: 0 };
      byId.set(id, known);
      return known;
    };
    // memory/ e qualquer outra coisa da pasta ficam de fora: só entra o que tem o id de uma sessão.
    for (const entry of await list(path)) {
      const transcript = entry.isFile() ? TRANSCRIPT.exec(entry.name) : null;
      if (transcript) part(transcript[1]).transcripts.push(join(path, entry.name));
      else if (entry.isDirectory() && UUID.test(entry.name)) part(entry.name).dir = join(path, entry.name);
    }
    if (byId.size === 0) continue;

    const dated: Array<{ path: string; mtime: number }> = [];
    for (const session of byId.values()) {
      const transcripts = await Promise.all(session.transcripts.map(async (t) => ({ path: t, mtime: await mtimeOf(t) })));
      dated.push(...transcripts);
      const measured = await measureAll(ctx, [...session.transcripts, ...(session.dir ? [session.dir] : [])]);
      session.size = measured.size;
      // O arquivo só cresce: o mtime é o último uso. Pedaço sem transcrição (workflow de outro projeto) usa o próprio.
      let used = Math.max(0, ...transcripts.map((t) => t.mtime));
      if (session.dir) used = Math.max(used, await newestJsonl(join(session.dir, 'subagents')));
      if (session.transcripts.length === 0) used = Math.max(used, measured.newest);
      index.lastUsed.set(session.id, Math.max(index.lastUsed.get(session.id) ?? 0, used));
    }
    index.folders.set(folder.name, [...byId.values()]);

    dated.sort((a, b) => b.mtime - a.mtime);
    for (const transcript of dated.slice(0, 5)) {
      const cwd = await cwdOfTranscript(transcript.path);
      if (cwd) {
        index.cwd.set(folder.name, cwd);
        break;
      }
    }
  }
  return index;
}

function projectOf(ctx: AiContext, index: SessionIndex, folder: string): string | null {
  return index.cwd.get(folder) ?? ctx.projects.find((project) => encodeProject(project) === folder) ?? null;
}

/**
 * Nome para mostrar quando não se sabe o cwd. A codificação perde informação, então o que dá é
 * cortar a pasta-mãe de um projeto conhecido, que diz onde termina o caminho e começa o nome.
 */
function labelOf(ctx: AiContext, index: SessionIndex, project: string | null, folder: string): string {
  if (project) return basename(project);
  const worktree = folder.split('--claude-worktrees-')[1];
  if (worktree) return worktree;
  const parents = [...ctx.projects, ...index.cwd.values(), join(ctx.home, 'x')].map((known) => encodeProject(dirname(known)) + '-');
  const parent = parents.filter((prefix) => folder.startsWith(prefix) && folder.length > prefix.length).sort((a, b) => b.length - a.length)[0];
  return parent ? folder.slice(parent.length) : folder.replace(/^-+/, '');
}

/** `busy`: sessões de jobs que o supervisor ainda roda, que não aparecem em ~/.claude/sessions. */
async function sessionItems(ctx: AiContext, claude: string, index: SessionIndex, busy: ReadonlySet<string>): Promise<Found[]> {
  const live = new Set([...liveIds(ctx), ...busy]);
  // file-history, uploads e afins ficam fora da pasta do projeto: vão com a pasta que tem a transcrição.
  const owner = new Map<string, string>();
  for (const withTranscript of [true, false]) {
    for (const [folder, parts] of index.folders) {
      for (const part of parts) {
        if (!owner.has(part.id) && (part.transcripts.length > 0) === withTranscript) owner.set(part.id, folder);
      }
    }
  }

  const items: Found[] = [];
  for (const [folder, parts] of index.folders) {
    const project = projectOf(ctx, index, folder);
    const groups = new Map<'live' | 'cold' | 'hot', SessionPart[]>();
    for (const part of parts) {
      const key = live.has(part.id) ? 'live' : ctx.isCold(index.lastUsed.get(part.id) ?? 0) ? 'cold' : 'hot';
      groups.set(key, [...(groups.get(key) ?? []), part]);
    }

    for (const [key, group] of groups) {
      const paths: string[] = [];
      let size = 0;
      for (const part of group) {
        paths.push(...part.transcripts, ...(part.dir ? [part.dir] : []));
        size += part.size;
        if (owner.get(part.id) !== folder) continue;
        for (const name of PER_SESSION) {
          const extra = join(claude, name, part.id);
          if (!(await exists(extra))) continue;
          paths.push(extra);
          size += (await ctx.measure(extra)).size;
        }
      }
      if (size <= 0) continue;
      const ids = group.map((part) => part.id);
      const item: Found = {
        tool: 'claude-code',
        kind: 'sessions',
        label: labelOf(ctx, index, project, folder),
        project,
        path: join(index.root, folder),
        key,
        paths,
        size,
        count: group.length,
        lastUsed: Math.max(0, ...ids.map((id) => index.lastUsed.get(id) ?? 0)),
        safety: 'moderate',
        removal: 'trash',
      };
      if (key === 'live') {
        item.blocked = 'live-session';
      } else {
        item.recheck = async (now) => (now.claudeSessions.some((s) => ids.includes(s.sessionId)) ? 'live-session' : null);
      }
      // O Desktop guarda as sessões dele para sempre; a varredura do cleanupPeriodDays não as alcança.
      if (key === 'cold' && !project?.startsWith(join(ctx.home, 'Library/Application Support/Claude/'))) item.hint = 'cleanup-period';
      items.push(item);
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Sessões em segundo plano

/**
 * O campo `state` mente (há job "working" de supervisor morto e job "done" adotado por uma sessão
 * viva), então o sinal é a sessão viva com o mesmo id, ou o supervisor vivo ainda com o job.
 */
async function jobBlock(ctx: AiContext, claude: string, job: string, state: Json, ids: string[]): Promise<AiBlock | null> {
  if (ctx.claudeSessions.some((session) => ids.includes(session.sessionId))) return 'live-session';
  const roster = await readJson(join(claude, 'daemon', 'roster.json'));
  if (!claudeAlive(ctx, roster?.supervisorPid)) return null;
  const listed = JSON.stringify(roster?.workers ?? null).includes(job);
  return listed || state.state !== 'done' ? 'live-session' : null;
}

async function jobItems(ctx: AiContext, claude: string, index: SessionIndex): Promise<{ items: Found[]; busy: Set<string> }> {
  const root = join(claude, 'jobs');
  const items: Found[] = [];
  const busy = new Set<string>();
  for (const job of await list(root)) {
    if (!job.isDirectory()) continue;
    const dir = join(root, job.name);
    const state = (await readJson(join(dir, 'state.json'))) ?? {};
    const ids = [text(state.sessionId), text(state.resumeSessionId)].filter((id): id is string => !!id);
    const check = (now: AiContext) => jobBlock(now, claude, job.name, state, ids);
    const blocked = await check(ctx);
    if (blocked) ids.forEach((id) => busy.add(id));

    // Só o rascunho sai: state.json, timeline e adopt.json são a lista de agentes do supervisor.
    const tmp = join(dir, 'tmp');
    const measured = await ctx.measure(tmp);
    if (measured.size <= 0) continue;
    const adopt = await readJson(join(dir, 'adopt.json'));
    const cwd = text(state.cwd)?.startsWith('/') ? (state.cwd as string) : null;
    const worktree = text(state.worktreePath);
    const repo = worktree?.includes('/.claude/worktrees/') ? worktree.slice(0, worktree.indexOf('/.claude/worktrees/')) : null;

    items.push({
      tool: 'claude-code',
      kind: 'jobs',
      label: basename(worktree ?? cwd ?? job.name),
      project: repo ?? cwd,
      path: tmp,
      size: measured.size,
      count: measured.files,
      lastUsed: Math.max(
        measured.newest,
        timeOf(state.updatedAt),
        timeOf(state.lastTerminalAt),
        timeOf(adopt?.writtenAtMs),
        ...ids.map((id) => index.lastUsed.get(id) ?? 0)
      ),
      safety: 'moderate',
      removal: 'trash',
      blocked: blocked ?? undefined,
      recheck: check,
    });
  }
  return { items, busy };
}

// ---------------------------------------------------------------------------
// Versões do binário nativo

/**
 * O `ps` mostra só "claude" para o binário nativo, então quem usa cada versão vem do `lsof` e do lock
 * que a ferramenta grava. Apagar uma versão em uso trava a sessão que roda dela.
 */
async function versionInUse(ctx: AiContext, path: string, lock: string): Promise<boolean> {
  if (claudeAlive(ctx, (await readJson(lock))?.pid)) return true;
  return ((await openBy(ctx, [path])).get(path)?.length ?? 0) > 0;
}

async function cliVersions(ctx: AiContext): Promise<Found[]> {
  const root = join(ctx.home, '.local/share/claude/versions');
  const locks = join(ctx.home, '.local/state/claude/locks');
  const names = (await list(root)).map((entry) => entry.name).filter((name) => /^\d+\.\d+/.test(name));
  if (names.length === 0) return [];

  // O alvo do launcher é a versão atual; sem link, fica a mais nova.
  const launcher = join(ctx.home, '.local/bin/claude');
  const target = await readlink(launcher)
    .then((link) => resolve(dirname(launcher), link))
    .catch(() => null);
  const current = target && dirname(target) === root ? basename(target) : newestVersion(names);
  const users = await openBy(
    ctx,
    names.map((name) => join(root, name))
  );

  const items: Found[] = [];
  for (const name of names) {
    const path = join(root, name);
    const lockPath = join(locks, `${name}.lock`);
    const lock = await readJson(lockPath);
    const measured = await ctx.measure(path);
    const busy = claudeAlive(ctx, lock?.pid) || (users.get(path)?.length ?? 0) > 0;
    const acquired = timeOf(lock?.acquiredAt);
    const item: Found = {
      tool: 'claude-code',
      kind: 'versions',
      label: name,
      project: null,
      path,
      size: measured.size,
      count: 1,
      // O mtime é a instalação; o lock diz quando um processo pegou a versão pela última vez.
      lastUsed: busy ? ctx.now : Math.max(measured.newest, acquired),
      confidence: busy || acquired ? 'high' : 'low',
      safety: 'safe',
      removal: 'trash',
    };
    if (name === current) {
      item.removal = 'none';
      item.blocked = 'current';
    } else {
      item.junk = 'old-version';
      if (busy) item.blocked = 'in-use';
      item.recheck = async (now) => ((await versionInUse(now, path, lockPath)) ? 'in-use' : null);
    }
    items.push(item);
  }
  return items;
}

// ---------------------------------------------------------------------------
// Sobras pequenas de ~/.claude

const LEFTOVERS: Array<{ name: string; kind: AiKind; safety: Found['safety'] }> = [
  { name: 'cache', kind: 'cache', safety: 'safe' },
  // Prompt antigo chamado de volta perde o texto colado.
  { name: 'paste-cache', kind: 'cache', safety: 'moderate' },
  { name: 'image-cache', kind: 'cache', safety: 'safe' },
  { name: 'statsig', kind: 'cache', safety: 'safe' },
  { name: 'todos', kind: 'cache', safety: 'safe' },
  { name: 'debug', kind: 'logs', safety: 'safe' },
  { name: 'logs', kind: 'logs', safety: 'safe' },
];

/** Antes disso nenhuma sessão viva tinha começado; sessão sem data de início trava tudo. */
async function oldestLiveStart(ctx: AiContext, claude: string): Promise<number> {
  let oldest = ctx.now - HOUR;
  for (const session of ctx.claudeSessions) {
    const started = timeOf((await readJson(join(claude, 'sessions', `${session.pid}.json`)))?.startedAt);
    oldest = Math.min(oldest, started);
  }
  return oldest;
}

async function leftovers(ctx: AiContext, claude: string): Promise<Found[]> {
  const base = (label: string, kind: AiKind, safety: Found['safety']) => ({
    tool: 'claude-code' as const,
    kind,
    label,
    project: null,
    safety,
    removal: 'trash' as const,
  });
  const items: Found[] = [];

  // Binários do instalador que ficaram de uma instalação interrompida; nunca rodam.
  const downloads = join(claude, 'downloads');
  const fetched = await ctx.measure(downloads);
  if (fetched.size > 0) {
    items.push({
      ...base('downloads', 'versions', 'safe'),
      path: downloads,
      size: fetched.size,
      count: fetched.files,
      lastUsed: fetched.newest,
      confidence: 'low',
      junk: 'old-version',
    });
  }

  for (const { name, kind, safety } of LEFTOVERS) {
    const path = join(claude, name);
    const measured = await ctx.measure(path);
    if (measured.size > 0) items.push({ ...base(name, kind, safety), path, size: measured.size, count: measured.files, lastUsed: measured.newest });
  }

  // O snapshot é lido a cada comando da sessão que o criou; o nome traz a hora em que ela começou.
  const snapshots = join(claude, 'shell-snapshots');
  const createdAt = async (file: string) => Number(/-(\d{13})-/.exec(basename(file))?.[1]) || (await mtimeOf(file));
  const dated = await Promise.all((await files(snapshots)).map(async (file) => ({ file, created: await createdAt(file) })));
  const start = await oldestLiveStart(ctx, claude);
  const stale = dated.filter((snapshot) => snapshot.created < start);
  const snapshotSize = await measureAll(
    ctx,
    stale.map((snapshot) => snapshot.file)
  );
  if (snapshotSize.size > 0) {
    items.push({
      ...base('shell-snapshots', 'cache', 'safe'),
      path: snapshots,
      paths: stale.map((snapshot) => snapshot.file),
      size: snapshotSize.size,
      count: stale.length,
      lastUsed: snapshotSize.newest,
      recheck: async (now) => {
        const limit = await oldestLiveStart(now, claude);
        return stale.some((snapshot) => snapshot.created >= limit) ? 'live-session' : null;
      },
    });
  }

  // Eventos que não chegaram a sair; o nome traz o id da sessão, e a viva ainda tenta reenviar.
  const telemetry = join(claude, 'telemetry');
  const live = liveIds(ctx);
  const sessionOf = (file: string) => basename(file).split('.')[1] ?? '';
  const failed = (await files(telemetry)).filter((file) => !live.has(sessionOf(file)));
  const telemetrySize = await measureAll(ctx, failed);
  if (telemetrySize.size > 0) {
    items.push({
      ...base('telemetry', 'logs', 'safe'),
      path: telemetry,
      paths: failed,
      size: telemetrySize.size,
      count: failed.length,
      lastUsed: telemetrySize.newest,
      recheck: async (now) => (now.claudeSessions.some((s) => failed.some((file) => sessionOf(file) === s.sessionId)) ? 'live-session' : null),
    });
  }

  const daemonLog = join(claude, 'daemon.log');
  const logSize = await ctx.measure(daemonLog);
  if (logSize.size > 0) {
    const supervisor = async (now: AiContext): Promise<AiBlock | null> =>
      claudeAlive(now, (await readJson(join(claude, 'daemon', 'roster.json')))?.supervisorPid) ? 'in-use' : null;
    items.push({
      ...base('daemon.log', 'logs', 'safe'),
      path: daemonLog,
      size: logSize.size,
      count: 1,
      lastUsed: logSize.newest,
      blocked: (await supervisor(ctx)) ?? undefined,
      recheck: supervisor,
    });
  }

  // Área dos downloads de atualização: mexida há menos de uma hora, pode ser uma atualização em curso.
  const staging = join(ctx.env.XDG_CACHE_HOME || join(ctx.home, '.cache'), 'claude', 'staging');
  const staged = (await list(staging)).map((entry) => join(staging, entry.name));
  const stagedSize = await measureAll(ctx, staged);
  if (stagedSize.size > 0 && ctx.now - stagedSize.newest > HOUR) {
    items.push({
      ...base('staging', 'cache', 'safe'),
      path: staging,
      paths: staged,
      size: stagedSize.size,
      count: staged.length,
      lastUsed: stagedSize.newest,
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Logs dos servidores MCP

/** A varredura do cleanupPeriodDays não passa por aqui; o nome do arquivo é a hora em que o servidor subiu. */
async function mcpLogs(ctx: AiContext, index: SessionIndex): Promise<Found[]> {
  const root = join(ctx.home, 'Library/Caches/claude-cli-nodejs');
  const items: Found[] = [];
  for (const folder of await list(root)) {
    if (!folder.isDirectory()) continue;
    const path = join(root, folder.name);
    const paths: string[] = [];
    let size = 0;
    let count = 0;
    let newest = 0;
    for (const server of await list(path)) {
      if (!server.isDirectory() || !server.name.startsWith('mcp-logs-')) continue;
      const dir = join(path, server.name);
      const logs = await Promise.all((await files(dir)).map(async (file) => ({ file, measured: await ctx.measure(file) })));
      const old = logs.filter((log) => ctx.isCold(log.measured.newest));
      if (old.length === 0) continue;
      // Pasta toda fria sai inteira; o Claude Code a recria quando o servidor sobe de novo.
      paths.push(...(old.length === logs.length ? [dir] : old.map((log) => log.file)));
      for (const log of old) {
        size += log.measured.size;
        newest = Math.max(newest, log.measured.newest);
      }
      count += old.length;
    }
    if (size <= 0) continue;
    const project = projectOf(ctx, index, folder.name);
    items.push({
      tool: 'claude-code',
      kind: 'logs',
      label: labelOf(ctx, index, project, folder.name),
      project,
      path,
      key: 'old',
      paths,
      size,
      count,
      lastUsed: newest,
      safety: 'safe',
      removal: 'trash',
    });
  }
  return items;
}

// ---------------------------------------------------------------------------
// Scratchpads em /tmp

/**
 * O macOS apaga arquivo por arquivo o que fica quatro dias parado em /tmp, e a varredura do Claude
 * Code apaga junto com a transcrição: só se mostra. Nada aqui é aberto, porque ler mudaria o atime e
 * adiaria a limpeza do macOS. A data vem da transcrição da sessão; a das pastas o tmp_cleaner mexe.
 */
async function scratchpads(ctx: AiContext, index: SessionIndex): Promise<Found[]> {
  const root = join(resolve(ctx.env.CLAUDE_CODE_TMPDIR || '/private/tmp'), `claude-${ctx.uid}`);
  const live = liveIds(ctx);
  const shown = {
    tool: 'claude-code' as const,
    kind: 'scratch' as const,
    safety: 'moderate' as const,
    removal: 'none' as const,
    blocked: 'self-cleaning' as const,
    hint: 'tmp-cleaner' as const,
  };
  const items: Found[] = [];

  for (const entry of await list(root)) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);

    if (entry.name === 'bash-edit-diff') {
      const shadows = (await list(path)).filter((shadow) => shadow.isDirectory());
      const size = await ctx.du(path);
      const used = await Promise.all(shadows.map((shadow) => mtimeOf(join(path, shadow.name, 'index'))));
      if (size > 0) items.push({ ...shown, label: entry.name, project: null, path, size, count: shadows.length, lastUsed: Math.max(0, ...used) });
      continue;
    }
    // Pasta de projeto: o cwd codificado começa pela barra, que vira hífen.
    if (!entry.name.startsWith('-')) continue;

    const sessions = (await list(path)).filter((session) => session.isDirectory() && UUID.test(session.name)).map((session) => session.name);
    const size = await ctx.du(path);
    if (size <= 0) continue;
    const lastUsed = sessions.some((id) => live.has(id)) ? ctx.now : Math.max(0, ...sessions.map((id) => index.lastUsed.get(id) ?? 0));
    const project = projectOf(ctx, index, entry.name);
    items.push({
      ...shown,
      label: labelOf(ctx, index, project, entry.name),
      project,
      path,
      size,
      count: sessions.length,
      lastUsed,
      confidence: lastUsed > 0 ? 'high' : 'low',
    });
  }
  return items;
}

const claudeCode: Collector = {
  id: 'claude-code',
  async collect(ctx) {
    const claude = claudeDir(ctx);
    const index = await indexSessions(ctx, claude);
    const jobs = await jobItems(ctx, claude, index);
    const parts = await Promise.all([
      sessionItems(ctx, claude, index, jobs.busy),
      cliVersions(ctx),
      leftovers(ctx, claude),
      mcpLogs(ctx, index),
      scratchpads(ctx, index),
    ]);
    return [...jobs.items, ...parts.flat()];
  },
};

// ---------------------------------------------------------------------------
// Claude Desktop

const appClosed = async (ctx: AiContext): Promise<AiBlock | null> => (ctx.running(DESKTOP_EXE) ? 'app-open' : null);

/** Cópias do Claude Code que o app baixa (aba Code e VM do Cowork): sai a que não é a atual. */
async function desktopVersions(ctx: AiContext, root: string, current: string | null): Promise<Found[]> {
  const names = (await list(root)).filter((entry) => entry.isDirectory() && /^\d+\.\d+/.test(entry.name)).map((entry) => entry.name);
  const keep = current && names.includes(current) ? current : newestVersion(names);
  const open = await appClosed(ctx);
  const items: Found[] = [];
  for (const name of names) {
    const path = join(root, name);
    const measured = await ctx.measure(path);
    // O `ps` mostra o caminho inteiro deste binário, então o uso de verdade se vê pelo processo.
    const busy = ctx.inUse(path);
    const item: Found = {
      tool: 'claude-desktop',
      kind: 'versions',
      label: `${basename(root)}/${name}`,
      project: null,
      path,
      size: measured.size,
      count: measured.files,
      // Sem processo, a única data é a do download.
      lastUsed: busy ? ctx.now : measured.newest,
      confidence: busy ? 'high' : 'low',
      safety: 'safe',
      removal: 'trash',
    };
    if (name === keep) {
      item.removal = 'none';
      item.blocked = 'current';
    } else {
      item.junk = 'old-version';
      if (busy) item.blocked = 'in-use';
      else if (open) item.blocked = open;
      item.recheck = appClosed;
    }
    items.push(item);
  }
  return items;
}

const claudeDesktop: Collector = {
  id: 'claude-desktop',
  async collect(ctx) {
    const base = join(ctx.home, 'Library/Application Support/Claude');
    const logs = join(ctx.home, 'Library/Logs/Claude');
    const open = await appClosed(ctx);
    const items: Found[] = [];

    // Disco da VM do Cowork. O mtime do rootfs.img é o da última atualização do app; o uso fica nos
    // logs do coworkd e no disco de dados. Sai pelo app, que sabe o que mais apagar junto.
    const vm = join(base, 'vm_bundles');
    const vmSize = await ctx.measure(vm);
    if (vmSize.size > 0) {
      const bundle = join(vm, 'claudevm.bundle');
      const rootfs = join(bundle, 'rootfs.img');
      const running = ((await openBy(ctx, [rootfs])).get(rootfs)?.length ?? 0) > 0;
      const signals = await Promise.all([join(logs, 'coworkd.log'), join(logs, 'cowork_vm_swift.log'), join(bundle, 'sessiondata.img')].map(mtimeOf));
      const used = Math.max(...signals);
      items.push({
        tool: 'claude-desktop',
        kind: 'vm',
        label: (await exists(bundle)) ? basename(bundle) : basename(vm),
        project: null,
        path: vm,
        size: vmSize.size,
        count: vmSize.files,
        lastUsed: running ? ctx.now : used || vmSize.newest,
        confidence: running || used ? 'high' : 'low',
        safety: 'moderate',
        removal: 'none',
        blocked: 'via-app',
        hint: 'cowork-vm',
      });
    }

    const caches = [...CHROMIUM_CACHES.map((name) => join(base, name)), join(ctx.home, 'Library/Caches/com.anthropic.claudefordesktop')];
    for (const path of caches) {
      const measured = await ctx.measure(path);
      if (measured.size <= 0) continue;
      items.push({
        tool: 'claude-desktop',
        kind: 'cache',
        label: basename(path),
        project: null,
        path,
        size: measured.size,
        count: measured.files,
        lastUsed: measured.newest,
        safety: 'safe',
        removal: 'trash',
        blocked: open ?? undefined,
        recheck: appClosed,
      });
    }

    const vmVersion = (await readFile(join(base, 'claude-code-vm', '.sdk-version'), 'utf8').catch(() => '')).trim();
    items.push(...(await desktopVersions(ctx, join(base, 'claude-code'), null)));
    items.push(...(await desktopVersions(ctx, join(base, 'claude-code-vm'), vmVersion || null)));

    // Só os rotacionados (main1.log…): os outros ainda são escritos, e o coworkd.log é o sinal de uso da VM.
    const names = (await list(logs)).filter((entry) => entry.isFile()).map((entry) => entry.name);
    const rotated = names
      .filter((name) => {
        const match = /^(.+?)\d+\.log$/.exec(name);
        return !!match && names.includes(`${match[1]}.log`);
      })
      .map((name) => join(logs, name));
    const rotatedSize = await measureAll(ctx, rotated);
    if (rotatedSize.size > 0) {
      items.push({
        tool: 'claude-desktop',
        kind: 'logs',
        label: basename(logs),
        project: null,
        path: logs,
        key: 'rotated',
        paths: rotated,
        size: rotatedSize.size,
        count: rotated.length,
        lastUsed: rotatedSize.newest,
        safety: 'safe',
        removal: 'trash',
      });
    }
    return items;
  },
};

export const claudeCollectors: Collector[] = [claudeCode, claudeDesktop];
