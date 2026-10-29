import { createHash } from 'node:crypto';
import { lstat, open, readFile, readdir, readlink, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { AiBlock } from '../../../shared/api';
import type { AiContext, Collector, Found, ProcessInfo } from '../types';

/**
 * OpenAI (Codex, ChatGPT) e Google (Gemini CLI, Antigravity).
 *
 * O Codex da CLI, do app, da extensão de IDE e do JetBrains escreve num ~/.codex só e
 * nunca apaga conversa: só comprime as frias para .jsonl.zst. O ChatGPT novo é o próprio
 * app do Codex (com.openai.codex). A ~/.gemini é dividida entre a Gemini CLI e o
 * Antigravity, então nunca sai inteira: sai o que é de cada sessão.
 */

/** O cabeçalho de uma conversa cabe aqui; o resto dela fica sem ler. */
const HEAD_BYTES = 64 * 1024;

/** O app ChatGPT novo (que é o app do Codex), os ajudantes dele e o computer-use. */
const CODEX_APP = /\/(?:ChatGPT|Codex)[^/]*\.app\/Contents\//;
/** Tudo o que escreve no ~/.codex: o app, a CLI, o binário da extensão de IDE e o do JetBrains. */
const CODEX_ANY = /\/(?:ChatGPT|Codex)[^/]*\.app\/Contents\/|(?:^|\/)codex(?:-[\w.-]+)?$/;
/** O ChatGPT antigo (com.openai.chat), que o app novo deixou oculto ao assumir o nome. */
const CHATGPT_CLASSIC = /\/\.?ChatGPT[^/]*\.app\/Contents\//;
/** O language server roda de dentro do pacote; a CLI do Antigravity 2.0 é o `agy`. */
const ANTIGRAVITY = /\/Antigravity[^/]*\.app\/|(?:^|\/)agy$/;
/** A Gemini CLI roda no Node: quem a denuncia são os argumentos, não o executável. */
const GEMINI_CLI = /(?:^|[\s/])gemini(?:\.js)?(?:\s|$)|@google\/gemini-cli\b/;
/** Seguir um link para cá abriria pedido de autorização na tela. */
const PROTECTED = /\/Library\/(?:Group Containers|Containers|CloudStorage|Mail|Messages|Safari)(?:\/|$)/;

/** Id de sessão ou nome de pasta que dá para juntar a um caminho sem sair dele. */
const SAFE_NAME = /^(?!\.\.?$)[\w.-]+$/;

const list = (dir: string) => readdir(dir, { withFileTypes: true }).catch(() => []);
const statOf = (path: string) => lstat(path).catch(() => null);
const mtimeOf = async (path: string) => (await statOf(path))?.mtimeMs ?? 0;

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

async function head(path: string, bytes = HEAD_BYTES): Promise<string> {
  const handle = await open(path, 'r').catch(() => null);
  if (!handle) return '';
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Arquivos com o nome no padrão até `depth` pastas abaixo de `dir`. */
async function findFiles(dir: string, name: RegExp, depth: number): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await list(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && depth > 0) found.push(...(await findFiles(path, name, depth - 1)));
    else if (entry.isFile() && name.test(entry.name)) found.push(path);
  }
  return found;
}

/** Soma o que existe entre os caminhos; o que não existe fica de fora da lista. */
async function measureAll(ctx: AiContext, candidates: readonly string[]) {
  const total = { paths: [] as string[], size: 0, newest: 0, files: 0 };
  for (const path of candidates) {
    if (!(await statOf(path))) continue;
    const measured = await ctx.measure(path);
    total.paths.push(path);
    total.size += measured.size;
    total.newest = Math.max(total.newest, measured.newest);
    total.files += measured.files;
  }
  return total;
}

/** Só sai com o app fechado: bloqueia agora e confere de novo logo antes de remover. */
function whileClosed(ctx: AiContext, app: RegExp): Pick<Found, 'blocked' | 'recheck'> {
  const recheck = async (now: AiContext): Promise<AiBlock | null> => (now.running(app) ? 'app-open' : null);
  return ctx.running(app) ? { blocked: 'app-open', recheck } : { recheck };
}

interface Session {
  project: string | null;
  /** O arquivo da conversa: é o que o Finder mostra e o que acusa uso depois da análise. */
  file: string;
  /** A conversa e o que sai junto com ela. */
  paths: string[];
  size: number;
  lastUsed: number;
  live?: boolean;
}

interface SessionGroup {
  key: 'cold' | 'hot' | 'live';
  project: string | null;
  /** A conversa mais nova do grupo. */
  path: string;
  files: string[];
  paths: string[];
  size: number;
  count: number;
  lastUsed: number;
}

/** Um grupo por projeto e por calor; a sessão viva fica à parte. */
function groupSessions(ctx: AiContext, sessions: readonly Session[]): SessionGroup[] {
  const groups = new Map<string, SessionGroup>();
  for (const session of sessions) {
    if (session.size <= 0) continue;
    const key = session.live ? 'live' : ctx.isCold(session.lastUsed) ? 'cold' : 'hot';
    const id = `${key}\n${session.project ?? ''}`;
    const group = groups.get(id) ?? { key, project: session.project, path: session.file, files: [], paths: [], size: 0, count: 0, lastUsed: 0 };
    group.files.push(session.file);
    group.paths.push(...session.paths);
    group.size += session.size;
    group.count++;
    if (session.lastUsed >= group.lastUsed) {
      group.lastUsed = session.lastUsed;
      group.path = session.file;
    }
    groups.set(id, group);
  }
  return [...groups.values()];
}

/** Alguma conversa foi escrita depois da análise: voltou a ser usada. */
async function touchedSince(files: readonly string[], since: number): Promise<boolean> {
  for (const file of files) if ((await mtimeOf(file)) > since) return true;
  return false;
}

// ---------------------------------------------------------------- Codex

const codexHome = (ctx: AiContext) => ctx.env.CODEX_HOME || join(ctx.home, '.codex');

/** rollout-<data de criação>-<id da thread>.jsonl, ou .jsonl.zst depois de comprimido. */
const ROLLOUT = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/;
/** Qualquer arquivo de uma thread, até o .zst.tmp de uma compressão em andamento. */
const ROLLOUT_ANY = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl/;

/** Componentes que o Chromium do app baixa sozinho e caches de GPU; os perfis ficam. */
const CODEX_BROWSER_CACHES = [
  'component_crx_cache',
  'WasmTtsEngine',
  'WidevineCdm',
  'OnDeviceHeadSuggestModel',
  'OptimizationHints',
  'CertificateRevocation',
  'GraphiteDawnCache',
  'GPUPersistentCache',
  'Crashpad',
  'BrowserMetrics-spare.pma',
  'Default/GPUCache',
  'Default/DawnGraphiteCache',
  'Default/DawnWebGPUCache',
];

/**
 * O cwd da primeira linha (session_meta) de uma conversa. O .zst só se lê descomprimindo, e o
 * Node do app não traz zstd: fica sem projeto.
 */
async function codexCwd(path: string): Promise<string | null> {
  if (!path.endsWith('.jsonl')) return null;
  const first = (await head(path)).split('\n', 1)[0];
  let cwd: unknown = null;
  try {
    const record: unknown = JSON.parse(first);
    if (isRecord(record) && record.type === 'session_meta' && isRecord(record.payload)) cwd = record.payload.cwd;
  } catch {
    // Linha maior que o pedaço lido: o cwd vem logo no começo do payload.
    const match = /"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(first);
    if (match && first.includes('"session_meta"')) {
      try {
        cwd = JSON.parse(match[1]);
      } catch {
        cwd = null;
      }
    }
  }
  return typeof cwd === 'string' && cwd.startsWith('/') ? cwd : null;
}

async function codexSessions(ctx: AiContext, root: string): Promise<Found[]> {
  const files = [
    ...(await findFiles(join(root, 'sessions'), ROLLOUT_ANY, 3)),
    ...(await findFiles(join(root, 'archived_sessions'), ROLLOUT_ANY, 0)),
  ];
  const images = join(root, 'generated_images');
  const snapshotsDir = join(root, 'shell_snapshots');
  const snapshots = (await list(snapshotsDir)).filter((entry) => entry.isFile()).map((entry) => entry.name);

  // A thread existe enquanto houver qualquer arquivo dela: as imagens de uma conversa sendo
  // comprimida não são órfãs.
  const threads = new Set(files.map((file) => ROLLOUT_ANY.exec(basename(file))?.[1] ?? ''));
  const sessions: Session[] = [];
  // Conversas que geraram imagens: o aviso muda, porque elas podem ser a única cópia.
  const withImages = new Set<string>();
  for (const file of files) {
    const thread = ROLLOUT.exec(basename(file))?.[1];
    if (!thread) continue;
    // Imagens e snapshot do shell são da thread: saem com ela, como o Codex faria.
    const own = await measureAll(ctx, [
      file,
      join(images, thread),
      ...snapshots.filter((name) => name.startsWith(`${thread}.`)).map((name) => join(snapshotsDir, name)),
    ]);
    sessions.push({ project: await codexCwd(file), file, paths: own.paths, size: own.size, lastUsed: own.newest });
    if (own.paths.includes(join(images, thread))) withImages.add(file);
  }

  const appOpen = ctx.running(CODEX_ANY);
  const found = groupSessions(ctx, sessions).map(
    (group): Found => ({
      tool: 'codex',
      kind: 'sessions',
      label: group.project ? basename(group.project) : 'sessions',
      project: group.project,
      path: group.path,
      key: group.key,
      paths: group.paths,
      size: group.size,
      count: group.count,
      lastUsed: group.lastUsed,
      safety: 'moderate',
      removal: 'trash',
      hint: group.files.some((file) => withImages.has(file)) ? 'generated-images' : 'archive-first',
      ...(appOpen ? { blocked: 'app-open' as const } : {}),
      // Com o app aberto, o índice (state_5.sqlite) aponta para a conversa que sumiu.
      recheck: async (now) => (now.running(CODEX_ANY) ? 'app-open' : (await touchedSince(group.files, group.lastUsed)) ? 'in-use' : null),
    })
  );

  // Imagens de uma conversa que já saiu: podem ser a única cópia, então não são lixo.
  const orphans = (await list(images)).filter((entry) => entry.isDirectory() && !threads.has(entry.name)).map((entry) => join(images, entry.name));
  const left = await measureAll(ctx, orphans);
  if (left.size > 0) {
    found.push({
      tool: 'codex',
      kind: 'sessions',
      label: 'generated_images',
      project: null,
      path: images,
      paths: left.paths,
      size: left.size,
      count: left.paths.length,
      lastUsed: left.newest,
      safety: 'moderate',
      removal: 'trash',
      hint: 'generated-images',
      ...whileClosed(ctx, CODEX_ANY),
    });
  }
  return found;
}

/** Algum link da pasta ainda leva a um binário que existe. */
async function anyLinkAlive(dir: string): Promise<boolean> {
  for (const entry of await list(dir)) {
    if (!entry.isSymbolicLink()) continue;
    const target = resolve(dir, await readlink(join(dir, entry.name)).catch(() => ''));
    if (PROTECTED.test(target) || (await stat(target).catch(() => null))) return true;
  }
  return false;
}

/** Sobras que nenhuma rotina do Codex limpa e que ele recria quando precisa. */
async function codexLeftovers(ctx: AiContext, root: string): Promise<Found[]> {
  const base = { tool: 'codex', project: null, safety: 'safe', removal: 'trash', ...whileClosed(ctx, CODEX_ANY) } as const;
  const found: Found[] = [];
  const tmp = join(root, '.tmp');

  for (const entry of await list(tmp)) {
    if (!entry.isDirectory() || !entry.name.startsWith('plugins-backup-')) continue;
    // Cópia antiga do marketplace que uma troca interrompida deixou para trás.
    const path = join(tmp, entry.name);
    const measured = await ctx.measure(path);
    found.push({ ...base, kind: 'temp', label: entry.name, path, size: measured.size, count: measured.files, lastUsed: await mtimeOf(path), junk: 'orphan' });
  }

  const clone = join(tmp, 'plugins');
  if ((await statOf(clone))?.isDirectory()) {
    // Sem .git o Codex clona de novo; o plugins.sha marca a última sincronização.
    const measured = await ctx.measure(clone);
    const synced = await mtimeOf(join(tmp, 'plugins.sha'));
    found.push({ ...base, kind: 'cache', label: '.tmp/plugins', path: clone, size: measured.size, count: measured.files, lastUsed: synced || measured.newest });
  }

  const cache = join(root, 'cache');
  const catalog = await ctx.measure(cache);
  found.push({ ...base, kind: 'cache', label: 'cache', path: cache, size: catalog.size, count: catalog.files, lastUsed: catalog.newest });

  // A raiz antiga do truque arg0: o janitor de hoje só limpa tmp/arg0, e estas ficam para sempre.
  const legacy = join(root, 'tmp/path');
  const dead: string[] = [];
  const linked: string[] = [];
  for (const entry of await list(legacy)) {
    if (!entry.isDirectory() || !entry.name.startsWith('codex-arg0')) continue;
    const dir = join(legacy, entry.name);
    ((await anyLinkAlive(dir)) ? linked : dead).push(dir);
  }
  for (const [dirs, key] of [
    [dead, 'orphan'],
    [linked, 'linked'],
  ] as const) {
    const total = await measureAll(ctx, dirs);
    if (total.size <= 0) continue;
    let newest = 0;
    for (const dir of total.paths) newest = Math.max(newest, await mtimeOf(dir));
    found.push({
      ...base,
      kind: 'temp',
      label: 'tmp/path',
      path: legacy,
      key,
      paths: total.paths,
      size: total.size,
      count: total.paths.length,
      lastUsed: newest,
      // Links quebrados não servem a ninguém; os que ainda levam a um binário podem servir.
      ...(key === 'orphan' ? { junk: 'orphan' as const } : {}),
    });
  }
  return found;
}

/** Os logs do app por dia: saem os de mais de uma semana. O mais novo diz quando o app foi usado. */
async function codexLogs(ctx: AiContext): Promise<{ item: Found | null; activity: number }> {
  const root = join(ctx.home, 'Library/Logs/com.openai.codex');
  const old = { paths: [] as string[], size: 0, newest: 0 };
  let activity = 0;
  for (const file of await findFiles(root, /^(?!\.DS_Store$)/, 3)) {
    const measured = await ctx.measure(file);
    activity = Math.max(activity, measured.newest);
    if (!ctx.isCold(measured.newest)) continue;
    old.paths.push(file);
    old.size += measured.size;
    old.newest = Math.max(old.newest, measured.newest);
  }
  if (old.size <= 0) return { item: null, activity };
  return {
    activity,
    item: {
      tool: 'codex',
      kind: 'logs',
      label: 'com.openai.codex',
      project: null,
      path: root,
      paths: old.paths,
      size: old.size,
      count: old.paths.length,
      lastUsed: old.newest,
      safety: 'safe',
      removal: 'trash',
    },
  };
}

/** Python, Node e LibreOffice dos plugins de documento, baixados pelo app. */
async function codexRuntimes(ctx: AiContext, activity: number): Promise<Found[]> {
  const root = join(ctx.home, '.cache/codex-runtimes');
  const found: Found[] = [];
  for (const entry of await list(root)) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    const manifest = await readJson(join(path, 'runtime.json'));
    const version = isRecord(manifest) && typeof manifest.bundleVersion === 'string' ? manifest.bundleVersion : null;
    // O mtime é o da instalação (milhares de arquivos com a data do update); o uso vem do app.
    const installed = (await mtimeOf(join(path, 'runtime.json'))) || (await mtimeOf(path));
    found.push({
      tool: 'codex',
      kind: 'runtime',
      label: version ? `${entry.name} ${version}` : entry.name,
      project: null,
      path,
      size: await ctx.du(path),
      count: 1,
      lastUsed: Math.max(activity, installed),
      confidence: 'low',
      safety: 'moderate',
      removal: 'trash',
      hint: 'redownload',
      ...whileClosed(ctx, CODEX_ANY),
    });
  }
  return found;
}

async function codexBrowserCaches(ctx: AiContext): Promise<Found[]> {
  const root = join(ctx.home, 'Library/Application Support/Codex');
  const total = await measureAll(
    ctx,
    CODEX_BROWSER_CACHES.map((name) => join(root, name))
  );
  if (total.size <= 0) return [];
  return [
    {
      tool: 'codex',
      kind: 'cache',
      label: 'Codex',
      project: null,
      path: root,
      paths: total.paths,
      size: total.size,
      count: total.files,
      lastUsed: total.newest,
      safety: 'safe',
      removal: 'trash',
      ...whileClosed(ctx, CODEX_APP),
    },
  ];
}

const codex: Collector = {
  id: 'codex',
  async collect(ctx) {
    const root = codexHome(ctx);
    const logs = await codexLogs(ctx);
    const found = [
      ...(await codexSessions(ctx, root)),
      ...(await codexLeftovers(ctx, root)),
      ...(await codexRuntimes(ctx, logs.activity)),
      ...(await codexBrowserCaches(ctx)),
      ...(logs.item ? [logs.item] : []),
    ];
    return found.filter((item) => item.size > 0);
  },
};

// ---------------------------------------------------------------- ChatGPT

/**
 * Só caches fora de Containers. As conversas do ChatGPT antigo são cópia da nuvem, mas levam
 * o acesso offline junto; e o app oculto em /Applications é do root.
 */
const CHATGPT_CACHES: ReadonlyArray<readonly [string, RegExp]> = [
  ['Codex', CODEX_APP],
  ['com.openai.codex', CODEX_APP],
  ['com.openai.sky.CUAService', CODEX_APP],
  ['com.openai.chat', CHATGPT_CLASSIC],
];

const chatgpt: Collector = {
  id: 'chatgpt',
  async collect(ctx) {
    const found: Found[] = [];
    for (const [name, app] of CHATGPT_CACHES) {
      const path = join(ctx.home, 'Library/Caches', name);
      const measured = await ctx.measure(path);
      if (measured.size <= 0) continue;
      found.push({
        tool: 'chatgpt',
        kind: 'cache',
        label: name,
        project: null,
        path,
        size: measured.size,
        count: measured.files,
        lastUsed: measured.newest,
        safety: 'safe',
        removal: 'trash',
        ...whileClosed(ctx, app),
      });
    }
    return found;
  },
};

// ---------------------------------------------------------------- Gemini CLI

/** session-<data>-<id curto>.jsonl; o .json é o formato antigo. */
const GEMINI_SESSION = /^session-.+\.jsonl?$/;
/** Nomes que a própria CLI se recusa a apagar como pasta de sessão. */
const GEMINI_RESERVED = new Set(['chats', 'logs', 'tool-outputs', 'checkpoints']);

/**
 * GEMINI_CLI_HOME toma o lugar da pasta pessoal (a CLI junta `.gemini` a ele). No sandbox do
 * macOS a CLI roda de ~/.cache/.gemini, com as mesmas tmp/ e history/.
 */
function geminiRoots(ctx: AiContext): string[] {
  const base = ctx.env.GEMINI_CLI_HOME || ctx.home;
  return [join(base, '.gemini'), join(base, '.cache/.gemini')];
}

const isGeminiCli = (p: ProcessInfo) => GEMINI_CLI.test(p.args);

/** Sem saber o cwd da CLI, ou o projeto da pasta, a CLI aberta pode ser daquele projeto. */
const worksIn = (p: ProcessInfo, project: string | null) => !p.cwd || !project || p.cwd === project || p.cwd.startsWith(project + '/');

/** O id completo vem no cabeçalho; o do nome do arquivo tem só oito letras. */
async function geminiSessionId(file: string): Promise<string | null> {
  const match = /"sessionId"\s*:\s*"([^"]+)"/.exec(await head(file, 4096));
  const id = match?.[1];
  return id && SAFE_NAME.test(id) && !GEMINI_RESERVED.has(id.toLowerCase()) ? id : null;
}

/** O que a CLI apaga junto com uma sessão (sessionOperations.ts). */
const geminiArtifacts = (projectDir: string, id: string) => [
  join(projectDir, 'logs', `session-${id}.jsonl`),
  join(projectDir, 'tool-outputs', `session-${id}`),
  join(projectDir, id),
];

/** O caminho do projeto que a CLI grava em cada pasta dele. */
async function projectMarker(dir: string): Promise<string | null> {
  const path = (await readFile(join(dir, '.project_root'), 'utf8').catch(() => '')).trim();
  return path.startsWith('/') ? path : null;
}

/** projects.json guarda caminho → id curto; aqui volta id → caminho. */
async function projectRegistry(root: string): Promise<Map<string, string>> {
  const json = await readJson(join(root, 'projects.json'));
  const ids = new Map<string, string>();
  if (isRecord(json) && isRecord(json.projects)) {
    for (const [path, id] of Object.entries(json.projects)) if (typeof id === 'string' && path.startsWith('/')) ids.set(id, path);
  }
  return ids;
}

async function geminiSessions(ctx: AiContext, projectDir: string, project: string | null): Promise<Session[]> {
  const chats = join(projectDir, 'chats');
  const sessions: Session[] = [];
  for (const entry of await list(chats)) {
    if (!entry.isFile() || !GEMINI_SESSION.test(entry.name)) continue;
    const file = join(chats, entry.name);
    const id = await geminiSessionId(file);
    const candidates = [file];
    if (id) {
      // Os subagentes gravam em chats/<sessão>/<id>.jsonl, cada um com os próprios artefatos.
      const subagents = join(chats, id);
      candidates.push(subagents, ...geminiArtifacts(projectDir, id));
      for (const sub of await list(subagents)) {
        const subId = sub.isFile() ? sub.name.replace(/\.jsonl?$/, '') : '';
        if (subId && subId !== sub.name && SAFE_NAME.test(subId) && !GEMINI_RESERVED.has(subId.toLowerCase())) {
          candidates.push(...geminiArtifacts(projectDir, subId));
        }
      }
    }
    const own = await measureAll(ctx, candidates);
    sessions.push({ project, file, paths: own.paths, size: own.size, lastUsed: own.newest });
  }
  return sessions;
}

/** checkpoint-<tag>.json: a conversa que o /chat save guardou e o /chat resume abre. */
const GEMINI_SAVED_CHAT = /^checkpoint-.+\.json$/;

async function geminiSavedChats(
  ctx: AiContext,
  projectDir: string,
  project: string | null,
  label: string,
  writers: number,
  reopened: (now: AiContext) => boolean
): Promise<Found[]> {
  const saved: Session[] = [];
  for (const entry of await list(projectDir)) {
    if (!entry.isFile() || !GEMINI_SAVED_CHAT.test(entry.name)) continue;
    const file = join(projectDir, entry.name);
    const measured = await ctx.measure(file);
    saved.push({ project, file, paths: [file], size: measured.size, lastUsed: measured.newest });
  }
  return groupSessions(ctx, saved).map(
    (group): Found => ({
      tool: 'gemini-cli',
      kind: 'sessions',
      label,
      project,
      path: group.path,
      key: `saved-${group.key}`,
      paths: group.paths,
      size: group.size,
      count: group.count,
      lastUsed: group.lastUsed,
      safety: 'moderate',
      removal: 'trash',
      hint: 'saved-chat',
      // Com a CLI aberta no projeto, um /chat resume lê daqui e um /chat save regrava a tag.
      ...(writers > 0 ? { blocked: 'in-use' as const } : {}),
      recheck: async (now) => (reopened(now) || (await touchedSince(group.files, group.lastUsed)) ? 'in-use' : null),
    })
  );
}

const geminiCli: Collector = {
  id: 'gemini-cli',
  async collect(ctx) {
    const found: Found[] = [];
    // As pastas das versões antigas da CLI levam o SHA-256 do caminho do projeto.
    const hashes = new Map(ctx.projects.map((path) => [createHash('sha256').update(path).digest('hex'), path]));
    const clis = ctx.processes.filter(isGeminiCli);

    for (const root of geminiRoots(ctx)) {
      const registry = await projectRegistry(root);
      const ids = new Set<string>();
      for (const sub of ['tmp', 'history']) {
        for (const entry of await list(join(root, sub))) {
          if (entry.isDirectory() && entry.name !== 'bin' && SAFE_NAME.test(entry.name)) ids.add(entry.name);
        }
      }

      for (const id of [...ids].sort()) {
        const projectDir = join(root, 'tmp', id);
        const historyDir = join(root, 'history', id);
        const project = (await projectMarker(projectDir)) ?? (await projectMarker(historyDir)) ?? registry.get(id) ?? hashes.get(id) ?? null;
        const label = project ? basename(project) : /^[0-9a-f]{64}$/.test(id) ? id.slice(0, 8) : id;
        const writers = clis.filter((p) => worksIn(p, project)).length;
        const reopened = (now: AiContext) => now.processes.some((p) => isGeminiCli(p) && worksIn(p, project));

        const sessions = await geminiSessions(ctx, projectDir, project);
        // A CLI aberta escreve na conversa mais nova do projeto.
        sessions
          .sort((a, b) => b.lastUsed - a.lastUsed)
          .slice(0, writers)
          .forEach((session) => (session.live = true));
        for (const group of groupSessions(ctx, sessions)) {
          found.push({
            tool: 'gemini-cli',
            kind: 'sessions',
            label,
            project,
            path: group.path,
            key: group.key,
            paths: group.paths,
            size: group.size,
            count: group.count,
            lastUsed: group.lastUsed,
            safety: 'moderate',
            removal: 'trash',
            ...(group.key === 'live' ? { blocked: 'live-session' as const } : {}),
            recheck: async (now) =>
              (await touchedSince(group.files, group.lastUsed)) || (group.key === 'hot' && reopened(now)) ? 'live-session' : null,
          });
        }

        // Os /chat save são conversas guardadas de propósito: saem como conversa, à parte, e
        // nunca junto com os pontos do /restore.
        found.push(...(await geminiSavedChats(ctx, projectDir, project, label, writers, reopened)));

        // /restore: o JSON de cada ponto e o git sombra, que não tem limpeza nenhuma.
        const checkpoints = await measureAll(ctx, [join(projectDir, 'checkpoints'), historyDir]);
        if (checkpoints.size <= 0) continue;
        const points = (await list(join(projectDir, 'checkpoints'))).filter((entry) => entry.isFile() && entry.name.endsWith('.json')).length;
        found.push({
          tool: 'gemini-cli',
          kind: 'checkpoints',
          label,
          project,
          path: checkpoints.paths[0],
          paths: checkpoints.paths,
          size: checkpoints.size,
          count: Math.max(points, 1),
          lastUsed: checkpoints.newest,
          safety: 'moderate',
          removal: 'trash',
          // A CLI aberta grava um checkpoint antes de cada edição.
          ...(writers > 0 ? { blocked: 'in-use' as const } : {}),
          recheck: async (now) => (reopened(now) ? 'in-use' : null),
        });
      }
    }
    return found;
  },
};

// ---------------------------------------------------------------- Antigravity

/** Caches do Electron e do Chromium; a pasta User/, os cookies e o estado de login ficam. */
const ANTIGRAVITY_CACHES = [
  'CachedData',
  'CachedConfigurations',
  'CachedProfilesData',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Cache',
  'Crashpad',
  'blob_storage',
];

/** O id do pacote: o Spotlight acha o app em qualquer pasta ou disco, e com qualquer nome. */
const ANTIGRAVITY_ID = 'com.google.antigravity';
/** Antigravity.app, "Antigravity 2.app", "Antigravity Beta.app"… */
const ANTIGRAVITY_BUNDLE = /^Antigravity[^/]*\.app$/;
/** Lixeira da conta ou de um disco externo: o app que está lá já foi desinstalado. */
const IN_TRASH = /\/\.Trash(?:es)?\//;

type AppPresence = 'running' | 'installed' | 'unknown';

/** Por que os restos não saem, conforme o app voltou, abriu ou não deu para saber. */
const PRESENCE_BLOCK: Record<AppPresence, AiBlock> = { running: 'app-open', installed: 'current', unknown: 'unverified' };

/**
 * Onde o app está, ou nulo se sumiu de vez. Na dúvida (o ps, o lsof ou o Spotlight falhou),
 * conta como presente: as extensões dele só viram resto com certeza.
 */
async function antigravityApp(ctx: AiContext, applications: string): Promise<AppPresence | null> {
  if (!ctx.processesKnown) return 'unknown';
  if (ctx.running(ANTIGRAVITY)) return 'running';
  for (const dir of [applications, join(ctx.home, 'Applications')]) {
    if ((await list(dir)).some((entry) => ANTIGRAVITY_BUNDLE.test(entry.name))) return 'installed';
  }
  // Num disco externo, numa subpasta ou renomeado, só o Spotlight acha.
  const spotlight = await ctx.exec('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == "${ANTIGRAVITY_ID}"`], { timeoutMs: 10_000 });
  if (spotlight.code !== 0) return 'unknown';
  return spotlight.stdout.split('\n').some((line) => line.startsWith('/') && !IN_TRASH.test(line)) ? 'installed' : null;
}

/** As pastas que o extensions.json aponta: são as versões em uso. */
async function registeredExtensions(extensions: string): Promise<Set<string>> {
  const json = await readJson(join(extensions, 'extensions.json'));
  const names = new Set<string>();
  for (const entry of Array.isArray(json) ? json : []) {
    if (!isRecord(entry)) continue;
    const location = isRecord(entry.location) ? (entry.location.path ?? entry.location.fsPath) : null;
    const name = typeof entry.relativeLocation === 'string' ? entry.relativeLocation : typeof location === 'string' ? basename(location) : null;
    if (name) names.add(name);
  }
  return names;
}

async function antigravityConversations(ctx: AiContext): Promise<Found[]> {
  const found: Found[] = [];
  for (const name of ['antigravity', 'antigravity-ide']) {
    const data = join(ctx.home, '.gemini', name);
    const conversations = join(data, 'conversations');
    const sessions: Session[] = [];
    for (const entry of await list(conversations)) {
      const id = entry.isFile() && entry.name.endsWith('.pb') ? entry.name.slice(0, -3) : '';
      if (!SAFE_NAME.test(id)) continue;
      const file = join(conversations, entry.name);
      // A conversa, os artefatos dela e as anotações: sozinha, a conversa fica na lista e não abre.
      const own = await measureAll(ctx, [file, join(data, 'brain', id), join(data, 'annotations', `${id}.pbtxt`)]);
      sessions.push({ project: null, file, paths: own.paths, size: own.size, lastUsed: own.newest });
    }
    for (const group of groupSessions(ctx, sessions)) {
      found.push({
        tool: 'antigravity',
        kind: 'sessions',
        label: name,
        project: null,
        path: group.path,
        key: group.key,
        paths: group.paths,
        size: group.size,
        count: group.count,
        lastUsed: group.lastUsed,
        safety: 'moderate',
        removal: 'trash',
        ...whileClosed(ctx, ANTIGRAVITY),
        recheck: async (now) => (now.running(ANTIGRAVITY) ? 'app-open' : (await touchedSince(group.files, group.lastUsed)) ? 'in-use' : null),
      });
    }
  }
  return found;
}

function antigravity(applications: string): Collector {
  return {
    id: 'antigravity',
    async collect(ctx) {
      const found: Found[] = [];
      const extensions = join(ctx.home, '.antigravity/extensions');
      const support = join(ctx.home, 'Library/Application Support/Antigravity');
      const closed = whileClosed(ctx, ANTIGRAVITY);
      const marked = await readJson(join(extensions, '.obsolete'));
      const obsolete = isRecord(marked) ? marked : {};
      const registered = await registeredExtensions(extensions);

      // Versão trocada por atualização: o app a apagaria no próximo início, que pode não vir.
      for (const [name, flagged] of Object.entries(obsolete)) {
        if (!flagged || !SAFE_NAME.test(name) || registered.has(name)) continue;
        const path = join(extensions, name);
        const stats = await statOf(path);
        if (!stats?.isDirectory()) continue;
        const measured = await ctx.measure(path);
        found.push({
          tool: 'antigravity',
          kind: 'versions',
          label: name,
          project: null,
          path,
          size: measured.size,
          count: 1,
          lastUsed: stats.mtimeMs,
          confidence: 'low',
          junk: 'old-version',
          safety: 'safe',
          removal: 'trash',
          // A janela aberta segue com a versão velha carregada até recarregar a extensão.
          ...closed,
        });
      }

      if (!(await antigravityApp(ctx, applications))) {
        // Sem o app, as extensões em uso viraram resto; voltam só reinstalando uma a uma. Vale o
        // extensions.json: a que está nele e também no .obsolete continua sendo a em uso.
        const active = [...registered].filter((name) => SAFE_NAME.test(name)).sort();
        const total = await measureAll(
          ctx,
          active.map((name) => join(extensions, name))
        );
        if (total.size > 0) {
          found.push({
            tool: 'antigravity',
            kind: 'leftovers',
            label: 'extensions',
            project: null,
            path: extensions,
            paths: total.paths,
            size: total.size,
            count: total.paths.length,
            lastUsed: Math.max(await mtimeOf(join(extensions, 'extensions.json')), await mtimeOf(join(support, 'User/globalStorage/state.vscdb'))),
            confidence: 'low',
            safety: 'moderate',
            removal: 'trash',
            // Reinstalado ou aberto depois da análise, as extensões voltam a ser as em uso.
            recheck: async (now) => {
              const app = await antigravityApp(now, applications);
              return app ? PRESENCE_BLOCK[app] : null;
            },
          });
        }
      }

      // VSIX que o próprio app já pôs de lado para apagar.
      const trash = join(support, 'CachedExtensionVSIXs/.trash');
      const discarded = await ctx.measure(trash);
      found.push({
        tool: 'antigravity',
        kind: 'cache',
        label: 'CachedExtensionVSIXs',
        project: null,
        path: trash,
        size: discarded.size,
        count: discarded.files,
        lastUsed: discarded.newest,
        junk: 'orphan',
        safety: 'safe',
        removal: 'trash',
        ...closed,
      });

      const caches = await measureAll(
        ctx,
        ANTIGRAVITY_CACHES.map((name) => join(support, name))
      );
      found.push({
        tool: 'antigravity',
        kind: 'cache',
        label: 'Antigravity',
        project: null,
        path: support,
        paths: caches.paths,
        size: caches.size,
        count: caches.files,
        lastUsed: caches.newest,
        safety: 'safe',
        removal: 'trash',
        ...closed,
      });

      // Uma pasta por abertura do app; a da sessão aberta é quente e fica.
      const logsDir = join(support, 'logs');
      const logs = { paths: [] as string[], size: 0, newest: 0 };
      for (const entry of await list(logsDir)) {
        if (!entry.isDirectory()) continue;
        const path = join(logsDir, entry.name);
        const measured = await ctx.measure(path);
        if (!ctx.isCold(measured.newest)) continue;
        logs.paths.push(path);
        logs.size += measured.size;
        logs.newest = Math.max(logs.newest, measured.newest);
      }
      found.push({
        tool: 'antigravity',
        kind: 'logs',
        label: 'logs',
        project: null,
        path: logsDir,
        paths: logs.paths,
        size: logs.size,
        count: logs.paths.length,
        lastUsed: logs.newest,
        safety: 'safe',
        removal: 'trash',
      });

      found.push(...(await antigravityConversations(ctx)));
      return found.filter((item) => item.size > 0);
    },
  };
}

export interface OpenaiGoogleOptions {
  /** Onde procurar o Antigravity.app, além de ~/Applications. Os testes trocam por uma pasta própria. */
  applications?: string;
}

export function createOpenaiGoogleCollectors(options: OpenaiGoogleOptions = {}): Collector[] {
  return [codex, chatgpt, geminiCli, antigravity(options.applications ?? '/Applications')];
}

export const openaiGoogleCollectors: Collector[] = createOpenaiGoogleCollectors();
