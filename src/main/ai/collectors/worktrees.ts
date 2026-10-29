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
 * depois de conferir que não há trabalho ali: mudança não commitada, commit que só ela segura
 * (HEAD destacado, reflog, refs dela), submódulo, segredo ou render ignorados que só existem nela,
 * lock de processo vivo ou sessão aberta.
 */

type Tool = Extract<AiToolId, 'claude-code' | 'cursor' | 'codex' | 'conductor' | 'claude-squad' | 'vibe-kanban' | 'crystal'>;

const TOOLS: readonly Tool[] = ['claude-code', 'cursor', 'codex', 'conductor', 'claude-squad', 'vibe-kanban', 'crystal'];

/** Comandos git e `du` ao mesmo tempo, somando todos os orquestradores: são dezenas de worktrees com node_modules. */
const CONCURRENCY = 4;
const GIT_TIMEOUT_MS = 60_000;
/**
 * Sem GIT_OPTIONAL_LOCKS um `git status` reescreve o index, e a análise esquentaria a worktree que
 * olha. LC_ALL: a saída do `prune --dry-run` é lida, e precisa vir em inglês.
 */
const GIT_ENV = { GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
/** O que o git escreve em `<common>/worktrees/<id>` quando a worktree é usada. O mtime da pasta não acompanha. */
const ACTIVITY = ['index', 'logs/HEAD', 'HEAD', 'COMMIT_EDITMSG', 'FETCH_HEAD', 'ORIG_HEAD'];
/**
 * Ignorados que costumam ser segredo: o `worktree remove` os apagaria sem avisar. Chave e
 * certificado com chave, perfil de assinatura, credencial de nuvem e de registro de pacotes,
 * configuração local do Android, .NET e Firebase, estado do Terraform.
 */
const SECRET = [
  /^\.env/,
  /\.(pem|key|p8|p12|pfx|jks|keystore|mobileprovision|provisionprofile|ppk|kdbx|gpg|tfvars|tfstate(\.backup)?)$/i,
  /^\.?(credentials|secrets?)([._-]|$)/i,
  /^(key|keystore|signing|local)\.properties$/,
  /^(google-services\.json|GoogleService-Info\.plist|\.npmrc|\.pypirc|\.netrc|\.dev\.vars)$/,
  /^appsettings(\..+)?\.json$/i,
  /^service-?account.*\.json$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)$/,
];
/** Pasta cujo nome já diz que tudo o que está dentro é segredo (além das que casam com SECRET, como `.env/`). */
const SECRET_DIR = /^(env|certs?|keys|private|\.ssh|\.aws|\.gnupg)$/i;
/**
 * Pastas que o build ou o gerenciador de pacotes recria: ignoradas inteiras, não guardam nada da
 * pessoa. `out` fica de fora de propósito: é onde o Remotion grava o render.
 */
const REGENERABLE = new Set([
  'node_modules', 'bower_components', 'jspm_packages', '.pnpm-store', '.yarn', 'vendor', 'deps',
  '.build', 'build', '_build', 'dist', 'bin', 'obj', 'target', 'DerivedData', 'Pods', 'Carthage',
  '.next', '.nuxt', '.output', '.svelte-kit', '.turbo', '.parcel-cache', '.vite', '.angular', '.expo', '.nx',
  '.docusaurus', '.astro', '.serverless', 'storybook-static',
  '.gradle', '.cxx', '.externalNativeBuild', '.kotlin', '.dart_tool', '.swiftpm',
  'venv', '.venv', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.nox', '.hypothesis',
  'coverage', '.nyc_output', 'htmlcov', '.cache',
]);
/** Onde as ferramentas põem o que a pessoa pediu (imagem gerada, render, plano): é trabalho, mesmo ignorado. */
const WORK_DIRS = new Set(['generated_images', 'saida', 'renders', 'plans']);
/** Vídeo e áudio num ignorado são saída de render, não de build. */
const MEDIA = /\.(mp4|m4v|mov|webm|mkv|avi|wav|mp3|m4a|aac|flac|ogg|aiff?)$/i;
/** Quanto se olha dentro das pastas ignoradas que não se recriam; passou disso, não dá para dizer que estão livres. */
const IGNORED_DEPTH = 8;
const IGNORED_LIMIT = 5_000;
/** Commits por `rev-list`: milhares na linha de comando passariam do limite do macOS. */
const REVS_PER_CALL = 1_000;
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
/**
 * O motivo do lock que tranca as outras worktrees sumidas durante o prune. Se o app fecha no meio
 * ou o unlock falha, o lock fica: é pelo motivo que a análise sabe que ninguém conta com ele e que
 * o próximo prune o solta.
 */
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
  /** As worktrees conferidas e os registros delas (`<common>/worktrees/<id>`): só eles o prune pode levar. */
  checked: Array<{ path: string; admin: string }>;
}

const blockedBy = (block: AiBlock): Verdict => ({ block, unlock: [], checked: [] });

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
/** Como `dirents`, mas nulo quando a pasta existe e não deu para ler. */
const listDir = (dir: string) =>
  readdir(dir, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => (error.code === 'ENOENT' ? [] : null));
const exists = async (path: string) => !!(await lstat(path).catch(() => null));
const hasContent = async (path: string) => ((await stat(path).catch(() => null))?.size ?? 0) > 0;
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

/** O mesmo teste do coletor do Claude Code: PID vivo de um processo do claude. */
const claudeAlive = (ctx: AiContext, pid: unknown) =>
  typeof pid === 'number' && ctx.processes.some((p) => p.pid === pid && /claude/i.test(`${p.exe} ${p.args}`));

/**
 * A sessão dona de uma worktree de subagente ou de workflow tem o cwd na raiz do repositório,
 * então o cwd não basta: vale o que está guardado na pasta da sessão viva. Só nomes de arquivo,
 * o state.json dos jobs e o roster do supervisor, nunca a conversa.
 */
async function findLive(ctx: AiContext): Promise<Live> {
  const live: Live = { cwds: [], agents: new Set(), runs: new Set(), worktrees: new Set() };
  const ids = new Set(ctx.claudeSessions.map((session) => session.sessionId));
  for (const session of ctx.claudeSessions) live.cwds.push(session.cwd, await realOutside(ctx, session.cwd));

  const base = claudeDir(ctx);
  const projects = join(base, 'projects');
  const names = async (dir: string) => (await dirents(dir)).map((entry) => entry.name);
  // Sem sessão aberta não há pasta de sessão viva para ler; os jobs, abaixo, ainda podem estar vivos.
  for (const project of ids.size > 0 ? await dirents(projects) : []) {
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

  // A regra do coletor do Claude Code para os jobs: o campo `state` mente, então o job está vivo
  // pela sessão (a primeira ou a retomada) ou pelo supervisor vivo que ainda o roda. O job do
  // supervisor não aparece em ~/.claude/sessions, e o PID do lock da worktree é de um worker que
  // pode já ter saído.
  const roster = await readJson(join(base, 'daemon', 'roster.json'));
  const supervisor = claudeAlive(ctx, roster?.supervisorPid);
  const workers = JSON.stringify(roster?.workers ?? null);
  for (const job of await dirents(join(base, 'jobs'))) {
    if (!job.isDirectory()) continue;
    const state = await readJson(join(base, 'jobs', job.name, 'state.json'));
    if (typeof state?.worktreePath !== 'string') continue;
    const own = [state.sessionId, state.resumeSessionId].filter((id): id is string => typeof id === 'string' && id !== '');
    const running = own.some((id) => ids.has(id)) || (supervisor && (workers.includes(job.name) || state.state !== 'done'));
    if (!running) continue;
    live.worktrees.add(state.worktreePath);
    live.worktrees.add(await realOutside(ctx, state.worktreePath));
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
  // O lock de guarda do próprio app, que sobrou de um prune interrompido.
  if (reason === GUARD_REASON) return 'stale';
  const pid = /\bpid (\d+)/.exec(reason)?.[1];
  if (!pid) return 'live';
  // PID que não aparece numa lista de processos incompleta não quer dizer processo morto.
  if (!ctx.processesKnown) return 'live';
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

/**
 * Submódulo baixado na worktree guarda o repositório dele em `<admin>/modules`, que não vai para a
 * Lixeira: o prune o apagaria de vez, com os commits que só ele tem. O próprio git não remove
 * worktree assim ("working trees containing submodules cannot be moved or removed"), e a regra é
 * a dele: pasta modules no registro, ou submódulo do .gitmodules com checkout na worktree.
 */
async function submodules(ctx: AiContext, path: string, admin: string): Promise<AiBlock | null> {
  if (await exists(join(admin, 'modules'))) return 'submodule';
  if (!(await exists(join(path, '.gitmodules')))) return null;
  const declared = await git(ctx, ['-C', path, 'config', '--file', '.gitmodules', '--null', '--get-regexp', '^submodule\\..*\\.path$']);
  // 1: nenhum submódulo declarado.
  if (declared.code === 1) return null;
  if (declared.code !== 0) return 'unverified';
  for (const entry of declared.stdout.split('\0')) {
    const newline = entry.indexOf('\n');
    if (newline < 0) continue;
    const dir = resolve(path, entry.slice(newline + 1));
    // Caminho que sai da worktree não é submódulo que o git aceite: na dúvida, fica.
    if (!inside(dir, path) || dir === path || (await exists(join(dir, '.git')))) return 'submodule';
  }
  return null;
}

/**
 * Commits que só o registro da worktree segura: o HEAD destacado, o reflog do HEAD dela (o agente
 * commitou destacado e depois fez checkout em outro lugar) e as refs que são só dela
 * (refs/worktree, refs/bisect, refs/rewritten). O prune apaga tudo isso e o commit some no próximo
 * gc. Guardado é o que algum branch, tag, remoto, stash ou reflog do repositório alcança, visto do
 * common dir com --single-worktree, para o reflog da própria worktree não contar.
 */
async function looseCommits(ctx: AiContext, path: string, common: string, admin: string): Promise<AiBlock | null> {
  const head = await git(ctx, ['-C', path, 'rev-parse', '--verify', '-q', 'HEAD']);
  // 1: branch ainda sem commit nenhum.
  if (head.code !== 0 && head.code !== 1) return 'unverified';
  const [reflog, refs] = await Promise.all([
    git(ctx, ['-C', path, 'log', '-g', '--format=%H', 'HEAD']),
    git(ctx, ['-C', path, 'for-each-ref', '--format=%(objectname)', 'refs/worktree/', 'refs/bisect/', 'refs/rewritten/']),
  ]);
  if (refs.code !== 0) return 'unverified';
  // Com o HEAD sem commit o git não lê o reflog dele; só preocupa se houver reflog para ler.
  if (reflog.code !== 0 && (head.code === 0 || (await hasContent(join(admin, 'logs/HEAD'))))) return 'unverified';

  const lines = [head.stdout, reflog.code === 0 ? reflog.stdout : '', refs.stdout].join('\n').split('\n');
  const commits = [...new Set(lines.map((line) => line.trim()).filter((line) => /^[0-9a-f]{40,64}$/.test(line)))];
  for (let i = 0; i < commits.length; i += REVS_PER_CALL) {
    const loose = await git(ctx, [
      '-C',
      common,
      'rev-list',
      '--max-count=1',
      ...commits.slice(i, i + REVS_PER_CALL),
      '--not',
      '--single-worktree',
      '--all',
      '--reflog',
    ]);
    if (loose.code !== 0) return 'unverified';
    if (loose.stdout.trim() !== '') return 'detached';
  }
  return null;
}

/** O caminho é de segredo, ou passa por uma pasta de segredos. */
const secretPath = (relative: string) =>
  relative.split('/').some((part) => SECRET.some((pattern) => pattern.test(part)) || SECRET_DIR.test(part));

/** O que se perderia com um arquivo ignorado: segredo, trabalho, ou nada que não se recrie. */
function lossOf(relative: string): 'env-only' | 'ignored-work' | null {
  const name = basename(relative);
  // Metadado do Finder em qualquer pasta, nunca igual ao do checkout principal.
  if (name === '.DS_Store') return null;
  if (secretPath(relative)) return 'env-only';
  if (relative.split('/').some((part) => WORK_DIRS.has(part)) || MEDIA.test(name)) return 'ignored-work';
  return null;
}

async function ignoredFile(path: string, root: string | null, relative: string): Promise<AiBlock | null> {
  const loss = lossOf(relative);
  if (!loss) return null;
  return (await keptInMain(join(path, relative), root && join(root, relative))) ? null : loss;
}

/**
 * Pasta ignorada inteira: o status mostra só `pasta/`, e a chave ou o render podem estar lá
 * dentro. Só as que se recriam passam sem olhar; as outras são lidas até IGNORED_DEPTH níveis e
 * IGNORED_LIMIT entradas (somadas na worktree toda).
 */
async function ignoredDir(path: string, root: string | null, top: string, nested: readonly string[], budget: { left: number }): Promise<AiBlock | null> {
  const stack = [{ relative: top, depth: 1 }];
  while (stack.length > 0) {
    const { relative, depth } = stack.pop()!;
    const name = basename(relative);
    // Dentro de uma pasta de segredos (certs/bin, .env/bin) nada é "build".
    if ((REGENERABLE.has(name) || name.endsWith('.egg-info')) && !secretPath(relative)) continue;
    const dir = join(path, relative);
    // Worktree aninhada do mesmo repositório tem a conferência dela, em inspect.
    if (nested.includes(dir)) continue;
    const entries = await listDir(dir);
    if (!entries) return 'unverified';
    // venv e cache marcado se recriam, seja qual for o nome da pasta (um venv chamado .env/).
    if (entries.some((entry) => entry.name === 'pyvenv.cfg' || entry.name === 'CACHEDIR.TAG')) continue;
    // Outro repositório ali dentro tem commits e mudanças que ninguém conferiu.
    // Esses três não passam numa nova análise: são a worktree, não um tropeço da leitura.
    if (entries.some((entry) => entry.name === '.git')) return 'ignored-work';
    if (entries.length > 0 && depth > IGNORED_DEPTH) return 'ignored-work';
    budget.left -= entries.length;
    if (budget.left < 0) return 'ignored-work';
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) stack.push({ relative: child, depth: depth + 1 });
      else if (entry.isFile()) {
        const loss = await ignoredFile(path, root, child);
        if (loss) return loss;
      }
    }
  }
  return null;
}

/**
 * Submódulo, mudança, commit que só ela segura e o que o .gitignore esconde (segredo, render) que
 * só existe ali: o que se perderia de verdade.
 */
async function work(ctx: AiContext, worktree: Worktree, repo: Repo, admin: string, nested: readonly string[]): Promise<AiBlock | null> {
  const submodule = await submodules(ctx, worktree.path, admin);
  if (submodule) return submodule;

  // --ignore-submodules=none: a configuração do repositório e a global não escondem submódulo sujo.
  const status = await git(ctx, [
    '-C',
    worktree.path,
    'status',
    '--porcelain',
    '-z',
    '--ignored=matching',
    '--untracked-files=normal',
    '--ignore-submodules=none',
  ]);
  // Sem status não dá para dizer que está limpa.
  if (status.code !== 0) return 'unverified';
  const { changed, ignored } = parseStatus(status.stdout);
  if (changed) return 'uncommitted';

  const loose = await looseCommits(ctx, worktree.path, repo.common, admin);
  if (loose) return loose;

  const budget = { left: IGNORED_LIMIT };
  for (const relative of ignored) {
    const loss = relative.endsWith('/')
      ? await ignoredDir(worktree.path, repo.root, relative.slice(0, -1), nested, budget)
      : await ignoredFile(worktree.path, repo.root, relative);
    if (loss) return loss;
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
  if (ownedByLive(worktree.path, await liveOf(ctx))) return blockedBy('live-session');
  if (now && ctx.inUse(worktree.path)) return blockedBy('in-use');
  const lock = lockState(ctx, worktree.locked);
  if (lock === 'live') return blockedBy('locked');
  const admin = await adminOf(worktree.path);
  if (!admin) return blockedBy('unverified');
  const nested = linked.filter((other) => !other.prunable && other.path.startsWith(worktree.path + '/'));
  const block = await work(ctx, worktree, repo, admin, nested.map((other) => other.path));
  if (block) return blockedBy(block);

  const verdict: Verdict = { block: null, unlock: lock === 'stale' ? [worktree.path] : [], checked: [{ path: worktree.path, admin }] };
  for (const other of nested) {
    const inner = await inspect(ctx, { ...item, worktree: other }, now);
    if (inner.block) return inner;
    verdict.unlock.push(...inner.unlock);
    verdict.checked.push(...inner.checked);
  }
  return verdict;
}

/** A worktree como o git a vê agora; nula se já não é uma worktree ligada do repositório. */
async function current(ctx: AiContext, item: Discovered): Promise<Discovered | null> {
  const worktrees = await listWorktrees(ctx, item.repo.common);
  const worktree = worktrees?.find((candidate) => candidate.path === item.worktree.path);
  if (!worktrees || !worktree || worktree.prunable) return null;
  return { ...item, worktree, linked: worktrees.slice(1) };
}

async function recheck(ctx: AiContext, item: Discovered): Promise<AiBlock | null> {
  // Sem a lista de processos não se sabe se o dono do lock ou a sessão ainda rodam.
  if (!ctx.processesKnown) return 'unverified';
  const fresh = await current(ctx, item);
  // Não dá mais para conferir; na dúvida, fica.
  if (!fresh) return 'unverified';
  return (await inspect(ctx, fresh, true)).block;
}

/** Os ids em `<common>/worktrees` dos registros conferidos; registro em outro lugar não entra. */
async function adminIds(common: string, admins: readonly string[]): Promise<Set<string>> {
  const place = await real(join(common, 'worktrees'));
  const ids = new Set<string>();
  for (const admin of admins) {
    if ((await real(dirname(admin))) === place) ids.add(basename(admin));
  }
  return ids;
}

/**
 * O prune leva o registro de toda worktree sumida, e com ele o que só o registro guarda: o HEAD
 * destacado, o reflog e as refs dela, o repositório dos submódulos (de uma worktree num disco
 * externo desmontado, por exemplo). As outras sumidas ficam trancadas enquanto ele roda, e antes
 * ele roda de mentira: só vai de verdade se tudo o que levaria são os registros das worktrees que
 * acabaram de ser conferidas. O que o lock não alcança (um registro sem o arquivo gitdir, que o
 * `worktree list` nem mostra) aparece ali, e então nada sai: fica o registro desta, que o próximo
 * prune leva.
 */
async function prune(ctx: AiContext, common: string, checked: Verdict['checked']): Promise<void> {
  const worktrees = await listWorktrees(ctx, common);
  if (!worktrees) return;
  const allowed = await adminIds(common, checked.map((entry) => entry.admin));
  const mine = new Set(checked.map((entry) => entry.path));
  const guarded: string[] = [];
  try {
    for (const worktree of worktrees.slice(1)) {
      if (mine.has(worktree.path)) continue;
      // Guarda que sobrou de uma rodada interrompida: protege esta também e sai no fim.
      if (worktree.locked === GUARD_REASON) guarded.push(worktree.path);
      if (!worktree.prunable || worktree.locked !== null) continue;
      if ((await git(ctx, ['-C', common, 'worktree', 'lock', '--reason', GUARD_REASON, worktree.path])).code !== 0) return;
      guarded.push(worktree.path);
    }
    const dry = await git(ctx, ['-C', common, 'worktree', 'prune', '--dry-run', '--verbose']);
    if (dry.code !== 0) return;
    const ids = [...`${dry.stdout}\n${dry.stderr}`.matchAll(/^Removing worktrees\/([^:\n]+): /gm)].map((match) => match[1]);
    if (ids.length === 0 || ids.some((id) => !allowed.has(id))) return;
    // O repositório de um submódulo mora no registro: se apareceu um desde a conferência, nada sai.
    for (const id of ids) {
      if (await exists(join(common, 'worktrees', id, 'modules'))) return;
    }
    await git(ctx, ['-C', common, 'worktree', 'prune']);
  } finally {
    // Se um unlock falhar ou o app fechar antes, o motivo GUARD_REASON faz a próxima rodada soltá-lo.
    for (const path of guarded) await git(ctx, ['-C', common, 'worktree', 'unlock', path]);
  }
}

async function removeWorktree(ctx: AiContext, item: Discovered): Promise<void> {
  if (!ctx.processesKnown) throw new Error('unverified');
  const fresh = await current(ctx, item);
  if (!fresh) throw new Error('not a linked worktree anymore');
  const verdict = await inspect(ctx, fresh, true);
  if (verdict.block) throw new Error(verdict.block);
  // Aninhada dentro de aninhada é conferida duas vezes: destrancar duas vezes daria erro.
  for (const path of new Set(verdict.unlock)) {
    if ((await git(ctx, ['-C', item.repo.common, 'worktree', 'unlock', path])).code !== 0) throw new Error('unlock failed');
  }
  await ctx.trash(fresh.worktree.path);
  // Já está na Lixeira: se o prune falhar, sobra só o registro, que o próximo prune leva.
  await prune(ctx, item.repo.common, verdict.checked).catch(() => undefined);
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
