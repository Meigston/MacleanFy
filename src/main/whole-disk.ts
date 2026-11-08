import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { lstat, readdir, readFile, stat, statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import {
  WHOLE_SEGMENTS,
  type HomeShareDTO,
  type HomeShareId,
  type WholeDiskDTO,
  type WholeDiskProgress,
  type WholeGroup,
  type WholePartDTO,
  type WholePhase,
  type WholeSegmentDTO,
  type WholeSegmentId,
} from '../shared/api';
import { parseDuError, parseDuLine, type DiskMap } from './disk';
import {
  BOOT_ROLES,
  CAPACITY_SCRIPT,
  parseApfsContainer,
  parseCapacity,
  parseDiskInfo,
  parseFirmlinks,
  parseLocalSnapshots,
  purgeableBytes,
  volumeOf,
  type ApfsContainer,
} from './volume';

/**
 * O disco inteiro, do jeito que o APFS conta.
 *
 * O que é do sistema sai dos volumes do contêiner de `/`, na hora e sem senha:
 * macOS (o volume selado), inicialização e recuperação, memória virtual. O volume
 * de dados é separado por duas medidas com `du`: uma fora da pasta pessoal (uma
 * execução só, ~20 s) e a passada da pasta pessoal que o explorador já faz. O que
 * nenhuma alcança — o que o macOS nega, snapshots, outras contas — fica com nome
 * próprio, "protegido e não identificado", em vez de espalhado pelos outros.
 *
 * Nada aqui pede senha nem entra na pasta pessoal por conta própria: o `du` de
 * fora pula `/Users/<conta>`, `/Volumes` e o autofs, e a pasta pessoal só é
 * medida quando alguém pede.
 */

export const DATA_ROOT = '/System/Volumes/Data';

/** Acima disso o volume de dados mudou o bastante para a medida não valer mais. */
const STALE_BYTES = 1e9;
/** Uma medida mais nova que isso é reaproveitada num novo pedido de medir. */
const REUSE_MS = 10 * 60 * 1000;
/** A página remonta a cada visita: leituras dos volumes mais próximas que isso são a mesma. */
const VOLUMES_REUSE_MS = 5000;
/** A pasta temporária da conta fica a quatro níveis de `private`. */
const OUTSIDE_DEPTH = 4;
const COMMAND_TIMEOUT_MS = 10_000;
const PROGRESS_MS = 250;
const DENIED_LIMIT = 500;
/** Uma subpasta com mais que isso da parte não diz nada sozinha: desce-se para dentro dela. */
const DESCEND_SHARE = 0.8;
const TOP_COUNT = 3;
/** Subpasta menor que isso não ajuda a achar o espaço. */
const TOP_MIN_BYTES = 100e6;

/** Pastas do volume de dados que aparecem na raiz, se `/usr/share/firmlinks` não puder ser lido. */
export const DEFAULT_FIRMLINKS: readonly string[] = [
  'AppleInternal',
  'Applications',
  'Library',
  'System/Library/Caches',
  'System/Library/Assets',
  'System/Library/PreinstalledAssets',
  'System/Library/AssetsV2',
  'System/Library/PreinstalledAssetsV2',
  'System/Library/Speech',
  'Users',
  'Volumes',
  'cores',
  'opt',
  'private',
  'usr/local',
];

// ---------------------------------------------------------------------------
// Fora da pasta pessoal
// ---------------------------------------------------------------------------

export type OutsideTarget = 'vm' | 'system-data' | 'caches' | 'dev' | 'apps' | 'others';

const TOP: Record<string, OutsideTarget | 'users' | 'skip'> = {
  Applications: 'apps',
  Library: 'apps',
  opt: 'dev',
  sw: 'dev',
  usr: 'dev',
  private: 'system-data',
  System: 'system-data',
  Users: 'users',
  // Pontos de montagem e autofs: entrar neles abriria pedidos de volumes removíveis e de rede.
  Volumes: 'skip',
  home: 'skip',
  Network: 'skip',
  '.PreviousSystemInformation': 'system-data',
  '.com.apple.templatemigration.boot-install': 'system-data',
};

/**
 * Para onde vai uma pasta da raiz do volume de dados. Uma pasta desconhecida é
 * do sistema — uma pasta nova do macOS nunca pode virar "dá para mexer" — e as
 * ocultas que o macOS nega (Spotlight, fseventsd, versões) nem entram no du.
 */
export function classifyTop(name: string): OutsideTarget | 'users' | 'skip' {
  if (Object.hasOwn(TOP, name)) return TOP[name];
  return name.startsWith('.') ? 'skip' : 'system-data';
}

export interface TopEntry {
  name: string;
  /** No mesmo volume que a raiz: um ponto de montagem ou outro disco não entra. */
  sameDevice: boolean;
  symlink: boolean;
  directory: boolean;
}

export interface Operand {
  path: string;
  segment: OutsideTarget;
}

/**
 * O que o du de fora mede: as pastas da raiz do volume de dados e cada entrada de
 * `/Users` que não é a conta. Nunca a raiz, `/Users` inteira, nem nada que contenha
 * a pasta pessoal.
 */
export function outsideOperands(
  top: TopEntry[],
  users: TopEntry[],
  account: string | null,
  home: string,
  dataRoot = DATA_ROOT
): Operand[] {
  // O disco de inicialização não diferencia maiúsculas: /Users/Ana e /Users/ana são a mesma pasta.
  const homes = [home, dataRoot + home].map((entry) => entry.toLowerCase());
  const holdsHome = (path: string) => {
    const lower = path.toLowerCase();
    return homes.some((entry) => entry === lower || entry.startsWith(lower + '/'));
  };
  const own = account?.toLowerCase() ?? null;
  const usable = (entry: TopEntry) => entry.sameDevice && entry.directory && !entry.symlink;
  const out: Operand[] = [];

  for (const entry of top) {
    if (!usable(entry)) continue;
    const kind = classifyTop(entry.name);
    if (kind === 'skip') continue;
    if (kind === 'users') {
      for (const user of users) {
        if (user.name.toLowerCase() === own || user.name.startsWith('.') || !usable(user)) continue;
        const path = join(dataRoot, 'Users', user.name);
        if (!holdsHome(path)) out.push({ path, segment: 'others' });
      }
      continue;
    }
    const path = join(dataRoot, entry.name);
    if (!holdsHome(path)) out.push({ path, segment: kind });
  }
  return out;
}

/** A pasta da conta em /var/folders, a partir do `os.tmpdir()` (`/var/folders/9z/abc/T`). */
export function userVarFolder(tmp: string, dataRoot = DATA_ROOT): string | null {
  const match = /^\/(?:private\/)?var\/folders\/([^/]+)\/([^/]+)\/T\/?$/.exec(tmp);
  return match ? join(dataRoot, 'private', 'var', 'folders', match[1], match[2]) : null;
}

export interface Carve {
  path: string;
  segment: OutsideTarget;
}

/** Pastas que saem do segmento da raiz delas para outro; nenhuma fica dentro de outra. */
export function outsideCarves(dataRoot: string, varFolder: string | null, sizes: ReadonlyMap<string, number>): Carve[] {
  const carves: Carve[] = [
    { path: join(dataRoot, 'Library', 'Developer'), segment: 'dev' },
    { path: join(dataRoot, 'Library', 'Caches'), segment: 'caches' },
    { path: join(dataRoot, 'private', 'tmp'), segment: 'caches' },
    { path: join(dataRoot, 'private', 'var', 'tmp'), segment: 'caches' },
    { path: join(dataRoot, 'private', 'var', 'vm'), segment: 'vm' },
  ];
  if (varFolder) carves.push({ path: varFolder, segment: 'caches' });
  // Os simuladores do iOS que o Xcode baixa moram entre os recursos do sistema.
  const assets = join(dataRoot, 'System', 'Library', 'AssetsV2');
  for (const path of sizes.keys()) {
    if (dirname(path) === assets && /SimulatorRuntime$/i.test(basename(path))) carves.push({ path, segment: 'dev' });
  }
  return carves;
}

/**
 * O caminho como aparece no Finder: o que é firmlink do volume de dados aparece
 * na raiz. Uma pasta que só guarda firmlinks (`usr`, `System`) aparece pelo
 * ancestral comum deles — `/usr`, `/System/Library` —, que é onde o Finder mostra
 * o conteúdo dela.
 */
export function visiblePath(path: string, firmlinks: readonly string[], dataRoot = DATA_ROOT): string {
  if (!path.startsWith(dataRoot + '/')) return path;
  const relative = path.slice(dataRoot.length + 1);
  if (firmlinks.some((link) => relative === link || relative.startsWith(link + '/'))) return '/' + relative;
  const below = firmlinks.filter((link) => link.startsWith(relative + '/')).map((link) => link.split('/'));
  if (below.length === 0) return path;
  const common: string[] = [];
  for (let index = 0; below.every((parts) => parts.length > index + 1 && parts[index] === below[0][index]); index++) {
    common.push(below[0][index]);
  }
  return '/' + common.join('/');
}

export interface OutsidePart {
  /** O caminho no volume de dados, como o du o leu. */
  path: string;
  bytes: number;
}

export interface OutsideSegment {
  bytes: number;
  parts: OutsidePart[];
  top: Array<{ path: string; bytes: number }>;
  partial: boolean;
}

export interface OutsideMeasure {
  segments: Map<OutsideTarget, OutsideSegment>;
  /** Σ das raízes medidas; é igual à soma dos segmentos. */
  total: number;
  at: number;
}

const isUnder = (path: string, parent: string) => path === parent || path.startsWith(parent + '/');

/** Reparte o que o du de fora mediu entre os segmentos, sem contar nada duas vezes. */
export function classifyOutside(
  sizes: ReadonlyMap<string, number>,
  operands: Operand[],
  carves: Carve[],
  denied: readonly string[],
  at: number
): OutsideMeasure {
  const segments = new Map<OutsideTarget, OutsideSegment>();
  const segment = (id: OutsideTarget) => {
    let found = segments.get(id);
    if (!found) segments.set(id, (found = { bytes: 0, parts: [], top: [], partial: false }));
    return found;
  };

  const children = new Map<string, string[]>();
  for (const path of sizes.keys()) {
    const parent = dirname(path);
    const list = children.get(parent);
    if (list) list.push(path);
    else children.set(parent, [path]);
  }
  const carved = new Set(carves.map((carve) => carve.path));
  /** O tamanho de uma pasta sem o que foi recortado dela para outro segmento. */
  const net = (path: string) =>
    (sizes.get(path) ?? 0) -
    carves.reduce((sum, carve) => (carve.path.startsWith(path + '/') ? sum + (sizes.get(carve.path) ?? 0) : sum), 0);

  let total = 0;
  for (const operand of operands) {
    const bytes = sizes.get(operand.path) ?? 0;
    total += bytes;
    const inside = carves.filter((carve) => carve.path.startsWith(operand.path + '/'));
    let carvedBytes = 0;
    for (const carve of inside) {
      const size = sizes.get(carve.path) ?? 0;
      carvedBytes += size;
      if (size > 0) segment(carve.segment).parts.push({ path: carve.path, bytes: size });
    }
    segment(operand.segment).parts.push({ path: operand.path, bytes: Math.max(0, bytes - carvedBytes) });
  }

  for (const [, entry] of segments) {
    entry.parts = entry.parts.filter((part) => part.bytes > 0).sort((a, b) => b.bytes - a.bytes);
    entry.bytes = entry.parts.reduce((sum, part) => sum + part.bytes, 0);

    // As maiores subpastas de cada parte; se uma sozinha tem quase tudo, o que importa está dentro dela.
    const inside = (path: string) =>
      (children.get(path) ?? []).filter((child) => !carved.has(child)).map((child) => ({ path: child, bytes: net(child) }));
    const candidates = entry.parts.flatMap((part) => {
      let list = inside(part.path);
      for (let depth = 0; depth < 4; depth++) {
        list.sort((a, b) => b.bytes - a.bytes);
        const [first] = list;
        const deeper = first ? inside(first.path) : [];
        if (!first || first.bytes <= DESCEND_SHARE * part.bytes || deeper.length === 0) break;
        list = [...deeper, ...list.slice(1)];
      }
      return list;
    });
    entry.top = candidates
      .filter((candidate) => candidate.bytes >= TOP_MIN_BYTES)
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, TOP_COUNT);
  }

  for (const path of denied) {
    const carve = carves.filter((entry) => isUnder(path, entry.path)).sort((a, b) => b.path.length - a.path.length)[0];
    const operand = operands.find((entry) => isUnder(path, entry.path));
    const id = carve?.segment ?? operand?.segment;
    if (id) segment(id).partial = true;
  }

  return { segments, total, at };
}

// ---------------------------------------------------------------------------
// Dentro da pasta pessoal
// ---------------------------------------------------------------------------

type RuleShare = Exclude<HomeShareId, 'photos' | 'app-data' | 'rest'>;

/** Pastas da conta que têm dono conhecido. Nenhuma fica dentro de outra, e todas estão a até três níveis. */
export const HOME_RULES: ReadonlyArray<{ rel: string; share: RuleShare }> = [
  ...[
    'Library/Developer',
    'Library/Android',
    'Library/pnpm',
    'Library/Containers/com.docker.docker',
    'Library/Group Containers/group.com.docker',
    '.android',
    '.gradle',
    '.npm',
    '.pnpm-store',
    '.nuget',
    '.dotnet',
    '.cargo',
    '.rustup',
    '.m2',
    '.cocoapods',
    '.docker',
    '.orbstack',
    '.colima',
    '.lima',
    '.nvm',
    '.bun',
    '.pub-cache',
  ].map((rel) => ({ rel, share: 'dev' as const })),
  ...['.claude', '.codex', '.cursor', '.ollama', '.lmstudio', '.cache/huggingface'].map((rel) => ({ rel, share: 'ai' as const })),
  { rel: 'Library/Caches', share: 'caches' },
  { rel: 'Library/Mobile Documents', share: 'icloud' },
  { rel: 'Library/CloudStorage', share: 'icloud' },
  { rel: 'Library/Mail', share: 'mail' },
  { rel: 'Library/Containers/com.apple.mail', share: 'mail' },
  { rel: 'Library/Messages', share: 'messages' },
  { rel: '.Trash', share: 'trash' },
];

/**
 * A pasta pessoal em fatias que somam a pasta inteira: as pastas de dono
 * conhecido, a fototeca, o resto da Biblioteca (dados de apps) e o resto da conta.
 */
export function carveHome(sizes: ReadonlyMap<string, number>, home: string, denied: readonly string[]): HomeShareDTO[] {
  const byLower = new Map<string, string>();
  for (const key of sizes.keys()) if (isUnder(key, home)) byLower.set(key.toLowerCase(), key);

  const shares = new Map<HomeShareId, HomeShareDTO>();
  const share = (id: HomeShareId) => {
    let found = shares.get(id);
    if (!found) shares.set(id, (found = { id, bytes: 0, paths: [], partial: false }));
    return found;
  };
  const taken: Array<{ path: string; share: HomeShareId }> = [];
  const take = (path: string, id: HomeShareId) => {
    const bytes = sizes.get(path) ?? 0;
    taken.push({ path, share: id });
    const entry = share(id);
    entry.bytes += bytes;
    if (bytes > 0) entry.paths.push({ path, bytes });
  };

  for (const rule of HOME_RULES) {
    const key = byLower.get(join(home, rule.rel).toLowerCase());
    if (key) take(key, rule.share);
  }
  const pictures = join(home, 'Pictures').toLowerCase();
  for (const key of sizes.keys()) {
    if (dirname(key).toLowerCase() === pictures && /\.photoslibrary$/i.test(key)) take(key, 'photos');
  }

  const library = byLower.get(join(home, 'Library').toLowerCase());
  const libraryBytes = library ? (sizes.get(library) ?? 0) : 0;
  const insideLibrary = taken.filter((entry) => library && isUnder(entry.path, library));
  const appData = Math.max(0, libraryBytes - insideLibrary.reduce((sum, entry) => sum + (sizes.get(entry.path) ?? 0), 0));
  share('app-data').bytes = appData;
  if (library && appData > 0) share('app-data').paths.push({ path: library, bytes: appData });

  const outsideLibrary = taken.filter((entry) => !(library && isUnder(entry.path, library)));
  const total = sizes.get(home) ?? 0;
  const rest = Math.max(0, total - libraryBytes - outsideLibrary.reduce((sum, entry) => sum + (sizes.get(entry.path) ?? 0), 0));
  share('rest').bytes = rest;
  if (rest > 0) share('rest').paths.push({ path: home, bytes: rest });

  // O du não imprime a pasta que o macOS negou: o dono dela sai das regras, medida ou não.
  const owners = [
    ...HOME_RULES.map((rule) => ({ path: join(home, rule.rel).toLowerCase(), share: rule.share as HomeShareId })),
    ...taken.map((entry) => ({ path: entry.path.toLowerCase(), share: entry.share })),
  ];
  const libraryPath = join(home, 'Library').toLowerCase();
  for (const path of denied) {
    const lower = path.toLowerCase();
    if (!isUnder(lower, home.toLowerCase())) continue;
    const owner = owners.filter((entry) => isUnder(lower, entry.path)).sort((a, b) => b.path.length - a.path.length)[0];
    const photos = dirname(lower) === pictures && /\.photoslibrary$/.test(lower);
    share(owner?.share ?? (photos ? 'photos' : isUnder(lower, libraryPath) ? 'app-data' : 'rest')).partial = true;
  }

  const order: HomeShareId[] = ['dev', 'ai', 'caches', 'icloud', 'photos', 'mail', 'messages', 'trash', 'app-data', 'rest'];
  return order
    .map((id) => shares.get(id))
    .filter((entry): entry is HomeShareDTO => entry !== undefined && (entry.bytes > 0 || entry.partial))
    .map((entry) => ({ ...entry, paths: entry.paths.sort((a, b) => b.bytes - a.bytes) }))
    .sort((a, b) => b.bytes - a.bytes);
}

// ---------------------------------------------------------------------------
// A conta
// ---------------------------------------------------------------------------

const GROUP: Record<WholeSegmentId, WholeGroup> = {
  macos: 'system',
  boot: 'system',
  vm: 'system',
  'system-data': 'system',
  unknown: 'unknown',
  pending: 'unknown',
  caches: 'yours',
  dev: 'yours',
  home: 'yours',
  apps: 'yours',
  others: 'yours',
  'other-volumes': 'yours',
};

export interface AssembleInput {
  /** O contêiner de `/` e os dispositivos do sistema e do volume de dados. */
  apfs: { container: ApfsContainer; system: string; data: string } | null;
  /** Reserva quando o APFS não respondeu; `dataUsed` é o usado do volume de dados (blocks − bfree). */
  statfs: { total: number; free: number; dataUsed: number | null };
  volumeName: string;
  purgeable: number | null;
  snapshots: string[];
  outside: OutsideMeasure | null;
  home: { bytes: number; shares: HomeShareDTO[]; partial: boolean; at: number } | null;
  homeOnData: boolean;
  homePath: string;
  phases: WholeDiskDTO['phases'];
  /** O volume de dados no fim da última medida, base para saber se ela ficou para trás. */
  dataAtMeasure: number | null;
  changedAt: number | null;
  otherAccounts: number;
  fullDiskAccess: boolean;
  /** Caminho visível de um caminho do volume de dados. */
  visible: (path: string) => string;
}

export function isStale(drift: number, changedAt: number | null, measuredAt: number | null): boolean {
  if (measuredAt === null) return false;
  return Math.abs(drift) > STALE_BYTES || (changedAt !== null && changedAt > measuredAt);
}

/** Do IPC só se aceita `true` de verdade: qualquer outra coisa não mede nada. */
export function wholeOptions(raw: unknown): { measure: boolean; refresh: boolean } {
  const options = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  return { measure: options.measure === true, refresh: options.refresh === true };
}

/** Junta os volumes e as medidas num disco cuja conta fecha em bytes. */
export function assemble(input: AssembleInput): WholeDiskDTO {
  const segments = new Map<WholeSegmentId, WholeSegmentDTO>();
  const add = (id: WholeSegmentId, part: WholePartDTO, extra?: Partial<Pick<WholeSegmentDTO, 'top' | 'partial'>>) => {
    if (part.bytes <= 0 && !extra?.partial) return;
    let entry = segments.get(id);
    if (!entry) segments.set(id, (entry = { id, group: GROUP[id], bytes: 0, parts: [], top: [], partial: false }));
    entry.bytes += part.bytes;
    if (part.bytes > 0) entry.parts.push(part);
    if (extra?.top) entry.top.push(...extra.top);
    if (extra?.partial) entry.partial = true;
  };

  let total: number;
  let free: number;
  let data: number;
  let systemVolumes: number;
  let otherVolumes = 0;
  let overhead = 0;
  let mode: WholeDiskDTO['mode'] = 'apfs';

  const system = input.apfs ? volumeOf(input.apfs.system, input.apfs.container.volumes) : null;
  const dataVolume = input.apfs ? volumeOf(input.apfs.data, input.apfs.container.volumes) : null;

  if (input.apfs && system && dataVolume && system !== dataVolume) {
    const { container } = input.apfs;
    total = container.ceiling;
    free = container.free;
    data = dataVolume.inUse;
    const inUse = container.volumes.reduce((sum, volume) => sum + volume.inUse, 0);
    overhead = Math.max(0, total - free - inUse);

    add('macos', { label: system.name, bytes: system.inUse, source: 'apfs' });
    for (const volume of container.volumes) {
      if (volume === system || volume === dataVolume) continue;
      const part: WholePartDTO = { label: volume.name, bytes: volume.inUse, source: 'apfs' };
      if (volume.roles.some((role) => BOOT_ROLES.includes(role))) add('boot', part);
      else if (volume.roles.includes('VM')) add('vm', part);
      else {
        // Outro macOS, um volume sem papel ou um papel que ainda não existe: é da pessoa decidir.
        add('other-volumes', part);
        otherVolumes += volume.inUse;
      }
    }
    add('boot', { label: '', bytes: overhead, source: 'apfs', special: 'structure' });
    systemVolumes = total - free - data - otherVolumes;
  } else {
    mode = 'basic';
    total = input.statfs.total;
    free = input.statfs.free;
    const used = Math.max(0, total - free);
    data = input.statfs.dataUsed !== null ? Math.min(used, input.statfs.dataUsed) : used;
    systemVolumes = used - data;
    add('macos', { label: input.volumeName, bytes: systemVolumes, source: 'statfs' });
  }

  const outside = input.outside;
  if (outside) {
    for (const [id, entry] of outside.segments) {
      const extra = {
        top: entry.top.map((top) => ({ label: input.visible(top.path), path: input.visible(top.path), bytes: top.bytes })),
        partial: entry.partial,
      };
      // Sem nenhuma parte medida, a marca de parcial ainda diz que há algo ali que o macOS negou.
      if (entry.parts.length === 0) add(id, { label: '', bytes: 0, source: 'du' }, extra);
      entry.parts.forEach((part, index) =>
        add(
          id,
          { label: input.visible(part.path), path: input.visible(part.path), bytes: part.bytes, source: 'du' },
          index === 0 ? extra : undefined
        )
      );
    }
  }
  const home = input.homeOnData ? input.home : null;
  if (home) add('home', { label: '~', path: input.homePath, bytes: home.bytes, source: 'du' }, { partial: home.partial });

  const measured = (outside?.total ?? 0) + (home?.bytes ?? 0);
  const rest = data - measured;
  const bothDone = outside !== null && (home !== null || !input.homeOnData);
  add(bothDone ? 'unknown' : 'pending', { label: '', bytes: Math.max(0, rest), source: 'rest' });
  const overcount = Math.max(0, -rest);

  const measuredAt = bothDone ? Math.min(outside!.at, home?.at ?? outside!.at) : null;
  const drift = input.dataAtMeasure !== null && measuredAt !== null ? data - input.dataAtMeasure : 0;

  for (const entry of segments.values()) {
    entry.parts.sort((a, b) => b.bytes - a.bytes);
    entry.top.sort((a, b) => b.bytes - a.bytes);
    entry.top = entry.top.slice(0, TOP_COUNT);
  }

  return {
    volumeName: input.volumeName,
    mode,
    total,
    free,
    purgeable: input.purgeable,
    snapshots: input.snapshots,
    data,
    systemVolumes,
    otherVolumes,
    overhead,
    segments: WHOLE_SEGMENTS.map((id) => segments.get(id)).filter(
      (entry): entry is WholeSegmentDTO => entry !== undefined && (entry.bytes > 0 || entry.partial)
    ),
    home: home ? home.shares : null,
    homePath: input.homePath,
    phases: input.phases,
    measuredAt,
    overcount,
    drift,
    stale: isStale(drift, input.changedAt, measuredAt),
    homeElsewhere: !input.homeOnData,
    otherAccounts: input.otherAccounts,
    fullDiskAccess: input.fullDiskAccess,
  };
}

// ---------------------------------------------------------------------------
// As medidas
// ---------------------------------------------------------------------------

/** Roda um comando e devolve o stdout; `input` vai pelo stdin. */
export type Runner = (file: string, args: string[], input?: string) => Promise<string>;

const run: Runner = (file, args, input) =>
  new Promise((resolve, reject) => {
    const child = execFile(file, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout)
    );
    child.stdin?.end(input ?? '');
  });

interface Volumes {
  apfs: AssembleInput['apfs'];
  statfs: AssembleInput['statfs'];
  volumeName: string;
  purgeable: number | null;
  snapshots: string[];
}

export interface WholeDiskDeps {
  run?: Runner;
  du?: string;
  dataRoot?: string;
  tmpdir?: string;
  firmlinks?: string;
  now?: () => number;
  fullDiskAccess?: () => Promise<boolean>;
}

export class WholeDisk {
  private readonly run: Runner;
  private readonly du: string;
  private readonly dataRoot: string;
  private readonly tmp: string;
  private readonly firmlinksFile: string;
  private readonly now: () => number;
  private readonly fullDiskAccess: () => Promise<boolean>;

  private volumes: { at: number; value: Volumes } | null = null;
  private outside: OutsideMeasure | null = null;
  private outsideTask: { child: ChildProcess | null; done: Promise<void> } | null = null;
  private outsideFailed = false;
  private homeTask: Promise<void> | null = null;
  private homeFailed = false;
  private dataAtMeasure: number | null = null;
  private changedAt: number | null = null;
  private firmlinks: readonly string[] | null = null;
  private onData: boolean | null = null;
  private accounts = 0;
  private known = new Set<string>();

  constructor(
    private readonly disk: DiskMap,
    deps: WholeDiskDeps = {}
  ) {
    this.run = deps.run ?? run;
    this.du = deps.du ?? '/usr/bin/du';
    this.dataRoot = deps.dataRoot ?? DATA_ROOT;
    this.tmp = deps.tmpdir ?? tmpdir();
    this.firmlinksFile = deps.firmlinks ?? '/usr/share/firmlinks';
    this.now = deps.now ?? Date.now;
    this.fullDiskAccess = deps.fullDiskAccess ?? (async () => true);
  }

  private get home(): string {
    return this.disk.homePath;
  }

  /**
   * O disco agora. Sem `measure` nada é medido: só os volumes e o que já houver.
   * Com `measure`, mede o que falta ou ficou velho; com `refresh`, tudo de novo.
   */
  async read(
    options: { measure: boolean; refresh: boolean },
    onProgress?: (progress: WholeDiskProgress) => void
  ): Promise<WholeDiskDTO> {
    if (options.refresh) this.cancel(true);
    if (options.measure || options.refresh) {
      const now = this.now();
      // O volume de dados mudou mais que o limite desde a medida: nenhuma das duas vale mais.
      const current = this.dataAtMeasure === null ? null : this.dataOf(await this.readVolumes(false));
      const drifted = current !== null && this.dataAtMeasure !== null && Math.abs(current - this.dataAtMeasure) > STALE_BYTES;
      const fresh = (at: number | undefined) =>
        !drifted && at !== undefined && now - at < REUSE_MS && !(this.changedAt !== null && this.changedAt > at);
      const runs: Promise<void>[] = [];
      // Cada fase avisa logo de saída se começa, se segue a que já corria ou se foi reaproveitada.
      if (options.refresh || this.outsideTask || !fresh(this.outside?.at)) {
        if (!this.outsideTask) onProgress?.({ phase: 'outside', bytes: 0, path: '' });
        runs.push(
          this.measureOutside(onProgress).then(() => {
            if (this.outsideFailed) onProgress?.({ phase: 'outside', bytes: 0, path: '', failed: true });
            else if (this.outside) onProgress?.({ phase: 'outside', bytes: this.outside.total, path: '', done: true });
          })
        );
      } else if (this.outside) onProgress?.({ phase: 'outside', bytes: this.outside.total, path: '', done: true });

      const snapshot = this.disk.homeSnapshot();
      const onData = await this.homeOnData();
      if (onData && (options.refresh || this.homeTask || this.homeFailed || !fresh(snapshot?.at))) {
        if (!this.homeTask) onProgress?.({ phase: 'home', bytes: 0, path: '' });
        runs.push(
          this.measureHome(options.refresh || snapshot !== null, onProgress).then(() => {
            const measured = this.disk.homeSnapshot();
            if (this.homeFailed) onProgress?.({ phase: 'home', bytes: 0, path: '', failed: true });
            else if (measured) onProgress?.({ phase: 'home', bytes: measured.sizes.get(this.home) ?? 0, path: '', done: true });
          })
        );
      } else if (onData && snapshot) onProgress?.({ phase: 'home', bytes: snapshot.sizes.get(this.home) ?? 0, path: '', done: true });
      if (runs.length > 0) {
        await Promise.all(runs);
        const volumes = await this.readVolumes(true);
        this.dataAtMeasure = this.dataOf(volumes);
      }
    }
    return this.build();
  }

  /** Uma limpeza, desinstalação ou remoção mudou o disco: a medida de antes deixa de valer. */
  markChanged(at = this.now()): void {
    this.changedAt = at;
  }

  /** Só os caminhos que a última leitura mostrou vão ao Finder. */
  knows(path: string): boolean {
    return this.known.has(path);
  }

  /** Encerra o du de fora; com `withHome`, também a passada da pasta pessoal. */
  cancel(withHome = false): void {
    this.outsideTask?.child?.kill();
    this.outsideTask = null;
    if (withHome && this.homeTask) {
      this.disk.cancel();
      this.homeTask = null;
    }
  }

  private dataOf(volumes: Volumes): number | null {
    if (volumes.apfs) {
      const volume = volumeOf(volumes.apfs.data, volumes.apfs.container.volumes);
      if (volume) return volume.inUse;
    }
    return volumes.statfs.dataUsed;
  }

  private async homeOnData(): Promise<boolean> {
    if (this.onData === null) {
      try {
        const [home, data] = await Promise.all([stat(this.home), stat(this.dataRoot)]);
        this.onData = home.dev === data.dev;
      } catch {
        this.onData = false;
      }
    }
    return this.onData;
  }

  private async plist(args: string[]): Promise<unknown> {
    const xml = await this.run('/usr/sbin/diskutil', args);
    return JSON.parse(await this.run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], xml));
  }

  private async readVolumes(fresh: boolean): Promise<Volumes> {
    const now = this.now();
    if (!fresh && this.volumes && now - this.volumes.at < VOLUMES_REUSE_MS) return this.volumes.value;

    const [rootInfo, dataInfo, capacity, snapshots, rootFs, dataFs] = await Promise.all([
      this.plist(['info', '-plist', '/']).then(parseDiskInfo, () => null),
      this.plist(['info', '-plist', this.dataRoot]).then(parseDiskInfo, () => null),
      this.run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', CAPACITY_SCRIPT]).then(parseCapacity, () => null),
      this.run('/usr/bin/tmutil', ['listlocalsnapshots', '/']).then(parseLocalSnapshots, () => [] as string[]),
      statfs('/').catch(() => null),
      statfs(this.dataRoot).catch(() => null),
    ]);

    let apfs: Volumes['apfs'] = null;
    const reference = rootInfo?.container;
    const sameGroup = !rootInfo?.groupId || !dataInfo?.groupId || rootInfo.groupId === dataInfo.groupId;
    if (rootInfo && dataInfo && reference && /^disk\d+$/.test(reference) && dataInfo.container === reference && sameGroup) {
      const container = await this.plist(['apfs', 'list', '-plist', reference]).then(
        (json) => parseApfsContainer(json, reference),
        () => null
      );
      if (container && volumeOf(rootInfo.device, container.volumes) && volumeOf(dataInfo.device, container.volumes)) {
        apfs = { container, system: rootInfo.device, data: dataInfo.device };
      }
    }

    const value: Volumes = {
      apfs,
      statfs: {
        total: rootFs ? rootFs.blocks * rootFs.bsize : 0,
        free: rootFs ? rootFs.bavail * rootFs.bsize : 0,
        dataUsed: dataFs ? (dataFs.blocks - dataFs.bfree) * dataFs.bsize : null,
      },
      volumeName: rootInfo?.volumeName ?? '',
      purgeable: capacity ? purgeableBytes(capacity) : null,
      snapshots,
    };
    this.volumes = { at: now, value };
    return value;
  }

  private async readFirmlinks(): Promise<readonly string[]> {
    if (!this.firmlinks) {
      const parsed = await readFile(this.firmlinksFile, 'utf8').then(parseFirmlinks, () => []);
      this.firmlinks = parsed.length > 0 ? parsed : DEFAULT_FIRMLINKS;
    }
    return this.firmlinks;
  }

  private async describe(dir: string, name: string, device: number): Promise<TopEntry | null> {
    try {
      const stats = await lstat(join(dir, name));
      return { name, sameDevice: stats.dev === device, symlink: stats.isSymbolicLink(), directory: stats.isDirectory() };
    } catch {
      return null;
    }
  }

  private async operands(): Promise<Operand[]> {
    const device = (await stat(this.dataRoot)).dev;
    // O que não entra no du não é nem olhado: um lstat em ponto de autofs já pode montar algo.
    const names = (await readdir(this.dataRoot)).filter((name) => classifyTop(name) !== 'skip');
    const top = (await Promise.all(names.map((name) => this.describe(this.dataRoot, name, device)))).filter(
      (entry): entry is TopEntry => entry !== null
    );
    const usersDir = join(this.dataRoot, 'Users');
    const userNames = await readdir(usersDir).catch(() => [] as string[]);
    const users = (await Promise.all(userNames.map((name) => this.describe(usersDir, name, device)))).filter(
      (entry): entry is TopEntry => entry !== null && entry.directory
    );
    const account = dirname(this.home) === '/Users' ? basename(this.home) : null;
    const own = account?.toLowerCase();
    this.accounts = users.filter(
      (user) =>
        user.name.toLowerCase() !== own && user.name !== 'Shared' && user.name !== 'Deleted Users' && !user.name.startsWith('.')
    ).length;
    return outsideOperands(top, users, account, this.home, this.dataRoot);
  }

  private measureOutside(onProgress?: (progress: WholeDiskProgress) => void): Promise<void> {
    if (this.outsideTask) return this.outsideTask.done;
    const task: { child: ChildProcess | null; done: Promise<void> } = { child: null, done: Promise.resolve() };

    task.done = (async () => {
      // A medida vale para a hora em que começou: uma limpeza durante ela a deixa velha.
      const startedAt = this.now();
      try {
        const operands = await this.operands();
        if (this.outsideTask !== task) return;
        const { sizes, denied } = await this.runDu(operands, task, onProgress);
        if (this.outsideTask !== task) return;
        const carves = outsideCarves(this.dataRoot, userVarFolder(this.tmp, this.dataRoot), sizes);
        this.outside = classifyOutside(sizes, operands, carves, denied, startedAt);
        this.outsideFailed = false;
      } catch {
        // Cancelada, a medida só sai de cena; falha de verdade volta a "ainda não medido".
        if (this.outsideTask === task) {
          this.outside = null;
          this.outsideFailed = true;
        }
      } finally {
        if (this.outsideTask === task) this.outsideTask = null;
      }
    })();
    this.outsideTask = task;
    return task.done;
  }

  /** Uma execução só: o du conta cada arquivo com vários links uma vez por execução. */
  private runDu(
    operands: Operand[],
    task: { child: ChildProcess | null },
    onProgress?: (progress: WholeDiskProgress) => void
  ): Promise<{ sizes: Map<string, number>; denied: string[] }> {
    const sizes = new Map<string, number>();
    const denied: string[] = [];
    if (operands.length === 0) return Promise.resolve({ sizes, denied });

    const roots = new Set(operands.map((operand) => operand.path));
    const child = spawn(this.du, ['-k', '-x', '-d', String(OUTSIDE_DEPTH), ...roots], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, LC_ALL: 'C' },
    });
    task.child = child;

    return new Promise((resolve, reject) => {
      let buffer = '';
      let errors = '';
      let measured = 0;
      let last = 0;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const entry = parseDuLine(line);
          if (!entry) continue;
          sizes.set(entry.path, entry.size);
          if (roots.has(dirname(entry.path))) measured += entry.size;
          if (onProgress && this.now() - last > PROGRESS_MS) {
            last = this.now();
            onProgress({ phase: 'outside', bytes: measured, path: entry.path });
          }
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        errors += chunk;
        const lines = errors.split('\n');
        errors = lines.pop() ?? '';
        for (const line of lines) {
          const path = parseDuError(line);
          if (path && denied.length < DENIED_LIMIT) denied.push(path);
        }
      });
      child.on('error', reject);
      // Pastas negadas fazem o du sair com 1, e o resto da medida vale.
      child.on('close', (code, signal) => {
        if (signal || (code !== null && code > 1)) reject(new Error(signal ?? `du exited with ${code}`));
        else resolve({ sizes, denied });
      });
    });
  }

  private measureHome(refresh: boolean, onProgress?: (progress: WholeDiskProgress) => void): Promise<void> {
    if (this.homeTask) return this.homeTask;
    const task: Promise<void> = this.disk
      .list(undefined, { refresh }, (progress) => onProgress?.({ phase: 'home', bytes: progress.bytes, path: progress.path }))
      .then(
        () => {
          if (this.homeTask === task) this.homeFailed = false;
        },
        () => {
          if (this.homeTask === task) this.homeFailed = true;
        }
      )
      .finally(() => {
        if (this.homeTask === task) this.homeTask = null;
      });
    this.homeTask = task;
    return task;
  }

  private async build(): Promise<WholeDiskDTO> {
    const [volumes, homeOnData, fullDiskAccess, firmlinks] = await Promise.all([
      this.readVolumes(false),
      this.homeOnData(),
      this.fullDiskAccess().catch(() => true),
      this.readFirmlinks(),
    ]);
    const snapshot = homeOnData ? this.disk.homeSnapshot() : null;
    const home = snapshot
      ? {
          bytes: snapshot.sizes.get(this.home) ?? 0,
          shares: carveHome(snapshot.sizes, this.home, snapshot.denied),
          partial: snapshot.denied.length > 0,
          at: snapshot.at,
        }
      : null;
    const phase = (running: boolean, failed: boolean, done: boolean): WholePhase =>
      running ? 'running' : failed ? 'failed' : done ? 'done' : 'idle';

    const dto = assemble({
      ...volumes,
      outside: this.outside,
      home,
      homeOnData,
      homePath: this.home,
      phases: {
        outside: phase(this.outsideTask !== null, this.outsideFailed, this.outside !== null),
        home: homeOnData ? phase(this.homeTask !== null, this.homeFailed, snapshot !== null) : 'idle',
      },
      dataAtMeasure: this.dataAtMeasure,
      changedAt: this.changedAt,
      otherAccounts: this.accounts,
      fullDiskAccess,
      visible: (path) => visiblePath(path, firmlinks, this.dataRoot),
    });

    this.known = new Set(['/Users']);
    for (const segment of dto.segments) {
      for (const part of segment.parts) if (part.path) this.known.add(part.path);
      for (const top of segment.top) this.known.add(top.path);
    }
    for (const share of dto.home ?? []) for (const entry of share.paths) this.known.add(entry.path);
    return dto;
  }
}
