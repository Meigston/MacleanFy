import { execFile } from 'node:child_process';
import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';
import type { StartupItemDTO, StartupScope, StartupWhen } from '../shared/api';

/**
 * O que o launchd abre sozinho: agentes ao entrar na conta e serviços do sistema
 * ao ligar o Mac. Só lê. Desligar fica com Ajustes → Itens de Início, onde o
 * macOS diz o que cada item faz; apagar os quebrados da pasta pessoal fica com a
 * Limpeza, na categoria de launch agents órfãos.
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
    return {
      path,
      label,
      program: read('Program') ?? (Array.isArray(args) ? args[0] : undefined),
      runAtLoad: read('RunAtLoad') === true,
      keepAlive: keepAlive && typeof keepAlive === 'object' ? Object.keys(keepAlive) : keepAlive === true,
      scheduled: read('StartInterval') != null || read('StartCalendarInterval') != null,
      disabled: read('Disabled') === true,
      app: [].concat(read('AssociatedBundleIdentifiers') ?? [], label).map(appFor).find(Boolean),
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

/** Plist vazio — como os que o Google deixa para desligar o Keystone — não roda nada e fica de fora. */
export function describeStartupItem(
  reading: PlistReading,
  scope: StartupScope,
  context: StartupContext
): StartupItemDTO | null {
  if (!reading.label && !reading.program && !reading.unreadable) return null;
  const label = reading.label ?? basename(reading.path).replace(/\.plist$/, '');
  if (label.startsWith('com.apple.')) return null;
  return {
    label,
    path: reading.path,
    scope,
    app: ownerApp(reading),
    program: reading.program ?? null,
    when: startupWhen(reading),
    missing: !!reading.program && context.missing.has(reading.program),
    disabled: context.overrides.get(label) ?? reading.disabled === true,
    running: context.running.has(label),
  };
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

export async function listStartupItems(): Promise<StartupItemDTO[]> {
  const files = (
    await Promise.all(
      STARTUP_FOLDERS.map(async ({ scope, dir }) => {
        const names = await readdir(dir).catch(() => [] as string[]);
        return names
          .filter((name) => name.endsWith('.plist') && !name.startsWith('com.apple.'))
          .map((name) => ({ scope, path: join(dir, name) }));
      })
    )
  ).flat();
  if (files.length === 0) return [];

  const uid = process.getuid?.() ?? 0;
  const [plists, userDisabled, systemDisabled, userList, systemPrint] = await Promise.all([
    run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', PLIST_SCRIPT, ...files.map((file) => file.path)]),
    run('/bin/launchctl', ['print-disabled', `gui/${uid}`]),
    run('/bin/launchctl', ['print-disabled', 'system']),
    run('/bin/launchctl', ['list']),
    run('/bin/launchctl', ['print', 'system']),
  ]);

  const readings = new Map(parsePlistReadings(plists).map((reading) => [reading.path, reading]));
  const programs = [...new Set([...readings.values()].map((reading) => reading.program))].filter(
    (program): program is string => !!program && isAbsolute(program)
  );
  const missing = new Set(
    (await Promise.all(programs.map(async (program) => ((await isMissing(program)) ? program : null)))).filter(
      (program): program is string => program !== null
    )
  );

  // Agentes carregam na sessão de quem está usando o Mac; serviços, no domínio do sistema.
  const user: StartupContext = { overrides: parseDisabled(userDisabled), running: parseLaunchctlList(userList), missing };
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
  return sortStartupItems(items);
}
