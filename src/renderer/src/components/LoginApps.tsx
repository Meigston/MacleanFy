import { useEffect, useState } from 'react';
import { ExternalLink, FolderOpen, ListChecks } from 'lucide-react';
import type { LoginAppDTO, LoginAppsDTO } from '../../../shared/api';
import { useT } from '../i18n';
import { Button, Spinner, Switch, shortPath } from './ui';

const FAILED: LoginAppsDTO = { status: 'error', apps: [] };

/**
 * Os apps de "Abrir ao iniciar sessão". A lista só é lida depois que a pessoa clica
 * em "Mostrar apps", porque é aí que o macOS pede a permissão de Automação; dada a
 * permissão, ela vem sozinha nas próximas vezes.
 */
export function LoginApps() {
  const tr = useT();
  const { t } = tr;
  const [data, setData] = useState<LoginAppsDTO | null>(null);
  const [asking, setAsking] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    window.macleanfy.startup
      .loginApps(false)
      .catch(() => FAILED)
      .then((next) => alive && setData(next));
    return () => {
      alive = false;
    };
  }, []);

  const ask = async () => {
    setAsking(true);
    setFailed(null);
    const next = await window.macleanfy.startup.loginApps(true).catch(() => FAILED);
    setAsking(false);
    setData(next);
  };

  const toggle = async (app: LoginAppDTO, on: boolean) => {
    setPending(app.path);
    setFailed(null);
    const result = await window.macleanfy.startup.setLoginApp(app.path, on).catch(() => null);
    setPending(null);
    if (result) setData(result.list);
    if (!result?.done) setFailed(app.name);
  };

  const apps = data?.status === 'granted' ? data.apps : [];
  const off = apps.filter((app) => app.off).length;
  const askButton = (label: string) => (
    <Button variant="primary" onClick={() => void ask()} disabled={asking} data-action="login-apps-ask">
      {asking ? (
        <>
          <Spinner size={14} />
          {t('perf.login.asking')}
        </>
      ) : (
        label
      )}
    </Button>
  );

  return (
    <article className="card startup login-apps">
      <div className="perf__apps-header">
        <div className="startup__heading">
          <span className="card__label">{t('perf.login')}</span>
          {apps.length > 0 && (
            <span className="startup__summary">
              {tr.plural('app', apps.length - off)}
              {off > 0 && (
                <>
                  <span aria-hidden="true">·</span>
                  {tr.plural('off', off)}
                </>
              )}
            </span>
          )}
        </div>
        <Button icon={<ExternalLink size={15} />} onClick={() => void window.macleanfy.startup.openSettings()}>
          {t('perf.startup.settings')}
        </Button>
      </div>

      {!data ? (
        <div className="startup__loading">
          <Spinner size={20} />
        </div>
      ) : data.status === 'unasked' ? (
        <div className="login-apps__ask">
          <span className="login-apps__icon">
            <ListChecks size={18} />
          </span>
          <span className="login-apps__text">
            <strong>{t('perf.login.ask.title')}</strong>
            <span>{t('perf.login.ask.text')}</span>
          </span>
          {askButton(t('perf.login.ask'))}
        </div>
      ) : data.status === 'denied' || data.status === 'error' ? (
        <div className="login-apps__ask">
          <span className="login-apps__text">
            <span>{t(data.status === 'denied' ? 'perf.login.denied' : 'perf.login.error')}</span>
          </span>
          <span className="login-apps__actions">
            {data.status === 'denied' && (
              <Button onClick={() => void window.macleanfy.startup.openAutomationSettings()}>
                {t('perf.login.automation')}
              </Button>
            )}
            {askButton(t('perf.login.retry'))}
          </span>
        </div>
      ) : apps.length === 0 ? (
        <p className="card__empty">{t('perf.login.empty')}</p>
      ) : (
        <ul className="perf__table">
          {apps.map((app) => (
            <li key={app.path} className="perf__row login-apps__row">
              <span className="startup__name">
                <strong>{app.name}</strong>
                <span>{shortPath(app.path)}</span>
              </span>
              <span className={`startup__status${app.off ? ' startup__status--off' : ''}`}>
                {t(app.off ? 'perf.startup.disabled' : app.hidden ? 'perf.login.hidden' : 'perf.login.on')}
              </span>
              <Switch
                on={!app.off}
                onChange={(on) => void toggle(app, on)}
                label={t('perf.login.toggle', { name: app.name })}
                disabled={pending !== null}
              />
              <button
                type="button"
                className="item__reveal"
                aria-label={t('action.reveal')}
                data-tip={t('action.reveal')}
                data-tip-pos="left"
                onClick={() => void window.macleanfy.system.reveal(app.path)}
              >
                <FolderOpen size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {failed && (
        <p className="startup__failed" role="status">
          {t('perf.startup.failed', { name: failed })}
        </p>
      )}
      {data?.status === 'granted' && <p className="card__sub">{t('perf.login.note')}</p>}
    </article>
  );
}
