import { Info, Lock, ShieldAlert, ShieldCheck, Sparkles, TriangleAlert, type LucideIcon } from 'lucide-react';
import { CATEGORIES, type CategoryId, type SafetyLevel } from '../../../core/types';
import type { HistoryEntry } from '../../../shared/api';
import { Button, Spinner } from '../components/ui';
import { useT, type Translator } from '../i18n';
import { safetyKey } from '../i18n/strings';
import { ALL_CATEGORY_IDS, CATEGORY_ICONS, GROUPS, GROUP_BY_NAME } from '../lib/catalog';
import { useStore } from '../state/store';

type Health = 'excellent' | 'good' | 'attention' | 'critical';

/** A saúde é o espaço livre: é o que um limpador consegue de fato mudar. */
function healthOf(freeRatio: number): Health {
  if (freeRatio >= 0.25) return 'excellent';
  if (freeRatio >= 0.15) return 'good';
  if (freeRatio >= 0.08) return 'attention';
  return 'critical';
}

const SAFETY_ICONS: Record<SafetyLevel, LucideIcon> = { safe: ShieldCheck, moderate: ShieldAlert, risky: TriangleAlert };
const SAFETY_LEVELS: SafetyLevel[] = ['safe', 'moderate', 'risky'];

/** Abaixo disto uma categoria não vale uma recomendação. */
const REC_MIN_BYTES = 50 * 1000 * 1000;

interface Recommendation {
  id: string;
  icon: LucideIcon;
  title: string;
  text: string;
  onClick?: () => void;
}

function Laptop() {
  return (
    <svg className="hero__laptop" viewBox="0 0 132 92" aria-hidden="true">
      <defs>
        <linearGradient id="laptop-screen" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7df6ff" />
          <stop offset="0.5" stopColor="#1f9dff" />
          <stop offset="1" stopColor="#5a3df0" />
        </linearGradient>
        <linearGradient id="laptop-base" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#dfe8ff" />
          <stop offset="1" stopColor="#8e9fd6" />
        </linearGradient>
      </defs>
      <rect x="18" y="4" width="96" height="66" rx="8" fill="#0a0d33" stroke="rgba(200,225,255,0.75)" strokeWidth="1.5" />
      <rect x="23.5" y="9.5" width="85" height="55" rx="4" fill="url(#laptop-screen)" />
      <path
        d="M23.5 46c14-16 26-18 38-6s22 12 47-8v28.5a4 4 0 0 1-4 4h-77a4 4 0 0 1-4-4z"
        fill="rgba(5,0,29,0.28)"
      />
      <path d="M4 74h124l-5.2 9.4a7 7 0 0 1-6.1 3.6H15.3a7 7 0 0 1-6.1-3.6z" fill="url(#laptop-base)" />
      <rect x="54" y="74" width="24" height="3.4" rx="1.7" fill="#7f90c8" />
    </svg>
  );
}

function historyLabel(entry: HistoryEntry, tr: Translator): string {
  if (entry.kind === 'uninstall') return tr.t('overview.freed.uninstall');

  const [first, ...rest] = entry.labels;
  const name = first in CATEGORIES ? tr.category(first as CategoryId).name : first;
  return rest.length > 0 ? tr.t('overview.freed.more', { label: name, count: rest.length }) : name;
}

export function Overview() {
  const tr = useT();
  const { t } = tr;
  const system = useStore((state) => state.system);
  const history = useStore((state) => state.history);
  const results = useStore((state) => state.results);
  const scanning = useStore((state) => state.scanning);
  const scanDone = useStore((state) => state.scanDone);
  const scanTotal = useStore((state) => state.scanTotal);
  const scannedAt = useStore((state) => state.scannedAt);
  const scan = useStore((state) => state.scan);
  const navigate = useStore((state) => state.navigate);

  const disk = system?.disk;
  const used = disk ? disk.total - disk.free : 0;
  const freeRatio = disk && disk.total > 0 ? disk.free / disk.total : 1;
  const health = healthOf(freeRatio);

  const scanned = ALL_CATEGORY_IDS.filter((id) => results[id]);
  const withItems = scanned.filter((id) => results[id]!.items.length > 0);
  const totalSize = scanned.reduce((sum, id) => sum + results[id]!.totalSize, 0);
  const totalItems = scanned.reduce((sum, id) => sum + results[id]!.items.length, 0);

  const byGroup = GROUPS.map((group) => ({
    ...group,
    size: scanned
      .filter((id) => CATEGORIES[id].group === group.group)
      .reduce((sum, id) => sum + results[id]!.totalSize, 0),
  }));

  const bySafety = SAFETY_LEVELS.map((level) => {
    const ids = scanned.filter((id) => CATEGORIES[id].safetyLevel === level);
    return {
      level,
      items: ids.reduce((sum, id) => sum + results[id]!.items.length, 0),
      size: ids.reduce((sum, id) => sum + results[id]!.totalSize, 0),
    };
  });

  const largest = [...withItems].sort((a, b) => results[b]!.totalSize - results[a]!.totalSize);
  const openCategory = (id: CategoryId) => navigate(GROUP_BY_NAME[CATEGORIES[id].group].route);

  const recs: Recommendation[] = [];
  if (system && !system.fullDiskAccess) {
    recs.push({
      id: 'fda',
      icon: Lock,
      title: t('rec.fda.title'),
      text: t('rec.fda.text'),
      onClick: () => void window.macleanfy.system.openFullDiskAccessSettings(),
    });
  }
  if (scanned.length === 0) {
    recs.push({
      id: 'scan',
      icon: Sparkles,
      title: t('rec.scan.title'),
      text: t('rec.scan.text'),
      onClick: () => void scan(),
    });
  }
  if (disk && freeRatio < 0.15) {
    recs.push({
      id: 'disk',
      icon: TriangleAlert,
      title: t('rec.disk.title'),
      text: t('rec.disk.text', { free: tr.size(disk.free) }),
      onClick: () => navigate('smart'),
    });
  }
  for (const id of largest) {
    if (CATEGORIES[id].safetyLevel === 'risky' || results[id]!.totalSize < REC_MIN_BYTES) continue;
    const category = tr.category(id);
    recs.push({
      id,
      icon: CATEGORY_ICONS[id],
      title: t('rec.category.title', { size: tr.size(results[id]!.totalSize), name: category.name }),
      text: category.description,
      onClick: () => openCategory(id),
    });
  }
  if (recs.length === 0) {
    recs.push({ id: 'ok', icon: ShieldCheck, title: t('rec.clean.title'), text: t('rec.clean.text') });
  }

  return (
    <section className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">{t('nav.overview')}</h1>
          <p className="page__subtitle">
            {scannedAt ? t('overview.lastScan', { when: tr.ago(scannedAt) }) : t('overview.neverScanned')}
          </p>
        </div>
        <div className="page__actions">
          <Button
            variant="primary"
            data-action="scan"
            disabled={scanning}
            icon={scanning ? <Spinner /> : <Sparkles size={16} />}
            onClick={() => void scan()}
          >
            {scanning
              ? t('action.scanning', { done: scanDone, total: scanTotal })
              : t(scanned.length > 0 ? 'action.rescan' : 'action.scan')}
          </Button>
        </div>
      </header>

      <div className="overview">
        <article className={`card hero hero--${health}`}>
          <span className="hero__ring" aria-hidden="true" />
          <Laptop />

          <span className="card__label">{t('overview.health')}:</span>
          <div className="hero__status">
            {system ? t(`overview.health.${health}`) : '—'}
            {disk && (
              <span
                className="hero__info"
                data-tip={t('overview.health.tip', {
                  free: tr.size(disk.free),
                  percent: Math.round(freeRatio * 100),
                })}
                data-tip-pos="bottom"
              >
                <Info size={13} />
              </span>
            )}
          </div>
          <span className="hero__model">
            {system ? [system.modelName, system.chip, system.memory].filter(Boolean).join(' · ') : ''}
          </span>

          <div className="hero__disk">
            <div className="hero__disk-row">
              <strong>{disk?.volumeName ?? '—'}</strong>
              <span>{disk ? t('overview.diskUsed', { used: tr.size(used), total: tr.size(disk.total) }) : ''}</span>
            </div>
            <div
              className="meter"
              role="meter"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round((1 - freeRatio) * 100)}
              aria-label={disk?.volumeName}
            >
              <div className="meter__fill" style={{ width: `${disk ? (1 - freeRatio) * 100 : 0}%` }} />
            </div>
          </div>
        </article>

        <article className="card">
          <span className="card__label">{t('overview.reclaimable')}</span>
          {scanned.length === 0 ? (
            <>
              <div className="card__value card__value--muted">—</div>
              <p className="card__empty">{t('overview.reclaimable.empty')}</p>
            </>
          ) : (
            <>
              <div className="card__value">{tr.size(totalSize)}</div>
              <span className="card__sub">
                {t('overview.reclaimable.in', { count: tr.plural('category', withItems.length) })}
              </span>
              <div className="segbar" role="img" aria-label={t('overview.reclaimable')}>
                {byGroup
                  .filter((group) => group.size > 0)
                  .map((group) => (
                    <span
                      key={group.group}
                      className="segbar__seg"
                      style={{ flexGrow: group.size, background: group.color }}
                      data-tip={`${tr.group(group.group)} · ${tr.size(group.size)}`}
                      data-tip-pos="top"
                    />
                  ))}
              </div>
              <ul className="legend">
                {byGroup.map((group) => (
                  <li key={group.group} className="legend__row">
                    <button type="button" className="legend__link" onClick={() => navigate(group.route)}>
                      <span className="legend__dot" style={{ background: group.color }} />
                      {tr.group(group.group)}
                    </button>
                    <span className="legend__value">{tr.size(group.size)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </article>

        <article className="card card--glow">
          <span className="card__label">{t('overview.freed')}</span>
          <div className="card__value">{tr.size(history?.totalFreedSpace ?? 0)}</div>
          <span className="card__sub">{history ? t('overview.since', { date: tr.date(history.since) }) : ''}</span>

          <div className="card__section">{t('overview.freed.recent')}</div>
          {history && history.entries.length > 0 ? (
            <ul className="legend">
              {history.entries.slice(0, 4).map((entry) => (
                <li key={entry.at} className="legend__row">
                  <span className="legend__text">{historyLabel(entry, tr)}</span>
                  <span className="legend__value">{tr.size(entry.freedSpace)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="card__empty">{t('overview.freed.empty')}</p>
          )}
        </article>

        <div className="recs">
          <div className="recs__header">
            <span>{recs.length === 1 ? t('overview.recs.one') : t('overview.recs', { count: recs.length })}</span>
            <button type="button" className="link" onClick={() => navigate('smart')}>
              {t('action.seeAll')}
            </button>
          </div>
          <div className="card recs__card">
            {recs.slice(0, 2).map((rec) => (
              <button key={rec.id} type="button" className="rec" disabled={!rec.onClick} onClick={rec.onClick}>
                <span className="rec__icon">
                  <rec.icon size={18} />
                </span>
                <span className="rec__body">
                  <strong>{rec.title}</strong>
                  <span>{rec.text}</span>
                </span>
              </button>
            ))}
          </div>
        </div>

        <article className="card">
          <span className="card__label">{t('overview.found')}</span>
          {scanned.length === 0 ? (
            <>
              <div className="card__value card__value--muted">—</div>
              <p className="card__empty">{t('overview.found.empty')}</p>
            </>
          ) : (
            <>
              <div className="card__value">{tr.plural('item', totalItems)}</div>
              <ul className="legend legend--bottom">
                {bySafety.map(({ level, items, size }) => {
                  const Icon = SAFETY_ICONS[level];
                  return (
                    <li key={level} className="legend__row">
                      <span className={`legend__status legend__status--${level}`}>
                        <Icon size={13} />
                      </span>
                      <span className="legend__text">
                        {t(safetyKey[level])} · {tr.number(items)}
                      </span>
                      <span className="legend__value">{tr.size(size)}</span>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </article>

        <article className="card">
          <span className="card__label">{t('overview.top')}</span>
          {largest.length === 0 ? (
            <p className="card__empty card__empty--center">{t('overview.top.empty')}</p>
          ) : (
            <ul className="toplist">
              {largest.slice(0, 3).map((id) => {
                const Icon = CATEGORY_ICONS[id];
                return (
                  <li key={id}>
                    <button type="button" className="toplist__row" onClick={() => openCategory(id)}>
                      <span className="toplist__icon">
                        <Icon size={16} />
                      </span>
                      <span className="toplist__name">{tr.category(id).name}</span>
                      <span className="legend__value">{tr.size(results[id]!.totalSize)}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </article>
      </div>
    </section>
  );
}
