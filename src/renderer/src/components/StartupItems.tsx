import { useEffect, useState } from 'react';
import { ExternalLink, FolderOpen, TriangleAlert } from 'lucide-react';
import type { StartupItemDTO } from '../../../shared/api';
import { useT } from '../i18n';
import type { StringKey } from '../i18n/strings';
import { Button, Spinner, shortPath } from './ui';

/** Quantos aparecem antes do "Mostrar todos": os quebrados e os que abrem sozinhos vêm primeiro. */
const PREVIEW = 8;

function whenKey(item: StartupItemDTO): StringKey {
  if (item.when === 'load') return item.scope === 'daemon' ? 'perf.startup.when.boot' : 'perf.startup.when.login';
  return `perf.startup.when.${item.when}`;
}

/**
 * O que o launchd abre sozinho. Lido uma vez ao abrir a tela: muda quando se
 * instala ou remove um app, não de dois em dois segundos.
 */
export function StartupItems() {
  const tr = useT();
  const { t } = tr;
  const [items, setItems] = useState<StartupItemDTO[] | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let alive = true;
    window.macleanfy.startup
      .list()
      .catch(() => [])
      .then((list) => alive && setItems(list));
    return () => {
      alive = false;
    };
  }, []);

  const broken = items?.filter((item) => item.missing).length ?? 0;
  const autostart = items?.filter((item) => item.when === 'load' && !item.disabled).length ?? 0;
  const shown = items && (expanded ? items : items.slice(0, PREVIEW));

  return (
    <article className="card startup">
      <div className="perf__apps-header">
        <div className="startup__heading">
          <span className="card__label">{t('perf.startup')}</span>
          {items && items.length > 0 && (
            <span className="startup__summary">
              {tr.plural('item', items.length)}
              <span aria-hidden="true">·</span>
              {tr.plural('autostart', autostart)}
              {broken > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  <span className="startup__broken">{tr.plural('broken', broken)}</span>
                </>
              )}
            </span>
          )}
        </div>
        <Button icon={<ExternalLink size={15} />} onClick={() => void window.macleanfy.startup.openSettings()}>
          {t('perf.startup.settings')}
        </Button>
      </div>

      {!items ? (
        <div className="startup__loading">
          <Spinner size={20} />
        </div>
      ) : items.length === 0 ? (
        <p className="card__empty">{t('perf.startup.empty')}</p>
      ) : (
        <ul className="perf__table">
          {shown?.map((item) => (
            <li key={item.path} className="perf__row startup__row">
              <span className="startup__name">
                <strong>{item.app ?? item.label}</strong>
                <span title={item.program ? shortPath(item.program) : undefined}>
                  {item.app ? `${item.label} · ` : ''}
                  {t(`perf.startup.scope.${item.scope}`)}
                </span>
              </span>
              <span className="startup__when">{t(whenKey(item))}</span>
              {item.missing ? (
                <span className="startup__status startup__status--missing" data-tip={t('perf.startup.missing.tip')}>
                  <TriangleAlert size={13} />
                  {t('perf.startup.missing')}
                </span>
              ) : (
                <span className={`startup__status startup__status--${item.disabled ? 'off' : item.running ? 'on' : 'idle'}`}>
                  {t(item.disabled ? 'perf.startup.disabled' : item.running ? 'perf.startup.running' : 'perf.startup.idle')}
                </span>
              )}
              <button
                type="button"
                className="item__reveal"
                aria-label={t('action.reveal')}
                data-tip={t('action.reveal')}
                data-tip-pos="left"
                onClick={() => void window.macleanfy.system.reveal(item.path)}
              >
                <FolderOpen size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {items && items.length > PREVIEW && (
        <button type="button" className="link startup__more" onClick={() => setExpanded((value) => !value)}>
          {expanded ? t('perf.startup.less') : t('perf.startup.more', { n: items.length })}
        </button>
      )}
      <p className="card__sub">{t('perf.startup.note')}</p>
    </article>
  );
}
