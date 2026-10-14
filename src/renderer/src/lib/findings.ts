import { Cpu, Flame, HardDrive, MemoryStick, RotateCcw, Search, Thermometer, type LucideIcon } from 'lucide-react';
import type { PerformanceFinding } from '../../../shared/api';
import type { Translator } from '../i18n';

export interface FindingText {
  icon: LucideIcon;
  title: string;
  text: string;
}

/** Título e explicação de um achado do diagnóstico, para a tela de Desempenho e para a Visão geral. */
export function describeFinding(finding: PerformanceFinding, tr: Translator): FindingText {
  const { t } = tr;
  const withApps = (text: string, apps: string[]) =>
    apps.length > 0 ? `${text} ${t('perf.finding.apps', { apps: tr.list(apps) })}` : text;

  switch (finding.id) {
    case 'memory':
      return {
        icon: MemoryStick,
        title: t(finding.severity === 'critical' ? 'perf.finding.memory.critical' : 'perf.finding.memory.warning'),
        text: withApps(t('perf.finding.memory.text'), finding.apps),
      };
    case 'swap':
      return {
        icon: HardDrive,
        title: t('perf.finding.swap.title', { size: tr.memory(finding.used) }),
        text: withApps(t('perf.finding.swap.text'), finding.apps),
      };
    case 'cpu':
      return {
        icon: Cpu,
        title: t('perf.finding.cpu.title'),
        text: withApps(
          t('perf.finding.cpu.text', { load: tr.number(Math.round(finding.load * 10) / 10), cores: finding.cores }),
          finding.apps
        ),
      };
    case 'runaway':
      return {
        icon: Flame,
        title: t('perf.finding.runaway.title', { app: finding.app }),
        text: t('perf.finding.runaway.text', { hours: finding.hours, average: finding.average }),
      };
    case 'spotlight':
      return { icon: Search, title: t('perf.finding.spotlight.title'), text: t('perf.finding.spotlight.text') };
    case 'thermal':
      return { icon: Thermometer, title: t('perf.finding.thermal.title'), text: t('perf.finding.thermal.text') };
    case 'uptime':
      return {
        icon: RotateCcw,
        title: t('perf.finding.uptime.title', { days: finding.days }),
        text: t('perf.finding.uptime.text'),
      };
  }
}
