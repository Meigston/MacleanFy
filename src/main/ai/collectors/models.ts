import { access, constants, open, readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { AiBlock, AiToolId } from '../../../shared/api';
import type { AiContext, Collector, Found } from '../types';

/**
 * Modelos baixados por apps e bibliotecas de IA local. O mtime de um peso é a data do
 * download, e o atime não anda no APFS quando o modelo é lido por mmap; por isso o uso vem
 * do registro da própria ferramenta quando ela tem um (LM Studio, Ollama, Chrome) e, sem ele,
 * da data do download com confiança baixa. Nada aqui lê o conteúdo de um peso: ler já mexe no
 * atime e, num modelo de 20 GB, custa caro.
 */

/** Download parcial mexido há menos que isso ainda pode estar baixando. */
const LIVE_DOWNLOAD_MS = 60 * 60 * 1000;
/** As cargas mais recentes estão no fim do server.log; o começo pode ter meses. */
const LOG_TAIL_BYTES = 16 * 1024 * 1024;
/** Do 1º de janeiro de 1601, onde o relógio do Chrome começa, até 1970. */
const CHROME_EPOCH_MS = 11_644_473_600_000;

const list = (dir: string) => readdir(dir, { withFileTypes: true }).catch(() => []);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** Nome lido de um JSON que vai virar pedaço de caminho: nada de barra nem `..`. */
const isSegment = (name: unknown): name is string =>
  typeof name === 'string' && /^[\w.@ -]+$/.test(name) && name !== '.' && name !== '..';

const byVersion = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** Pasta dada por variável de ambiente; só vale caminho absoluto ou a partir de `~/`. */
function envDir(ctx: AiContext, name: string): string | null {
  const value = ctx.env[name]?.trim();
  if (!value) return null;
  if (value.startsWith('~/')) return resolve(ctx.home, value.slice(2));
  return value.startsWith('/') ? resolve(value) : null;
}

const cacheHome = (ctx: AiContext) => envDir(ctx, 'XDG_CACHE_HOME') ?? join(ctx.home, '.cache');

type Closed = Pick<Found, 'blocked' | 'recheck'>;

/** O app guarda estado aberto sobre os arquivos: só saem com ele fechado, conferido de novo na hora. */
function whenClosed(ctx: AiContext, exe: RegExp): Closed {
  return {
    ...(ctx.running(exe) ? { blocked: 'app-open' as const } : {}),
    recheck: async (now: AiContext): Promise<AiBlock | null> => (now.running(exe) ? 'app-open' : null),
  };
}

type ModelFields = Pick<Found, 'label' | 'path' | 'size' | 'count' | 'lastUsed'> & Partial<Found>;

/** Modelo baixado: sai para a Lixeira e a ferramenta baixa de novo quando precisar. */
function modelItem(tool: AiToolId, fields: ModelFields): Found {
  return {
    tool,
    kind: 'model',
    project: null,
    safety: 'moderate',
    removal: 'trash',
    hint: 'redownload',
    confidence: 'low',
    ...fields,
  };
}

/**
 * A Lixeira só aceita o que está na conta (é o que o scanner confere por último). Modelo num
 * disco externo, apontado por variável ou configuração, fica só para ver.
 */
function insideAccount(ctx: AiContext, item: Found): Found {
  if ((item.paths ?? [item.path]).every((path) => path.startsWith(ctx.home + '/'))) return item;
  const shown: Found = { ...item, removal: 'none', blocked: item.blocked ?? 'via-app' };
  delete shown.remove;
  return shown;
}

function collector(id: AiToolId, collect: (ctx: AiContext) => Promise<Found[]>): Collector {
  return {
    id,
    collect: async (ctx) => (await collect(ctx)).filter((item) => item.size > 0).map((item) => insideAccount(ctx, item)),
  };
}

// --- LM Studio ---------------------------------------------------------------------------

const LM_STUDIO = /\/LM Studio\.app\/Contents\/|(^|\/)(llmster|lms)$/;

async function lmStudioRoot(ctx: AiContext): Promise<string> {
  // Quem move a pasta do LM Studio deixa o novo lugar neste ponteiro.
  const pointer = (await readFile(join(ctx.home, '.lmstudio-home-pointer'), 'utf8').catch(() => '')).trim();
  return pointer.startsWith('/') ? resolve(pointer) : join(ctx.home, '.lmstudio');
}

async function lmStudioModelRoots(ctx: AiContext, root: string): Promise<string[]> {
  // Do settings.json só interessa a pasta: o resto guarda os tokens do Hugging Face.
  const settings = await readJson(join(root, 'settings.json'));
  const folder = isRecord(settings) ? settings.downloadsFolder : null;
  const chosen = typeof folder === 'string' && folder.startsWith('/') ? resolve(folder) : join(root, 'models');
  // A pasta das versões anteriores à 0.3, que pode ter ficado sem migrar.
  return [...new Set([chosen, join(ctx.home, '.cache/lm-studio/models')])];
}

/** Os pares do model-data.json, que o LM Studio grava em superjson: `json` é a lista de um Map. */
function superjsonPairs(data: unknown): Array<[string, unknown]> {
  const body = isRecord(data) && 'json' in data ? data.json : data;
  if (Array.isArray(body)) {
    return body.filter((pair): pair is [string, unknown] => Array.isArray(pair) && typeof pair[0] === 'string');
  }
  return isRecord(body) ? Object.entries(body) : [];
}

/** De que repositórios vieram os arquivos de um modelo do catálogo do LM Studio (lmstudio.ai/models). */
async function hubSources(manifestPath: string): Promise<string[]> {
  const manifest = await readJson(manifestPath);
  const targets: string[] = [];
  for (const dependency of isRecord(manifest) && Array.isArray(manifest.dependencies) ? manifest.dependencies : []) {
    if (!isRecord(dependency)) continue;
    for (const key of Array.isArray(dependency.modelKeys) ? dependency.modelKeys : []) {
      if (typeof key === 'string') targets.push(key);
    }
    for (const source of Array.isArray(dependency.sources) ? dependency.sources : []) {
      if (isRecord(source) && typeof source.user === 'string' && typeof source.repo === 'string') {
        targets.push(`${source.user}/${source.repo}`);
      }
    }
  }
  return targets;
}

/**
 * Última carga de cada pasta <publisher>/<modelo>, em minúsculas. O LM Studio grava
 * `lastLoadedTimestamp` na entrada que foi carregada: a do repositório, ou a do catálogo,
 * que aponta para o repositório pelo manifesto em hub/models.
 */
async function lmStudioLoads(root: string): Promise<Map<string, number>> {
  const loads = new Map<string, number>();
  const note = (key: string, at: number) => {
    const folder = key.toLowerCase();
    loads.set(folder, Math.max(loads.get(folder) ?? 0, at));
  };
  for (const [key, value] of superjsonPairs(await readJson(join(root, '.internal/model-data.json')))) {
    if (!isRecord(value) || typeof value.lastLoadedTimestamp !== 'number' || value.lastLoadedTimestamp <= 0) continue;
    const at = value.lastLoadedTimestamp;
    const source = isRecord(value.source) ? value.source : {};
    if (source.type === 'huggingface' && typeof source.owner === 'string' && typeof source.repo === 'string') {
      note(`${source.owner}/${source.repo}`, at);
    } else if (source.type === 'hub' && isSegment(source.owner) && isSegment(source.name)) {
      for (const target of await hubSources(join(root, 'hub/models', source.owner, source.name, 'manifest.json'))) note(target, at);
    }
    note(key.split('/').slice(0, 2).join('/'), at);
  }
  return loads;
}

async function lmStudioModels(ctx: AiContext, root: string, closed: Closed): Promise<Found[]> {
  const loads = await lmStudioLoads(root);
  const items: Found[] = [];
  for (const models of await lmStudioModelRoots(ctx, root)) {
    for (const publisher of await list(models)) {
      if (!publisher.isDirectory() || publisher.name.startsWith('.')) continue;
      for (const model of await list(join(models, publisher.name))) {
        if (!model.isDirectory() || model.name.startsWith('.')) continue;
        // A pasta inteira: o GGUF e o mmproj andam juntos, e um sem o outro não carrega.
        const path = join(models, publisher.name, model.name);
        const { size, newest, files } = await ctx.measure(path);
        const loaded = loads.get(`${publisher.name}/${model.name}`.toLowerCase()) ?? 0;
        // Sem registro de carga o app nunca abriu o modelo: sobra a data do download.
        items.push(
          modelItem('lm-studio', {
            label: `${publisher.name}/${model.name}`,
            path,
            size,
            count: files,
            lastUsed: Math.max(loaded, newest),
            confidence: loaded > 0 && loaded >= newest ? 'high' : 'low',
            ...(loaded === 0 ? { hint: 'never-loaded' as const } : {}),
            ...closed,
          })
        );
      }
    }
  }
  return items;
}

interface Runtime {
  dir: string;
  name: string;
  version: string;
  vendor: string[];
}

async function runtimesIn(dir: string): Promise<Runtime[]> {
  const found: Runtime[] = [];
  for (const entry of await list(dir)) {
    if (!entry.isDirectory() || entry.name === 'vendor') continue;
    const manifest = await readJson(join(dir, entry.name, 'backend-manifest.json'));
    if (!isRecord(manifest) || typeof manifest.name !== 'string' || typeof manifest.version !== 'string') continue;
    const vendor = Array.isArray(manifest.vendor_lib_package_names)
      ? manifest.vendor_lib_package_names.filter((name): name is string => typeof name === 'string')
      : [];
    found.push({ dir: join(dir, entry.name), name: manifest.name, version: manifest.version, vendor });
  }
  return found;
}

/**
 * Motores que o app não usa mais. A versão escolhida de cada um está em
 * backend-preferences-v1.json; as outras são lixo, e com elas o Python do vendor que só
 * elas usam. Framework não tem escolha gravada: sai a versão que tem outra mais nova ao lado.
 */
async function lmStudioRuntimes(ctx: AiContext, root: string, closed: Closed): Promise<Found[]> {
  const preferences = await readJson(join(root, '.internal/backend-preferences-v1.json'));
  const selected = new Map<string, Set<string>>();
  for (const preference of Array.isArray(preferences) ? preferences : []) {
    if (!isRecord(preference) || typeof preference.name !== 'string' || typeof preference.version !== 'string') continue;
    selected.set(preference.name, (selected.get(preference.name) ?? new Set<string>()).add(preference.version));
  }

  const backendsDir = join(root, 'extensions/backends');
  const backends = await runtimesIn(backendsDir);
  const frameworks = await runtimesIn(join(root, 'extensions/frameworks'));
  // Se a versão escolhida não está instalada, o app pode cair em qualquer outra: nenhuma sai.
  const oldBackends = backends.filter((backend) => {
    const chosen = selected.get(backend.name);
    return (
      !!chosen &&
      !chosen.has(backend.version) &&
      backends.some((other) => other.name === backend.name && chosen.has(other.version))
    );
  });
  const oldFrameworks = frameworks.filter((framework) =>
    frameworks.some((other) => other.name === framework.name && byVersion(other.version, framework.version) > 0)
  );
  const stale = [...oldBackends, ...oldFrameworks];
  const needed = new Set(
    [...backends, ...frameworks].filter((runtime) => !stale.includes(runtime)).flatMap((runtime) => runtime.vendor)
  );
  const vendors = new Set(stale.flatMap((runtime) => runtime.vendor).filter((name) => !needed.has(name)));

  const runtimeItem = async (path: string, label: string): Promise<Found> => {
    const { size, newest, files } = await ctx.measure(path);
    return {
      tool: 'lm-studio',
      kind: 'runtime',
      label,
      project: null,
      path,
      size,
      count: files,
      lastUsed: newest,
      confidence: 'low',
      junk: 'old-version',
      safety: 'safe',
      removal: 'trash',
      ...closed,
    };
  };

  const items: Found[] = [];
  for (const runtime of stale) {
    items.push(await runtimeItem(runtime.dir, `${runtime.name.replace(/-mac-.*$/, '')} ${runtime.version}`));
  }
  for (const name of vendors) {
    const segments = name.split('/');
    if (segments.every(isSegment)) {
      items.push(await runtimeItem(join(backendsDir, 'vendor', ...segments), segments[segments.length - 1]));
    }
  }
  return items;
}

const lmStudio = collector('lm-studio', async (ctx) => {
  const root = await lmStudioRoot(ctx);
  const closed = whenClosed(ctx, LM_STUDIO);
  return [...(await lmStudioModels(ctx, root, closed)), ...(await lmStudioRuntimes(ctx, root, closed))];
});

// --- Ollama ------------------------------------------------------------------------------

export const OLLAMA_BINARIES = [
  '/opt/homebrew/bin/ollama',
  '/usr/local/bin/ollama',
  '/Applications/Ollama.app/Contents/Resources/ollama',
];

async function firstExecutable(paths: readonly string[]): Promise<string | null> {
  for (const path of paths) {
    if (await access(path, constants.X_OK).then(() => true, () => false)) return path;
  }
  return null;
}

async function ollamaModelsDir(ctx: AiContext): Promise<string> {
  const fromEnv = envDir(ctx, 'OLLAMA_MODELS');
  if (fromEnv) return fromEnv;
  // O app da barra de menus herda as variáveis do launchd, não as do terminal.
  const launchd = await ctx.exec('/bin/launchctl', ['getenv', 'OLLAMA_MODELS'], { timeoutMs: 5_000 });
  const value = launchd.code === 0 ? launchd.stdout.trim() : '';
  return value.startsWith('/') ? resolve(value) : join(ctx.home, '.ollama/models');
}

/** O nome que o `ollama ls` mostra e o `ollama rm` aceita, de manifests/<registro>/<espaço>/<modelo>/<tag>. */
export function ollamaName([registry, space, model, tag]: string[]): string {
  if (registry === 'registry.ollama.ai') return `${space === 'library' ? '' : `${space}/`}${model}:${tag}`;
  return `${registry}/${space}/${model}:${tag}`;
}

interface OllamaManifest {
  path: string;
  name: string;
  /** Nomes dos arquivos em blobs/ (sha256-<hex>) que o manifesto cita. */
  blobs: string[];
}

async function ollamaManifests(root: string): Promise<OllamaManifest[]> {
  const found: OllamaManifest[] = [];
  const names = new Set<string>();
  const walk = async (dir: string, parts: string[]): Promise<void> => {
    for (const entry of await list(dir)) {
      if (entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory() && parts.length < 3) {
        await walk(path, [...parts, entry.name]);
        continue;
      }
      if (!entry.isFile() || parts.length !== 3) continue;
      const manifest = await readJson(path);
      if (!isRecord(manifest)) continue;
      const blobs = new Set<string>();
      for (const layer of [manifest.config, ...(Array.isArray(manifest.layers) ? manifest.layers : [])]) {
        const digest = isRecord(layer) ? layer.digest : null;
        if (typeof digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(digest)) blobs.add(digest.replace(':', '-'));
      }
      const name = ollamaName([...parts, entry.name]);
      if (blobs.size > 0 && !names.has(name)) {
        names.add(name);
        found.push({ path, name, blobs: [...blobs] });
      }
    }
  };
  for (const top of ['manifests', 'manifests-v2']) await walk(join(root, top), []);
  return found;
}

async function tail(path: string, bytes: number): Promise<string> {
  const handle = await open(path, 'r').catch(() => null);
  if (!handle) return '';
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Hora no começo de uma linha do log: `time=<RFC 3339>` (slog) ou `AAAA/MM/DD hh:mm:ss` (log antigo, hora local). */
function logTime(line: string): number {
  const slog = /^time=(\S+)/.exec(line);
  if (slog) return Date.parse(slog[1]) || 0;
  const old = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(line);
  if (!old) return 0;
  const [, year, month, day, hour, minute, second] = old.map(Number);
  return new Date(year, month - 1, day, hour, minute, second).getTime();
}

/**
 * Quando cada camada foi carregada. O Ollama não grava uso; o que sobra é o server.log, onde
 * cada carga aparece com a hora e o caminho do blob (`runner --model …/blobs/sha256-…`).
 */
async function ollamaLoads(ctx: AiContext): Promise<Map<string, number>> {
  const loads = new Map<string, number>();
  const logs = join(ctx.home, '.ollama/logs');
  for (const entry of await list(logs)) {
    if (!entry.isFile() || !/^server(-\d+)?\.log$/.test(entry.name)) continue;
    for (const line of (await tail(join(logs, entry.name), LOG_TAIL_BYTES)).split('\n')) {
      if (!line.includes('sha256-')) continue;
      const at = logTime(line);
      if (at <= 0) continue;
      for (const match of line.matchAll(/sha256-([0-9a-f]{64})/g)) {
        const blob = `sha256-${match[1]}`;
        loads.set(blob, Math.max(loads.get(blob) ?? 0, at));
      }
    }
  }
  return loads;
}

/**
 * Um item por modelo:tag. Sai só pelo `ollama rm`: apagar um blob à mão quebra todas as tags que
 * o usam, e apagar o manifesto faz a poda da próxima inicialização levar as camadas.
 */
export function ollamaCollector(binaries: readonly string[] = OLLAMA_BINARIES): Collector {
  return collector('ollama', async (ctx) => {
    const root = await ollamaModelsDir(ctx);
    const manifests = await ollamaManifests(root);
    if (manifests.length === 0) return [];
    // Tags com as mesmas camadas são um modelo só com dois nomes (llama3 e llama3:8b). Contadas
    // à parte, cada uma veria todas as camadas como da outra e o modelo sumiria da lista.
    const models = new Map<string, OllamaManifest[]>();
    for (const manifest of manifests) {
      const key = [...manifest.blobs].sort().join(' ');
      models.set(key, [...(models.get(key) ?? []), manifest]);
    }
    const users = new Map<string, number>();
    for (const [first] of models.values()) {
      for (const blob of first.blobs) users.set(blob, (users.get(blob) ?? 0) + 1);
    }
    const [binary, loads] = await Promise.all([firstExecutable(binaries), ollamaLoads(ctx)]);

    const items: Found[] = [];
    for (const tags of models.values()) {
      tags.sort((a, b) => a.name.localeCompare(b.name));
      const names = tags.map((tag) => tag.name);
      // Camada que outro modelo também usa continua no disco depois do rm: não conta.
      const own = tags[0].blobs.filter((blob) => users.get(blob) === 1).map((blob) => join(root, 'blobs', blob));
      let size = 0;
      let count = 0;
      for (const blob of own) {
        const measured = await ctx.measure(blob);
        size += measured.size;
        count += measured.files;
      }
      const loaded = Math.max(0, ...tags[0].blobs.map((blob) => loads.get(blob) ?? 0));
      let pulled = 0;
      for (const tag of tags) pulled = Math.max(pulled, (await ctx.measure(tag.path)).newest);
      const item = modelItem('ollama', {
        label: names.join(', '),
        path: tags[0].path,
        paths: [...tags.map((tag) => tag.path), ...own],
        size,
        count,
        lastUsed: loaded || pulled,
        confidence: loaded ? 'high' : 'low',
      });
      if (binary) {
        item.removal = 'command';
        // O `ollama rm` pede ao servidor que apague: com ele parado, não sai nada.
        if (!ollamaServing(ctx)) item.blocked = 'app-closed';
        item.recheck = async (now) => (ollamaServing(now) ? null : 'app-closed');
        item.remove = async (now) => {
          for (const name of names) {
            const result = await now.exec(binary, ['rm', name], { timeoutMs: 120_000 });
            if (result.code !== 0) throw new Error(result.stderr.trim() || `ollama rm exited with ${result.code}`);
          }
        };
      } else {
        item.removal = 'none';
        item.blocked = 'via-app';
        item.hint = 'tool-command';
      }
      items.push(item);
    }
    return items;
  });
}

/** O servidor do Ollama no ar: o app (Ollama.app) ou um `ollama serve` do Homebrew. */
function ollamaServing(ctx: AiContext): boolean {
  return ctx.processes.some((p) => /\/ollama$/i.test(p.exe) || /(^|\/)ollama serve\b/.test(p.args));
}

// --- Hugging Face ------------------------------------------------------------------------

const HF_REPO = /^(models|datasets|spaces|kernels)--(.+)$/;

const hfHome = (ctx: AiContext) => envDir(ctx, 'HF_HOME') ?? join(cacheHome(ctx), 'huggingface');

async function liveDownload(ctx: AiContext, blobs: string): Promise<boolean> {
  for (const entry of await list(blobs)) {
    if (!entry.name.endsWith('.incomplete')) continue;
    if (ctx.now - (await ctx.measure(join(blobs, entry.name))).newest < LIVE_DOWNLOAD_MS) return true;
  }
  return false;
}

/**
 * Um repositório do cache sai inteiro: um blob avulso quebra os links de snapshots/. O tamanho
 * é só o de blobs/, porque snapshots/ são links. Parcial (*.incomplete) parado é lixo à parte;
 * mexido há pouco, é um download em andamento e segura o repositório.
 */
async function hfRepo(ctx: AiContext, repo: string, type: string, label: string): Promise<Found[]> {
  const blobs = join(repo, 'blobs');
  const orphans: Array<{ path: string; size: number; newest: number }> = [];
  let size = 0;
  let count = 0;
  let downloaded = 0;
  let live = false;
  for (const entry of await list(blobs)) {
    const path = join(blobs, entry.name);
    const measured = await ctx.measure(path);
    if (entry.name.endsWith('.incomplete')) {
      if (ctx.now - measured.newest >= LIVE_DOWNLOAD_MS) {
        orphans.push({ path, size: measured.size, newest: measured.newest });
        continue;
      }
      live = true;
    }
    size += measured.size;
    count += measured.files;
    downloaded = Math.max(downloaded, measured.newest);
  }
  const snapshots = await ctx.measure(join(repo, 'snapshots'));
  const recheck = async (now: AiContext): Promise<AiBlock | null> => ((await liveDownload(now, blobs)) ? 'in-use' : null);

  const items: Found[] = [];
  if (size > 0) {
    // Com parcial parado dentro, o repositório sai por partes, para o parcial ser um item à parte.
    const parts = orphans.length
      ? [
          ...(await list(repo)).filter((entry) => entry.name !== 'blobs').map((entry) => join(repo, entry.name)),
          ...(await list(blobs))
            .map((entry) => join(blobs, entry.name))
            .filter((path) => !orphans.some((orphan) => orphan.path === path)),
        ]
      : undefined;
    items.push(
      modelItem('hugging-face', {
        kind: type === 'models' || type === 'kernels' ? 'model' : 'cache',
        label,
        path: repo,
        ...(parts ? { paths: parts } : {}),
        size,
        count,
        lastUsed: Math.max(downloaded, snapshots.newest),
        ...(live ? { blocked: 'in-use' as const } : {}),
        recheck,
      })
    );
  }
  const partial = orphans.reduce((sum, orphan) => sum + orphan.size, 0);
  if (partial > 0) {
    items.push({
      tool: 'hugging-face',
      kind: 'cache',
      label,
      project: null,
      path: blobs,
      paths: orphans.map((orphan) => orphan.path),
      size: partial,
      count: orphans.length,
      lastUsed: Math.max(...orphans.map((orphan) => orphan.newest)),
      junk: 'orphan',
      safety: 'safe',
      removal: 'trash',
      recheck,
    });
  }
  return items;
}

const huggingFace = collector('hugging-face', async (ctx) => {
  const home = hfHome(ctx);
  const hub = envDir(ctx, 'HF_HUB_CACHE') ?? envDir(ctx, 'HUGGINGFACE_HUB_CACHE') ?? join(home, 'hub');
  const items: Found[] = [];
  for (const entry of await list(hub)) {
    const match = HF_REPO.exec(entry.name);
    if (entry.isDirectory() && match) {
      items.push(...(await hfRepo(ctx, join(hub, entry.name), match[1], match[2].split('--').join('/'))));
    }
  }
  // Shards e staging do hf_xet: a própria documentação manda apagar a pasta para recuperar espaço.
  const xet = envDir(ctx, 'HF_XET_CACHE') ?? join(home, 'xet');
  const measured = await ctx.measure(xet);
  items.push({
    tool: 'hugging-face',
    kind: 'cache',
    label: 'xet',
    project: null,
    path: xet,
    size: measured.size,
    count: measured.files,
    lastUsed: measured.newest,
    safety: 'safe',
    removal: 'trash',
  });
  return items;
});

// --- Jan e GPT4All -----------------------------------------------------------------------

const JAN = /\/Jan\.app\/Contents\//;
const GPT4ALL = /\/gpt4all\.app\/Contents\//i;

/** Pastas de modelo do Jan: as que têm model.yml ou um GGUF, até três níveis abaixo (<org>/<repo> ou <id>). */
async function janModelFolders(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, level: number): Promise<void> => {
    const entries = await list(dir);
    if (level > 0 && entries.some((entry) => entry.isFile() && (entry.name === 'model.yml' || entry.name.endsWith('.gguf')))) {
      found.push(dir);
      return;
    }
    if (level >= 3) return;
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) await walk(join(dir, entry.name), level + 1);
    }
  };
  await walk(root, 0);
  return found;
}

const jan = collector('jan', async (ctx) => {
  const data = join(ctx.home, 'Library/Application Support/Jan/data');
  const closed = whenClosed(ctx, JAN);
  const items: Found[] = [];
  for (const engine of ['llamacpp', 'mlx']) {
    const root = join(data, engine, 'models');
    for (const path of await janModelFolders(root)) {
      const { size, newest, files } = await ctx.measure(path);
      items.push(modelItem('jan', { label: relative(root, path), path, size, count: files, lastUsed: newest, ...closed }));
    }
  }
  return items;
});

async function gpt4allModels(ctx: AiContext): Promise<string> {
  // Do GPT4All.ini só a linha da pasta de modelos.
  const ini = await readFile(join(ctx.home, '.config/gpt4all.io/GPT4All.ini'), 'utf8').catch(() => '');
  const custom = /^modelPath=(.+)$/m.exec(ini)?.[1].trim().replace(/^"(.*)"$/, '$1');
  return custom?.startsWith('/') ? resolve(custom) : join(ctx.home, 'Library/Application Support/nomic.ai/GPT4All');
}

/** Os chats (gpt4all-*.chat) e o banco do LocalDocs moram na mesma pasta: só os pesos entram. */
const gpt4all = collector('gpt4all', async (ctx) => {
  const dir = await gpt4allModels(ctx);
  const closed = whenClosed(ctx, GPT4ALL);
  const items: Found[] = [];
  for (const entry of await list(dir)) {
    if (!entry.isFile() || !/\.(gguf|bin)$/i.test(entry.name)) continue;
    const path = join(dir, entry.name);
    const { size, newest } = await ctx.measure(path);
    if (entry.name.startsWith('incomplete-')) {
      // Download que o app largou no meio; com o app aberto pode estar baixando.
      items.push({
        tool: 'gpt4all',
        kind: 'cache',
        label: entry.name.slice('incomplete-'.length),
        project: null,
        path,
        size,
        count: 1,
        lastUsed: newest,
        junk: 'orphan',
        safety: 'safe',
        removal: 'trash',
        ...closed,
      });
      continue;
    }
    items.push(modelItem('gpt4all', { label: entry.name, path, size, count: 1, lastUsed: newest, ...closed }));
  }
  return items;
});

// --- Chrome (Gemini Nano) ----------------------------------------------------------------

/** Pasta de dados e app de cada canal; cada um baixa a sua cópia do modelo. */
const CHROME_CHANNELS = [
  ['Chrome', 'Google Chrome'],
  ['Chrome Beta', 'Google Chrome Beta'],
  ['Chrome Dev', 'Google Chrome Dev'],
  ['Chrome Canary', 'Google Chrome Canary'],
] as const;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Do Local State só a parte da IA no dispositivo: o último uso por recurso, em microssegundos
 * desde 1601 (é por ele que o próprio Chrome despeja o modelo), e o nome de cada modelo
 * baixado por manifesto. Uso pode ser automático (alerta de golpe), não só pedido de alguém.
 */
async function chromeAiState(dataDir: string): Promise<{ lastUse: number; assets: Record<string, string> }> {
  const state = await readJson(join(dataDir, 'Local State'));
  const guide = isRecord(state) && isRecord(state.optimization_guide) ? state.optimization_guide : {};
  const execution = isRecord(guide.model_execution) ? guide.model_execution : {};
  let lastUse = 0;
  for (const value of Object.values(isRecord(execution.last_usage_by_feature) ? execution.last_usage_by_feature : {})) {
    // Pode vir 'uninstall_requested' no lugar da data.
    const micros = typeof value === 'string' || typeof value === 'number' ? Number(value) : NaN;
    if (Number.isFinite(micros) && micros > 0) lastUse = Math.max(lastUse, Math.round(micros / 1000 - CHROME_EPOCH_MS));
  }
  const assets: Record<string, string> = {};
  for (const [key, entry] of Object.entries(isRecord(execution.manifest_asset_ledger) ? execution.manifest_asset_ledger : {})) {
    if (isRecord(entry) && typeof entry.asset_id === 'string') assets[key] = entry.asset_id;
  }
  return { lastUse, assets };
}

/**
 * O Gemini Nano (OptGuideOnDeviceModel) e os modelos novos baixados por manifesto
 * (OptGuideManifestModel/<chave>). Os modelos pequenos do Chrome não entram: voltam sozinhos.
 * Apagar à mão só adianta com a IA no dispositivo desligada; senão o Chrome baixa tudo de novo.
 */
const chromeAi = collector('chrome-ai', async (ctx) => {
  const items: Found[] = [];
  for (const [channel, app] of CHROME_CHANNELS) {
    const dataDir = join(ctx.home, 'Library/Application Support/Google', channel);
    const folders: Array<{ path: string; label: string }> = [];
    const nano = join(dataDir, 'OptGuideOnDeviceModel');
    const versions = (await list(nano)).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    if (versions.length) folders.push({ path: nano, label: `${channel} ${versions.sort(byVersion).join(', ')}` });
    const manifestModels = join(dataDir, 'OptGuideManifestModel');
    const keys = (await list(manifestModels)).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    if (folders.length === 0 && keys.length === 0) continue;

    const { lastUse, assets } = await chromeAiState(dataDir);
    for (const key of keys) {
      folders.push({ path: join(manifestModels, key), label: `${channel} ${assets[key] ?? key.slice(0, 12)}` });
    }
    const closed = whenClosed(ctx, new RegExp(`/${escapeRegExp(app)}\\.app/Contents/MacOS/`));
    for (const { path, label } of folders) {
      const { size, newest, files } = await ctx.measure(path);
      items.push(
        modelItem('chrome-ai', {
          label,
          path,
          size,
          count: files,
          lastUsed: lastUse || newest,
          confidence: lastUse ? 'high' : 'low',
          hint: 'chrome-ai',
          ...closed,
        })
      );
    }
  }
  return items;
});

// --- rembg, PyTorch Hub e Whisper --------------------------------------------------------

/** Um arquivo por modelo, sem registro de uso: o mtime é a data do download. */
async function looseModels(ctx: AiContext, tool: AiToolId, dir: string, pattern: RegExp): Promise<Found[]> {
  const items: Found[] = [];
  for (const entry of await list(dir)) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    const path = join(dir, entry.name);
    const { size, newest } = await ctx.measure(path);
    items.push(modelItem(tool, { label: entry.name, path, size, count: 1, lastUsed: newest }));
  }
  return items;
}

const rembg = collector('rembg', (ctx) =>
  looseModels(ctx, 'rembg', envDir(ctx, 'U2NET_HOME') ?? join(envDir(ctx, 'XDG_DATA_HOME') ?? ctx.home, '.u2net'), /\.onnx$/i)
);

const whisper = collector('whisper', (ctx) => looseModels(ctx, 'whisper', join(cacheHome(ctx), 'whisper'), /\.pt$/i));

/** Pesos em hub/checkpoints e, ao lado, o código de cada repositório que o torch.hub baixou. */
const torch = collector('torch', async (ctx) => {
  const torchHome = envDir(ctx, 'TORCH_HOME');
  const hub = torchHome ? join(torchHome, 'hub') : join(cacheHome(ctx), 'torch/hub');
  const items = await looseModels(ctx, 'torch', join(hub, 'checkpoints'), /^[^.]/);
  for (const entry of await list(hub)) {
    if (!entry.isDirectory() || entry.name === 'checkpoints' || entry.name.startsWith('.')) continue;
    const path = join(hub, entry.name);
    const { size, newest, files } = await ctx.measure(path);
    items.push(modelItem('torch', { kind: 'cache', safety: 'safe', label: entry.name, path, size, count: files, lastUsed: newest }));
  }
  return items;
});

export const modelCollectors: Collector[] = [
  lmStudio,
  ollamaCollector(),
  huggingFace,
  jan,
  gpt4all,
  chromeAi,
  rembg,
  torch,
  whisper,
];
