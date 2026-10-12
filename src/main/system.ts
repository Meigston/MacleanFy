import { execFile } from 'node:child_process';
import { readdir, statfs } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import type { MaintenanceResultDTO, MaintenanceTask, SystemInfo } from '../shared/api';

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

/**
 * Comandos fixos, por caminho absoluto. Nada vindo da interface entra na linha
 * de comando: ela só escolhe a chave.
 */
const MAINTENANCE_COMMANDS: Record<MaintenanceTask, string> = {
  dns: '/usr/bin/dscacheutil -flushcache && /usr/bin/killall -HUP mDNSResponder',
  purgeable: '/usr/sbin/purge',
};

/**
 * As duas tarefas exigem root. Em vez do `sudo -n` do CLI — que só funciona com
 * sudo sem senha —, o osascript abre o diálogo de autenticação do próprio macOS.
 */
export function runMaintenance(task: MaintenanceTask): Promise<MaintenanceResultDTO> {
  const command = MAINTENANCE_COMMANDS[task];
  if (!command) return Promise.resolve({ success: false, error: `Unknown task: ${String(task)}` });

  return new Promise((resolve) => {
    execFile(
      '/usr/bin/osascript',
      ['-e', `do shell script "${command}" with administrator privileges`],
      { timeout: 120000 },
      (error, _stdout, stderr) => {
        if (!error) resolve({ success: true });
        else if (/-128|User cancel/i.test(stderr)) resolve({ success: false, cancelled: true });
        else resolve({ success: false, error: stderr.trim() || error.message });
      }
    );
  });
}
