import type { MemoryPressure, PerformanceFinding, ThermalState } from '../../shared/api';
import { appNameOf, isSystemProcess, type ProcessGroup, type ProcessRow } from './parse';

/**
 * Por que o Mac pode estar lento, a partir de uma leitura. Só lê: aponta o que
 * pesa e o que fazer, e nunca encerra nem muda nada.
 *
 * Os limites miram o que a pessoa sente, não o que é tecnicamente alto: o
 * macOS usa toda a memória que tem de propósito, e um núcleo a 100% por alguns
 * segundos é normal. O que pesa é a memória faltar, o disco virar memória, a
 * CPU ficar ocupada por minutos e um processo ficar horas preso num laço.
 */

const GIB = 1024 ** 3;
const HOUR = 3600;
const DAY = 24 * HOUR;

/** Swap a partir do qual o disco já está fazendo papel de memória. */
const SWAP_MIN_BYTES = 2 * GIB;
const SWAP_RAM_RATIO = 0.25;
/** Carga média de 5 minutos por núcleo. */
const CPU_LOAD_PER_CORE = 0.9;
/** Processo preso: aberto há horas, com média alta desde então e ainda alto agora. */
const RUNAWAY_MIN_ELAPSED = 2 * HOUR;
const RUNAWAY_MIN_AVERAGE = 0.5;
const RUNAWAY_MIN_NOW = 30;
/** Indexação do Spotlight somando processos, em % de um núcleo. */
const SPOTLIGHT_CPU = 50;
const UPTIME_INFO_DAYS = 7;
const UPTIME_WARNING_DAYS = 14;

const SPOTLIGHT = /^(mds|mds_stores|mdworker.*|mdbulkimport|corespotlightd)$/;
const SEVERITY_ORDER = { critical: 0, warning: 1, info: 2 };

export interface DiagnosisInput {
  memory: { total: number; pressure: MemoryPressure; swapUsed: number };
  load: number[];
  cores: number;
  processes: ProcessRow[];
  groups: ProcessGroup[];
  thermal: ThermalState;
  uptime: number;
}

/** Os apps que a pessoa abriu e que mais pesam no recurso pedido. */
function heaviest(groups: ProcessGroup[], by: 'cpu' | 'memory', count = 3): string[] {
  return groups
    .filter((group) => !group.system && group[by] > 0)
    .sort((a, b) => b[by] - a[by])
    .slice(0, count)
    .map((group) => group.name);
}

export function diagnose(input: DiagnosisInput): PerformanceFinding[] {
  const findings: PerformanceFinding[] = [];
  const { memory, groups } = input;

  if (memory.pressure !== 'normal') {
    findings.push({ id: 'memory', severity: memory.pressure, apps: heaviest(groups, 'memory') });
  } else if (memory.swapUsed >= SWAP_MIN_BYTES && memory.swapUsed >= memory.total * SWAP_RAM_RATIO) {
    // Sem pressão agora, mas muita coisa foi parar no disco: volta devagar quando for usada.
    findings.push({ id: 'swap', severity: 'warning', used: memory.swapUsed, apps: heaviest(groups, 'memory') });
  }

  const load = input.load[1] ?? 0;
  if (input.cores > 0 && load / input.cores >= CPU_LOAD_PER_CORE) {
    findings.push({ id: 'cpu', severity: 'warning', load, cores: input.cores, apps: heaviest(groups, 'cpu') });
  }

  const runaway = input.processes
    .filter((row) => !isSystemProcess(row.command) && !SPOTLIGHT.test(appNameOf(row.command)))
    .filter((row) => row.elapsed >= RUNAWAY_MIN_ELAPSED && row.cpu >= RUNAWAY_MIN_NOW)
    .filter((row) => row.cpuTime / row.elapsed >= RUNAWAY_MIN_AVERAGE)
    .sort((a, b) => b.cpuTime / b.elapsed - a.cpuTime / a.elapsed)
    .slice(0, 2);
  for (const row of runaway) {
    findings.push({
      id: 'runaway',
      severity: 'warning',
      app: appNameOf(row.command),
      hours: Math.floor(row.elapsed / HOUR),
      average: Math.round((row.cpuTime / row.elapsed) * 100),
    });
  }

  const spotlight = input.processes
    .filter((row) => SPOTLIGHT.test(appNameOf(row.command)))
    .reduce((sum, row) => sum + row.cpu, 0);
  if (spotlight >= SPOTLIGHT_CPU) findings.push({ id: 'spotlight', severity: 'info', cpu: Math.round(spotlight) });

  if (input.thermal === 'serious' || input.thermal === 'critical') {
    findings.push({ id: 'thermal', severity: input.thermal === 'critical' ? 'critical' : 'warning' });
  }

  const days = Math.floor(input.uptime / DAY);
  if (days >= UPTIME_INFO_DAYS) {
    findings.push({ id: 'uptime', severity: days >= UPTIME_WARNING_DAYS ? 'warning' : 'info', days });
  }

  return findings.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
}
