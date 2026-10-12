import { useEffect, useMemo, useState } from 'react';
import { AppWindow, ChevronDown, ChevronRight, CircleCheck, FolderOpen, RefreshCw, Search, Trash2 } from 'lucide-react';
import type { UninstallResultDTO } from '../../../shared/api';
import { Button, Checkbox, Modal, Spinner, shortPath } from '../components/ui';
import { useT } from '../i18n';
import { useStore } from '../state/store';

export function Uninstaller() {
  const tr = useT();
  const { t } = tr;
  const apps = useStore((state) => state.apps);
  const loading = useStore((state) => state.appsLoading);
  const progress = useStore((state) => state.appsProgress);
  const selected = useStore((state) => state.appSelection);
  const loadApps = useStore((state) => state.loadApps);
  const toggleApp = useStore((state) => state.toggleApp);
  const uninstallSelected = useStore((state) => state.uninstallSelected);

  const [query, setQuery] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<UninstallResultDTO | null>(null);

  useEffect(() => {
    if (useStore.getState().apps === null) void loadApps();
  }, [loadApps]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (apps ?? []).filter((app) => app.name.toLowerCase().includes(needle));
  }, [apps, query]);

  const chosen = (apps ?? []).filter((app) => selected.has(app.path));
  const chosenSize = chosen.reduce((sum, app) => sum + app.totalSize, 0);
  const totalSize = (apps ?? []).reduce((sum, app) => sum + app.totalSize, 0);

  const closeDialog = () => {
    setConfirming(false);
    setResult(null);
  };

  const run = async () => {
    setRunning(true);
    try {
      setResult(await uninstallSelected());
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">{t('nav.uninstaller')}</h1>
          <p className="page__subtitle">
            {loading
              ? t('uninstaller.subtitle.loading', { done: progress?.completed ?? 0, total: progress?.total ?? 0 })
              : apps
                ? t('uninstaller.subtitle', { count: tr.plural('app', apps.length), size: tr.size(totalSize) })
                : ''}
          </p>
        </div>
        <div className="page__actions">
          <label className="search">
            <Search size={15} />
            <input
              type="search"
              value={query}
              placeholder={t('uninstaller.search')}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <Button
            disabled={loading}
            aria-label={t('action.rescan')}
            data-tip={t('action.rescan')}
            data-tip-pos="bottom"
            icon={loading ? <Spinner /> : <RefreshCw size={15} />}
            onClick={() => void loadApps()}
          />
        </div>
      </header>

      {loading && !apps ? (
        <div className="stage">
          <Spinner size={34} />
          <p className="stage__text">
            {t('uninstaller.subtitle.loading', { done: progress?.completed ?? 0, total: progress?.total ?? 0 })}
          </p>
          <div className="meter meter--accent stage__meter">
            <div
              className="meter__fill"
              style={{ width: `${progress ? (progress.completed / Math.max(progress.total, 1)) * 100 : 0}%` }}
            />
          </div>
        </div>
      ) : (
        <>
          <div className="page__body">
            <div className="catlist">
              {visible.length === 0 && <p className="card__empty card__empty--center">{t('uninstaller.empty')}</p>}
              {visible.map((app) => {
                const isOpen = open === app.path;
                const isSelected = selected.has(app.path);
                return (
                  <div key={app.path} className={`cat${isSelected ? ' cat--selected' : ''}`}>
                    <div
                      className="cat__row cat__row--app"
                      role="button"
                      tabIndex={0}
                      aria-expanded={isOpen}
                      onClick={() => setOpen(isOpen ? null : app.path)}
                      onKeyDown={(event) => {
                        if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) {
                          event.preventDefault();
                          setOpen(isOpen ? null : app.path);
                        }
                      }}
                    >
                      <Checkbox
                        state={isSelected ? 'on' : 'off'}
                        label={app.name}
                        onChange={() => toggleApp(app.path)}
                      />
                      {app.icon ? (
                        <img className="cat__appicon" src={app.icon} alt="" draggable={false} />
                      ) : (
                        <span className="cat__icon">
                          <AppWindow size={18} />
                        </span>
                      )}
                      <span className="cat__text">
                        <span className="cat__name">{app.name}</span>
                        <span className="cat__desc">
                          {app.related.length > 0
                            ? tr.plural('related', app.related.length)
                            : t('uninstaller.related.none')}
                        </span>
                      </span>
                      <span className="cat__numbers">
                        <span className="cat__size">{tr.size(app.totalSize)}</span>
                      </span>
                      <span className="cat__chevron">
                        {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                      </span>
                    </div>

                    {isOpen && (
                      <div className="cat__items">
                        {[{ path: app.path, size: app.size }, ...app.related].map((entry, index) => (
                          <div key={entry.path} className="item item--static">
                            <span className="item__text">
                              <span className="item__name">
                                {index === 0 ? t('uninstaller.bundle') : entry.path.split('/').pop()}
                              </span>
                              <span className="item__path">{shortPath(entry.path)}</span>
                            </span>
                            <span className="item__size">{tr.size(entry.size)}</span>
                            <button
                              type="button"
                              className="item__reveal"
                              aria-label={t('action.reveal')}
                              data-tip={t('action.reveal')}
                              data-tip-pos="left"
                              onClick={() => void window.macleanfy.system.reveal(entry.path)}
                            >
                              <FolderOpen size={14} />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <footer className="actionbar">
            <div className="actionbar__text">
              {chosen.length > 0 ? (
                <strong>
                  {t('uninstaller.selected', { size: tr.size(chosenSize), count: tr.plural('app', chosen.length) })}
                </strong>
              ) : (
                <strong>{t('cleaner.selected.none')}</strong>
              )}
            </div>
            <Button
              variant="danger"
              size="lg"
              disabled={chosen.length === 0 || loading}
              icon={<Trash2 size={16} />}
              onClick={() => setConfirming(true)}
            >
              {t('uninstaller.action')}
            </Button>
          </footer>
        </>
      )}

      {confirming && (
        <Modal onClose={running ? undefined : closeDialog} labelledBy="uninstall-title">
          {result ? (
            <>
              <div className="result">
                <span className="result__icon">
                  <CircleCheck size={30} />
                </span>
                <h2 id="uninstall-title" className="result__title">
                  {t('uninstaller.result', { count: tr.plural('app', result.uninstalled) })}
                </h2>
                <p className="modal__text">{tr.size(result.freedSpace)}</p>
              </div>
              {result.errors.length > 0 && (
                <div className="notice notice--warning">
                  {t('uninstaller.result.errors', { names: result.errors.join(', ') })}
                </div>
              )}
              <div className="modal__actions">
                <Button variant="primary" onClick={closeDialog}>
                  {t('action.done')}
                </Button>
              </div>
            </>
          ) : (
            <>
              <div>
                <h2 id="uninstall-title" className="modal__title">
                  {t('uninstaller.dialog.title', { count: tr.plural('app', chosen.length) })}
                </h2>
                <p className="modal__text">{t('uninstaller.dialog.text')}</p>
              </div>
              <ul className="plan">
                {chosen.map((app) => (
                  <li key={app.path} className="plan__row">
                    <span className="plan__name">{app.name}</span>
                    <span className="plan__count">
                      {app.related.length > 0 ? tr.plural('related', app.related.length) : ''}
                    </span>
                    <span className="plan__size">{tr.size(app.totalSize)}</span>
                  </li>
                ))}
              </ul>
              <div className="modal__actions">
                <Button disabled={running} onClick={closeDialog}>
                  {t('action.cancel')}
                </Button>
                <Button
                  variant="danger"
                  disabled={running}
                  icon={running ? <Spinner /> : undefined}
                  onClick={() => void run()}
                >
                  {t('uninstaller.action')}
                </Button>
              </div>
            </>
          )}
        </Modal>
      )}
    </section>
  );
}
