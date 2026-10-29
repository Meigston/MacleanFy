import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { AiBlock, AiToolId } from '../../../shared/api';
import type { AiContext, Collector, ExecResult, Found } from '../types';

/**
 * As worktrees que os orquestradores de agentes deixam. Quem diz o que é worktree é o
 * `git worktree list` do repositório dono, nunca a pasta sozinha: pasta que o git não conhece
 * mais pode ter qualquer coisa e fica de fora. E só entra o que está debaixo das pastas dos
 * orquestradores; worktree em outro lugar é trabalho do usuário.
 *
 * Sai para a Lixeira e depois `git worktree prune`, sem `--force` e sem tocar no branch, e só
 * depois de conferir que não há trabalho ali: mudança não commitada, commit solto em HEAD
 * destacado, `.env` que só existe nela, lock de processo vivo ou sessão aberta.
 */

type Tool = Extract<AiToolId, 'claude-code' | 'cursor' | 'codex' | 'conductor' | 'claude-squad' | 'vibe-kanban' | 'crystal'>;

const TOOLS: readonly Tool[] = ['claude-code', 'cursor', 'codex', 'conductor', 'claude-squad', 'vibe-kanban', 'crystal'];

/** Comandos git e `du` ao mesmo tempo, somando todos os orquestradores: são dezenas de worktrees com node_modules. */
const CONCURRENCY = 4;
const GIT_TIMEOUT_MS = 60_000;
/** Sem isso um `git status` reescreve o index, e a análise esquentaria a worktree que olha. */
const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0' };
/** O que o git escreve em `<common>/worktrees/<id>` quando a worktree é usada. O mtime da pasta não acompanha. */
const ACTIVITY = ['index', 'logs/HEAD', 'HEAD', 'COMMIT_EDITMSG', 'FETCH_HEAD', 'ORIG_HEAD'];
/** Ignorados que costumam ser segredo: o `worktree remove` os apagaria sem avisar. */
const SECRET = /^\.env|\.(p8|p12|jks|keystore)$/;
/** Pastas que abrem pedido de autorização do macOS: repositório ali dentro nem é olhado. */
const PROTECTED = [
  'Library/CloudStorage',
  'Library/Mobile Documents',
  'Library/Containers',
  'Library/Group Containers',
  'Library/Mail',
  'Library/Messages',
  'Library/Safari',
];
const GUARD_REASON = 'macleanfy: protegida durante o git worktree prune';

interface Worktree {
  path: string;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  /** Motivo do lock; vazio quando trancada sem motivo, nulo quando não está trancada. */
  locked: string | null;
  prunable: boolean;
}

interface Repo {
  /** O `.git` de verdade (o common dir), que identifica o repositório. */
  common: string;
  /** A worktree principal; nulo em repositório bare. */
  root: string | null;
  project: string;
}

interface Discovered {
  tool: Tool;
  repo: Repo;
  worktree: Worktree;
  /** As outras worktrees ligadas do mesmo repositório, para achar as que estão dentro desta. */
  linked: Worktree[];
}

/** O que é das sessões vivas do Claude Code. */
interface Live {
  cwds: string[];
  /** agent-<id> com transcrição numa sessão viva. */
  agents: Set<string>;
  /** wf_<run> de workflows de sessões vivas; as worktrees deles se chamam wf_<run>-<n>. */
  runs: Set<string>;
  /** worktreePath dos jobs em segundo plano cuja sessão está viva. */
  worktrees: Set<string>;
}

interface Verdict {
  block: AiBlock | null;
  /** Worktrees trancadas por processo que já morreu: são destrancadas na remoção. */
  unlock: string[];
}

interface Shared {
  limit<T>(task: () => Promise<T>): Promise<T>;
  discovered?: Promise<Discovered[]>;
  live?: Promise<Live>;
}

function limiter(max: number): Shared['limit'] {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (task) => {
    if (active < max) active++;
    else await new Promise<void>((wake) => waiting.push(wake));
    try {
      return await task();
    } finally {
      // A vaga passa direto para quem espera, para ninguém furar a fila no meio.
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  };
}

/** Uma análise descobre uma vez só e divide o limite de comandos entre os coletores. */
const perContext = new WeakMap<AiContext, Shared>();

function shared(ctx: AiContext): Shared {
  let state = perContext.get(ctx);
  if (!state) {
    state = { limit: limiter(CONCURRENCY) };
    perContext.set(ctx, state);
  }
  return state;
}

function git(ctx: AiContext, args: string[]): Promise<ExecResult> {
  // Sem fsmonitor: um status não pode deixar um daemon rodando em cada worktree.
  return shared(ctx).limit(() =>
    ctx.exec('git', ['-c', 'core.fsmonitor=false', ...args], { env: GIT_ENV, timeoutMs: GIT_TIMEOUT_MS })
  );
}

const real = (path: string) => realpath(path).catch(() => path);
const dirents = (dir: string) => readdir(dir, { withFileTypes: true }).catch(() => []);
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent + '/');
const isProtected = (ctx: AiContext, path: string) => PROTECTED.some((folder) => inside(path, join(ctx.home, folder)));
/** Resolve o link, menos em pasta protegida, onde até o lstat pode abrir o pedido de autorização. */
const realOutside = (ctx: AiContext, path: string) => (isProtected(ctx, path) ? path : real(path));
const claudeDir = (ctx: AiContext) => ctx.env.CLAUDE_CONFIG_DIR || join(ctx.home, '.claude');
/** O nome da pasta em ~/.claude/projects: todo caractere que não é letra ou número vira '-'. */
const encodeCwd = (path: string) => path.replace(/[^a-zA-Z0-9]/g, '-');

/** A saída de `git worktree list --porcelain -z`: campos separados por NUL, worktrees por NUL duplo. */
export function parseWorktreeList(output: string): Worktree[] {
  const list: Worktree[] = [];
  let current: Worktree | null = null;
  for (const field of output.split('\0')) {
    if (field === '') {
      current = null;
      continue;
    }
    const space = field.indexOf(' ');
    const key = space < 0 ? field : field.slice(0, space);
    const value = space < 0 ? '' : field.slice(space + 1);
    if (key === 'worktree') {
      current = { path: value, branch: null, detached: false, bare: false, locked: null, prunable: false };
      list.push(current);
    } else if (current) {
      if (key === 'branch') current.branch = value.replace(/^refs\/heads\//, '');
      else if (key === 'detached') current.detached = true;
      else if (key === 'bare') current.bare = true;
      else if (key === 'locked') current.locked = value;
      else if (key === 'prunable') current.prunable = true;
    }
  }
  return list;
}

/** A saída de `git status --porcelain -z`: se houve mudança, e quais caminhos estão ignorados. */
export function parseStatus(output: string): { changed: boolean; ignored: string[] } {
  const fields = output.split('\0');
  const ignored: string[] = [];
  let changed = false;
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (field.length < 4) continue;
    if (field.startsWith('!! ')) {
      ignored.push(field.slice(3));
    } else {
      changed = true;
      // Renomeado e copiado trazem o caminho de origem no campo seguinte.
      if (field[0] === 'R' || field[0] === 'C') i++;
    }
  }
  return { changed, ignored };
}

/** O common dir de uma pasta cujo `.git` é arquivo (`gitdir: …/.git/worktrees/<id>`). */
async function commonOfLink(ctx: AiContext, dir: string): Promise<string | null> {
  const text = await readFile(join(dir, '.git'), 'utf8').catch(() => null);
  const gitdir = text && /^gitdir: (.+)$/m.exec(text)?.[1].trim();
  if (!gitdir) return null;
  const admin = resolve(dir, gitdir);
  if (isProtected(ctx, admin)) return null;
  const common = (await readFile(join(admin, 'commondir'), 'utf8').catch(() => null))?.trim();
  // Sem commondir é submódulo: o gitdir já é o repositório.
  return real(common ? resolve(admin, common) : admin);
}

/** O repositório de um projeto, subindo até achar o `.git`, sem passar da pasta pessoal. */
async function commonOfProject(ctx: AiContext, project: string): Promise<string | null> {
  if (isProtected(ctx, project)) return null;
  for (let dir = project; dir !== ctx.home && dir !== dirname(dir); dir = dirname(dir)) {
    const dotgit = await lstat(join(dir, '.git')).catch(() => null);
    if (dotgit?.isDirectory()) return real(join(dir, '.git'));
    if (dotgit?.isFile()) return commonOfLink(ctx, dir);
  }
  return null;
}

/** Checkouts ligados (com `.git` arquivo) até `depth` níveis abaixo de uma pasta de orquestrador. */
async function linksUnder(root: string, depth: number): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await dirents(root)) {
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    const dotgit = await lstat(join(dir, '.git')).catch(() => null);
    if (dotgit?.isFile()) found.push(dir);
    else if (!dotgit && depth > 1) found.push(...(await linksUnder(dir, depth - 1)));
  }
  return found;
}

interface Places {
  /** Pastas da conta onde só um orquestrador põe worktrees, com e sem link resolvido. */
  roots: Array<{ tool: Tool; bases: string[] }>;
  crystal: boolean;
}

async function places(ctx: AiContext): Promise<Places> {
  const h = (relative: string) => join(ctx.home, relative);
  const fixed: Array<[Tool, string]> = [
    ['cursor', h('.cursor/worktrees')],
    ['codex', join(resolve(ctx.env.CODEX_HOME || h('.codex')), 'worktrees')],
    ['conductor', h('conductor/workspaces')],
    ['claude-squad', h('.claude-squad/worktrees')],
    ['vibe-kanban', join(ctx.tmp, 'vibe-kanban/worktrees')],
  ];
  // O git devolve o caminho resolvido (/private/var/folders…); o $TMPDIR vem sem ele (/var/folders…).
  const roots = await Promise.all(
    fixed.map(async ([tool, base]) => ({ tool, bases: [...new Set([base, await real(base)])] }))
  );
  // <projeto>/worktrees é o padrão do Crystal, mas também costume de quem cria worktree à mão:
  // só conta como do Crystal com os dados do app na conta.
  const crystal = !!(await lstat(ctx.env.CRYSTAL_DIR || h('.crystal')).catch(() => null));
  return { roots, crystal };
}

function toolOf(path: string, repo: Repo, where: Places): Tool | null {
  const parent = dirname(path);
  if (basename(parent) === 'worktrees' && basename(dirname(parent)) === '.claude') return 'claude-code';
  if (repo.root && parent === join(repo.root, 'worktrees') && where.crystal) return 'crystal';
  // Local antigo do Conductor, dentro do repositório.
  if (repo.root && parent === join(repo.root, '.conductor')) return 'conductor';
  // Vibe Kanban com a "Workspace Directory" escolhida pelo usuário.
  if (parent.split('/').includes('.vibe-kanban-workspaces')) return 'vibe-kanban';
  for (const { tool, bases } of where.roots) {
    if (bases.some((base) => path.startsWith(base + '/'))) return tool;
  }
  return null;
}

async function listWorktrees(ctx: AiContext, common: string): Promise<Worktree[] | null> {
  // -C no próprio .git funciona também em repositório bare.
  const result = await git(ctx, ['-C', common, 'worktree', 'list', '--porcelain', '-z']);
  return result.code === 0 ? parseWorktreeList(result.stdout) : null;
}

async function discover(ctx: AiContext): Promise<Discovered[]> {
  const where = await places(ctx);
  const fromProjects = await Promise.all(ctx.projects.map((project) => commonOfProject(ctx, project)));
  // Repositório que nenhuma sessão citou ainda aparece pela pasta do orquestrador.
  const links = (await Promise.all(where.roots.map(({ bases }) => linksUnder(bases[0], 2)))).flat();
  const fromLinks = await Promise.all(links.map((dir) => commonOfLink(ctx, dir)));
  const commons = new Set(
    [...fromProjects, ...fromLinks].filter((common): common is string => !!common && !isProtected(ctx, common))
  );

  // Sem nada em <common>/worktrees não há worktree ligada, e o git nem roda.
  const withLinked: string[] = [];
  for (const common of commons) {
    if ((await dirents(join(common, 'worktrees'))).length > 0) withLinked.push(common);
  }

  const found: Discovered[] = [];
  let listed = 0;
  await Promise.all(
    withLinked.map(async (common) => {
      const worktrees = await listWorktrees(ctx, common);
      if (!worktrees || worktrees.length === 0) return;
      listed++;
      const [main, ...linked] = worktrees;
      const root = main.bare ? null : main.path;
      const project = root ?? (basename(common) === '.git' ? dirname(common) : common);
      const repo: Repo = { common, root, project };
      for (const worktree of linked) {
        // Pasta ou .git sumidos: o git chama de prunable, e o que sobrou já não é worktree.
        if (worktree.prunable) continue;
        const tool = toolOf(worktree.path, repo, where);
        if (tool) found.push({ tool, repo, worktree, linked });
      }
    })
  );
  // Git que não roda em repositório nenhum é falha, não lista vazia.
  if (withLinked.length > 0 && listed === 0) throw new Error('git worktree list failed');
  return found;
}

function discovered(ctx: AiContext): Promise<Discovered[]> {
  const state = shared(ctx);
  state.discovered ??= discover(ctx);
  return state.discovered;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = JSON.parse(await readFile(path, 'utf8'));
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * A sessão dona de uma worktree de subagente ou de workflow tem o cwd na raiz do repositório,
 * então o cwd não basta: vale o que está guardado na pasta da sessão viva. Só nomes de arquivo
 * e o state.json dos jobs, nunca a conversa.
 */
async function findLive(ctx: AiContext): Promise<Live> {
  const live: Live = { cwds: [], agents: new Set(), runs: new Set(), worktrees: new Set() };
  const ids = new Set(ctx.claudeSessions.map((session) => session.sessionId));
  if (ids.size === 0) return live;
  for (const session of ctx.claudeSessions) live.cwds.push(session.cwd, await realOutside(ctx, session.cwd));

  const base = claudeDir(ctx);
  const projects = join(base, 'projects');
  const names = async (dir: string) => (await dirents(dir)).map((entry) => entry.name);
  for (const project of await dirents(projects)) {
    if (!project.isDirectory()) continue;
    for (const entry of await dirents(join(projects, project.name))) {
      if (!entry.isDirectory() || !ids.has(entry.name)) continue;
      const session = join(projects, project.name, entry.name);
      for (const name of await names(join(session, 'subagents'))) {
        const agent = /^(agent-[0-9a-z]+)\.(meta\.json|jsonl)$/.exec(name)?.[1];
        if (agent) live.agents.add(agent);
      }
      for (const name of await names(join(session, 'subagents/workflows'))) {
        if (name.startsWith('wf_')) live.runs.add(name);
      }
      for (const name of await names(join(session, 'workflows'))) {
        const run = /^(wf_.+)\.json$/.exec(name)?.[1];
        if (run) live.runs.add(run);
      }
    }
  }

  for (const job of await dirents(join(base, 'jobs'))) {
    if (!job.isDirectory()) continue;
    const state = await readJson(join(base, 'jobs', job.name, 'state.json'));
    if (typeof state?.worktreePath === 'string' && typeof state.sessionId === 'string' && ids.has(state.sessionId)) {
      live.worktrees.add(state.worktreePath);
      live.worktrees.add(await realOutside(ctx, state.worktreePath));
    }
  }
  return live;
}

function liveOf(ctx: AiContext): Promise<Live> {
  const state = shared(ctx);
  state.live ??= findLive(ctx);
  return state.live;
}

function ownedByLive(path: string, live: Live): boolean {
  if (live.cwds.some((cwd) => inside(cwd, path)) || live.worktrees.has(path)) return true;
  const name = basename(path);
  if (live.agents.has(name)) return true;
  const run = /^(wf_[0-9a-f]+-[0-9a-f]+)-\d+$/.exec(name)?.[1];
  return !!run && live.runs.has(run);
}

/** Lock com PID de processo vivo, ou sem PID: alguém ainda conta com a worktree. */
function lockState(ctx: AiContext, reason: string | null): 'none' | 'live' | 'stale' {
  if (reason === null) return 'none';
  const pid = /\bpid (\d+)/.exec(reason)?.[1];
  if (!pid) return 'live';
  const owner = ctx.processes.find((process) => process.pid === Number(pid));
  if (!owner) return 'stale';
  // PID reaproveitado: lock do Claude Code apontando para outro programa também é velho.
  if (/^claude session/.test(reason) && !/claude/i.test(`${owner.exe} ${owner.args}`)) return 'stale';
  return 'live';
}

/** O mesmo arquivo, byte a byte, no checkout principal. Link não conta: o alvo fica. */
async function keptInMain(file: string, original: string | null): Promise<boolean> {
  const own = await lstat(file).catch(() => null);
  if (!own || own.isSymbolicLink() || !own.isFile()) return true;
  if (!original) return false;
  const [mine, theirs] = await Promise.all([readFile(file).catch(() => null), readFile(original).catch(() => null)]);
  return !!mine && !!theirs && mine.equals(theirs);
}

/** Mudança, commit solto e segredo que só existe ali: o que se perderia de verdade. */
async function work(ctx: AiContext, worktree: Worktree, root: string | null): Promise<AiBlock | null> {
  const status = await git(ctx, [
    '-C',
    worktree.path,
    'status',
    '--porcelain',
    '-z',
    '--ignored=matching',
    '--untracked-files=normal',
  ]);
  // Sem status não dá para dizer que está limpa.
  if (status.code !== 0) return 'unverified';
  const { changed, ignored } = parseStatus(status.stdout);
  if (changed) return 'uncommitted';

  if (worktree.detached) {
    const loose = await git(ctx, ['-C', worktree.path, 'rev-list', '--max-count=1', 'HEAD', '--not', '--branches', '--tags', '--remotes']);
    if (loose.code !== 0 || loose.stdout.trim() !== '') return 'detached';
  }

  for (const relative of ignored) {
    // Pasta ignorada inteira (node_modules/, um venv chamado .env/) não é segredo copiado.
    if (relative.endsWith('/') || !SECRET.test(basename(relative))) continue;
    if (!(await keptInMain(join(worktree.path, relative), root && join(root, relative)))) return 'env-only';
  }
  return null;
}

/**
 * O que impede a remoção, na ordem do relatório: sessão viva, processo, lock vivo, trabalho.
 * Worktree aninhada (sessão aberta numa worktree que criou outra) iria junto para a Lixeira,
 * então é conferida também.
 */
async function inspect(ctx: AiContext, item: Discovered, now: boolean): Promise<Verdict> {
  const { worktree, repo, linked } = item;
  if (ownedByLive(worktree.path, await liveOf(ctx))) return { block: 'live-session', unlock: [] };
  if (now && ctx.inUse(worktree.path)) return { block: 'in-use', unlock: [] };
  const lock = lockState(ctx, worktree.locked);
  if (lock === 'live') return { block: 'locked', unlock: [] };
  const block = await work(ctx, worktree, repo.root);
  if (block) return { block, unlock: [] };

  const unlock = lock === 'stale' ? [worktree.path] : [];
  for (const nested of linked) {
    if (nested.prunable || !nested.path.startsWith(worktree.path + '/')) continue;
    const verdict = await inspect(ctx, { ...item, worktree: nested }, now);
    if (verdict.block) return verdict;
    unlock.push(...verdict.unlock);
  }
  return { block: null, unlock };
}

/** A worktree como o git a vê agora; nula se já não é uma worktree ligada do repositório. */
async function current(ctx: AiContext, item: Discovered): Promise<Discovered | null> {
  const worktrees = await listWorktrees(ctx, item.repo.common);
  const worktree = worktrees?.find((candidate) => candidate.path === item.worktree.path);
  if (!worktrees || !worktree || worktree.prunable) return null;
  return { ...item, worktree, linked: worktrees.slice(1) };
}

async function recheck(ctx: AiContext, item: Discovered): Promise<AiBlock | null> {
  const fresh = await current(ctx, item);
  // Não dá mais para conferir; na dúvida, fica.
  if (!fresh) return 'unverified';
  return (await inspect(ctx, fresh, true)).block;
}

/**
 * O prune leva o registro de toda worktree sumida, e com ele os commits que só o HEAD dela
 * segurava (uma worktree num disco externo desmontado, por exemplo). As outras sumidas ficam
 * trancadas enquanto ele roda.
 */
async function prune(ctx: AiContext, common: string, removed: string): Promise<void> {
  const worktrees = await listWorktrees(ctx, common);
  if (!worktrees) return;
  const others = worktrees
    .slice(1)
    .filter((worktree) => worktree.prunable && worktree.locked === null && !inside(worktree.path, removed));
  const guarded: string[] = [];
  try {
    for (const worktree of others) {
      if ((await git(ctx, ['-C', common, 'worktree', 'lock', '--reason', GUARD_REASON, worktree.path])).code !== 0) return;
      guarded.push(worktree.path);
    }
    await git(ctx, ['-C', common, 'worktree', 'prune']);
  } finally {
    for (const path of guarded) await git(ctx, ['-C', common, 'worktree', 'unlock', path]);
  }
}

async function removeWorktree(ctx: AiContext, item: Discovered): Promise<void> {
  const fresh = await current(ctx, item);
  if (!fresh) throw new Error('not a linked worktree anymore');
  const verdict = await inspect(ctx, fresh, true);
  if (verdict.block) throw new Error(verdict.block);
  for (const path of verdict.unlock) {
    if ((await git(ctx, ['-C', item.repo.common, 'worktree', 'unlock', path])).code !== 0) throw new Error('unlock failed');
  }
  await ctx.trash(fresh.worktree.path);
  // Já está na Lixeira: se o prune falhar, sobra só o registro, que o próximo prune leva.
  await prune(ctx, item.repo.common, fresh.worktree.path).catch(() => undefined);
}

/** O registro da worktree em <common>/worktrees/<id>, pelo arquivo .git dela. */
async function adminOf(path: string): Promise<string | null> {
  const text = await readFile(join(path, '.git'), 'utf8').catch(() => null);
  const gitdir = text && /^gitdir: (.+)$/m.exec(text)?.[1].trim();
  return gitdir ? resolve(path, gitdir) : null;
}

async function newest(paths: string[]): Promise<number> {
  const times = await Promise.all(paths.map((path) => stat(path).then((s) => s.mtimeMs, () => 0)));
  return Math.max(0, ...times);
}

/** A transcrição mais nova do Claude Code aberto dentro da worktree; o arquivo só cresce. */
async function transcriptTime(ctx: AiContext, path: string): Promise<number> {
  const dir = join(claudeDir(ctx), 'projects', encodeCwd(path));
  const files = (await dirents(dir)).filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'));
  return newest(files.map((entry) => join(dir, entry.name)));
}

function labelOf(worktree: Worktree): string {
  const name = basename(worktree.path);
  const branch = worktree.branch;
  // O Claude Code chama o branch de worktree-<nome>: repetir não diz nada.
  if (!branch || branch === name || branch === `worktree-${name}` || branch.length > 40) return name;
  return `${name} · ${branch}`;
}

async function toFound(ctx: AiContext, item: Discovered): Promise<Found | null> {
  const { worktree, repo, tool } = item;
  const admin = await adminOf(worktree.path);
  if (!admin) return null;
  const viaApp = tool === 'codex';

  const blockOf = async (): Promise<AiBlock | null> => {
    // O Codex grava um snapshot ao arquivar o chat; tirar por fora perde isso.
    if (viaApp) return ownedByLive(worktree.path, await liveOf(ctx)) ? 'live-session' : 'via-app';
    // Processo trabalhando ali: o scanner marca 'in-use', e o status nem precisa rodar.
    if (ctx.inUse(worktree.path)) return null;
    return (await inspect(ctx, item, false)).block;
  };

  const [size, used, transcript, blocked] = await Promise.all([
    shared(ctx).limit(() => ctx.du(worktree.path)),
    newest(ACTIVITY.map((file) => join(admin, file))),
    transcriptTime(ctx, worktree.path),
    blockOf(),
  ]);
  if (size <= 0) return null;

  const lastUsed = Math.max(used, transcript);
  const found: Found = {
    tool,
    kind: 'worktree',
    label: labelOf(worktree),
    project: repo.project,
    path: worktree.path,
    size,
    count: 1,
    lastUsed,
    confidence: lastUsed > 0 ? 'high' : 'low',
    safety: 'moderate',
    removal: viaApp ? 'none' : 'git',
  };
  if (blocked) found.blocked = blocked;
  if (!viaApp) {
    found.hint = 'branch-kept';
    found.recheck = (fresh) => recheck(fresh, item);
    found.remove = (fresh) => removeWorktree(fresh, item);
  }
  return found;
}

/** Um coletor por orquestrador, para o erro de um não esconder os outros. */
export const worktreeCollectors: Collector[] = TOOLS.map((tool) => ({
  id: tool,
  async collect(ctx: AiContext): Promise<Found[]> {
    const mine = (await discovered(ctx)).filter((item) => item.tool === tool);
    const items = await Promise.all(mine.map((item) => toFound(ctx, item)));
    return items.filter((item): item is Found => item !== null);
  },
}));
