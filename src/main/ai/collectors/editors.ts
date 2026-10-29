import type { Dirent } from 'node:fs';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AiBlock, AiToolId } from '../../../shared/api';
import { cwdOfTranscript } from '../context';
import type { AiContext, Collector, Found } from '../types';

/**
 * O que os editores e as extensões de IA deixam no disco: o chat do Copilot no VS Code, no CLI
 * e nos IDEs JetBrains, as tarefas do Cline, do Roo e do Kilo, o Continue, o Zed, o AI Assistant
 * da JetBrains, versões velhas de extensão de IA e os restos de Cursor, Windsurf, Trae e Kiro
 * desinstalados. Só caminhos conhecidos: varrer ~/Library/Application Support esbarra em pastas
 * protegidas e abre pedido de autorização na tela.
 */

const APP_SUPPORT = 'Library/Application Support';
/** Chat que só sai pelo próprio app aparece a partir deste tamanho; abaixo disso é ruído. */
const VIA_APP_MIN = 500 * 1024 * 1024;
/** Pastas medidas ao mesmo tempo. */
const PARALLEL = 8;

const VSCODE_EXE = /\/Visual Studio Code\.app\/Contents\/MacOS\//;
const INSIDERS_EXE = /\/Visual Studio Code - Insiders\.app\/Contents\/MacOS\//;
// "Cursor" sozinho casaria com o CursorUIViewService do sistema: só o executável do app.
const CURSOR_EXE = /\/Cursor( [^/]*)?\.app\/Contents\/MacOS\//;
const WINDSURF_EXE = /\/(Windsurf|Devin)( [^/]*)?\.app\/Contents\/MacOS\//;
const TRAE_EXE = /\/Trae( [^/]*)?\.app\/Contents\/MacOS\//;
const KIRO_EXE = /\/Kiro( [^/]*)?\.app\/Contents\/MacOS\//;
const ZED_EXE = /\/Zed( [^/]*)?\.app\/Contents\/MacOS\//;
/** O executável de cada IDE da JetBrains (o Android Studio é um deles por dentro). */
const JETBRAINS_EXE =
  /\.app\/Contents\/MacOS\/(idea|pycharm|webstorm|phpstorm|goland|clion|rider|datagrip|rubymine|rustrover|dataspell|aqua|writerside|studio)$/;

interface Editor {
  /** A pasta em ~/Library/Application Support. */
  dir: string;
  exe: RegExp;
}

const CODE: Editor = { dir: 'Code', exe: VSCODE_EXE };
const CODE_INSIDERS: Editor = { dir: 'Code - Insiders', exe: INSIDERS_EXE };
/** O VS Code e os forks dele: todos guardam os dados das extensões em User/globalStorage/<id>. */
const VSCODE_FAMILY: Editor[] = [
  CODE,
  CODE_INSIDERS,
  { dir: 'VSCodium', exe: /\/VSCodium\.app\/Contents\/MacOS\// },
  { dir: 'Cursor', exe: CURSOR_EXE },
  { dir: 'Windsurf', exe: WINDSURF_EXE },
  { dir: 'Devin', exe: WINDSURF_EXE },
  { dir: 'Trae', exe: TRAE_EXE },
  { dir: 'Kiro', exe: KIRO_EXE },
  { dir: 'Antigravity', exe: /\/Antigravity\.app\/Contents\/MacOS\// },
];
const ANY_EDITOR = new RegExp([...VSCODE_FAMILY.map((editor) => editor.exe.source), JETBRAINS_EXE.source].join('|'));

/**
 * Extensões de IA do marketplace do VS Code e a ferramenta de cada uma. Nulo: é de IA, mas a
 * ferramenta não tem id próprio na tela, e o item fica com o editor.
 */
const AI_EXTENSIONS: Record<string, AiToolId | null> = {
  'github.copilot': 'copilot',
  'github.copilot-chat': 'copilot',
  'github.copilot-nightly': 'copilot',
  'github.copilot-labs': 'copilot',
  // As extensões de modernização com o Copilot (.NET e Java).
  'ms-dotnettools.upgrade-agent': 'copilot',
  'vscjava.migrate-java-to-azure': 'copilot',
  'vscjava.vscode-java-upgrade': 'copilot',
  'anthropic.claude-code': 'claude-code',
  'openai.chatgpt': 'codex',
  'saoudrizwan.claude-dev': 'cline',
  'rooveterinaryinc.roo-cline': 'roo-code',
  'kilocode.kilo-code': 'kilo-code',
  'continue.continue': 'continue',
  'google.gemini-cli-vscode-ide-companion': 'gemini-cli',
  'sst-dev.opencode': 'opencode',
  'codeium.codeium': 'windsurf',
  'google.geminicodeassist': null,
  'amazonwebservices.amazon-q-vscode': null,
  'sourcegraph.cody-ai': null,
  'tabnine.tabnine-vscode': null,
  'augment.vscode-augment': null,
  'supermaven.supermaven': null,
  'codium.codium': null,
  'qodo.qodo-gen': null,
  'danielsanmedium.dscodegpt': null,
  'blackboxapp.blackbox': null,
  'visualstudioexptteam.vscodeintellicode': null,
};

const isAiExtension = (id: string) => Object.hasOwn(AI_EXTENSIONS, id);

// ——— leitura ————————————————————————————————————————————————————————————————

const entries = (dir: string): Promise<Dirent[]> => readdir(dir, { withFileTypes: true }).catch(() => []);
const statOf = (path: string) => lstat(path).catch(() => null);
const mtimeOf = async (path: string) => (await statOf(path))?.mtimeMs ?? 0;
const home = (ctx: AiContext, path: string) => join(ctx.home, path);

/** Pasta vinda de variável de ambiente; relativa ou vazia não vale. */
function envDir(ctx: AiContext, name: string, fallback: string): string {
  const value = ctx.env[name];
  return value && isAbsolute(value) ? resolve(value) : home(ctx, fallback);
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
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

async function measureAll(ctx: AiContext, paths: readonly string[]): Promise<{ size: number; newest: number; files: number }> {
  const parts = await Promise.all(paths.map((path) => ctx.measure(path)));
  return {
    size: parts.reduce((sum, part) => sum + part.size, 0),
    newest: Math.max(0, ...parts.map((part) => part.newest)),
    files: parts.reduce((sum, part) => sum + part.files, 0),
  };
}

const present = async (paths: readonly string[]) =>
  (await Promise.all(paths.map(async (path) => ((await statOf(path)) ? path : null)))).filter((path): path is string => path !== null);

const parseVersion = (text: string) => text.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ——— agrupar por projeto e por calor ——————————————————————————————————————————

/** Uma sessão (ou um índice, um checkpoint) antes de juntar com as outras do mesmo projeto. */
interface Unit {
  /** Junta as unidades do mesmo projeto, ou do mesmo workspace quando não há projeto. */
  group: string;
  label: string;
  project: string | null;
  /** Para onde o "Mostrar no Finder" aponta. */
  anchor: string;
  paths: string[];
  size: number;
  lastUsed: number;
  live?: boolean;
}

type Owner = Pick<Unit, 'group' | 'label' | 'project'>;
type Gate = Pick<Found, 'blocked' | 'recheck'>;
type Shared = Pick<Found, 'tool' | 'kind' | 'safety' | 'removal'> & Partial<Pick<Found, 'blocked' | 'recheck' | 'hint' | 'confidence' | 'junk'>>;

/**
 * Um item para as frias e outro para as quentes de cada projeto, e as abertas agora à parte. O
 * `path` é o da unidade mais recente: único por grupo, já que nenhuma unidade é de dois projetos.
 */
function grouped(ctx: AiContext, units: readonly Unit[], shared: Shared): Found[] {
  const groups = new Map<string, { heat: string; members: Unit[] }>();
  for (const unit of units) {
    if (unit.size <= 0) continue;
    const heat = unit.live ? 'live' : ctx.isCold(unit.lastUsed) ? 'cold' : 'hot';
    const id = `${unit.group}\0${heat}`;
    const group = groups.get(id) ?? { heat, members: [] };
    group.members.push(unit);
    groups.set(id, group);
  }
  return [...groups.values()].map(({ heat, members }) => {
    const newest = members.reduce((a, b) => (b.lastUsed > a.lastUsed ? b : a));
    const item: Found = {
      ...shared,
      label: newest.label,
      project: newest.project,
      path: newest.anchor,
      key: heat,
      paths: members.flatMap((member) => member.paths),
      size: members.reduce((sum, member) => sum + member.size, 0),
      count: members.length,
      lastUsed: newest.lastUsed,
    };
    if (heat === 'live') item.blocked = 'live-session';
    return item;
  });
}

/** O app tem de estar fechado: banco em WAL, ou arquivo que ele regrava ao sair. */
function whileClosed(ctx: AiContext, exe: RegExp): Gate {
  const recheck = async (now: AiContext): Promise<AiBlock | null> => (now.running(exe) ? 'app-open' : null);
  return ctx.running(exe) ? { blocked: 'app-open', recheck } : { recheck };
}

function owner(ctx: AiContext, cwd: string | null | undefined, fallback: string): Owner {
  if (!cwd || !cwd.startsWith('/')) return { group: fallback, label: fallback, project: null };
  const path = cwd.length > 1 ? cwd.replace(/\/+$/, '') : cwd;
  // A pasta pessoal não é projeto: seria dona de tudo.
  if (path === ctx.home) return { group: path, label: '~', project: null };
  return { group: path, label: basename(path), project: path };
}

/** O projeto que tem a pasta com esse nome, quando só um tem. */
function projectNamed(ctx: AiContext, name: string, more: Iterable<string> = []): string | null {
  const matches = [...new Set([...ctx.projects, ...more])].filter((project) => basename(project) === name);
  return matches.length === 1 ? matches[0] : null;
}

/** Uma unidade por subpasta. */
async function folderUnits(ctx: AiContext, parent: string, who: Owner): Promise<Unit[]> {
  const folders = (await entries(parent)).filter((entry) => entry.isDirectory());
  return mapLimit(folders, PARALLEL, async (entry) => {
    const path = join(parent, entry.name);
    const { size, newest } = await ctx.measure(path);
    return { ...who, anchor: parent, paths: [path], size, lastUsed: newest };
  });
}

/** Uma unidade por arquivo aceito. */
async function fileUnits(ctx: AiContext, parent: string, who: Owner, accept: (name: string) => boolean): Promise<Unit[]> {
  const files = (await entries(parent)).filter((entry) => entry.isFile() && accept(entry.name));
  return mapLimit(files, PARALLEL, async (entry) => {
    const path = join(parent, entry.name);
    const { size, newest } = await ctx.measure(path);
    return { ...who, anchor: parent, paths: [path], size, lastUsed: newest };
  });
}

// ——— Copilot no VS Code ———————————————————————————————————————————————————————

/** Os índices de busca do Copilot por workspace, com o -wal e o -shm de cada um. */
const COPILOT_INDEX = /^(local-index\.\d+\.db|workspace-chunks\.db|codebase-external\.sqlite)(-wal|-shm|-journal)?$/;
/** Embeddings que o Copilot baixa ou calcula de novo. */
const COPILOT_EMBEDDINGS = ['commandEmbeddings.json', 'settingEmbeddings.json', 'toolEmbeddingsCache.bin'];

function fileUrl(uri: string): string | null {
  try {
    return fileURLToPath(uri);
  } catch {
    return null;
  }
}

/** De quem é um workspaceStorage/<hash>, pelo workspace.json; sem ele, é uma janela vazia. */
async function workspaceOwner(ctx: AiContext, dir: string, name: string): Promise<Owner> {
  const json = asRecord(await readJson(join(dir, 'workspace.json')));
  const folder = typeof json?.folder === 'string' ? json.folder : null;
  const workspace = typeof json?.workspace === 'string' ? json.workspace : null;
  const uri = folder ?? workspace;
  if (!uri) return { group: dir, label: name, project: null };
  const path = uri.startsWith('file://') ? fileUrl(uri) : null;
  if (!path) {
    // Workspace remoto (ssh, contêiner): o nome é o fim da URI.
    const tail = uri.split('/').filter(Boolean).pop() ?? name;
    return { group: uri, label: tail.replace(/%20/g, ' '), project: null };
  }
  if (folder) return owner(ctx, path, name);
  // Um .code-workspace junta pastas que só abrindo o arquivo se sabe; o nome dele basta.
  const file = basename(path);
  const label = file === 'workspace.json' ? `Workspaces/${basename(dirname(path))}` : file.replace(/\.code-workspace$/, '');
  return { group: path, label, project: null };
}

/** As sessões de um workspace: o arquivo do chat, os anexos e a transcrição do mesmo id. */
async function chatUnits(ctx: AiContext, dir: string, who: Owner): Promise<Unit[]> {
  const chats = join(dir, 'chatSessions');
  const copilot = join(dir, 'GitHub.copilot-chat');
  const byId = new Map<string, string[]>();
  const add = (id: string, path: string) => byId.set(id, [...(byId.get(id) ?? []), path]);

  // A mesma sessão pode estar no .jsonl novo e no .json antigo.
  for (const entry of await entries(chats)) {
    if (entry.isFile() && /\.jsonl?$/.test(entry.name)) add(entry.name.replace(/\.jsonl?$/, ''), join(chats, entry.name));
  }
  const resources = join(copilot, 'chat-session-resources');
  for (const entry of await entries(resources)) {
    if (entry.isDirectory()) add(entry.name, join(resources, entry.name));
  }
  const transcripts = join(copilot, 'transcripts');
  for (const entry of await entries(transcripts)) {
    if (entry.isFile() && entry.name.endsWith('.jsonl')) add(entry.name.slice(0, -'.jsonl'.length), join(transcripts, entry.name));
  }

  return mapLimit([...byId.values()], PARALLEL, async (paths) => {
    const { size, newest } = await measureAll(ctx, paths);
    return { ...who, anchor: dirname(paths[0]), paths, size, lastUsed: newest };
  });
}

async function copilotVsCode(ctx: AiContext): Promise<Found[]> {
  const found: Found[] = [];
  for (const editor of [CODE, CODE_INSIDERS]) {
    const user = home(ctx, join(APP_SUPPORT, editor.dir, 'User'));
    const storage = join(user, 'workspaceStorage');
    const gate = whileClosed(ctx, editor.exe);
    const sessions: Unit[] = [];
    const checkpoints: Unit[] = [];
    const indexes: Unit[] = [];
    const logs: Unit[] = [];

    await mapLimit(await entries(storage), 4, async (workspace) => {
      if (!workspace.isDirectory()) return;
      const dir = join(storage, workspace.name);
      const who = await workspaceOwner(ctx, dir, workspace.name);
      sessions.push(...(await chatUnits(ctx, dir, who)));
      checkpoints.push(...(await folderUnits(ctx, join(dir, 'chatEditingSessions'), who)));

      // Só os arquivos de índice: memory-tool/, a memória do agente, mora na mesma pasta.
      const copilot = join(dir, 'GitHub.copilot-chat');
      const index = (await entries(copilot)).filter((entry) => entry.isFile() && COPILOT_INDEX.test(entry.name)).map((entry) => join(copilot, entry.name));
      if (index.length > 0) {
        const { size, newest } = await measureAll(ctx, index);
        indexes.push({ ...who, anchor: copilot, paths: index, size, lastUsed: newest });
      }
      const debugLogs = join(copilot, 'debug-logs');
      const debugSize = await ctx.measure(debugLogs);
      if (debugSize.size > 0) logs.push({ ...who, anchor: debugLogs, paths: [debugLogs], size: debugSize.size, lastUsed: debugSize.newest });
    });

    const empty = join(user, 'globalStorage/emptyWindowChatSessions');
    sessions.push(...(await fileUnits(ctx, empty, { group: empty, label: 'emptyWindowChatSessions', project: null }, (name) => /\.jsonl?$/.test(name))));

    const moderate: Omit<Shared, 'kind'> = { tool: 'copilot', safety: 'moderate', removal: 'trash', ...gate };
    const safe: Omit<Shared, 'kind'> = { tool: 'copilot', safety: 'safe', removal: 'trash', ...gate };
    found.push(
      ...grouped(ctx, sessions, { ...moderate, kind: 'sessions' }),
      ...grouped(ctx, checkpoints, { ...moderate, kind: 'checkpoints' }),
      ...grouped(ctx, indexes, { ...safe, kind: 'index' }),
      ...grouped(ctx, logs, { ...safe, kind: 'logs' })
    );

    const global = join(user, 'globalStorage/github.copilot-chat');
    const embeddings = await present(COPILOT_EMBEDDINGS.map((name) => join(global, name)));
    const measured = await measureAll(ctx, embeddings);
    found.push({
      tool: 'copilot',
      kind: 'cache',
      label: 'embeddings',
      project: null,
      path: global,
      paths: embeddings,
      size: measured.size,
      count: embeddings.length,
      // A data é a do download.
      lastUsed: measured.newest,
      confidence: 'low',
      safety: 'safe',
      removal: 'trash',
      hint: 'redownload',
      ...gate,
    });
  }
  return found;
}

// ——— Copilot CLI ——————————————————————————————————————————————————————————————

/** Só `cwd` e `updated_at` do workspace.yaml: o resumo e o nome que moram ali são conversa. */
async function sessionHeader(path: string): Promise<{ cwd: string | null; updatedAt: number }> {
  const text = await readFile(path, 'utf8').catch(() => '');
  let cwd: string | null = null;
  let updatedAt = 0;
  for (const line of text.split('\n')) {
    // Linhas de bloco (o resumo) vêm recuadas; só as chaves da raiz interessam.
    const match = /^(cwd|updated_at):[ \t]*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].trim().replace(/^(['"])(.*)\1$/, '$2');
    if (match[1] === 'cwd') cwd = value.startsWith('/') ? value : null;
    else updatedAt = Date.parse(value) || 0;
  }
  return { cwd, updatedAt };
}

const alive = (ctx: AiContext, pid: number) => ctx.processes.some((process) => process.pid === pid);

/** inuse.<pid>.lock de um processo vivo: a sessão está aberta. Trava de PID morto não conta. */
async function liveLock(ctx: AiContext, dir: string): Promise<boolean> {
  for (const entry of await entries(dir)) {
    const match = /^inuse\.(\d+)\.lock$/.exec(entry.name);
    if (match && alive(ctx, Number(match[1]))) return true;
  }
  return false;
}

async function copilotCli(ctx: AiContext): Promise<Found[]> {
  const root = envDir(ctx, 'COPILOT_HOME', '.copilot');
  const state = join(root, 'session-state');
  const unknown = { group: state, label: 'session-state', project: null };
  const units = await mapLimit(await entries(state), PARALLEL, async (entry): Promise<Unit | null> => {
    const path = join(state, entry.name);
    if (entry.isDirectory()) {
      const header = await sessionHeader(join(path, 'workspace.yaml'));
      const { size, newest } = await ctx.measure(path);
      // O events.jsonl só cresce; o mtime da pasta não acompanha.
      const lastUsed = header.updatedAt || (await mtimeOf(join(path, 'events.jsonl'))) || newest;
      const who = header.cwd ? owner(ctx, header.cwd, state) : unknown;
      return { ...who, anchor: path, paths: [path], size, lastUsed, live: await liveLock(ctx, path) };
    }
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      // O formato antigo: a sessão inteira num arquivo só.
      const { size, newest } = await ctx.measure(path);
      const cwd = await cwdOfTranscript(path);
      return { ...(cwd ? owner(ctx, cwd, state) : unknown), anchor: path, paths: [path], size, lastUsed: newest };
    }
    return null;
  });

  const found = grouped(
    ctx,
    units.filter((unit): unit is Unit => unit !== null),
    { tool: 'copilot', kind: 'sessions', safety: 'moderate', removal: 'trash' }
  );
  for (const item of found) {
    // O índice do Copilot CLI (session-store.db) só esquece a sessão depois do reindex.
    item.hint = 'reindex';
    if (item.blocked) continue;
    const dirs = item.paths ?? [];
    item.recheck = async (now) => ((await Promise.all(dirs.map((dir) => liveLock(now, dir)))).some(Boolean) ? 'live-session' : null);
  }

  // process-<início em ms>-<pid>.log; o do processo vivo ainda está sendo escrito.
  const logsDir = join(root, 'logs');
  const logs = await fileUnits(ctx, logsDir, { group: logsDir, label: 'logs', project: null }, (name) => {
    const match = /^process-\d+-(\d+)\.log$/.exec(name);
    return !!match && !alive(ctx, Number(match[1]));
  });
  found.push(
    ...grouped(
      ctx,
      logs.filter((unit) => ctx.isCold(unit.lastUsed)),
      { tool: 'copilot', kind: 'logs', safety: 'safe', removal: 'trash' }
    )
  );

  // jb/ (conversas do Copilot nos IDEs JetBrains) não tem documentação: só o que está frio.
  const jb = join(root, 'jb');
  const conversations = await folderUnits(ctx, jb, { group: jb, label: 'jb', project: null });
  found.push(
    ...grouped(
      ctx,
      conversations.filter((unit) => ctx.isCold(unit.lastUsed)),
      { tool: 'copilot', kind: 'sessions', safety: 'moderate', removal: 'trash', ...whileClosed(ctx, JETBRAINS_EXE) }
    )
  );
  return found;
}

// ——— Copilot nos IDEs JetBrains ———————————————————————————————————————————————————

/** Os stores Nitrite do Copilot, um por projeto em cada um destes tipos. */
const COPILOT_STORES = ['chat-agent-sessions', 'chat-sessions', 'chat-edit-sessions', 'bg-agent-sessions'];

const unescapeXml = (text: string) =>
  text.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * projectWorkspaceId → pasta do projeto, pelos projetos recentes de cada IDE. O .idea/workspace.xml
 * do projeto diria o mesmo, mas lê-lo pediria acesso à pasta Documentos.
 */
async function jetbrainsProjectIds(ctx: AiContext): Promise<Map<string, string>> {
  const root = home(ctx, join(APP_SUPPORT, 'JetBrains'));
  const ids = new Map<string, string>();
  for (const product of await entries(root)) {
    if (!product.isDirectory()) continue;
    for (const file of ['recentProjects.xml', 'recentSolutions.xml']) {
      const xml = await readFile(join(root, product.name, 'options', file), 'utf8').catch(() => '');
      for (const match of xml.matchAll(/<entry key="([^"]+)">([\s\S]*?)<\/entry>/g)) {
        const id = /projectWorkspaceId="([^"]+)"/.exec(match[2])?.[1];
        if (!id) continue;
        let path = unescapeXml(match[1]).replace('$USER_HOME$', ctx.home);
        // O Rider guarda a solução; o projeto é a pasta dela.
        if (/\.(sln|slnx|slnf|csproj|fsproj|vbproj|ipr)$/i.test(path)) path = dirname(path);
        if (path.startsWith('/')) ids.set(id, path);
      }
    }
  }
  return ids;
}

/** O mtime dos bancos do store: o .xd, o xd.lck e o blobs/ ficam parados meses. */
async function storeLastUsed(ctx: AiContext, dirs: readonly string[]): Promise<number> {
  let newest = 0;
  for (const dir of dirs) {
    for (const entry of await entries(dir)) {
      if (entry.isFile() && entry.name.endsWith('.db')) newest = Math.max(newest, await mtimeOf(join(dir, entry.name)));
    }
  }
  return newest || (await measureAll(ctx, dirs)).newest;
}

async function packageVersion(path: string): Promise<string | null> {
  const json = asRecord(await readJson(path));
  return typeof json?.version === 'string' ? json.version : null;
}

async function copilotJetBrains(ctx: AiContext): Promise<Found[]> {
  const config = join(envDir(ctx, 'XDG_CONFIG_HOME', '.config'), 'github-copilot');
  const cache = envDir(ctx, 'XDG_CACHE_HOME', '.cache');
  const gate = whileClosed(ctx, JETBRAINS_EXE);
  const ids = await jetbrainsProjectIds(ctx);
  const found: Found[] = [];

  // <código do IDE>/<tipo>/<ProjectId>: rd é o Rider, db o DataGrip. Fora desses tipos ficam a
  // autenticação (auth.db, apps.json) e a configuração compartilhada (intellij/).
  const units: Unit[] = [];
  for (const ide of await entries(config)) {
    if (!ide.isDirectory() || ide.name === 'intellij') continue;
    const stores = new Map<string, string[]>();
    for (const type of COPILOT_STORES) {
      const parent = join(config, ide.name, type);
      for (const store of await entries(parent)) {
        if (store.isDirectory()) stores.set(store.name, [...(stores.get(store.name) ?? []), join(parent, store.name)]);
      }
    }
    // Os tipos do mesmo projeto saem juntos: um sem o outro deixa o histórico pela metade.
    units.push(
      ...(await mapLimit([...stores], PARALLEL, async ([id, dirs]): Promise<Unit> => {
        // Stores antigos têm o nome do projeto no lugar do id.
        const project = ids.get(id) ?? projectNamed(ctx, id, ids.values());
        const { size } = await measureAll(ctx, dirs);
        return {
          group: project ?? `${ide.name}/${id}`,
          label: project ? basename(project) : id,
          project,
          anchor: dirs[0],
          paths: dirs,
          size,
          lastUsed: await storeLastUsed(ctx, dirs),
        };
      }))
    );
  }
  found.push(...grouped(ctx, units, { tool: 'copilot', kind: 'sessions', safety: 'moderate', removal: 'trash', ...gate }));

  // <pasta do projeto>.<hash>: derivados do código, que o plugin refaz ao abrir o projeto.
  for (const [folder, kind] of [
    ['project-context', 'cache'],
    ['project-index', 'index'],
  ] as const) {
    const parent = join(cache, 'github-copilot', folder);
    const dirs = (await entries(parent)).filter((entry) => entry.isDirectory());
    found.push(
      ...(await mapLimit(dirs, PARALLEL, async (entry): Promise<Found> => {
        const path = join(parent, entry.name);
        const { size, newest, files } = await ctx.measure(path);
        const name = entry.name.replace(/\.[0-9a-f]{6,}$/i, '');
        return { tool: 'copilot', kind, label: name, project: projectNamed(ctx, name, ids.values()), path, size, count: files, lastUsed: newest, safety: 'safe', removal: 'trash', ...gate };
      }))
    );
  }

  // ~/.cache/pkg/<sha256>: o @github/copilot que o plugin extrai, uma pasta por versão. A em uso é
  // a que o plugin de cada IDE embute.
  const inUse = new Set<string>();
  const jetbrains = home(ctx, join(APP_SUPPORT, 'JetBrains'));
  for (const product of await entries(jetbrains)) {
    const version = await packageVersion(
      join(jetbrains, product.name, 'plugins/github-copilot-intellij/copilot-agent/dist/node_modules/@github/copilot/package.json')
    );
    if (version) inUse.add(version);
  }
  const pkg = join(cache, 'pkg');
  const extracted = (
    await mapLimit(await entries(pkg), PARALLEL, async (entry) => {
      const version = entry.isDirectory() ? await packageVersion(join(pkg, entry.name, '@github/copilot/package.json')) : null;
      return version ? { path: join(pkg, entry.name), version } : null;
    })
  ).filter((item): item is { path: string; version: string } => item !== null);
  // Sem plugin lido, ao menos a mais nova fica.
  const newest = extracted.reduce<string | null>(
    (best, item) => (!best || compareVersions(parseVersion(item.version), parseVersion(best)) > 0 ? item.version : best),
    null
  );
  if (newest) inUse.add(newest);
  for (const item of extracted.filter((candidate) => !inUse.has(candidate.version))) {
    const { size, newest: extractedAt } = await ctx.measure(item.path);
    found.push({
      tool: 'copilot',
      kind: 'versions',
      label: `@github/copilot ${item.version}`,
      project: null,
      path: item.path,
      size,
      count: 1,
      lastUsed: extractedAt,
      confidence: 'low',
      junk: 'old-version',
      safety: 'safe',
      removal: 'trash',
    });
  }
  return found;
}

// ——— versões velhas de extensão ——————————————————————————————————————————————————

/** <publisher>.<nome>-<versão>[-<plataforma>]: o id é o que vem antes do primeiro x.y.z. */
const EXTENSION_FOLDER = /^(.+?)-(\d+\.\d+\.\d+[^-]*)(?:-.+)?$/;

/**
 * As versões de extensão que nada usa: as que o editor marcou no .obsolete (ele as apaga no
 * próximo início) e as que não são a mais nova do id nem estão no extensions.json.
 */
async function oldExtensions(ctx: AiContext, dir: string, toolOf: (id: string) => AiToolId | null, gate: Gate): Promise<Found[]> {
  const obsolete = new Set(Object.keys(asRecord(await readJson(join(dir, '.obsolete'))) ?? {}));
  const listed = await readJson(join(dir, 'extensions.json'));
  const referenced = Array.isArray(listed)
    ? new Set(
        listed.flatMap((entry) => {
          const record = asRecord(entry);
          const location = asRecord(record?.location)?.path;
          const name = typeof record?.relativeLocation === 'string' ? record.relativeLocation : typeof location === 'string' ? basename(location) : null;
          return name ? [name] : [];
        })
      )
    : null;

  const folders = (await entries(dir)).flatMap((entry) => {
    const match = entry.isDirectory() ? EXTENSION_FOLDER.exec(entry.name) : null;
    const id = match?.[1].toLowerCase();
    const tool = id ? toolOf(id) : null;
    return match && id && tool ? [{ name: entry.name, id, version: parseVersion(match[2]), tool }] : [];
  });
  const newest = new Map<string, (typeof folders)[number]>();
  for (const folder of folders) {
    const current = newest.get(folder.id);
    if (!current || compareVersions(folder.version, current.version) > 0) newest.set(folder.id, folder);
  }
  const old = folders.filter((folder) => obsolete.has(folder.name) || (newest.get(folder.id) !== folder && !referenced?.has(folder.name)));

  return mapLimit(old, PARALLEL, async (folder): Promise<Found> => {
    const path = join(dir, folder.name);
    const { size, newest: installedAt } = await ctx.measure(path);
    return {
      tool: folder.tool,
      kind: 'versions',
      label: folder.name,
      project: null,
      path,
      size,
      count: 1,
      lastUsed: installedAt,
      confidence: 'low',
      junk: 'old-version',
      safety: 'safe',
      removal: 'trash',
      ...gate,
    };
  });
}

// ——— VS Code: agent host e extensões de IA ———————————————————————————————————————————

async function vscode(ctx: AiContext): Promise<Found[]> {
  const found: Found[] = [];
  for (const [editor, extensions] of [
    [CODE, '.vscode/extensions'],
    [CODE_INSIDERS, '.vscode-insiders/extensions'],
  ] as const) {
    const gate = whileClosed(ctx, editor.exe);
    // O agent host (VS Code 1.129+) roda Copilot, Claude e Codex num processo à parte.
    const data = home(ctx, join(APP_SUPPORT, editor.dir, 'agentSessionData'));
    const sessions = await folderUnits(ctx, data, { group: data, label: 'agentSessionData', project: null });
    found.push(...grouped(ctx, sessions, { tool: 'vscode', kind: 'sessions', safety: 'moderate', removal: 'trash', ...gate }));
    // Só as de IA; a de IA sem ferramenta própria na tela fica com o VS Code.
    const toolOf = (id: string) => (isAiExtension(id) ? (AI_EXTENSIONS[id] ?? 'vscode') : null);
    found.push(...(await oldExtensions(ctx, home(ctx, extensions), toolOf, gate)));
  }
  return found;
}

// ——— Cursor, Windsurf, Trae, Kiro: instalado ou resto ————————————————————————————————

interface Leftover {
  path: string;
  /** Só estas partes saem; o resto da pasta é configuração. */
  parts?: string[];
  /** Árvore enorme (extensões): só o `du`, e a data do extensions.json. */
  huge?: boolean;
}

interface AiEditor {
  tool: AiToolId;
  /** O nome do .app em /Applications ou ~/Applications. */
  app: RegExp;
  exe: RegExp;
  extensions(ctx: AiContext): string[];
  /** O que fica no disco depois que o app sai. Nunca a configuração (mcp.json, regras, argv.json). */
  leftovers(ctx: AiContext): Promise<Leftover[]>;
  /** Onde o app guarda os chats, que só ele sabe apagar. */
  chats(ctx: AiContext): string[];
}

const CURSOR_BUNDLE = 'com.todesktop.230313mzl4w4u92';

const AI_EDITORS: AiEditor[] = [
  {
    tool: 'cursor',
    app: /^Cursor( .*)?\.app$/,
    exe: CURSOR_EXE,
    extensions: (ctx) => [home(ctx, '.cursor/extensions')],
    leftovers: async (ctx) => {
      const items: Leftover[] = [
        { path: home(ctx, '.cursor/extensions'), huge: true },
        { path: home(ctx, `${APP_SUPPORT}/Cursor`) },
        { path: home(ctx, `Library/Caches/${CURSOR_BUNDLE}`) },
        { path: home(ctx, `Library/Caches/${CURSOR_BUNDLE}.ShipIt`) },
        { path: home(ctx, `${APP_SUPPORT}/Caches/cursor-updater`) },
        { path: home(ctx, 'Library/Logs/Cursor') },
        { path: home(ctx, `Library/HTTPStorages/${CURSOR_BUNDLE}`) },
      ];
      // O cursor-agent (CLI) usa estas pastas e vive sem o app. ~/.cursor/worktrees nunca: pode
      // ter trabalho que só existe ali.
      if (!(await statOf(home(ctx, '.local/bin/cursor-agent')))) {
        items.push(...['projects', 'chats', 'acp-sessions', 'ai-tracking'].map((name) => ({ path: home(ctx, `.cursor/${name}`) })));
      }
      return items;
    },
    chats: (ctx) => [home(ctx, `${APP_SUPPORT}/Cursor/User/globalStorage/state.vscdb`)],
  },
  {
    tool: 'windsurf',
    app: /^(Windsurf|Devin)( .*)?\.app$/,
    exe: WINDSURF_EXE,
    extensions: (ctx) => [home(ctx, '.windsurf/extensions'), home(ctx, '.devin/extensions')],
    // ~/.codeium fica: o plugin do Windsurf para VS Code e JetBrains usa a mesma pasta.
    leftovers: async (ctx) => [
      { path: home(ctx, '.windsurf/extensions'), huge: true },
      { path: home(ctx, '.devin/extensions'), huge: true },
      { path: home(ctx, `${APP_SUPPORT}/Windsurf`) },
      { path: home(ctx, `${APP_SUPPORT}/Devin`) },
      { path: home(ctx, 'Library/Caches/com.exafunction.windsurf') },
      { path: home(ctx, 'Library/Caches/com.exafunction.windsurf.ShipIt') },
      { path: home(ctx, 'Library/HTTPStorages/com.exafunction.windsurf') },
    ],
    chats: (ctx) => [home(ctx, '.codeium/windsurf/cascade')],
  },
  {
    tool: 'trae',
    app: /^Trae( .*)?\.app$/,
    exe: TRAE_EXE,
    extensions: (ctx) => [home(ctx, '.trae/extensions')],
    leftovers: async (ctx) => [
      { path: home(ctx, '.trae/extensions'), huge: true },
      // config.json fica.
      { path: home(ctx, '.trae-aicc'), parts: ['.ripgrep', '.code_contribution', '.code_contribution_changelog'] },
      { path: home(ctx, '.icube-remote-ssh/server-cache') },
      { path: home(ctx, `${APP_SUPPORT}/Trae`) },
      { path: home(ctx, 'Library/Caches/com.trae.app') },
      { path: home(ctx, 'Library/Caches/com.trae.ShipIt') },
      { path: home(ctx, 'Library/HTTPStorages/com.trae.app') },
    ],
    chats: () => [],
  },
  {
    tool: 'kiro',
    app: /^Kiro( .*)?\.app$/,
    exe: KIRO_EXE,
    extensions: (ctx) => [join(envDir(ctx, 'KIRO_HOME', '.kiro'), 'extensions')],
    // O resto de ~/.kiro é do Kiro CLI e de configuração (steering, mcp.json).
    leftovers: async (ctx) => [
      { path: join(envDir(ctx, 'KIRO_HOME', '.kiro'), 'extensions'), huge: true },
      { path: home(ctx, `${APP_SUPPORT}/Kiro`) },
      { path: home(ctx, 'Library/Caches/dev.kiro.desktop') },
    ],
    chats: () => [],
  },
];

async function installed(ctx: AiContext, appDirs: readonly string[], editor: AiEditor): Promise<boolean> {
  if (ctx.running(editor.exe)) return true;
  for (const dir of appDirs) {
    if ((await entries(dir)).some((entry) => editor.app.test(entry.name))) return true;
  }
  return false;
}

async function leftover(ctx: AiContext, tool: AiToolId, item: Leftover): Promise<Found | null> {
  const paths = await present(item.parts ? item.parts.map((part) => join(item.path, part)) : [item.path]);
  if (paths.length === 0) return null;

  let size = 0;
  let lastUsed = 0;
  let count = 0;
  if (item.huge) {
    for (const path of paths) {
      size += await ctx.du(path);
      lastUsed = Math.max(lastUsed, (await mtimeOf(join(path, 'extensions.json'))) || (await mtimeOf(path)));
      count += (await entries(path)).filter((entry) => entry.isDirectory()).length;
    }
  } else {
    const measured = await measureAll(ctx, paths);
    size = measured.size;
    lastUsed = measured.newest;
    count = measured.files;
  }
  return {
    tool,
    kind: 'leftovers',
    label: relative(ctx.home, item.path),
    project: null,
    path: item.path,
    paths,
    size,
    count,
    lastUsed,
    // A data das extensões é a da instalação, não a do uso.
    confidence: item.huge ? 'low' : 'high',
    safety: 'moderate',
    removal: 'trash',
  };
}

async function aiEditor(ctx: AiContext, appDirs: readonly string[], editor: AiEditor): Promise<Found[]> {
  if (!(await installed(ctx, appDirs, editor))) {
    const items = await Promise.all((await editor.leftovers(ctx)).map((item) => leftover(ctx, editor.tool, item)));
    return items.filter((item): item is Found => item !== null);
  }

  const gate = whileClosed(ctx, editor.exe);
  const found: Found[] = [];
  // No editor de IA toda extensão velha conta; a de IA conhecida vai para a ferramenta dela.
  const toolOf = (id: string) => (isAiExtension(id) ? (AI_EXTENSIONS[id] ?? editor.tool) : editor.tool);
  for (const dir of editor.extensions(ctx)) found.push(...(await oldExtensions(ctx, dir, toolOf, gate)));

  for (const path of editor.chats(ctx)) {
    const { size, newest, files } = await ctx.measure(path);
    if (size < VIA_APP_MIN) continue;
    found.push({
      tool: editor.tool,
      kind: 'sessions',
      label: basename(path),
      project: null,
      path,
      size,
      count: files,
      lastUsed: newest,
      safety: 'moderate',
      removal: 'none',
      blocked: 'via-app',
    });
  }
  return found;
}

/** O cursor-agent baixa uma versão por atualização; a em uso é o alvo do link em ~/.local/bin. */
async function cursorAgentVersions(ctx: AiContext): Promise<Found[]> {
  const versions = home(ctx, '.local/share/cursor-agent/versions');
  const bin = home(ctx, '.local/bin');
  const targets = (
    await Promise.all(
      ['cursor-agent', 'agent'].map((name) =>
        readlink(join(bin, name)).then(
          (target) => resolve(bin, target),
          () => null
        )
      )
    )
  ).filter((target): target is string => target !== null && target.startsWith(versions + '/'));
  // Sem o link não dá para saber qual está em uso.
  if (targets.length === 0) return [];

  const old = (await entries(versions)).filter((entry) => {
    const path = join(versions, entry.name);
    return entry.isDirectory() && !targets.some((target) => target === path || target.startsWith(path + '/'));
  });
  return mapLimit(old, PARALLEL, async (entry): Promise<Found> => {
    const path = join(versions, entry.name);
    const { size, newest } = await ctx.measure(path);
    return {
      tool: 'cursor',
      kind: 'versions',
      label: `cursor-agent ${entry.name}`,
      project: null,
      path,
      size,
      count: 1,
      lastUsed: newest,
      confidence: 'low',
      junk: 'old-version',
      safety: 'safe',
      removal: 'trash',
    };
  });
}

// ——— Cline, Roo Code, Kilo Code ——————————————————————————————————————————————————

/** Uma tarefa por pasta; o ui_messages.json é regravado a cada mensagem. */
async function taskUnits(ctx: AiContext, tasks: string, who: Owner): Promise<Unit[]> {
  const folders = (await entries(tasks)).filter((entry) => entry.isDirectory());
  return mapLimit(folders, PARALLEL, async (entry) => {
    const path = join(tasks, entry.name);
    const { size, newest } = await ctx.measure(path);
    return { ...who, anchor: tasks, paths: [path], size, lastUsed: (await mtimeOf(join(path, 'ui_messages.json'))) || newest };
  });
}

/**
 * As tarefas de uma extensão da linhagem do Cline em cada editor da família VS Code. O projeto da
 * tarefa só está dentro da conversa, então o item é por editor.
 */
async function extensionTasks(ctx: AiContext, tool: AiToolId, extensionId: string): Promise<Found[]> {
  const found: Found[] = [];
  for (const editor of VSCODE_FAMILY) {
    const storage = home(ctx, join(APP_SUPPORT, editor.dir, 'User/globalStorage', extensionId));
    const who = { group: storage, label: editor.dir, project: null };
    const gate = whileClosed(ctx, editor.exe);
    found.push(...grouped(ctx, await taskUnits(ctx, join(storage, 'tasks'), who), { tool, kind: 'sessions', safety: 'moderate', removal: 'trash', ...gate }));

    // O Cline guarda os checkpoints num git-sombra por workspace, que copia a árvore inteira.
    const checkpoints = join(storage, 'checkpoints');
    const repos = (await entries(checkpoints)).filter((entry) => entry.isDirectory());
    const units = await mapLimit(repos, PARALLEL, async (entry): Promise<Unit> => {
      const path = join(checkpoints, entry.name);
      const git = join(path, '.git');
      const lastUsed = Math.max(...(await Promise.all(['index', 'HEAD', 'logs/HEAD'].map((name) => mtimeOf(join(git, name))))));
      return { ...who, anchor: checkpoints, paths: [path], size: await ctx.du(path), lastUsed: lastUsed || (await mtimeOf(path)) };
    });
    found.push(...grouped(ctx, units, { tool, kind: 'checkpoints', safety: 'moderate', removal: 'trash', ...gate }));
  }
  return found;
}

async function cline(ctx: AiContext): Promise<Found[]> {
  const found = await extensionTasks(ctx, 'cline', 'saoudrizwan.claude-dev');
  // O Cline CLI e o plugin para JetBrains guardam fora do VS Code.
  const tasks = home(ctx, '.cline/data/tasks');
  const units = await taskUnits(ctx, tasks, { group: tasks, label: '.cline', project: null });
  found.push(...grouped(ctx, units, { tool: 'cline', kind: 'sessions', safety: 'moderate', removal: 'trash' }));
  return found;
}

// ——— Continue ————————————————————————————————————————————————————————————————————

/** Os índices que o Continue refaz; o globalContext.json, ao lado deles, é estado. */
const CONTINUE_INDEX = /^((index|docs|autocompleteCache)\.sqlite(-wal|-shm|-journal)?|lancedb)$/;

async function continueDev(ctx: AiContext): Promise<Found[]> {
  const root = envDir(ctx, 'CONTINUE_GLOBAL_DIR', '.continue');
  const found: Found[] = [];

  // sessions.json é o índice das sessões.
  const isSession = (name: string) => name.endsWith('.json') && name !== 'sessions.json';
  for (const dir of [join(root, 'sessions'), home(ctx, '.continue-cli/sessions')]) {
    const units = await fileUnits(ctx, dir, { group: dir, label: basename(dirname(dir)), project: null }, isSession);
    found.push(...grouped(ctx, units, { tool: 'continue', kind: 'sessions', safety: 'moderate', removal: 'trash' }));
  }

  const indexDir = join(root, 'index');
  const index = (await entries(indexDir)).filter((entry) => CONTINUE_INDEX.test(entry.name)).map((entry) => join(indexDir, entry.name));
  const indexSize = await measureAll(ctx, index);
  found.push({
    tool: 'continue',
    kind: 'index',
    label: 'index',
    project: null,
    path: indexDir,
    paths: index,
    size: indexSize.size,
    count: index.length,
    lastUsed: indexSize.newest,
    safety: 'safe',
    removal: 'trash',
    // O SQLite fica aberto no editor que roda o Continue.
    ...whileClosed(ctx, ANY_EDITOR),
  });

  const logs = join(root, 'logs');
  const logSize = await ctx.measure(logs);
  found.push({ tool: 'continue', kind: 'logs', label: 'logs', project: null, path: logs, size: logSize.size, count: logSize.files, lastUsed: logSize.newest, safety: 'safe', removal: 'trash' });
  return found;
}

// ——— Zed —————————————————————————————————————————————————————————————————————————

async function zed(ctx: AiContext): Promise<Found[]> {
  const threads = home(ctx, join(APP_SUPPORT, 'Zed/threads'));
  const db = join(threads, 'threads.db');
  const current = await measureAll(ctx, [db, `${db}-wal`]);
  if (current.size <= 0) return [];
  const legacy = join(threads, 'threads-db.1.mdb');
  const old = await ctx.measure(legacy);
  return [
    // Todas as threads num SQLite só: apagar uma é pelo Agent Panel.
    { tool: 'zed', kind: 'sessions', label: 'threads.db', project: null, path: db, size: current.size, count: 1, lastUsed: current.newest, safety: 'moderate', removal: 'none', blocked: 'via-app' },
    // O LMDB de antes da migração para SQLite fica parado ao lado.
    {
      tool: 'zed',
      kind: 'sessions',
      label: 'threads-db.1.mdb',
      project: null,
      path: legacy,
      size: old.size,
      count: old.files,
      lastUsed: old.newest,
      junk: 'old-version',
      safety: 'moderate',
      removal: 'trash',
      ...whileClosed(ctx, ZED_EXE),
    },
  ];
}

// ——— JetBrains: AI Assistant e Junie ——————————————————————————————————————————————

async function jetbrains(ctx: AiContext): Promise<Found[]> {
  const root = home(ctx, join(APP_SUPPORT, 'JetBrains'));
  const gate = whileClosed(ctx, JETBRAINS_EXE);
  const found: Found[] = [];

  // <uuid>.agentsession, .events e .lastid são a mesma tarefa de agente. Só a aia-task-history:
  // o chat do AI Assistant fica no workspace/*.xml, junto do estado do projeto.
  for (const product of await entries(root)) {
    if (!product.isDirectory()) continue;
    const history = join(root, product.name, 'aia-task-history');
    const byTask = new Map<string, string[]>();
    for (const entry of await entries(history)) {
      if (!entry.isFile()) continue;
      const task = entry.name.split('.')[0];
      byTask.set(task, [...(byTask.get(task) ?? []), join(history, entry.name)]);
    }
    const who = { group: history, label: product.name, project: null };
    const units = await mapLimit([...byTask.values()], PARALLEL, async (paths): Promise<Unit> => {
      const { size, newest } = await measureAll(ctx, paths);
      return { ...who, anchor: history, paths, size, lastUsed: newest };
    });
    found.push(...grouped(ctx, units, { tool: 'jetbrains', kind: 'sessions', safety: 'moderate', removal: 'trash', ...gate }));
  }

  const junie = home(ctx, '.junie/sessions');
  const sessions = await folderUnits(ctx, junie, { group: junie, label: 'junie', project: null });
  found.push(...grouped(ctx, sessions, { tool: 'jetbrains', kind: 'sessions', safety: 'moderate', removal: 'trash' }));
  return found;
}

// ——— os coletores ——————————————————————————————————————————————————————————————————

export interface EditorOptions {
  /** Onde procurar os apps instalados; os testes trocam pelas pastas da conta de mentira. */
  appDirs?(ctx: AiContext): string[];
}

const defaultAppDirs = (ctx: AiContext) => ['/Applications', join(ctx.home, 'Applications')];

export function createEditorCollectors(options: EditorOptions = {}): Collector[] {
  const appDirs = options.appDirs ?? defaultAppDirs;
  const collector = (id: AiToolId, read: (ctx: AiContext) => Promise<Found[]>): Collector => ({
    id,
    collect: async (ctx) => (await read(ctx)).filter((item) => item.size > 0),
  });
  const editor = (tool: AiToolId) => {
    const spec = AI_EDITORS.find((candidate) => candidate.tool === tool)!;
    return collector(tool, (ctx) => aiEditor(ctx, appDirs(ctx), spec));
  };
  // O Copilot mora em três lugares que não dependem um do outro: um erro num não esconde os outros.
  return [
    collector('copilot', copilotVsCode),
    collector('copilot', copilotCli),
    collector('copilot', copilotJetBrains),
    collector('vscode', vscode),
    editor('cursor'),
    collector('cursor', cursorAgentVersions),
    editor('windsurf'),
    editor('trae'),
    editor('kiro'),
    collector('zed', zed),
    collector('cline', cline),
    collector('roo-code', (ctx) => extensionTasks(ctx, 'roo-code', 'rooveterinaryinc.roo-cline')),
    collector('kilo-code', (ctx) => extensionTasks(ctx, 'kilo-code', 'kilocode.kilo-code')),
    collector('continue', continueDev),
    collector('jetbrains', jetbrains),
  ];
}

export const editorCollectors: Collector[] = createEditorCollectors();
