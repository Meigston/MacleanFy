import { useEffect, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  BatteryCharging,
  BatteryFull,
  CircleCheck,
  Cpu,
  ExternalLink,
  HardDrive,
  MemoryStick,
  Network,
  Timer,
} from 'lucide-react';
import type { PerformanceSample } from '../../../shared/api';
import { Button, Spinner } from '../components/ui';
import { useT, type Translator } from '../i18n';
import { describeFinding } from '../lib/findings';

/** Enquanto a tela está aberta. Fora dela nada é medido. */
const INTERVAL_MS = 2000;

function percent(value: number, tr: Translator, digits = 0): string {
  return `${new Intl.NumberFormat(tr.locale, { maximumFractionDigits: digits }).format(value)}%`;
}

function uptimeText(seconds: number, tr: Translator): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return days > 0 ? tr.t('perf.uptime.days', { days, hours }) : tr.t('perf.uptime.hours', { hours, minutes });
}

export function Performance() {
  const tr = useT();
  const { t } = tr;
  const [sample, setSample] = useState<PerformanceSample | null>(null);
  const [by, setBy] = useState<'cpu' | 'memory'>('cpu');

  // Uma leitura por vez: a próxima só é pedida depois que a anterior chega.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const next = await window.macleanfy.performance.sample();
        if (alive) setSample(next);
      } catch {
        // uma leitura perdida não apaga a anterior
      } finally {
        if (alive) timer = setTimeout(() => void tick(), INTERVAL_MS);
      }
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);

  const header = (
    <header className="page__header">
      <div>
        <h1 className="page__title">{t('nav.performance')}</h1>
        <p className="page__subtitle">{t('perf.subtitle')}</p>
      </div>
      <div className="page__actions">
        <Button icon={<ExternalLink size={15} />} onClick={() => void window.macleanfy.performance.openActivityMonitor()}>
          {t('perf.activityMonitor')}
        </Button>
      </div>
    </header>
  );

  if (!sample) {
    return (
      <section className="page">
        {header}
        <div className="page__body perf perf--loading">
          <Spinner size={28} />
        </div>
      </section>
    );
  }

  const { cpu, memory, disk, network, battery } = sample;
  const loadFormat = new Intl.NumberFormat(tr.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const apps = by === 'cpu' ? sample.topCpu : sample.topMemory;
  const memoryShare = memory.total > 0 ? memory.used / memory.total : 0;

  return (
    <section className="page">
      {header}
      <div className="page__body perf">
        <article className="card perf__diagnosis">
          <span className="card__label">{t('perf.diagnosis')}</span>
          {sample.findings.length === 0 ? (
            <div className="finding finding--ok">
              <span className="finding__icon">
                <CircleCheck size={18} />
              </span>
              <span className="finding__body">
                <strong>{t('perf.diagnosis.none.title')}</strong>
                <span>{t('perf.diagnosis.none.text')}</span>
              </span>
            </div>
          ) : (
            sample.findings.map((finding) => {
              const { icon: Icon, title, text } = describeFinding(finding, tr);
              return (
                <div key={finding.id + title} className={`finding finding--${finding.severity}`}>
                  <span className="finding__icon">
                    <Icon size={18} />
                  </span>
                  <span className="finding__body">
                    <strong>{title}</strong>
                    <span>{text}</span>
                  </span>
                </div>
              );
            })
          )}
        </article>

        <div className="perf__grid">
          <article className="card perf__metric">
            <span className="card__label perf__label">
              <Cpu size={15} />
              {t('perf.cpu')}
            </span>
            <div className="card__value">{percent(cpu.usage * 100, tr)}</div>
            <div className="perf__cores" aria-hidden="true">
              {cpu.cores.map((usage, index) => (
                <span key={index} className="perf__core">
                  <span style={{ height: `${Math.max(3, usage * 100)}%` }} />
                </span>
              ))}
            </div>
            <p className="card__sub">
              {t('perf.cpu.load', {
                load: cpu.load.map((value) => loadFormat.format(value)).join(' · '),
                cores: cpu.cores.length,
              })}
            </p>
          </article>

          <article className="card perf__metric">
            <span className="card__label perf__label">
              <MemoryStick size={15} />
              {t('perf.memory')}
            </span>
            <div className="card__value">{tr.memory(memory.used)}</div>
            <p className="card__sub">{t('perf.memory.of', { total: tr.memory(memory.total) })}</p>
            <div className={`meter perf__meter perf__meter--${memory.pressure}`}>
              <div className="meter__fill" style={{ width: `${Math.min(100, memoryShare * 100)}%` }} />
            </div>
            <div className="perf__lines">
              <span className={`perf__pressure perf__pressure--${memory.pressure}`}>
                {t(`perf.memory.pressure.${memory.pressure}`)}
              </span>
              <span>{t('perf.memory.swap', { size: tr.memory(memory.swapUsed) })}</span>
              <span>{t('perf.memory.cached', { size: tr.memory(memory.cached) })}</span>
            </div>
          </article>

          <article className="card perf__metric">
            <span className="card__label perf__label">
              <HardDrive size={15} />
              {t('perf.disk')}
            </span>
            <div className="perf__rates">
              <span>
                <ArrowDown size={14} />
                {t('perf.disk.read')}
                <strong>{t('perf.rate', { size: tr.size(disk.read) })}</strong>
              </span>
              <span>
                <ArrowUp size={14} />
                {t('perf.disk.write')}
                <strong>{t('perf.rate', { size: tr.size(disk.write) })}</strong>
              </span>
            </div>
          </article>

          <article className="card perf__metric">
            <span className="card__label perf__label">
              <Network size={15} />
              {t('perf.network')}
              {network.iface && <span className="perf__tag">{network.iface}</span>}
            </span>
            {network.iface ? (
              <div className="perf__rates">
                <span>
                  <ArrowDown size={14} />
                  {t('perf.network.down')}
                  <strong>{t('perf.rate', { size: tr.size(network.down) })}</strong>
                </span>
                <span>
                  <ArrowUp size={14} />
                  {t('perf.network.up')}
                  <strong>{t('perf.rate', { size: tr.size(network.up) })}</strong>
                </span>
              </div>
            ) : (
              <p className="card__empty">{t('perf.network.none')}</p>
            )}
          </article>

          {battery && (
            <article className="card perf__metric">
              <span className="card__label perf__label">
                {battery.charging ? <BatteryCharging size={15} /> : <BatteryFull size={15} />}
                {t('perf.battery')}
              </span>
              <div className="card__value">{percent(battery.percent, tr)}</div>
              <p className="card__sub">
                {t(
                  battery.charging
                    ? 'perf.battery.charging'
                    : battery.plugged
                      ? 'perf.battery.plugged'
                      : 'perf.battery.unplugged'
                )}
              </p>
              <div className="perf__lines">
                {battery.health !== null && (
                  <span>
                    {t('perf.battery.health', { health: Math.round(battery.health * 100), cycles: battery.cycles })}
                  </span>
                )}
                {battery.temperature !== null && (
                  <span>{t('perf.battery.temperature', { temperature: tr.number(Math.round(battery.temperature)) })}</span>
                )}
              </div>
            </article>
          )}

          <article className="card perf__metric">
            <span className="card__label perf__label">
              <Timer size={15} />
              {t('perf.system')}
            </span>
            <div className="card__value perf__value--small">{t('perf.uptime', { time: uptimeText(sample.uptime, tr) })}</div>
            <div className="perf__lines">
              <span className={`perf__thermal perf__thermal--${sample.thermal}`}>{t(`perf.thermal.${sample.thermal}`)}</span>
            </div>
          </article>
        </div>

        <article className="card perf__apps">
          <div className="perf__apps-header">
            <span className="card__label">{t('perf.apps')}</span>
            <div className="segmented" role="radiogroup" aria-label={t('perf.apps')}>
              {(['cpu', 'memory'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  role="radio"
                  aria-checked={by === option}
                  className={`segmented__option${by === option ? ' segmented__option--on' : ''}`}
                  onClick={() => setBy(option)}
                >
                  {t(option === 'cpu' ? 'perf.apps.cpu' : 'perf.apps.memory')}
                </button>
              ))}
            </div>
          </div>
          <ul className="perf__table">
            {apps.map((app) => (
              <li key={app.name} className="perf__row">
                <span className="perf__name">
                  {app.name}
                  {app.count > 1 && <span className="perf__count">×{app.count}</span>}
                </span>
                <span className={`perf__cell${by === 'cpu' ? ' perf__cell--on' : ''}`}>{percent(app.cpu, tr, 1)}</span>
                <span className={`perf__cell${by === 'memory' ? ' perf__cell--on' : ''}`}>{tr.memory(app.memory)}</span>
              </li>
            ))}
          </ul>
          <p className="card__sub">{t('perf.apps.note')}</p>
        </article>
      </div>
    </section>
  );
}
