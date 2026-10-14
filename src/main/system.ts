import { execFile } from 'node:child_process';
import { readdir, statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import type { MaintenanceInfo, MaintenanceResultDTO, MaintenanceTask, SystemInfo } from '../shared/api';
import { DS_STORE_DOMAIN, DS_STORE_KEYS, parseDefaultsBool, parseSpotlightStatus } from './maintenance';
import { CAPACITY_SCRIPT, parseCapacity, parseLocalSnapshots, purgeableBytes } from './volume';

function run(command: string, args: string[], timeout = 15000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
  });
}

interface Hardware {
  modelName: string;
  chip: string;
  memory: string;
}

// O hardware não muda com o app aberto, e o system_profiler demora a responder.
let hardware: Promise<Hardware> | undefined;

async function readHardware(): Promise<Hardware> {
  try {
    const json = JSON.parse(await run('/usr/sbin/system_profiler', ['SPHardwareDataType', '-json']));
    const data = json?.SPHardwareDataType?.[0] ?? {};
    return {
      modelName: String(data.machine_name ?? 'Mac'),
      chip: String(data.chip_type ?? data.cpu_type ?? ''),
      memory: String(data.physical_memory ?? ''),
    };
  } catch {
    return { modelName: 'Mac', chip: '', memory: '' };
  }
}

async function readVolumeName(): Promise<string> {
  try {
    const plist = await run('/usr/sbin/diskutil', ['info', '-plist', '/']);
    const match = plist.match(/<key>VolumeName<\/key>\s*<string>([^<]+)<\/string>/);
    return match?.[1] ?? 'Macintosh HD';
  } catch {
    return 'Macintosh HD';
  }
}

/**
 * Sem Acesso Total ao Disco o macOS nega a leitura de ~/.Trash (e de Mail,
 * Safari e afins), e os scanners enxergam essas pastas como vazias.
 */
async function hasFullDiskAccess(): Promise<boolean> {
  try {
    await readdir(join(homedir(), '.Trash'));
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== 'EPERM' && code !== 'EACCES';
  }
}

export async function getSystemInfo(): Promise<SystemInfo> {
  hardware ??= readHardware();

  const [hw, volumeName, fullDiskAccess, fsStats] = await Promise.all([
    hardware,
    readVolumeName(),
    hasFullDiskAccess(),
    statfs(homedir()),
  ]);

  return {
    appVersion: app.getVersion(),
    osVersion: process.getSystemVersion(),
    locale: app.getLocale(),
    ...hw,
    disk: {
      volumeName,
      total: fsStats.blocks * fsStats.bsize,
      free: fsStats.bavail * fsStats.bsize,
    },
    fullDiskAccess,
  };
}

/** O Finder deixa de gravar .DS_Store só com as duas chaves ligadas. */
async function readNoDsStore(): Promise<boolean> {
  const values = await Promise.all(
    DS_STORE_KEYS.map((key) =>
      run('/usr/bin/defaults', ['read', DS_STORE_DOMAIN, key])
        .then(parseDefaultsBool)
        .catch(() => false)
    )
  );
  return values.every(Boolean);
}

export async function getMaintenanceInfo(): Promise<MaintenanceInfo> {
  const [capacity, snapshots, spotlight, noDsStore] = await Promise.all([
    run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', CAPACITY_SCRIPT])
      .then(parseCapacity)
      .catch(() => null),
    run('/usr/bin/tmutil', ['listlocalsnapshots', '/'])
      .then(parseLocalSnapshots)
      .catch(() => []),
    run('/usr/bin/mdutil', ['-s', '/'])
      .then(parseSpotlightStatus)
      .catch(() => null),
    readNoDsStore(),
  ]);
  return { purgeable: capacity ? purgeableBytes(capacity) : null, snapshots, spotlight, noDsStore };
}

type MaintenanceCommand =
  /** Roda como root, pelo diálogo de senha do macOS. */
  | { admin: true; script: string }
  | { admin: false; file: string; args: string[] };

/**
 * Comandos fixos, por caminho absoluto. Nada vindo da interface entra na linha
 * de comando: ela só escolhe a chave.
 *
 * Não há `/usr/sbin/purge` aqui de propósito: apesar do nome, ele esvazia o cache
 * de disco que fica na memória — não libera espaço nenhum, e deixa o Mac mais lento
 * até o cache se refazer.
 */
const MAINTENANCE_COMMANDS: Record<MaintenanceTask, MaintenanceCommand> = {
  dns: { admin: true, script: '/usr/bin/dscacheutil -flushcache && /usr/bin/killall -HUP mDNSResponder' },
  quicklook: { admin: false, file: '/usr/bin/qlmanage', args: ['-r', 'cache'] },
  // Só pede o índice novo: o macOS o refaz em segundo plano, e o comando volta na hora.
  spotlight: { admin: true, script: '/usr/bin/mdutil -E /' },
  snapshots: { admin: true, script: '/usr/bin/tmutil deletelocalsnapshots /' },
};

/**
 * O que exige root não passa pelo `sudo -n` do CLI — que só funciona com sudo
 * sem senha —: o osascript abre o diálogo de autenticação do próprio macOS.
 */
export function runMaintenance(task: MaintenanceTask): Promise<MaintenanceResultDTO> {
  const command = Object.hasOwn(MAINTENANCE_COMMANDS, task) ? MAINTENANCE_COMMANDS[task] : undefined;
  if (!command) return Promise.resolve({ success: false, error: `Unknown task: ${String(task)}` });

  if (!command.admin) {
    return run(command.file, command.args, 60000).then(
      () => ({ success: true }),
      (error: Error) => ({ success: false, error: error.message })
    );
  }
  return runAsAdmin(command.script);
}

/**
 * Roda como root pelo diálogo de senha do próprio macOS. O script vem sempre de
 * texto fixo ou de caminhos já conferidos: nada nele precisa de escape.
 */
export function runAsAdmin(script: string): Promise<MaintenanceResultDTO> {
  if (/["\\]/.test(script)) return Promise.resolve({ success: false, error: 'Unsafe command' });
  return new Promise((resolve) => {
    execFile(
      '/usr/bin/osascript',
      ['-e', `do shell script "${script}" with administrator privileges`],
      { timeout: 120000 },
      (error, _stdout, stderr) => {
        if (!error) resolve({ success: true });
        else if (/-128|User cancel/i.test(stderr)) resolve({ success: false, cancelled: true });
        else resolve({ success: false, error: stderr.trim() || error.message });
      }
    );
  });
}

/**
 * Preferência da conta, sem senha. Desligar apaga as chaves em vez de gravar
 * `false`: volta exatamente ao padrão do macOS.
 */
export async function setNoDsStore(on: boolean): Promise<MaintenanceResultDTO> {
  try {
    for (const key of DS_STORE_KEYS) {
      if (on) await run('/usr/bin/defaults', ['write', DS_STORE_DOMAIN, key, '-bool', 'true']);
      else await run('/usr/bin/defaults', ['delete', DS_STORE_DOMAIN, key]).catch(() => undefined);
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
