import { execFile } from 'node:child_process';
import { cpus, loadavg, totalmem, uptime, type CpuInfo } from 'node:os';
import { powerMonitor } from 'electron';
import type { PerformanceSample, ProcessGroupDTO } from '../../shared/api';
import { diagnose } from './diagnose';
import {
  groupProcesses,
  parseBattery,
  parseDefaultInterface,
  parseDiskStats,
  parseNetstat,
  parsePressure,
  parsePs,
  parseSwap,
  parseSysctl,
  parseVmStat,
  type BatteryReading,
} from './parse';

/** Comandos do próprio macOS, por caminho absoluto, em inglês. Uma falha vira texto vazio. */
function run(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: 5000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout) => resolve(error ? '' : stdout)
    );
  });
}

/** Valor que muda devagar: lido de novo só depois de `ttl`. */
function cached<T>(ttl: number, read: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | null = null;
  let at = 0;
  return () => {
    if (!value || Date.now() - at > ttl) {
      value = read();
      at = Date.now();
    }
    return value;
  };
}

interface Counters {
  at: number;
  cpus: CpuInfo[];
  disk: { read: number; write: number };
  network: { received: number; sent: number } | null;
  iface: string | null;
}

/** Uso de cada núcleo entre duas leituras, de 0 a 1. */
function coreUsage(before: CpuInfo[], after: CpuInfo[]): number[] {
  return after.map((core, index) => {
    const previous = before[index]?.times;
    if (!previous) return 0;
    const total = (Object.keys(core.times) as Array<keyof CpuInfo['times']>).reduce(
      (sum, key) => sum + core.times[key] - previous[key],
      0
    );
    return total > 0 ? Math.min(1, Math.max(0, 1 - (core.times.idle - previous.idle) / total)) : 0;
  });
}

const rate = (after: number, before: number, seconds: number) => Math.max(0, after - before) / seconds;

const TOP = 8;
const top = (groups: ProcessGroupDTO[], by: 'cpu' | 'memory') =>
  [...groups].sort((a, b) => b[by] - a[by]).slice(0, TOP);

/**
 * Lê como o Mac está agora. CPU, disco e rede são taxas: cada leitura compara
 * com a anterior, e quando ela é velha (ou não existe) espera meio segundo para
 * ter com o que comparar. Nada aqui pede senha nem muda o sistema.
 */
export class PerformanceMonitor {
  private last: Counters | null = null;
  private pending: Promise<PerformanceSample> | null = null;

  private readonly defaultInterface = cached(60_000, async () =>
    parseDefaultInterface(await run('/sbin/route', ['-n', 'get', 'default']))
  );

  private readonly battery = cached<BatteryReading | null>(30_000, async () =>
    parseBattery(await run('/usr/sbin/ioreg', ['-rn', 'AppleSmartBattery']))
  );

  /** Duas telas pedindo ao mesmo tempo recebem a mesma leitura. */
  sample(): Promise<PerformanceSample> {
    this.pending ??= this.read().finally(() => {
      this.pending = null;
    });
    return this.pending;
  }

  private async counters(): Promise<Counters> {
    const iface = await this.defaultInterface();
    const [disk, network] = await Promise.all([
      run('/usr/sbin/ioreg', ['-r', '-c', 'IOBlockStorageDriver', '-w0']),
      run('/usr/sbin/netstat', ['-ibn']),
    ]);
    return {
      at: Date.now(),
      cpus: cpus(),
      disk: parseDiskStats(disk),
      network: iface ? parseNetstat(network, iface) : null,
      iface,
    };
  }

  private async read(): Promise<PerformanceSample> {
    let before = this.last;
    if (!before || Date.now() - before.at > 5000) {
      before = await this.counters();
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const [after, sysctl, vmStat, ps, battery] = await Promise.all([
      this.counters(),
      run('/usr/sbin/sysctl', ['kern.memorystatus_vm_pressure_level', 'vm.swapusage']),
      run('/usr/bin/vm_stat', []),
      run('/bin/ps', ['-Aww', '-o', 'pid=,pcpu=,rss=,etime=,time=,comm=']),
      this.battery(),
    ]);
    this.last = after;

    const seconds = Math.max(0.1, (after.at - before.at) / 1000);
    const cores = coreUsage(before.cpus, after.cpus);
    const values = parseSysctl(sysctl);
    const swap = parseSwap(values['vm.swapusage']);
    const pressure = parsePressure(values['kern.memorystatus_vm_pressure_level']);
    const memory = parseVmStat(vmStat);
    const processes = parsePs(ps);
    const groups = groupProcesses(processes);
    const thermal = powerMonitor.getCurrentThermalState();
    const total = totalmem();

    return {
      at: after.at,
      cpu: {
        usage: cores.length ? cores.reduce((sum, core) => sum + core, 0) / cores.length : 0,
        cores,
        load: loadavg(),
      },
      memory: { total, ...memory, pressure, swapUsed: swap.used, swapTotal: swap.total },
      disk: {
        read: rate(after.disk.read, before.disk.read, seconds),
        write: rate(after.disk.write, before.disk.write, seconds),
      },
      network: {
        iface: after.iface,
        down:
          after.network && before.network && after.iface === before.iface
            ? rate(after.network.received, before.network.received, seconds)
            : 0,
        up:
          after.network && before.network && after.iface === before.iface
            ? rate(after.network.sent, before.network.sent, seconds)
            : 0,
      },
      battery,
      uptime: uptime(),
      thermal,
      topCpu: top(groups, 'cpu'),
      topMemory: top(groups, 'memory'),
      findings: diagnose({
        memory: { total, pressure, swapUsed: swap.used },
        load: loadavg(),
        cores: cores.length,
        processes,
        groups,
        thermal,
        uptime: uptime(),
      }),
    };
  }
}
