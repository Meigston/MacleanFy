import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronRight, File, Folder, FolderOpen, Trash2 } from 'lucide-react';
import { isInPhotosLibrary, type DiskEntryDTO, type DiskFolderDTO, type DiskProgress } from '../../../shared/api';
import { Button, Modal, Spinner, shortPath } from '../components/ui';
import { WholeDisk } from '../components/WholeDisk';
import { useT } from '../i18n';
import { useStore } from '../state/store';

/** Linhas mostradas antes de juntar o resto em "menores". */
const SHOWN = 60;
/** Abaixo disto, a pasta já está no mapa: não vale piscar a tela de "medindo". */
const MEASURING_DELAY_MS = 150;

/** A última pasta aberta, para voltar a ela ao sair e entrar de novo na tela. */
let remembered: string | undefined;

/** `waiting`: a pasta pessoal ainda não foi medida; quem mede é o cartão do disco inteiro. */
type Phase = 'checking' | 'waiting' | 'measuring' | 'ready' | 'error';

export function Disk() {
  const tr = useT();
  const { t } = tr;
  const fullDiskAccess = useStore((state) => state.system?.fullDiskAccess ?? true);
  const setDiskBusy = useStore((state) => state.setDiskBusy);
  const [phase, setPhase] = useState<Phase>('checking');
  const [folder, setFolder] = useState<DiskFolderDTO | null>(null);
  const [progress, setProgress] = useState<DiskProgress | null>(null);
  const [trashing, setTrashing] = useState<DiskEntryDTO | null>(null);
  const [trashBusy, setTrashBusy] = useState(false);
  // A pasta pessoal em outro disco não entra na medida do cartão: o explorador mede sozinho.
  const [homeElsewhere, setHomeElsewhere] = useState(false);
  const [wholeReload, setWholeReload] = useState(0);
  const request = useRef(0);
  const folderCard = useRef<HTMLElement>(null);
  // Lido na montagem e apagado depois: o pedido do cartão da Visão geral vale uma vez.
  const [intent] = useState(() => useStore.getState().diskIntent);

  useEffect(() => window.macleanfy.disk.onProgress(setProgress), []);

  const open = async (path?: string, options: { refresh?: boolean; cachedOnly?: boolean } = {}) => {
    const id = ++request.current;
    const timer = options.cachedOnly
      ? undefined
      : setTimeout(() => {
          if (request.current === id) {
            setProgress(null);
            setPhase('measuring');
            setDiskBusy(true);
          }
        }, MEASURING_DELAY_MS);
    try {
      const next = await window.macleanfy.disk.list(path, options);
      if (request.current !== id) return;
      if (next) {
        remembered = next.path;
        setFolder(next);
        setPhase('ready');
      } else if (options.cachedOnly && path !== undefined) {
        // A pasta lembrada não está mais no mapa (uma medida nova não desce tão fundo): volta à pasta pessoal.
        remembered = undefined;
        return open(undefined, options);
      } else setPhase('waiting');
    } catch {
      if (request.current === id) setPhase(folder ? 'ready' : 'error');
    } finally {
      clearTimeout(timer);
      if (request.current === id) setDiskBusy(false);
    }
  };

  useEffect(() => {
    useStore.getState().consumeDiskIntent();
    void open(remembered, { cachedOnly: true });
    return () => setDiskBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const confirmTrash = async () => {
    if (!trashing || !folder) return;
    setTrashBusy(true);
    try {
      if (await window.macleanfy.disk.trash(trashing.path)) {
        // O que foi para a Lixeira muda as fatias da pasta pessoal no cartão de cima.
        setWholeReload((current) => current + 1);
        await open(folder.path);
      }
    } finally {
      setTrashBusy(false);
      setTrashing(null);
    }
  };

  const showFolders = () => folderCard.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const explore = async (path: string) => {
    await open(path);
    showFolders();
  };

  const shown = folder?.entries.slice(0, SHOWN) ?? [];
  const rest = folder?.entries.slice(SHOWN) ?? [];
  const restSize = rest.reduce((sum, entry) => sum + entry.size, 0);
  // As pastas do primeiro nível da conta e da Biblioteca seguram o sistema: delas só se mostra.
  const parent = folder && folder.crumbs.length > 1 ? folder.crumbs[folder.crumbs.length - 2].path : null;
  const trashable = !!folder && folder.crumbs.length > 1 && !(folder.crumbs.length === 2 && folder.crumbs[1].name === 'Library');
  const percent = new Intl.NumberFormat(tr.locale, { style: 'percent', maximumFractionDigits: 1 });

  return (
    <section className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">{t('nav.disk')}</h1>
          <p className="page__subtitle">{t('disk.subtitle')}</p>
        </div>
      </header>

      <div className="page__body disk">
        <WholeDisk
          autoMeasure={intent === 'whole' && fullDiskAccess}
          onExplore={(path) => void explore(path)}
          onShowFolders={showFolders}
          onHomeMeasured={() => void open(remembered, { cachedOnly: true })}
          onRead={(dto) => setHomeElsewhere(dto.homeElsewhere)}
          reloadKey={wholeReload}
        />

        {homeElsewhere && !folder && phase === 'waiting' && (
          <article className="card disk__elsewhere">
            <p className="card__empty">{t('disk.elsewhere')}</p>
            <Button variant="primary" onClick={() => void open()}>
              {t('disk.measureHome')}
            </Button>
          </article>
        )}
        {homeElsewhere && !folder && phase === 'measuring' && (
          <article className="card disk__folder-measuring">
            <Spinner size={22} />
            <p className="stage__text">{t('disk.measuring', { size: tr.size(progress?.bytes ?? 0) })}</p>
            <p className="disk__current">{progress ? shortPath(progress.path) : ''}</p>
          </article>
        )}

        {!fullDiskAccess && (
          <div className="notice notice--warning disk__notice">
            <span>{t('disk.noAccess')}</span>
            <button type="button" className="link" onClick={() => void window.macleanfy.system.openFullDiskAccessSettings()}>
              {t('action.grant')}
            </button>
          </div>
        )}

        {phase === 'error' && !folder && <div className="notice notice--warning disk__notice">{t('disk.error')}</div>}

        {folder && (phase === 'ready' || phase === 'measuring') && (
          <article className="card disk__folder" ref={folderCard}>
            <nav className="disk__crumbs" aria-label={t('nav.disk')}>
              <button
                type="button"
                className="item__reveal disk__up"
                aria-label={t('disk.up')}
                data-tip={t('disk.up')}
                disabled={!parent || phase === 'measuring'}
                onClick={() => parent && void open(parent)}
              >
                <ArrowUp size={14} />
              </button>
              {folder.crumbs.map((crumb, index) => (
                <span key={crumb.path} className="disk__crumb">
                  {index > 0 && <ChevronRight size={13} />}
                  <button
                    type="button"
                    className={index === folder.crumbs.length - 1 ? 'disk__crumb--here' : undefined}
                    onClick={() => index < folder.crumbs.length - 1 && void open(crumb.path)}
                  >
                    {index === 0 ? t('disk.home') : crumb.name}
                  </button>
                </span>
              ))}
              <span className="disk__total">{tr.size(folder.size)}</span>
            </nav>

            {phase === 'measuring' ? (
              <div className="disk__folder-measuring">
                <Spinner size={22} />
                <p className="stage__text">{t('disk.measuring', { size: tr.size(progress?.bytes ?? 0) })}</p>
                <p className="disk__current">{progress ? shortPath(progress.path) : ''}</p>
              </div>
            ) : folder.entries.length === 0 ? (
              <p className="card__empty">{t('disk.empty')}</p>
            ) : (
              <ul className="disk__list">
                {shown.map((entry) => {
                  const fraction = folder.size > 0 ? entry.size / folder.size : 0;
                  return (
                    <li
                      key={entry.path}
                      className={`disk__row${entry.directory ? ' disk__row--folder' : ''}`}
                      role={entry.directory ? 'button' : undefined}
                      tabIndex={entry.directory ? 0 : undefined}
                      onClick={() => entry.directory && void open(entry.path)}
                      onKeyDown={(event) => {
                        if (entry.directory && event.key === 'Enter' && event.target === event.currentTarget) {
                          void open(entry.path);
                        }
                      }}
                    >
                      <span className="disk__icon">{entry.directory ? <Folder size={16} /> : <File size={16} />}</span>
                      <span className="disk__name">{entry.name}</span>
                      <span className="disk__bar" aria-hidden="true">
                        <span style={{ width: `${Math.max(fraction * 100, entry.size > 0 ? 0.6 : 0)}%` }} />
                      </span>
                      <span className="disk__size">{tr.size(entry.size)}</span>
                      <span className="disk__share">{percent.format(fraction)}</span>
                      <span className="disk__actions">
                        <button
                          type="button"
                          className="item__reveal"
                          aria-label={t('action.reveal')}
                          data-tip={t('action.reveal')}
                          data-tip-pos="left"
                          onClick={(event) => {
                            event.stopPropagation();
                            void window.macleanfy.system.reveal(entry.path);
                          }}
                        >
                          <FolderOpen size={14} />
                        </button>
                        {trashable && !isInPhotosLibrary(entry.path) && (
                          <button
                            type="button"
                            className="item__reveal disk__trash"
                            aria-label={t('disk.trash')}
                            data-tip={t('disk.trash')}
                            data-tip-pos="left"
                            onClick={(event) => {
                              event.stopPropagation();
                              setTrashing(entry);
                            }}
                          >
                            <Trash2 size={14} />
                          </button>
                        )}
                      </span>
                    </li>
                  );
                })}
                {rest.length > 0 && (
                  <li className="disk__row disk__row--rest">
                    <span className="disk__icon" />
                    <span className="disk__name">
                      {t('disk.smaller', { count: tr.plural('item', rest.length), size: tr.size(restSize) })}
                    </span>
                  </li>
                )}
              </ul>
            )}
          </article>
        )}
      </div>

      {trashing && (
        <Modal onClose={trashBusy ? undefined : () => setTrashing(null)} labelledBy="disk-trash-title">
          <div>
            <h2 id="disk-trash-title" className="modal__title">
              {t('disk.trash.title', { name: trashing.name })}
            </h2>
            <p className="modal__text">{t('disk.trash.text', { size: tr.size(trashing.size) })}</p>
            <p className="disk__current">{shortPath(trashing.path)}</p>
          </div>
          <div className="modal__actions">
            <Button disabled={trashBusy} onClick={() => setTrashing(null)}>
              {t('action.cancel')}
            </Button>
            <Button
              variant="danger"
              disabled={trashBusy}
              icon={trashBusy ? <Spinner /> : <Trash2 size={15} />}
              onClick={() => void confirmTrash()}
            >
              {t('disk.trash')}
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
