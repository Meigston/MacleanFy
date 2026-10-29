import { createHash } from 'node:crypto';
import { lstat, open, readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { AiToolId } from '../../../shared/api';
import { cwdOfTranscript } from '../context';
import type { AiContext, Collector, Found, ProcessInfo } from '../types';

/**
 * Agentes de terminal (opencode, Aider, Goose, Amp, Qwen Code, Crush), o Granola e os pacotes
 * que o npx baixa para subir servidores MCP. Só leem: configuração, credencial e banco de estado
 * de cada ferramenta nunca entram em `paths`, e o conteúdo das conversas nunca é lido.
 */

const DAY = 24 * 60 * 60 * 1000;

const list = (dir: string) => readdir(dir, { withFileTypes: true }).catch(() => []);
const stat = (path: string) => lstat(path).catch(() => null);
const within = (child: string | undefined, parent: string) => !!child && (child === parent || child.startsWith(parent + '/'));

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

async function existing(paths: readonly string[]): Promise<string[]> {
  const found = await Promise.all(paths.map(async (path) => ((await stat(path)) ? path : null)));
  return found.filter((path): path is string => path !== null);
}

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function measureAll(ctx: AiContext, paths: readonly string[]) {
  const parts = await mapLimit(paths, 8, (path) => ctx.measure(path));
  return parts.reduce(
    (total, m) => ({ size: total.size + m.size, newest: Math.max(total.newest, m.newest), files: total.files + m.files }),
    { size: 0, newest: 0, files: 0 }
  );
}

/** Mede o item; sem nada dentro, não há item. */
async function measured(ctx: AiContext, item: Omit<Found, 'size' | 'count' | 'lastUsed'>): Promise<Found[]> {
  const m = await measureAll(ctx, item.paths ?? [item.path]);
  return m.size > 0 ? [{ ...item, size: m.size, count: m.files, lastUsed: m.newest }] : [];
}

/** A pasta XDG que a variável aponta e a padrão: nem toda ferramenta respeita a variável. */
function xdg(ctx: AiContext, kind: 'data' | 'cache' | 'state', name: string): string[] {
  const variable = { data: 'XDG_DATA_HOME', cache: 'XDG_CACHE_HOME', state: 'XDG_STATE_HOME' }[kind];
  const fallback = { data: '.local/share', cache: '.cache', state: '.local/state' }[kind];
  const root = ctx.env[variable];
  const dirs = [root?.startsWith('/') ? join(root, name) : null, join(ctx.home, fallback, name)];
  return [...new Set(dirs.filter((dir): dir is string => dir !== null))];
}

type Matcher = (process: ProcessInfo) => boolean;

/** Pelo nome do executável, ou pelo script que o node ou o python roda (npm e pip instalam assim). */
function toolProcess(name: string): Matcher {
  const exe = new RegExp(`^${name}$`, 'i');
  const arg = new RegExp(`(^|[\\s/])${name}(\\s|$)`);
  return (p) => exe.test(basename(p.exe)) || arg.test(p.args);
}

const ampProcess = toolProcess('amp');
const qwenProcess = toolProcess('qwen');
const isOpencode = toolProcess('opencode');
const isAider = toolProcess('aider');
const isGoose = toolProcess('goosed?');
const isAmp: Matcher = (p) => ampProcess(p) || p.args.includes('@sourcegraph/amp');
const isQwen: Matcher = (p) => qwenProcess(p) || p.args.includes('@qwen-code/');
const isCrush = toolProcess('crush');
const isGranola: Matcher = (p) => p.exe.includes('/Granola.app/') || /^Granola( |$)/.test(basename(p.exe));
/** O instalador do Squirrel.Mac: roda justamente depois que o app fecha. */
const isShipIt: Matcher = (p) => basename(p.exe) === 'ShipIt';

type Gate = Pick<Found, 'blocked' | 'recheck'>;

/** Banco com WAL e arquivo aberto: com a ferramenta rodando, nada dela sai. Confere de novo na hora. */
function closedGate(ctx: AiContext, isOpen: (ctx: AiContext) => boolean): Gate {
  const recheck = async (now: AiContext) => (isOpen(now) ? ('app-open' as const) : null);
  return isOpen(ctx) ? { blocked: 'app-open', recheck } : { recheck };
}

/** Os caminhos (relativos ao projeto) que estão no git dele. git só de leitura, sem tocar no index. */
async function trackedIn(ctx: AiContext, project: string, relatives: readonly string[]): Promise<Set<string>> {
  const tracked = new Set<string>();
  if (!(await stat(join(project, '.git')))) return tracked;
  for (const relative of relatives) {
    const result = await ctx.exec('git', ['-C', project, 'ls-files', '--error-unmatch', '--', relative], {
      timeoutMs: 15_000,
      env: { GIT_OPTIONAL_LOCKS: '0' },
    });
    // 1 é "não está no git". Qualquer outro erro (git ausente, repositório quebrado): na dúvida, versionado.
    if (result.code === 0 || (result.code !== 1 && !/not a git repository/i.test(result.stderr))) tracked.add(relative);
  }
  return tracked;
}

/** Arquivo versionado só se mostra: apagar mexeria no projeto. */
const removalOf = (tracked: boolean, gate: Gate): Pick<Found, 'removal' | 'blocked' | 'recheck'> =>
  tracked ? { removal: 'none', blocked: 'tracked' } : { removal: 'trash', ...gate };

interface SessionGroup {
  tool: AiToolId;
  label: string;
  project: string | null;
  /** O que o Finder mostra; sem ele, a sessão mais nova do grupo. */
  path?: string;
  gate: Gate;
  /** Quantas das sessões mais novas estão abertas agora. */
  live?: number;
}

/** Um item para as sessões frias e outro para as quentes; as abertas agora ficam à parte. */
async function sessionItems(ctx: AiContext, group: SessionGroup, sessions: readonly string[][]): Promise<Found[]> {
  const all = await mapLimit(
    sessions.filter((paths) => paths.length > 0),
    8,
    async (paths) => ({ paths, ...(await measureAll(ctx, paths)) })
  );
  all.sort((a, b) => b.newest - a.newest);
  const live = all.slice(0, group.live ?? 0);
  const rest = all.slice(live.length);
  const buckets = [
    ['live', live],
    ['cold', rest.filter((s) => ctx.isCold(s.newest))],
    ['hot', rest.filter((s) => !ctx.isCold(s.newest))],
  ] as const;

  return buckets
    .filter(([, bucket]) => bucket.length > 0)
    .map(
      ([key, bucket]): Found => ({
        tool: group.tool,
        kind: 'sessions',
        label: group.label,
        project: group.project,
        path: group.path ?? bucket[0].paths[0],
        key,
        paths: bucket.flatMap((s) => s.paths),
        size: bucket.reduce((sum, s) => sum + s.size, 0),
        count: bucket.length,
        lastUsed: bucket.reduce((newest, s) => Math.max(newest, s.newest), 0),
        safety: 'moderate',
        removal: 'trash',
        ...(key === 'live' ? { blocked: 'live-session' as const } : group.gate),
      })
    )
    .filter((item) => item.size > 0);
}

/** Cada parte como número: 1.5.0 < 1.10.0, e uma prévia vem antes do lançamento. */
const VERSION = /^\d+(\.\d+)*(-[\w.-]+)?(\+[\w.-]+)?$/;

function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre = ''] = v.split('+')[0].split(/-(.*)/s);
    return { core: core.split('.').map(Number), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
    const diff = (x.core[i] ?? 0) - (y.core[i] ?? 0);
    if (diff !== 0) return Math.sign(diff);
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre.localeCompare(y.pre, 'en', { numeric: true });
}

// ─── opencode ────────────────────────────────────────────────────────────────

/** Um repositório git interno: HEAD e objects/ na raiz. */
async function isGitDir(dir: string): Promise<boolean> {
  return !!(await stat(join(dir, 'HEAD'))) && !!(await stat(join(dir, 'objects')))?.isDirectory();
}

/** O snapshot só ganha objetos e reescreve o index; HEAD e refs não andam. */
async function gitDirUsed(dir: string): Promise<number> {
  const objects = join(dir, 'objects');
  const fanout = (await list(objects)).filter((e) => e.isDirectory()).map((e) => join(objects, e.name));
  const stats = await Promise.all([join(dir, 'index'), join(dir, 'HEAD'), objects, ...fanout].map(stat));
  return stats.reduce((newest, s) => Math.max(newest, s?.mtimeMs ?? 0), 0);
}

/** id do projeto → pasta. O formato antigo grava storage/project/<id>.json; o novo, o id em <repo>/.git/opencode. */
async function opencodeProjects(ctx: AiContext, data: string): Promise<Map<string, string>> {
  const projects = new Map<string, string>();
  const dir = join(data, 'storage/project');
  for (const file of await list(dir)) {
    if (!file.isFile() || !file.name.endsWith('.json')) continue;
    const json = await readJson(join(dir, file.name));
    if (typeof json?.worktree === 'string' && json.worktree.startsWith('/')) {
      projects.set(typeof json.id === 'string' ? json.id : file.name.slice(0, -5), json.worktree);
    }
  }
  for (const project of ctx.projects) {
    const id = (await readFile(join(project, '.git/opencode'), 'utf8').catch(() => '')).trim();
    if (/^[\w-]{1,80}$/.test(id) && !projects.has(id)) projects.set(id, project);
  }
  return projects;
}

const opencode: Collector = {
  id: 'opencode',
  async collect(ctx) {
    const gate = closedGate(ctx, (c) => c.processes.some(isOpencode));
    const found: Found[] = [];

    for (const data of xdg(ctx, 'data', 'opencode')) {
      if (!(await stat(data))) continue;
      const projects = await opencodeProjects(ctx, data);
      const named = (id: string) => {
        const worktree = projects.get(id) ?? null;
        return { label: worktree ? basename(worktree) : id.slice(0, 12), project: worktree };
      };

      // O "desfazer" do opencode: um git por projeto e worktree, com cópia inteira dos arquivos.
      // Nada o limpa e passa de 100 GB, por isso o du.
      const snapshots = join(data, 'snapshot');
      for (const project of await list(snapshots)) {
        if (!project.isDirectory()) continue;
        const dir = join(snapshots, project.name);
        const repos = (await isGitDir(dir)) ? [dir] : (await list(dir)).filter((e) => e.isDirectory()).map((e) => join(dir, e.name));
        for (const repo of repos) {
          if (!(await isGitDir(repo))) continue;
          found.push({
            tool: 'opencode',
            kind: 'checkpoints',
            ...named(project.name),
            path: repo,
            size: await ctx.du(repo),
            count: 1,
            lastUsed: await gitDirUsed(repo),
            safety: 'moderate',
            removal: 'trash',
            ...gate,
          });
        }
      }

      // Formato antigo: um JSON por sessão, e as mensagens e partes em pastas com o id de cada uma.
      const storage = join(data, 'storage');
      for (const project of await list(join(storage, 'session'))) {
        if (!project.isDirectory()) continue;
        const dir = join(storage, 'session', project.name);
        const files = (await list(dir)).filter((f) => f.isFile() && f.name.endsWith('.json'));
        const sessions = await mapLimit(files, 8, async (file) => {
          const id = file.name.slice(0, -5);
          const messages = join(storage, 'message', id);
          const parts = (await list(messages)).filter((m) => m.name.endsWith('.json')).map((m) => join(storage, 'part', m.name.slice(0, -5)));
          return existing([join(dir, file.name), messages, ...parts, join(storage, 'session_diff', `${id}.json`)]);
        });
        const { label, project: worktree } = named(project.name);
        const live = worktree ? ctx.processes.filter((p) => isOpencode(p) && within(p.cwd, worktree)).length : 0;
        found.push(...(await sessionItems(ctx, { tool: 'opencode', label, project: worktree, path: dir, gate, live }, sessions)));
      }

      // O banco novo guarda todas as sessões e o estado: só se mostra o tamanho.
      const names = (await list(data)).map((e) => e.name);
      for (const db of names.filter((name) => /^opencode(-[\w.]+)?\.db$/.test(name))) {
        const paths = [db, `${db}-wal`, `${db}-shm`].filter((name) => names.includes(name)).map((name) => join(data, name));
        found.push(
          ...(await measured(ctx, {
            tool: 'opencode',
            kind: 'sessions',
            label: db,
            project: null,
            path: paths[0],
            paths,
            safety: 'moderate',
            removal: 'none',
            blocked: 'via-app',
          }))
        );
      }

      const log = join(data, 'log');
      found.push(...(await measured(ctx, { tool: 'opencode', kind: 'logs', label: 'cli', project: null, path: log, safety: 'safe', removal: 'trash', ...gate })));
    }

    // Pacotes dos provedores, lista de modelos e os LSP baixados: a doc manda apagar quando algo quebra.
    for (const cache of xdg(ctx, 'cache', 'opencode')) {
      found.push(
        ...(await measured(ctx, {
          tool: 'opencode',
          kind: 'cache',
          label: 'cache',
          project: null,
          path: cache,
          confidence: 'low',
          safety: 'safe',
          removal: 'trash',
          hint: 'redownload',
          ...gate,
        }))
      );
    }

    const desktop = join(ctx.home, 'Library/Application Support/ai.opencode.desktop/logs');
    found.push(...(await measured(ctx, { tool: 'opencode', kind: 'logs', label: 'desktop', project: null, path: desktop, safety: 'safe', removal: 'trash', ...gate })));
    return found;
  },
};

// ─── Aider ───────────────────────────────────────────────────────────────────

const AIDER_HISTORY = ['.aider.chat.history.md', '.aider.input.history', '.aider.llm.history'];

const aider: Collector = {
  id: 'aider',
  async collect(ctx) {
    const found: Found[] = [];
    found.push(
      ...(await measured(ctx, {
        tool: 'aider',
        kind: 'cache',
        label: 'caches',
        project: null,
        path: join(ctx.home, '.aider/caches'),
        confidence: 'low',
        safety: 'safe',
        removal: 'trash',
        hint: 'redownload',
        ...closedGate(ctx, (c) => c.processes.some(isAider)),
      }))
    );

    // O Aider grava na raiz do repositório; .aider.conf.yml, .env e afins são configuração.
    for (const project of ctx.projects) {
      const names = (await list(project)).map((e) => e.name);
      const tags = names.filter((name) => /^\.aider\.tags\.cache\.v\d+$/.test(name));
      const histories = AIDER_HISTORY.filter((name) => names.includes(name));
      if (tags.length === 0 && histories.length === 0) continue;
      const gate = closedGate(ctx, (c) => c.processes.some((p) => isAider(p) && within(p.cwd, project)));
      const tracked = await trackedIn(ctx, project, [...tags, ...histories]);
      const label = basename(project);

      for (const name of tags) {
        const path = join(project, name);
        found.push(...(await measured(ctx, { tool: 'aider', kind: 'cache', label, project, path, safety: 'safe', ...removalOf(tracked.has(name), gate) })));
      }

      // O histórico é um arquivo só por projeto, com todas as sessões: não dá para separar frio de quente.
      for (const group of [histories.filter((name) => !tracked.has(name)), histories.filter((name) => tracked.has(name))]) {
        if (group.length === 0) continue;
        const paths = group.map((name) => join(project, name));
        found.push(
          ...(await measured(ctx, {
            tool: 'aider',
            kind: 'sessions',
            label,
            project,
            path: paths[0],
            paths,
            safety: 'moderate',
            ...removalOf(tracked.has(group[0]), gate),
          }))
        );
      }
    }
    return found;
  },
};

// ─── Goose ───────────────────────────────────────────────────────────────────

/** O working_dir da primeira linha de uma sessão no formato antigo; o resto do arquivo não é lido. */
async function gooseWorkingDir(path: string): Promise<string | null> {
  const handle = await open(path, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const header = buffer.subarray(0, bytesRead).toString('utf8').split('\n')[0];
    const dir = (JSON.parse(header) as { working_dir?: unknown }).working_dir;
    return typeof dir === 'string' && dir.startsWith('/') ? dir : null;
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

const goose: Collector = {
  id: 'goose',
  async collect(ctx) {
    const gate = closedGate(ctx, (c) => c.processes.some(isGoose));
    const found: Found[] = [];

    for (const data of xdg(ctx, 'data', 'goose')) {
      const dir = join(data, 'sessions');
      const entries = await list(dir);
      const names = entries.map((e) => e.name);

      // Desde a 1.10 todas as sessões ficam num banco só, que sai por `goose session remove`.
      if (names.includes('sessions.db')) {
        const paths = ['sessions.db', 'sessions.db-wal', 'sessions.db-shm'].filter((name) => names.includes(name)).map((name) => join(dir, name));
        found.push(
          ...(await measured(ctx, {
            tool: 'goose',
            kind: 'sessions',
            label: 'sessions.db',
            project: null,
            path: paths[0],
            paths,
            safety: 'moderate',
            removal: 'none',
            blocked: 'via-app',
            hint: 'tool-command',
          }))
        );
      }

      // Os .jsonl de antes da 1.10, que a ferramenta já não gerencia.
      const byProject = new Map<string, string[][]>();
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const path = join(dir, entry.name);
        const project = (await gooseWorkingDir(path)) ?? '';
        byProject.set(project, [...(byProject.get(project) ?? []), [path]]);
      }
      for (const [project, sessions] of byProject) {
        const live = project ? ctx.processes.filter((p) => isGoose(p) && within(p.cwd, project)).length : 0;
        const group = { tool: 'goose' as const, label: project ? basename(project) : 'sessions', project: project || null, gate, live };
        found.push(...(await sessionItems(ctx, group, sessions)));
      }
    }

    // Logs do CLI e do servidor (a ferramenta apaga os de mais de duas semanas) e do app.
    for (const state of xdg(ctx, 'state', 'goose')) {
      found.push(...(await measured(ctx, { tool: 'goose', kind: 'logs', label: 'cli', project: null, path: join(state, 'logs'), safety: 'safe', removal: 'trash', ...gate })));
    }
    const desktop = join(ctx.home, 'Library/Application Support/Goose/logs');
    found.push(...(await measured(ctx, { tool: 'goose', kind: 'logs', label: 'desktop', project: null, path: desktop, safety: 'safe', removal: 'trash', ...gate })));
    return found;
  },
};

// ─── Amp ─────────────────────────────────────────────────────────────────────

const amp: Collector = {
  id: 'amp',
  async collect(ctx) {
    const gate = closedGate(ctx, (c) => c.processes.some(isAmp));
    const found: Found[] = [];

    // Cópia local dos threads, que continuam no servidor do Amp. Não dizem de que projeto são.
    for (const data of xdg(ctx, 'data', 'amp')) {
      const dir = join(data, 'threads');
      const threads = (await list(dir)).filter((f) => f.isFile() && /^T-.+\.json$/.test(f.name)).map((f) => [join(dir, f.name)]);
      const live = ctx.processes.filter(isAmp).length;
      found.push(...(await sessionItems(ctx, { tool: 'amp', label: 'threads', project: null, path: dir, gate, live }, threads)));
    }
    for (const cache of xdg(ctx, 'cache', 'amp')) {
      found.push(...(await measured(ctx, { tool: 'amp', kind: 'logs', label: 'cli', project: null, path: join(cache, 'logs'), safety: 'safe', removal: 'trash', ...gate })));
    }
    return found;
  },
};

// ─── Qwen Code ───────────────────────────────────────────────────────────────

/** Como o Qwen Code (fork do Gemini CLI) nomeia a pasta de um projeto. */
const sanitizeCwd = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-');
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const qwenCode: Collector = {
  id: 'qwen-code',
  async collect(ctx) {
    // QWEN_RUNTIME_DIR leva projects/, tmp/ e debug/; configuração e memória ficam em QWEN_HOME.
    const home = ctx.env.QWEN_HOME || join(ctx.home, '.qwen');
    const runtime = ctx.env.QWEN_RUNTIME_DIR || home;
    const gate = closedGate(ctx, (c) => c.processes.some(isQwen));
    const found: Found[] = [];
    const bySanitized = new Map(ctx.projects.map((project) => [sanitizeCwd(project), project]));
    const byHash = new Map(ctx.projects.map((project) => [sha256(project), project]));
    const liveIn = (project: string | null) => (project ? ctx.processes.filter((p) => isQwen(p) && within(p.cwd, project)).length : 0);

    for (const entry of await list(join(runtime, 'projects'))) {
      if (!entry.isDirectory()) continue;
      const chats = join(runtime, 'projects', entry.name, 'chats');
      const transcripts = (await list(chats)).filter((f) => f.isFile() && f.name.endsWith('.jsonl')).map((f) => join(chats, f.name));
      if (transcripts.length === 0) continue;
      const sessions = await Promise.all(transcripts.map((path) => existing([path, path.replace(/\.jsonl$/, '.runtime.json')])));

      // O nome da pasta perde informação (barra e hífen viram a mesma coisa): primeiro os projetos
      // conhecidos, depois o cwd gravado no começo da conversa.
      let project = bySanitized.get(entry.name) ?? null;
      if (!project) {
        for (const path of transcripts.slice(0, 3)) {
          project = await cwdOfTranscript(path);
          if (project) break;
        }
      }
      const label = project ? basename(project) : entry.name;
      found.push(...(await sessionItems(ctx, { tool: 'qwen-code', label, project, path: chats, gate, live: liveIn(project) }, sessions)));
    }

    // Checkpoints e histórico de shell, numa pasta com o sha256 da raiz do projeto.
    for (const entry of await list(join(runtime, 'tmp'))) {
      if (!entry.isDirectory() || !/^[0-9a-f]{64}$/.test(entry.name)) continue;
      const project = byHash.get(entry.name) ?? null;
      found.push(
        ...(await measured(ctx, {
          tool: 'qwen-code',
          kind: 'checkpoints',
          label: project ? basename(project) : entry.name.slice(0, 12),
          project,
          path: join(runtime, 'tmp', entry.name),
          safety: 'moderate',
          removal: 'trash',
          ...(liveIn(project) > 0 ? { blocked: 'live-session' as const } : gate),
        }))
      );
    }

    const debug = join(runtime, 'debug');
    found.push(...(await measured(ctx, { tool: 'qwen-code', kind: 'logs', label: 'debug', project: null, path: debug, safety: 'safe', removal: 'trash', ...gate })));
    return found;
  },
};

// ─── Crush ───────────────────────────────────────────────────────────────────

const crush: Collector = {
  id: 'crush',
  async collect(ctx) {
    const found: Found[] = [];
    for (const project of ctx.projects) {
      const dir = join(project, '.crush');
      const names = (await list(dir)).map((e) => e.name);
      if (names.length === 0) continue;
      const gate = closedGate(ctx, (c) => c.processes.some((p) => isCrush(p) && within(p.cwd, project)));
      const label = basename(project);

      // Sessões e mensagens do projeto num SQLite com WAL: os três arquivos saem juntos.
      if (names.includes('crush.db')) {
        const files = ['crush.db', 'crush.db-wal', 'crush.db-shm'].filter((name) => names.includes(name)).map((name) => `.crush/${name}`);
        const tracked = (await trackedIn(ctx, project, files)).size > 0;
        const paths = files.map((file) => join(project, file));
        found.push(
          ...(await measured(ctx, { tool: 'crush', kind: 'sessions', label, project, path: paths[0], paths, safety: 'moderate', ...removalOf(tracked, gate) }))
        );
      }
      if (names.includes('logs')) {
        const tracked = (await trackedIn(ctx, project, ['.crush/logs'])).size > 0;
        found.push(...(await measured(ctx, { tool: 'crush', kind: 'logs', label, project, path: join(dir, 'logs'), safety: 'safe', ...removalOf(tracked, gate) })));
      }
    }
    return found;
  },
};

// ─── Granola ─────────────────────────────────────────────────────────────────

/** Só os caches do Chromium; granola.db, os *.json.enc, IndexedDB, cookies e o armazenamento web ficam. */
const GRANOLA_CACHES = /^(Cache|Code Cache|GPUCache|Dawn\w*|Shared Dictionary|blob_storage|DIPS(-wal|-shm|-journal)?)$/;

async function bundleVersion(ctx: AiContext, app: string): Promise<string | null> {
  const plist = join(app, 'Contents/Info.plist');
  const text = await readFile(plist, 'utf8').catch(() => null);
  if (text === null) return null;
  const match = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(text);
  if (match) return match[1].trim();
  if (!text.startsWith('bplist')) return null;
  const result = await ctx.exec('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist]);
  return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

/** O nome da pasta de cache do electron-updater, que o app-update.yml de dentro do app traz. */
async function updaterCacheDir(app: string): Promise<string | null> {
  const yml = await readFile(join(app, 'Contents/Resources/app-update.yml'), 'utf8').catch(() => '');
  const name = /^updaterCacheDirName:\s*['"]?([^'"\n]+?)['"]?\s*$/m.exec(yml)?.[1];
  return name && !name.includes('/') && !name.startsWith('.') ? name : null;
}

const downloading = async (pending: string) => (await list(pending)).some((e) => e.name.startsWith('temp-'));

/**
 * O electron-updater nunca limpa o pending/ depois de instalar. Sobra é o zip cuja versão já está
 * instalada; download em andamento (temp-*), update marcado para a próxima abertura ou ShipIt
 * rodando ficam de fora.
 */
async function granolaPending(ctx: AiContext): Promise<Found[]> {
  let app: string | null = null;
  for (const candidate of [join(ctx.home, 'Applications/Granola.app'), '/Applications/Granola.app']) {
    if (await stat(join(candidate, 'Contents/Info.plist'))) {
      app = candidate;
      break;
    }
  }
  const dirName = (app && (await updaterCacheDir(app))) || '@granolaelectron-updater';
  const found: Found[] = [];

  // O electron-updater anterior à 6.0 gravava em Application Support/Caches.
  for (const root of [join(ctx.home, 'Library/Caches'), join(ctx.home, 'Library/Application Support/Caches')]) {
    const pending = join(root, dirName, 'pending');
    const info = await readJson(join(pending, 'update-info.json'));
    if (!info || info.installOnNextLaunch === true || ctx.processes.some(isShipIt) || (await downloading(pending))) continue;

    const fileName = typeof info.fileName === 'string' ? info.fileName : '';
    const version = /(\d+(?:\.\d+){1,3})/.exec(fileName)?.[1] ?? null;
    const installed = app ? await bundleVersion(ctx, app) : null;
    const downloadedAt = (await stat(join(pending, 'update-info.json')))?.mtimeMs ?? 0;
    // App desinstalado: o update não tem para onde ir. Sem versão para comparar, só depois de um
    // dia e com o app fechado.
    if (app && version && installed && compareVersions(version, installed) > 0) continue;
    if (app && !(version && installed) && (ctx.processes.some(isGranola) || ctx.now - downloadedAt < DAY)) continue;

    const m = await ctx.measure(pending);
    if (m.size <= 0) continue;
    found.push({
      tool: 'granola',
      kind: 'versions',
      label: version ?? (fileName || 'pending'),
      project: null,
      path: pending,
      size: m.size,
      count: m.files,
      lastUsed: downloadedAt,
      confidence: 'low',
      junk: 'orphan',
      safety: 'safe',
      removal: 'trash',
      recheck: async (now) => (now.processes.some(isShipIt) || (await downloading(pending)) ? 'in-use' : null),
    });
  }
  return found;
}

const granola: Collector = {
  id: 'granola',
  async collect(ctx) {
    const support = join(ctx.home, 'Library/Application Support/Granola');
    const caches = (await list(support)).filter((e) => GRANOLA_CACHES.test(e.name)).map((e) => join(support, e.name));
    const found: Found[] = [];
    if (caches.length > 0) {
      found.push(
        ...(await measured(ctx, {
          tool: 'granola',
          kind: 'cache',
          label: 'Chromium',
          project: null,
          path: support,
          paths: caches,
          safety: 'safe',
          removal: 'trash',
          ...closedGate(ctx, (c) => c.processes.some(isGranola)),
        }))
      );
    }
    found.push(...(await granolaPending(ctx)));
    return found;
  },
};

// ─── npx ─────────────────────────────────────────────────────────────────────

/** Um nome de pacote do npm, com ou sem versão; o que não tiver essa cara nunca é guardado. */
const SPEC = /^(@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*(@[\w.^~<>=*|-]+)?$/i;
const PACKAGE_NAME = /^(@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*$/i;

/** O pacote que um servidor MCP manda o npx rodar. Do resto dos argumentos (DSN, chaves) nada fica. */
function npxSpec(command: unknown, args: unknown): string | null {
  if (typeof command !== 'string' || !Array.isArray(args)) return null;
  const strings = args.filter((arg): arg is string => typeof arg === 'string');
  const exe = basename(command);
  const rest = exe === 'npx' ? strings : exe === 'npm' && strings[0] === 'exec' ? strings.slice(1) : null;
  if (!rest) return null;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const value = arg === '-p' || arg === '--package' ? rest[i + 1] : arg.startsWith('--package=') ? arg.slice(10) : arg.startsWith('-') ? undefined : arg;
    if (value !== undefined) return SPEC.test(value) ? value : null;
  }
  return null;
}

/** Os pacotes que as configurações de MCP pedem ao npx. Só command e args; env nunca é lido. */
async function mcpSpecs(ctx: AiContext): Promise<Set<string>> {
  const specs = new Set<string>();
  const add = (servers: unknown) => {
    if (!servers || typeof servers !== 'object') return;
    for (const server of Object.values(servers)) {
      const spec = server && typeof server === 'object' ? npxSpec((server as { command?: unknown }).command, (server as { args?: unknown }).args) : null;
      if (spec) specs.add(spec);
    }
  };

  const claudeDir = ctx.env.CLAUDE_CONFIG_DIR;
  const files = [
    join(ctx.home, '.claude.json'),
    ...(claudeDir ? [join(claudeDir, '.claude.json')] : []),
    join(ctx.home, '.cursor/mcp.json'),
    join(ctx.home, 'Library/Application Support/Code/User/mcp.json'),
    join(ctx.home, 'Library/Application Support/Claude/claude_desktop_config.json'),
    ...ctx.projects.map((project) => join(project, '.mcp.json')),
  ];
  for (const file of files) {
    const json = await readJson(file);
    if (!json) continue;
    add(json.mcpServers);
    add(json.servers);
    if (json.projects && typeof json.projects === 'object') {
      for (const project of Object.values(json.projects)) add((project as { mcpServers?: unknown } | null)?.mcpServers);
    }
  }

  // config.toml do Codex: de cada [mcp_servers.x], só command e args.
  const toml = await readFile(join(ctx.env.CODEX_HOME || join(ctx.home, '.codex'), 'config.toml'), 'utf8').catch(() => '');
  for (const section of toml.split(/^\s*\[/m)) {
    if (!section.startsWith('mcp_servers.')) continue;
    const command = /^\s*command\s*=\s*["']([^"'\n]*)["']/m.exec(section)?.[1];
    const args = /^\s*args\s*=\s*\[([\s\S]*?)\]/m.exec(section)?.[1] ?? '';
    const spec = npxSpec(command, [...args.matchAll(/"((?:[^"\\\n]|\\.)*)"|'([^'\n]*)'/g)].map((m) => m[1] ?? m[2]));
    if (spec) specs.add(spec);
  }
  return specs;
}

interface NpxEntry {
  path: string;
  mtime: number;
  /** O que foi pedido ao npx (`_npx.packages`). */
  specs: string[];
  packages: Array<{ name: string; version: string | null }>;
  broken: boolean;
}

async function readNpxEntry(path: string, mtime: number): Promise<NpxEntry> {
  const json = await readJson(join(path, 'package.json'));
  const deps = json?.dependencies;
  const names = deps && typeof deps === 'object' && !Array.isArray(deps) ? Object.keys(deps) : [];
  const requested = (json?._npx as { packages?: unknown } | undefined)?.packages;
  const specs = Array.isArray(requested) ? requested.filter((spec): spec is string => typeof spec === 'string') : [];
  let broken = !json || names.length === 0;

  const packages = await Promise.all(
    names.map(async (name) => {
      const own = PACKAGE_NAME.test(name) ? await stat(join(path, 'node_modules', name)) : null;
      if (!own) broken = true;
      // Pacote local (file:) é link para o repositório: não seguir.
      if (!own || own.isSymbolicLink()) return { name, version: null };
      const manifest = await readJson(join(path, 'node_modules', name, 'package.json'));
      if (!manifest) broken = true;
      return { name, version: typeof manifest?.version === 'string' && VERSION.test(manifest.version) ? manifest.version : null };
    })
  );
  return { path, mtime, specs, packages, broken };
}

/** Mexida há menos disso, a entrada pode ser uma instalação do npx em andamento. */
const NPX_SETTLE_MS = 60 * 60 * 1000;

/**
 * A última vez que o npx mexeu na entrada. Ele cria a pasta e o node_modules no começo e grava o
 * package.json só no fim, então no meio da instalação a entrada parece quebrada; o npm 11 ainda
 * segura um concurrency.lock que toca a cada segundo. O processo `npm exec` não cita o caminho.
 */
async function npxTouched(path: string): Promise<number> {
  const marks = ['', 'package.json', 'concurrency.lock', 'node_modules', 'node_modules/.package-lock.json'];
  const stats = await Promise.all(marks.map((mark) => stat(join(path, mark))));
  return stats.reduce((newest, s) => Math.max(newest, s?.mtimeMs ?? 0), 0);
}

const npxRecent = async (ctx: AiContext, path: string) => ctx.now - (await npxTouched(path)) < NPX_SETTLE_MS;

/** Entrada mais velha que outra com os mesmos pacotes, e que nenhuma configuração de MCP pede. */
function oldVersions(entries: readonly NpxEntry[], configured: ReadonlySet<string>): Set<string> {
  const comparable = entries.filter((e) => !e.broken && e.packages.length > 0 && e.packages.every((p) => p.version));
  const key = (e: NpxEntry) => e.packages.map((p) => p.name).sort().join('\n');
  const version = (e: NpxEntry, name: string) => e.packages.find((p) => p.name === name)?.version ?? '';
  const newer = (b: NpxEntry, a: NpxEntry) => {
    const diffs = a.packages.map((p) => compareVersions(version(b, p.name), p.version ?? ''));
    return diffs.every((d) => d >= 0) && diffs.some((d) => d > 0);
  };
  const old = new Set<string>();
  for (const a of comparable) {
    if (a.specs.some((spec) => configured.has(spec))) continue;
    if (comparable.some((b) => b !== a && key(b) === key(a) && newer(b, a))) old.add(a.path);
  }
  return old;
}

const npx: Collector = {
  id: 'npx',
  async collect(ctx) {
    const cache = ctx.env.npm_config_cache || ctx.env.NPM_CONFIG_CACHE || join(ctx.home, '.npm');
    const root = join(cache, '_npx');
    const dirs = (await list(root)).filter((e) => e.isDirectory()).map((e) => join(root, e.name));
    if (dirs.length === 0) return [];

    // O mtime da pasta é a instalação, ou a última vez que o npx revalidou um pacote sem versão.
    const entries = await mapLimit(dirs, 8, async (path) => readNpxEntry(path, (await stat(path))?.mtimeMs ?? 0));
    const old = oldVersions(entries, await mcpSpecs(ctx));
    const sizes = await mapLimit(entries, 4, (entry) => ctx.du(entry.path));
    const recent = await mapLimit(entries, 8, (entry) => npxRecent(ctx, entry.path));

    return entries
      .map((entry, i): Found => {
        const label = entry.packages.map((p) => (p.version ? `${p.name}@${p.version}` : p.name)).join(', ');
        const item: Found = {
          tool: 'npx',
          kind: 'packages',
          label: label || basename(entry.path),
          // `npx /caminho/do/repo` aponta o projeto.
          project: entry.specs.find((spec) => spec.startsWith('/')) ?? null,
          path: entry.path,
          size: sizes[i],
          count: 1,
          lastUsed: entry.mtime,
          confidence: 'low',
          safety: 'safe',
          removal: 'trash',
          hint: 'redownload',
          // Uma entrada quebrada e parada pode voltar a ser preenchida: o npx reusa a pasta dos mesmos pacotes.
          recheck: async (now) => ((await npxRecent(now, entry.path)) ? 'recent' : null),
        };
        // Recém-mexida não é lixo: pode ser a instalação que está subindo um servidor MCP.
        if (recent[i]) item.blocked = 'recent';
        else if (entry.broken) item.junk = 'orphan';
        else if (old.has(entry.path)) item.junk = 'old-version';
        return item;
      })
      .filter((item) => item.size > 0);
  },
};

export const agentCollectors: Collector[] = [opencode, aider, goose, amp, qwenCode, crush, granola, npx];
