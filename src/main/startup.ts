import { execFile } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import type { StartupItemDTO, StartupScope, StartupWhen } from '../shared/api';

/**
 * O que o launchd abre sozinho: agentes ao entrar na conta, ajudantes que os apps
 * cadastram para abrir junto com ela e serviços do sistema ao ligar o Mac.
 *
 * Ligar e desligar mexe só na lista de desligados da sua sessão no launchd
 * (`launchctl enable`/`disable` em gui/<uid>), a mesma que os Ajustes usam: não
 * apaga nem edita plist e não pede senha. Serviços do sistema pediriam a senha de
 * administrador e ficam com Ajustes → Itens de Início. Apagar os quebrados da pasta
 * pessoal fica com a Limpeza, na categoria de launch agents órfãos.
 *
 * Os itens da Apple ficam de fora: são do sistema e não há o que decidir sobre eles.
 */

export const STARTUP_FOLDERS: Array<{ scope: StartupScope; dir: string }> = [
  { scope: 'user', dir: join(homedir(), 'Library', 'LaunchAgents') },
  { scope: 'agent', dir: '/Library/LaunchAgents' },
  { scope: 'daemon', dir: '/Library/LaunchDaemons' },
];

/**
 * Lê os plists pela API do Foundation, por JavaScript for Automation: ela entende
 * plist binário e XML, e o NSWorkspace acha o app dono pelo identificador. Os
 * caminhos chegam como argumentos, nunca dentro do script.
 */
export const PLIST_SCRIPT = `
ObjC.import('AppKit');
function run(argv) {
  const workspace = $.NSWorkspace.sharedWorkspace;
  const appFor = (id) => {
    if (typeof id !== 'string' || !id) return undefined;
    const url = workspace.URLForApplicationWithBundleIdentifier(id);
    return url.isNil() ? undefined : ObjC.unwrap(url.path);
  };
  return JSON.stringify(argv.map((path) => {
    const plist = $.NSDictionary.dictionaryWithContentsOfFile(path);
    // Alguns fabricantes deixam o plist legível só pelo root: sobra o nome do arquivo.
    if (plist.isNil()) return { path, unreadable: true, app: appFor(path.split('/').pop().replace(/\\.plist$/, '')) };
    const read = (key) => ObjC.deepUnwrap(plist.objectForKey(key));
    const args = read('ProgramArguments');
    const keepAlive = read('KeepAlive');
    const label = read('Label');
    const associated = [].concat(read('AssociatedBundleIdentifiers') ?? []);
    return {
      path,
      label,
      program: read('Program') ?? (Array.isArray(args) ? args[0] : undefined),
      runAtLoad: read('RunAtLoad') === true,
      keepAlive: keepAlive && typeof keepAlive === 'object' ? Object.keys(keepAlive) : keepAlive === true,
      scheduled: read('StartInterval') != null || read('StartCalendarInterval') != null,
      disabled: read('Disabled') === true,
      bundleIds: associated.filter((id) => typeof id === 'string'),
      app: associated.concat(label).map(appFor).find(Boolean),
    };
  }));
}
`;

/** Um plist como o script o devolve. */
export interface PlistReading {
  path: string;
  label?: string;
  program?: string;
  runAtLoad?: boolean;
  /** `true`, `false` ou as condições do dicionário KeepAlive. */
  keepAlive?: boolean | string[];
  scheduled?: boolean;
  disabled?: boolean;
  /** Caminho do app que o macOS associa ao item. */
  app?: string;
  /** Apps que o plist declara como donos, em AssociatedBundleIdentifiers. */
  bundleIds?: string[];
  /** Só o root lê o plist. */
  unreadable?: boolean;
}

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);

export function parsePlistReadings(output: string): PlistReading[] {
  let list: unknown;
  try {
    list = JSON.parse(output);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry: Record<string, unknown>) => {
    const path = text(entry?.path);
    if (!path) return [];
    const keepAlive = entry.keepAlive;
    return [
      {
        path,
        label: text(entry.label),
        program: text(entry.program),
        runAtLoad: entry.runAtLoad === true,
        keepAlive: Array.isArray(keepAlive) ? keepAlive.filter((key) => typeof key === 'string') : keepAlive === true,
        scheduled: entry.scheduled === true,
        disabled: entry.disabled === true,
        app: text(entry.app),
        bundleIds: Array.isArray(entry.bundleIds) ? entry.bundleIds.filter((id) => typeof id === 'string') : [],
        unreadable: entry.unreadable === true,
      },
    ];
  });
}

/**
 * Serviços desligados por cima do plist, na saída do `launchctl print-disabled`.
 * Versões novas escrevem `enabled`/`disabled`; as antigas, `false`/`true`.
 */
export function parseDisabled(output: string): Map<string, boolean> {
  const overrides = new Map<string, boolean>();
  for (const [, label, state] of output.matchAll(/"([^"]+)"\s*=>\s*(enabled|disabled|true|false)/g)) {
    overrides.set(label, state === 'disabled' || state === 'true');
  }
  return overrides;
}

/** Rótulos com processo vivo no `launchctl list` da conta: a primeira coluna é o PID. */
export function parseLaunchctlList(output: string): Set<string> {
  const running = new Set<string>();
  for (const line of output.split('\n')) {
    const [pid, , label] = line.trim().split(/\s+/);
    if (label && /^\d+$/.test(pid) && Number(pid) > 0) running.add(label);
  }
  return running;
}

/** Rótulos com processo vivo no bloco `services` do `launchctl print system`. */
export function parseSystemServices(output: string): Set<string> {
  const running = new Set<string>();
  const block = output.match(/^\tservices = \{\n([\s\S]*?)^\t\}/m)?.[1] ?? '';
  for (const line of block.split('\n')) {
    const [pid, , label] = line.trim().split(/\s+/);
    if (label && /^\d+$/.test(pid) && Number(pid) > 0) running.add(label);
  }
  return running;
}

/**
 * Quando o item roda. KeepAlive com SuccessfulExit implica rodar ao carregar,
 * diz o launchd.plist: ele precisa rodar uma vez para ter como sair.
 */
export function startupWhen(reading: PlistReading): StartupWhen {
  if (reading.unreadable) return 'unknown';
  const keepAlive = reading.keepAlive;
  if (reading.runAtLoad || keepAlive === true || (Array.isArray(keepAlive) && keepAlive.includes('SuccessfulExit'))) {
    return 'load';
  }
  return reading.scheduled ? 'schedule' : 'demand';
}

/** O app dono: o pacote .app mais de fora no caminho do programa, ou o que o macOS associa ao item. */
export function ownerApp(reading: PlistReading): string | null {
  const fromProgram = reading.program?.match(/([^/]+)\.app(?:\/|$)/)?.[1];
  if (fromProgram) return fromProgram;
  return reading.app ? basename(reading.app).replace(/\.app$/, '') : null;
}

export interface StartupContext {
  overrides: Map<string, boolean>;
  running: Set<string>;
  /** Programas que não existem mais no disco. */
  missing: Set<string>;
}

/**
 * O que o MacleanFy liga e desliga: agentes e ajudantes, que carregam na sessão de quem
 * usa o Mac, com rótulo conhecido. Item "quando chamado" não abre sozinho — desligá-lo só
 * quebraria o app que chama — e só ganha o botão se já estiver desligado, para voltar.
 */
export function isToggleable(item: Pick<StartupItemDTO, 'scope' | 'when' | 'disabled'>): boolean {
  if (item.scope === 'daemon' || item.when === 'unknown') return false;
  return item.when !== 'demand' || item.disabled;
}

/** Plist vazio — como os que o Google deixa para desligar o Keystone — não roda nada e fica de fora. */
export function describeStartupItem(
  reading: PlistReading,
  scope: StartupScope,
  context: StartupContext
): StartupItemDTO | null {
  if (!reading.label && !reading.program && !reading.unreadable) return null;
  const label = reading.label ?? basename(reading.path).replace(/\.plist$/, '');
  if (label.startsWith('com.apple.')) return null;
  const when = startupWhen(reading);
  const disabled = context.overrides.get(label) ?? reading.disabled === true;
  return {
    label,
    path: reading.path,
    scope,
    app: ownerApp(reading),
    program: reading.program ?? null,
    when,
    missing: !!reading.program && context.missing.has(reading.program),
    disabled,
    running: context.running.has(label),
    toggleable: isToggleable({ scope, when, disabled }),
  };
}

/** Os rótulos do bloco `services` de um `launchctl print` de domínio, rodando ou não. */
export function parseServiceLabels(output: string): string[] {
  const block = output.match(/^\tservices = \{\n([\s\S]*?)^\t\}/m)?.[1] ?? '';
  return block
    .split('\n')
    .map((line) => line.trim().split(/\s+/)[2])
    .filter((label): label is string => !!label);
}

/** O que o `launchctl print gui/<uid>/<rótulo>` diz de um serviço carregado. */
export interface ServiceInfo {
  /** Quem cadastrou o serviço sem plist, como `smd` (o ServiceManagement dos apps). */
  submittedBy: string | null;
  /** O plist, quando o serviço veio de um. */
  plist: string | null;
  /** O app que cadastrou o ajudante. */
  parent: string | null;
  running: boolean;
}

export function parseServicePrint(output: string): ServiceInfo | null {
  const path = output.match(/^\tpath = (.+)$/m)?.[1]?.trim();
  if (!path) return null;
  const submitted = path.match(/^\(submitted by ([^.)[]+)/)?.[1] ?? null;
  return {
    submittedBy: submitted,
    plist: submitted ? null : path,
    parent: output.match(/^\tparent bundle identifier = (.+)$/m)?.[1]?.trim() ?? null,
    running: /^\tstate = running$/m.test(output),
  };
}

/**
 * Ajudante que um app cadastra para abrir ao entrar na conta: pelo ServiceManagement
 * (SMLoginItemSetEnabled, SMAppService) ou por um plist de dentro do próprio app.
 */
export function isLoginHelper(info: ServiceInfo): boolean {
  return info.submittedBy === 'smd' || (!!info.plist && /\.app\/Contents\/Library\/LaunchAgents\/[^/]+\.plist$/.test(info.plist));
}

/** O app mais de fora num caminho: o dono de um ajudante guardado dentro dele. */
export function outermostApp(path: string): string | null {
  return path.match(/([^/]+)\.app(?:\/|$)/)?.[1] ?? null;
}

/** Rótulos que podem ser ajudantes: os que não vêm de plist das três pastas, nem da Apple. */
export function helperCandidates(labels: Iterable<string>, plistLabels: Set<string>): string[] {
  return [...new Set(labels)].filter(
    (label) =>
      !plistLabels.has(label) &&
      !label.startsWith('com.apple.') &&
      // Apps abertos (application.<id>.<n>) e processos sem nome (0x…) não são cadastros.
      !label.startsWith('application.') &&
      !/^0x[0-9a-f]+/i.test(label)
  );
}

/**
 * Um ajudante, com o que o launchd diz dele (nulo quando não está carregado) e onde o
 * macOS acha os apps. Desligado e fora do launchd, só conta se o app do ajudante ainda
 * existe dentro de outro app: senão é sobra de cadastro antigo e não abre nada.
 */
export function describeHelper(
  label: string,
  info: ServiceInfo | null,
  disabled: boolean | undefined,
  apps: Record<string, string>
): StartupItemDTO | null {
  if (info && !isLoginHelper(info)) return null;
  const bundle = apps[label];
  const inside = bundle && /\.app\/Contents\/Library\/LoginItems\/[^/]+\.app$/.test(bundle) ? bundle : undefined;
  if (!info && (disabled === undefined || !inside)) return null;
  const path = inside ?? info?.plist ?? (info?.parent ? apps[info.parent] : undefined) ?? bundle;
  if (!path) return null;
  const parentApp = info?.parent ? apps[info.parent] : undefined;
  const isDisabled = disabled === true;
  return {
    label,
    path,
    scope: 'helper',
    app: outermostApp(path) ?? (parentApp ? outermostApp(parentApp) : null),
    program: inside ?? null,
    when: 'load',
    missing: false,
    disabled: isDisabled,
    running: info?.running ?? false,
    toggleable: isToggleable({ scope: 'helper', when: 'load', disabled: isDisabled }),
  };
}

/** Onde o macOS acha o app de cada identificador, pelo NSWorkspace. Os identificadores chegam como argumentos. */
export const APP_PATHS_SCRIPT = `
ObjC.import('AppKit');
function run(argv) {
  const workspace = $.NSWorkspace.sharedWorkspace;
  const found = {};
  for (const id of argv) {
    const url = workspace.URLForApplicationWithBundleIdentifier(id);
    if (!url.isNil()) found[id] = ObjC.unwrap(url.path);
  }
  return JSON.stringify(found);
}
`;

export function parseAppPaths(output: string): Record<string, string> {
  try {
    const found = JSON.parse(output) as unknown;
    if (!found || typeof found !== 'object' || Array.isArray(found)) return {};
    return Object.fromEntries(
      Object.entries(found).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && isAbsolute(entry[1]))
    );
  } catch {
    return {};
  }
}

const WHEN_ORDER: Record<StartupWhen, number> = { load: 0, schedule: 1, demand: 2, unknown: 3 };

/** Quebrados primeiro; depois o que abre sozinho, o periódico e o que espera ser chamado. */
export function sortStartupItems(items: StartupItemDTO[]): StartupItemDTO[] {
  return [...items].sort(
    (a, b) =>
      Number(b.missing) - Number(a.missing) ||
      WHEN_ORDER[a.when] - WHEN_ORDER[b.when] ||
      (a.app ?? a.label).localeCompare(b.app ?? b.label)
  );
}

/** Comandos do próprio macOS, por caminho absoluto, em inglês. Uma falha vira texto vazio. */
function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: 15000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout) => resolve(error ? '' : stdout)
    );
  });
}

/** Só a ausência conta como quebrado: sem permissão para olhar não quer dizer que não existe. */
async function isMissing(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
}

export interface StartupPlist {
  scope: StartupScope;
  path: string;
}

/** Os plists de terceiros nas três pastas do launchd. */
async function startupPlists(): Promise<StartupPlist[]> {
  return (
    await Promise.all(
      STARTUP_FOLDERS.map(async ({ scope, dir }) => {
        const names = await readdir(dir).catch(() => [] as string[]);
        return names
          .filter((name) => name.endsWith('.plist') && !name.startsWith('com.apple.'))
          .map((name) => ({ scope, path: join(dir, name) }));
      })
    )
  ).flat();
}

async function readPlists(files: StartupPlist[]): Promise<Map<string, PlistReading>> {
  if (files.length === 0) return new Map();
  const output = await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', PLIST_SCRIPT, ...files.map((file) => file.path)]);
  return new Map(parsePlistReadings(output).map((reading) => [reading.path, reading]));
}

/** Cada plist de terceiros com o que ele diz, para quem precisa decidir de quem ele é. */
export async function readStartupPlists(): Promise<Array<StartupPlist & { reading: PlistReading }>> {
  const files = await startupPlists();
  const readings = await readPlists(files);
  return files.flatMap((file) => {
    const reading = readings.get(file.path);
    return reading ? [{ ...file, reading }] : [];
  });
}

async function appPaths(ids: string[]): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  return parseAppPaths(await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', APP_PATHS_SCRIPT, ...ids]));
}

/** Os ajudantes de login dos apps, carregados ou desligados na sessão. */
async function listHelpers(
  uid: number,
  plistLabels: Set<string>,
  overrides: Map<string, boolean>,
  session: string
): Promise<StartupItemDTO[]> {
  const candidates = helperCandidates([...parseServiceLabels(session), ...overrides.keys()], plistLabels);
  const infos = new Map(
    await Promise.all(
      candidates.map(
        async (label) => [label, parseServicePrint(await run('/bin/launchctl', ['print', `gui/${uid}/${label}`]))] as const
      )
    )
  );
  const helpers = candidates.filter((label) => {
    const info = infos.get(label);
    return info ? isLoginHelper(info) : overrides.has(label);
  });
  const parents = helpers.map((label) => infos.get(label)?.parent).filter((id): id is string => !!id);
  const apps = await appPaths([...new Set([...helpers, ...parents])]);
  return helpers.flatMap((label) => {
    const item = describeHelper(label, infos.get(label) ?? null, overrides.get(label), apps);
    return item ? [item] : [];
  });
}

export async function listStartupItems(): Promise<StartupItemDTO[]> {
  const files = await startupPlists();
  const uid = process.getuid?.() ?? 0;
  const [readings, userDisabled, systemDisabled, userList, systemPrint, session] = await Promise.all([
    readPlists(files),
    run('/bin/launchctl', ['print-disabled', `gui/${uid}`]),
    run('/bin/launchctl', ['print-disabled', 'system']),
    run('/bin/launchctl', ['list']),
    run('/bin/launchctl', ['print', 'system']),
    run('/bin/launchctl', ['print', `gui/${uid}`]),
  ]);

  const programs = [...new Set([...readings.values()].map((reading) => reading.program))].filter(
    (program): program is string => !!program && isAbsolute(program)
  );
  const missing = new Set(
    (await Promise.all(programs.map(async (program) => ((await isMissing(program)) ? program : null)))).filter(
      (program): program is string => program !== null
    )
  );

  // Agentes carregam na sessão de quem está usando o Mac; serviços, no domínio do sistema.
  const userOverrides = parseDisabled(userDisabled);
  const user: StartupContext = { overrides: userOverrides, running: parseLaunchctlList(userList), missing };
  const system: StartupContext = {
    overrides: parseDisabled(systemDisabled),
    running: parseSystemServices(systemPrint),
    missing,
  };

  const items = files.flatMap(({ scope, path }) => {
    const reading = readings.get(path);
    const item = reading && describeStartupItem(reading, scope, scope === 'daemon' ? system : user);
    return item ? [item] : [];
  });
  const plistLabels = new Set(
    [...readings.values()].map((reading) => reading.label ?? basename(reading.path).replace(/\.plist$/, ''))
  );
  const helpers = await listHelpers(uid, plistLabels, userOverrides, session).catch(() => []);
  const known = new Set(items.map((item) => item.path));
  return sortStartupItems([...items, ...helpers.filter((helper) => !known.has(helper.path))]);
}

/**
 * Liga ou desliga um item na sessão de quem usa o Mac e confere na lista de desligados
 * do launchd. Vale a partir do próximo login; o que está aberto continua aberto.
 */
export async function setStartupEnabled(label: string, on: boolean): Promise<boolean> {
  const uid = process.getuid?.() ?? 0;
  await run('/bin/launchctl', [on ? 'enable' : 'disable', `gui/${uid}/${label}`]);
  const overrides = parseDisabled(await run('/bin/launchctl', ['print-disabled', `gui/${uid}`]));
  return (overrides.get(label) ?? false) === !on;
}
