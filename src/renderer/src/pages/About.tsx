import { CircleAlert, CircleCheck, ExternalLink, Heart, Languages, Lock, Scale } from 'lucide-react';
import logoUrl from '../assets/logo.webp';
import { Button } from '../components/ui';
import { LOCALES, useT } from '../i18n';
import { useStore } from '../state/store';

const REPO_URL = 'https://github.com/Meigston/MacleanFy';
const UPSTREAM_URL = 'https://github.com/guhcostan/mac-cleaner-cli';

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
        </header>

        <div className="about__grid">
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

          <article className="card about__card">
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
        </div>
      </div>
    </section>
  );
}
