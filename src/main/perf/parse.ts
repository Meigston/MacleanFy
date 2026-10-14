/**
 * Leitura das saídas dos comandos do macOS que dizem como o Mac está agora.
 * Tudo aqui é função pura: recebe o texto, devolve números. Os comandos rodam
 * com LC_ALL=C, mas a vírgula decimal também é aceita — em português o
 * `sysctl` e o `ps` escrevem "36,5".
 */

const number = (text: string): number => Number(text.replace(',', '.'));

/** Linhas `nome: valor` do `sysctl`, por nome. */
export function parseSysctl(output: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of output.split('\n')) {
    const at = line.indexOf(':');
    if (at > 0) values[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return values;
}

const UNIT: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 };

/** `total = 19456.00M  used = 18005.81M  free = 1450.19M  (encrypted)`, em bytes. */
export function parseSwap(value: string | undefined): { total: number; used: number } {
  const read = (name: string) => {
    const match = value?.match(new RegExp(`${name} = ([\\d.,]+)([KMG])`));
    return match ? number(match[1]) * UNIT[match[2]] : 0;
  };
  return { total: read('total'), used: read('used') };
}

export type MemoryPressure = 'normal' | 'warning' | 'critical';

/** `kern.memorystatus_vm_pressure_level`: 1 normal, 2 aviso, 4 crítico. */
export function parsePressure(value: string | undefined): MemoryPressure {
  if (value === '4') return 'critical';
  if (value === '2') return 'warning';
  return 'normal';
}

/** Memória em uso e em cache, contada como o Monitor de Atividade conta. */
export function parseVmStat(output: string): { used: number; cached: number } {
  const pageSize = Number(output.match(/page size of (\d+) bytes/)?.[1] ?? 4096);
  const pages = (label: string) => Number(output.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0);

  // Memória dos apps (anônima, menos o que eles mesmos marcaram como descartável),
  // a presa ao kernel e a comprimida. Arquivo em cache não conta: o sistema o
  // devolve na hora em que alguém pedir.
  const used = pages('Anonymous pages') - pages('Pages purgeable') + pages('Pages wired down') + pages('Pages occupied by compressor');
  const cached = pages('File-backed pages') + pages('Pages purgeable');
  return { used: Math.max(0, used) * pageSize, cached: cached * pageSize };
}

/** `[[dd-]hh:]mm:ss[.cc]`; o `ps` deixa os minutos passarem de 59 no tempo de CPU. */
export function parseDuration(text: string): number {
  const [days, clock] = text.includes('-') ? text.split('-') : ['0', text];
  const parts = clock.split(':').map(number);
  if (parts.some(Number.isNaN) || Number.isNaN(Number(days))) return 0;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return Number(days) * 86400 + seconds;
}

export interface ProcessRow {
  pid: number;
  /** Média que o próprio `ps` mantém do último minuto, em % de um núcleo. */
  cpu: number;
  memory: number;
  /** Segundos desde que o processo abriu. */
  elapsed: number;
  /** Segundos de CPU gastos desde então. */
  cpuTime: number;
  command: string;
}

/** `ps -Aww -o pid=,pcpu=,rss=,etime=,time=,comm=` */
export function parsePs(output: string): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+([\d.,]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      cpu: number(match[2]),
      memory: Number(match[3]) * 1024,
      elapsed: parseDuration(match[4]),
      cpuTime: parseDuration(match[5]),
      command: match[6].trim(),
    });
  }
  return rows;
}

/**
 * Nome que a pessoa reconhece: o primeiro `.app` do caminho, para que os
 * ajudantes do Chrome somem como "Google Chrome"; fora de um app, o executável.
 */
export function appNameOf(command: string): string {
  const app = command.split('/').find((part) => part.endsWith('.app'));
  if (app) return app.slice(0, -'.app'.length);
  return command.split('/').pop() || command;
}

export interface ProcessGroup {
  name: string;
  /** Soma dos processos, em % de um núcleo. */
  cpu: number;
  /** Soma da memória residente: aproximada, porque partes compartilhadas entram mais de uma vez. */
  memory: number;
  count: number;
  /** Só processos do próprio macOS: não é algo que a pessoa abriu e possa fechar. */
  system: boolean;
}

/** Executáveis do macOS, que ficam fora da lista de "quem pesa" do diagnóstico. */
export function isSystemProcess(command: string): boolean {
  return /^\/(System|usr|sbin|bin|Library\/Apple)\//.test(command) || command === 'kernel_task' || command === 'launchd';
}

export function groupProcesses(rows: ProcessRow[]): ProcessGroup[] {
  const groups = new Map<string, ProcessGroup>();
  for (const row of rows) {
    const name = appNameOf(row.command);
    const group = groups.get(name) ?? { name, cpu: 0, memory: 0, count: 0, system: true };
    group.cpu += row.cpu;
    group.memory += row.memory;
    group.count++;
    group.system &&= isSystemProcess(row.command);
    groups.set(name, group);
  }
  return [...groups.values()];
}

/** Bytes lidos e gravados desde o boot, somando todos os discos do `ioreg`. */
export function parseDiskStats(output: string): { read: number; write: number } {
  let read = 0;
  let write = 0;
  for (const match of output.matchAll(/"Bytes \((Read|Write)\)"=(\d+)/g)) {
    if (match[1] === 'Read') read += Number(match[2]);
    else write += Number(match[2]);
  }
  return { read, write };
}

/** Interface da rota padrão, na saída do `route -n get default`. */
export function parseDefaultInterface(output: string): string | null {
  return output.match(/interface:\s*(\S+)/)?.[1] ?? null;
}

/** Bytes recebidos e enviados por uma interface, na linha `<Link#>` do `netstat -ibn`. */
export function parseNetstat(output: string, iface: string): { received: number; sent: number } | null {
  for (const line of output.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols[0] !== iface || !cols[2]?.startsWith('<Link')) continue;
    // Sem endereço de hardware (VPN), a coluna Address some e tudo anda uma casa.
    const offset = cols.length === 11 ? 0 : -1;
    return { received: Number(cols[6 + offset]), sent: Number(cols[9 + offset]) };
  }
  return null;
}

export interface BatteryReading {
  percent: number;
  charging: boolean;
  plugged: boolean;
  cycles: number;
  /** Capacidade atual sobre a de fábrica, de 0 a 1. */
  health: number | null;
  /** Graus Celsius. */
  temperature: number | null;
}

/** `ioreg -rn AppleSmartBattery`; nulo num Mac sem bateria. */
export function parseBattery(output: string): BatteryReading | null {
  const value = (key: string) => output.match(new RegExp(`^\\s*"${key}" = (\\S+)`, 'm'))?.[1];
  const integer = (key: string) => {
    const raw = value(key);
    return raw !== undefined && /^-?\d+$/.test(raw) ? Number(raw) : null;
  };

  const current = integer('CurrentCapacity');
  if (current === null) return null;

  // No Apple Silicon a MaxCapacity é 100 (percentual) e a capacidade real vem em
  // AppleRawMaxCapacity; nos Intel a MaxCapacity já é em mAh.
  const max = integer('MaxCapacity');
  const rawMax = integer('AppleRawMaxCapacity') ?? (max !== null && max > 100 ? max : null);
  const design = integer('DesignCapacity');
  const percent = max !== null && max > 100 ? Math.round((current / max) * 100) : current;
  const temperature = integer('Temperature');

  return {
    percent: Math.min(100, Math.max(0, percent)),
    charging: value('IsCharging') === 'Yes',
    plugged: value('ExternalConnected') === 'Yes',
    cycles: integer('CycleCount') ?? 0,
    health: rawMax && design ? Math.min(1, rawMax / design) : null,
    temperature: temperature !== null && temperature > 0 ? temperature / 100 : null,
  };
}
