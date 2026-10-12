import { CircleAlert, CircleCheck, CircleUserRound, ExternalLink, Heart, Languages, Lock, Scale } from 'lucide-react';
import airdroidfyUrl from '../assets/airdroidfy.png';
import logoUrl from '../assets/logo.webp';
import { Button, Spinner } from '../components/ui';
import { LOCALES, useT } from '../i18n';
import { useStore } from '../state/store';

const REPO_URL = 'https://github.com/Meigston/MacleanFy';
const UPSTREAM_URL = 'https://github.com/guhcostan/mac-cleaner-cli';
const DEVELOPER = { name: 'Meigston Ramos', linkedin: 'https://www.linkedin.com/in/meigston/' };
const AIRDROIDFY_URL = 'https://airdroidfy.com/?ref=macleanfy';

/** Onde está a atualização, com o próximo passo ao lado. Sem nada a mostrar rodando do código-fonte. */
function UpdateStatus() {
  const { t } = useT();
  const update = useStore((state) => state.update);

  const check = () => void window.macleanfy.updates.check();
  const prompt = () => useStore.getState().setUpdatePrompt(true);

  let text = '';
  let action: { label: string; run(): void } | null = null;
  switch (update.status) {
    case 'unsupported':
      return null;
    case 'idle':
      action = { label: t('update.check'), run: check };
      break;
    case 'checking':
      text = t('update.checking');
      break;
    case 'current':
      text = t('update.current');
      action = { label: t('update.action.again'), run: check };
      break;
    case 'available':
      text = t('update.available', { version: update.version });
      action = { label: t('update.action.update'), run: prompt };
      break;
    case 'downloading':
      text = t('update.downloading', {
        version: update.version,
        percent: update.total > 0 ? Math.floor((update.transferred / update.total) * 100) : 0,
      });
      action = { label: t('update.action.progress'), run: prompt };
      break;
    case 'ready':
      text = t('update.ready', { version: update.version });
      action = { label: t('update.action.restart'), run: prompt };
      break;
    case 'error':
      text = t('update.error');
      action = { label: t('update.action.retry'), run: check };
      break;
  }

  return (
    <p className="about__update">
      {update.status === 'checking' && <Spinner size={13} />}
      {text && <span>{text}</span>}
      {action && (
        <button type="button" className="link" data-action="update" onClick={action.run}>
          {action.label}
        </button>
      )}
    </p>
  );
}

export function About() {
  const { t, locale } = useT();
  const system = useStore((state) => state.system);
  const setLocale = useStore((state) => state.setLocale);

  const open = (url: string) => void window.macleanfy.system.openExternal(url);

  return (
    <section className="page">
      <div className="page__body about">
        <header className="about__brand">
          <img className="about__logo" src={logoUrl} alt="MacleanFy" draggable={false} />
          <p className="about__tagline">{t('about.tagline')}</p>
          <p className="page__meta">
            {system ? t('about.version', { version: system.appVersion, os: system.osVersion }) : ''}
          </p>
          <UpdateStatus />
        </header>

        <div className="about__grid">
          <article className="card about__card">
            <h2 className="about__title">
              <CircleUserRound size={16} />
              {t('about.dev.title')}
            </h2>
            <p className="about__name">{DEVELOPER.name}</p>
            <p className="about__text">{t('about.dev.text')}</p>
            <button type="button" className="link" onClick={() => open(DEVELOPER.linkedin)}>
              LinkedIn
              <ExternalLink size={13} />
            </button>
          </article>

          <article className="card about__card about__card--credit">
            <h2 className="about__title">
              <Heart size={16} />
              {t('about.based.title')}
            </h2>
            <p className="about__text">{t('about.based.text')}</p>
            <button type="button" className="link" onClick={() => open(UPSTREAM_URL)}>
              {t('about.based.link')}
              <ExternalLink size={13} />
            </button>
          </article>

          <article className="card about__card">
            <h2 className="about__title">
              <Scale size={16} />
              {t('about.repo.title')}
            </h2>
            <p className="about__text">{t('about.repo.text')}</p>
            <div className="about__links">
              <button type="button" className="link" onClick={() => open(REPO_URL)}>
                {t('about.repo.link')}
                <ExternalLink size={13} />
              </button>
              <button type="button" className="link" onClick={() => open(`${REPO_URL}/blob/main/LICENSE`)}>
                {t('about.license')}
                <ExternalLink size={13} />
              </button>
            </div>
          </article>

          <article className="card about__card">
            <h2 className="about__title">
              <Lock size={16} />
              {t('about.fda.title')}
            </h2>
            <p className={`about__status about__status--${system?.fullDiskAccess ? 'ok' : 'missing'}`}>
              {system?.fullDiskAccess ? <CircleCheck size={15} /> : <CircleAlert size={15} />}
              <span>{t(system?.fullDiskAccess ? 'about.fda.granted' : 'about.fda.missing')}</span>
            </p>
            <Button onClick={() => void window.macleanfy.system.openFullDiskAccessSettings()}>
              {t('action.grant')}
            </Button>
          </article>

          <article className="card about__card about__card--wide">
            <h2 className="about__title">
              <Languages size={16} />
              {t('about.language')}
            </h2>
            <div className="segmented" role="radiogroup" aria-label={t('about.language')}>
              {LOCALES.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="radio"
                  aria-checked={locale === option.id}
                  className={`segmented__option${locale === option.id ? ' segmented__option--on' : ''}`}
                  onClick={() => setLocale(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </article>

          <article className="card about__card about__card--wide">
            <img className="about__app-icon" src={airdroidfyUrl} alt="" draggable={false} />
            <div className="about__more">
              <h2 className="about__eyebrow">{t('about.more.title')}</h2>
              <p className="about__name">Airdroidfy</p>
              <p className="about__text">{t('about.more.text')}</p>
            </div>
            <button type="button" className="link" onClick={() => open(AIRDROIDFY_URL)}>
              airdroidfy.com
              <ExternalLink size={13} />
            </button>
          </article>
        </div>
      </div>
    </section>
  );
}
