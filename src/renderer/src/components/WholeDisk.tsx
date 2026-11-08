import { useEffect, useRef, useState } from 'react';
import { ChevronRight, Lock, RefreshCw } from 'lucide-react';
import type { HomeShareDTO, WholeDiskDTO, WholeDiskProgress, WholeSegmentDTO } from '../../../shared/api';
import { useT } from '../i18n';
import type { StringKey } from '../i18n/strings';
import {
  HATCHED,
  SEGMENT_COLORS,
  barWeights,
  groupTotals,
  isMeasured,
  isRunning,
  notices,
  segmentAction,
  shareAction,
  type WholeAction,
} from '../lib/disk';
import { useStore, type Route } from '../state/store';
import { Button, Spinner } from './ui';

/** Abaixo disto o purgável não muda o número do Finder de um jeito que alguém note. */
const PURGEABLE_NOTE_MIN = 100e6;

const ROUTE_ACTION: Partial<Record<Route, StringKey>> = {
  uninstaller: 'whole.action.uninstaller',
  development: 'whole.action.development',
  system: 'whole.action.system',
  performance: 'whole.action.performance',
  maintenance: 'whole.action.maintenance',
  storage: 'whole.action.storage',
  ai: 'whole.action.ai',
};

interface Props {
  /** Veio do cartão da Visão geral, com Acesso Total ao Disco: mede sem esperar o botão. */
  autoMeasure: boolean;
  /** Abre uma pasta da conta no explorador logo abaixo. */
  onExplore(path: string): void;
  /** Rola até o explorador de pastas. */
  onShowFolders(): void;
  /** A pasta pessoal acabou de ser medida: o explorador já tem o que mostrar. */
  onHomeMeasured(): void;
  /** Cada leitura do disco, para a página saber, por exemplo, se a pasta pessoal fica em outro disco. */
  onRead?(dto: WholeDiskDTO): void;
  /** Muda quando algo na pasta pessoal mudou por fora (a Lixeira do explorador): o cartão lê de novo. */
  reloadKey?: number;
}

type Progress = Partial<Record<WholeDiskProgress['phase'], WholeDiskProgress>>;

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1) || path;

/**
 * O disco inteiro numa barra só: o que é do macOS (não dá para mexer), o que o
 * macOS não deixa medir e o que é seu, cada parte com o caminho de onde veio e o
 * que dá para fazer com ela.
 */
export function WholeDisk({ autoMeasure, onExplore, onShowFolders, onHomeMeasured, onRead, reloadKey = 0 }: Props) {
  const tr = useT();
  const { t } = tr;
  const navigate = useStore((state) => state.navigate);
  const setBusy = useStore((state) => state.setDiskWholeBusy);
  const [dto, setDtoState] = useState<WholeDiskDTO | null>(null);
  const [failed, setFailed] = useState(false);
  const [measuring, setMeasuring] = useState(false);
  const [progress, setProgress] = useState<Progress>({});
  const [announce, setAnnounce] = useState('');
  const alive = useRef(true);
  const busy = useRef({ loading: true, measuring: false });
  const callbacks = useRef({ onHomeMeasured, onRead });
  callbacks.current = { onHomeMeasured, onRead };

  const setDto = (next: WholeDiskDTO) => {
    setDtoState(next);
    callbacks.current.onRead?.(next);
  };

  const syncBusy = () => {
    if (alive.current) setBusy(busy.current.loading || busy.current.measuring);
  };

  const reload = async () => {
    const next = await window.macleanfy.disk.whole().catch(() => null);
    if (alive.current && next) setDto(next);
  };

  const measure = async (refresh: boolean) => {
    busy.current.measuring = true;
    syncBusy();
    setMeasuring(true);
    setProgress({});
    try {
      const next = await window.macleanfy.disk.whole(refresh ? { refresh: true } : { measure: true });
      if (!alive.current) return;
      setDto(next);
      if (next.phases.home === 'done') callbacks.current.onHomeMeasured();
    } catch {
      if (alive.current) await reload();
    } finally {
      busy.current.measuring = false;
      if (alive.current) {
        setMeasuring(false);
        syncBusy();
      }
    }
  };

  useEffect(() => {
    // Cada execução do efeito tem a própria marca: no StrictMode a primeira, já desmontada, não mede nada.
    let active = true;
    alive.current = true;
    busy.current.loading = true;
    syncBusy();
    const unsubscribe = window.macleanfy.disk.onWholeProgress((next) => {
      setProgress((current) => ({ ...current, [next.phase]: next }));
      if (next.failed) setAnnounce(t(next.phase === 'outside' ? 'whole.error.outside' : 'whole.error.home'));
      if (next.done) {
        setAnnounce(t(next.phase === 'outside' ? 'whole.progress.outside' : 'whole.progress.home', { size: tr.size(next.bytes) }));
        if (next.phase === 'home') callbacks.current.onHomeMeasured();
        void reload();
      }
    });

    void window.macleanfy.disk
      .whole()
      .then((next) => {
        if (!active) return;
        setDto(next);
        // Uma medida que já corria (a pessoa saiu e voltou) continua daqui; o pedido do cartão mede o que
        // falta ou ficou velho — o processo principal sabe o que está velho, por limpeza ou por drift.
        if (isRunning(next) || (autoMeasure && (!isMeasured(next) || next.stale))) void measure(false);
      })
      .catch(() => active && setFailed(true))
      .finally(() => {
        if (!active) return;
        busy.current.loading = false;
        syncBusy();
      });

    return () => {
      active = false;
      alive.current = false;
      unsubscribe();
      setBusy(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (reloadKey > 0) void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  if (!dto) {
    return (
      <article className="card whole whole--loading" aria-busy="true">
        {failed ? <p className="card__empty">{t('whole.error.outside')}</p> : <Spinner size={20} />}
      </article>
    );
  }

  const percent = new Intl.NumberFormat(tr.locale, { style: 'percent', maximumFractionDigits: 1 });
  const share = (bytes: number) => percent.format(dto.total > 0 ? bytes / dto.total : 0);
  const totals = groupTotals(dto);
  const used = dto.total - dto.free;
  const measured = isMeasured(dto);
  const running = measuring || isRunning(dto);
  const system = dto.segments.filter((segment) => segment.group === 'system');
  const yours = dto.segments.filter((segment) => segment.group === 'yours');
  const gap = dto.segments.find((segment) => segment.group === 'unknown');
  const home = dto.segments.find((segment) => segment.id === 'home');
  const weights = barWeights(dto);
  const weightTotal = weights.reduce((sum, entry) => sum + entry.weight, 0) || 1;

  /** Só a pasta pessoal vira "~": /Users/Shared e as outras contas aparecem como são. */
  const tilde = (path: string) =>
    path === dto.homePath || path.startsWith(dto.homePath + '/') ? '~' + path.slice(dto.homePath.length) : path;

  const label = (segment: WholeSegmentDTO): string =>
    segment.id === 'macos' && dto.mode === 'basic' ? t('whole.seg.macos.basic') : t(`whole.seg.${segment.id}`);
  const sizeOf = (bytes: number, partial: boolean) => (partial ? t('whole.partial', { size: tr.size(bytes) }) : tr.size(bytes));

  const actionLabel = (action: WholeAction): string => {
    switch (action.kind) {
      case 'route':
        return t(ROUTE_ACTION[action.route] ?? 'whole.action.explore');
      case 'explore':
        return t('whole.action.explore');
      case 'reveal':
        return t('action.reveal');
      case 'fda':
        return t('action.grant');
      case 'measure':
        return t('disk.measure');
      case 'scroll-home':
        return t('whole.action.scroll-home');
    }
  };

  const run = (action: WholeAction) => {
    switch (action.kind) {
      case 'route':
        navigate(action.route);
        break;
      case 'explore':
        onExplore(action.path);
        break;
      case 'reveal':
        void window.macleanfy.system.reveal(action.path);
        break;
      case 'fda':
        void window.macleanfy.system.openFullDiskAccessSettings();
        break;
      case 'measure':
        void measure(false);
        break;
      case 'scroll-home':
        onShowFolders();
        break;
    }
  };

  const actionButton = (action: WholeAction, name: string) => (
    <button type="button" className="whole__action" aria-label={`${name}: ${actionLabel(action)}`} onClick={() => run(action)}>
      {actionLabel(action)}
      <ChevronRight size={13} aria-hidden="true" />
    </button>
  );

  const lock = (
    <span className="whole__lock">
      <Lock size={12} aria-hidden="true" />
      <span className="sr-only">{t('whole.lock')}</span>
    </span>
  );

  const pathChip = (text: string, path: string | undefined, bytes: number) => (
    <span key={`${text}${path ?? ''}`} className="whole__chip">
      {path ? (
        <button type="button" className="whole__path" title={path} onClick={() => void window.macleanfy.system.reveal(path)}>
          {text}
        </button>
      ) : (
        <span>{text}</span>
      )}{' '}
      {tr.size(bytes)}
    </span>
  );

  const segmentRow = (segment: WholeSegmentDTO) => {
    const action = segmentAction(segment, dto);
    const name = label(segment);
    const parts = segment.id === 'home' || segment.group === 'unknown' ? [] : segment.parts.slice(0, 4);
    const notes: string[] = [];
    if (segment.id === 'unknown') {
      if (dto.snapshots.length > 0) notes.push(t('whole.unknown.snapshots', { count: tr.plural('snapshot', dto.snapshots.length) }));
      if (dto.otherAccounts > 0) notes.push(t('whole.unknown.accounts', { count: tr.plural('account', dto.otherAccounts) }));
      if (!dto.fullDiskAccess) notes.push(t('whole.unknown.noAccess'));
    }
    return (
      <li key={segment.id} className="whole__row">
        <span
          className={`whole__swatch${HATCHED.has(segment.id) ? ' whole__swatch--hatch' : ''}`}
          style={{ background: HATCHED.has(segment.id) ? undefined : SEGMENT_COLORS[segment.id] }}
          aria-hidden="true"
        />
        <span className="whole__text">
          <span className="whole__name">
            {name}
            {segment.group === 'system' && !action && lock}
          </span>
          <span className="whole__tip">
            {t(segment.id === 'macos' && dto.mode === 'basic' ? 'whole.seg.macos.basic.tip' : `whole.seg.${segment.id}.tip`)}
          </span>
          {notes.map((note) => (
            <span key={note} className="whole__tip">
              {note}
            </span>
          ))}
          {parts.length > 0 && (
            <span className="whole__parts">
              {parts.map((part) =>
                pathChip(part.special === 'structure' ? t('whole.part.structure') : tilde(part.label), part.path, part.bytes)
              )}
            </span>
          )}
          {segment.top.length > 0 && (
            <span className="whole__parts">
              <span className="whole__top">{t('whole.top')}</span>
              {segment.top.map((top) => pathChip(baseName(top.label), top.path, top.bytes))}
            </span>
          )}
          {action && action.kind !== 'measure' && actionButton(action, name)}
        </span>
        <span className="whole__size">{sizeOf(segment.bytes, segment.partial)}</span>
        <span className="whole__share">{share(segment.bytes)}</span>
      </li>
    );
  };

  const shareRow = (entry: HomeShareDTO, homeBytes: number) => {
    const action = shareAction(entry, dto.homePath);
    const name = t(`whole.share.${entry.id}`);
    const fraction = homeBytes > 0 ? entry.bytes / homeBytes : 0;
    return (
      <li key={entry.id} className="whole__home-row">
        <span className="whole__text">
          <span className="whole__name">{name}</span>
          <span className="whole__tip">{t(`whole.share.${entry.id}.tip`)}</span>
          {actionButton(action, name)}
        </span>
        <span className="disk__bar" aria-hidden="true">
          <span style={{ width: `${Math.max(fraction * 100, entry.bytes > 0 ? 0.6 : 0)}%` }} />
        </span>
        <span className="whole__size">{sizeOf(entry.bytes, entry.partial)}</span>
        <span className="whole__share">{percent.format(fraction)}</span>
      </li>
    );
  };

  /** O que a fase já tem medido no retrato, para a fase pronta que não mandou progresso nesta visita. */
  const knownBytes = (phase: WholeDiskProgress['phase']) =>
    phase === 'home'
      ? (home?.bytes ?? 0)
      : dto.segments.reduce(
          (sum, segment) =>
            segment.id === 'home' ? sum : sum + segment.parts.reduce((inner, part) => inner + (part.source === 'du' ? part.bytes : 0), 0),
          0
        );

  const phaseLine = (phase: WholeDiskProgress['phase']) => {
    const state = dto.phases[phase];
    const current = progress[phase];
    const key = phase === 'outside' ? 'whole.progress.outside' : 'whole.progress.home';
    const failed = current ? current.failed === true : state === 'failed';
    const done = !failed && (current ? current.done === true : state === 'done');
    const bytes = current ? current.bytes : done ? knownBytes(phase) : 0;
    const waiting = !current && !done && !failed;
    return (
      <div className={`whole__phase${done ? ' whole__phase--done' : ''}`}>
        {done || failed ? (
          <span className={`whole__check${failed ? ' whole__check--failed' : ''}`} aria-hidden="true" />
        ) : (
          <Spinner size={13} />
        )}
        <span>
          {failed
            ? `${t(key, { size: tr.size(bytes) })} · ${t('whole.progress.failed')}`
            : `${t(key, { size: tr.size(bytes) })}${done ? ` · ${t('whole.progress.done')}` : waiting ? ` · ${t('whole.progress.waiting')}` : ''}`}
        </span>
      </div>
    );
  };

  const outsideLive = progress.outside && !progress.outside.done && !progress.outside.failed;
  const currentPath = outsideLive ? progress.outside?.path : progress.home?.path;
  const unknownBytes = gap?.id === 'unknown' ? gap.bytes : 0;
  const finder = dto.purgeable !== null && dto.purgeable >= PURGEABLE_NOTE_MIN ? dto.free + dto.purgeable : null;

  return (
    <article className="card whole" aria-busy={running}>
      <header className="whole__head">
        <div>
          <span className="card__label">{t('whole.label')}</span>
          <h2 className="whole__title">
            {t('whole.title', { name: dto.volumeName || 'Macintosh HD', used: tr.size(used), total: tr.size(dto.total) })}
          </h2>
        </div>
        {measured && !running && (
          <div className="whole__head-actions">
            <span className="disk__measured">{t('disk.measured', { ago: tr.ago(dto.measuredAt!) })}</span>
            <Button icon={<RefreshCw size={15} />} onClick={() => void measure(true)}>
              {t('disk.remeasure')}
            </Button>
          </div>
        )}
      </header>

      <div
        className="whole__bar"
        role="img"
        aria-label={t(gap?.id === 'pending' ? 'whole.bar.pending' : 'whole.bar', {
          system: tr.size(totals.system),
          unknown: tr.size(totals.unknown),
          yours: tr.size(totals.yours),
          free: tr.size(dto.free),
          total: tr.size(dto.total),
        })}
      >
        {weights
          .filter((entry) => entry.weight > 0)
          .map((entry) => {
            const segment = dto.segments.find((item) => item.id === entry.id);
            const name = segment ? label(segment) : t('whole.free');
            const bytes = segment ? segment.bytes : dto.free;
            return (
              <span
                key={entry.id}
                className={`whole__slice${entry.id === 'free' ? ' whole__slice--free' : ''}${
                  entry.id !== 'free' && HATCHED.has(entry.id) ? ' whole__slice--hatch' : ''
                }`}
                style={{
                  flexGrow: entry.weight / weightTotal,
                  background: entry.id === 'free' || HATCHED.has(entry.id) ? undefined : SEGMENT_COLORS[entry.id],
                }}
                data-tip={`${name} · ${tr.size(bytes)}`}
              />
            );
          })}
      </div>

      <p className="whole__summary">
        {measured
          ? [
              t('whole.summary', { system: tr.size(totals.system), yours: tr.size(totals.yours) }),
              unknownBytes > 0 ? t('whole.summary.unknown', { unknown: tr.size(unknownBytes) }) : '',
            ]
              .filter(Boolean)
              .join(' ')
          : t('whole.summary.pending', { system: tr.size(dto.systemVolumes), data: tr.size(gap?.bytes ?? dto.data) })}
      </p>

      {notices(dto).map((notice) => (
        <div key={notice} className={`notice${notice.startsWith('error') ? ' notice--warning' : ''} whole__notice`}>
          <span>
            {notice === 'stale'
              ? t('whole.stale', { when: dto.measuredAt ? tr.ago(dto.measuredAt) : '' })
              : notice === 'overcount'
                ? t('whole.overcount', { size: tr.size(dto.overcount) })
                : notice === 'basic'
                  ? t('whole.basic')
                  : notice === 'homeElsewhere'
                    ? t('whole.homeElsewhere')
                    : t(notice === 'error-outside' ? 'whole.error.outside' : 'whole.error.home')}
          </span>
          {(notice === 'stale' || notice.startsWith('error')) && !running && (
            <button type="button" className="link" onClick={() => void measure(notice === 'stale')}>
              {notice === 'stale' ? t('disk.remeasure') : t('whole.retry')}
            </button>
          )}
        </div>
      ))}

      <div className="whole__groups">
        <section className="whole__group" aria-labelledby="whole-system">
          <h3 id="whole-system" className="whole__group-title">
            <span>{t('whole.group.system')}</span>
            <strong>{tr.size(totals.system)}</strong>
          </h3>
          <ul className="whole__list">{system.map(segmentRow)}</ul>
        </section>

        <section className="whole__group" aria-labelledby="whole-yours">
          <h3 id="whole-yours" className="whole__group-title">
            <span>{t('whole.group.yours')}</span>
            {yours.length > 0 && <strong>{tr.size(totals.yours)}</strong>}
          </h3>
          {yours.length > 0 && <ul className="whole__list">{yours.map(segmentRow)}</ul>}
          {running ? (
            <div className="whole__progress">
              {phaseLine('outside')}
              {dto.phases.home !== 'idle' || progress.home || !dto.homeElsewhere ? phaseLine('home') : null}
              <p className="disk__current">{currentPath ? tilde(currentPath) : ''}</p>
              <span className="sr-only" aria-live="polite">
                {announce}
              </span>
            </div>
          ) : gap?.id === 'pending' ? (
            <div className="whole__pending">
              <span className="whole__swatch whole__swatch--hatch" aria-hidden="true" />
              <div>
                <strong>{t('whole.pending.title', { data: tr.size(gap.bytes) })}</strong>
                <p>{t('whole.pending.text', { data: tr.size(gap.bytes) })}</p>
                <Button variant="primary" onClick={() => void measure(false)} data-action="whole-measure">
                  {t('disk.measure')}
                </Button>
              </div>
            </div>
          ) : null}
        </section>
      </div>

      <ul className="whole__list whole__list--wide">
        {gap?.id === 'unknown' && segmentRow(gap)}
        <li className="whole__row">
          <span className="whole__swatch whole__swatch--free" aria-hidden="true" />
          <span className="whole__text">
            <span className="whole__name">{t('whole.free')}</span>
            {finder !== null && (
              <span className="whole__tip">
                {t('whole.free.finder', { finder: tr.size(finder), purgeable: tr.size(dto.purgeable!) })}
              </span>
            )}
          </span>
          <span className="whole__size">{tr.size(dto.free)}</span>
          <span className="whole__share">{share(dto.free)}</span>
        </li>
      </ul>

      {dto.home && home && (
        <section className="whole__home" aria-labelledby="whole-home">
          <h3 id="whole-home" className="whole__group-title">
            <span>{t('whole.home.title')}</span>
            <strong>{tr.size(home.bytes)}</strong>
          </h3>
          <ul className="whole__list">{dto.home.map((entry) => shareRow(entry, home.bytes))}</ul>
        </section>
      )}

      <details className="whole__reconcile">
        <summary>{t('whole.reconcile.title')}</summary>
        <p>
          {t('whole.reconcile.used', {
            used: tr.size(used),
            system: tr.size(dto.systemVolumes),
            data: tr.size(dto.data),
            other: dto.otherVolumes > 0 ? t('whole.reconcile.other', { size: tr.size(dto.otherVolumes) }) : '',
          })}
        </p>
        {measured && (
          <p>
            {dto.overcount > 0
              ? t('whole.reconcile.data.overcount', {
                  data: tr.size(dto.data),
                  measured: tr.size(dto.data + dto.overcount),
                  overcount: tr.size(dto.overcount),
                })
              : t('whole.reconcile.data', {
                  data: tr.size(dto.data),
                  measured: tr.size(dto.data - unknownBytes),
                  unknown: tr.size(unknownBytes),
                })}
          </p>
        )}
        <p>{t('whole.reconcile.settings')}</p>
        {/* Com clones contados duas vezes, a soma das pastas não fecha em bytes com o volume. */}
        {dto.overcount === 0 && <p>{t('whole.reconcile.rounding')}</p>}
      </details>
    </article>
  );
}
