import { CircleCheck, Download, ExternalLink, TriangleAlert } from 'lucide-react';
import { useT } from '../i18n';
import { useStore } from '../state/store';
import { Button, Modal, Spinner } from './ui';

const RELEASE_URL = 'https://github.com/Meigston/MacleanFy/releases/tag/v';

/** Aviso de versão nova, andamento do download e convite para reiniciar, no mesmo diálogo. */
export function UpdateDialog() {
  const tr = useT();
  const { t } = tr;
  const update = useStore((state) => state.update);
  const current = useStore((state) => state.system?.appVersion ?? '');
  const close = () => useStore.getState().setUpdatePrompt(false);

  switch (update.status) {
    case 'available':
      return (
        <Modal onClose={close} labelledBy="update-title">
          <div className="result">
            <span className="result__icon">
              <Download size={30} />
            </span>
            <h2 id="update-title" className="result__title">
              {t('dialog.update.title', { version: update.version })}
            </h2>
            <p className="modal__text">{t('dialog.update.text', { current })}</p>
            <button
              type="button"
              className="link update__notes"
              onClick={() => void window.macleanfy.system.openExternal(RELEASE_URL + update.version)}
            >
              {t('dialog.update.notes')}
              <ExternalLink size={13} />
            </button>
          </div>
          <div className="modal__actions">
            <Button onClick={close}>{t('dialog.update.later')}</Button>
            <Button
              variant="primary"
              data-action="update-download"
              onClick={() => void window.macleanfy.updates.download()}
            >
              {t('dialog.update.confirm')}
            </Button>
          </div>
        </Modal>
      );

    case 'downloading':
      return (
        <Modal onClose={close} labelledBy="update-title">
          <div className="result">
            <Spinner size={30} />
            <h2 id="update-title" className="result__title">
              {t('dialog.update.downloading', { version: update.version })}
            </h2>
          </div>
          <div className="meter meter--accent">
            <div
              className="meter__fill"
              style={{ width: `${update.total > 0 ? (update.transferred / update.total) * 100 : 0}%` }}
            />
          </div>
          {update.total > 0 && (
            <p className="result__progress">
              {t('dialog.update.progress', { done: tr.size(update.transferred), total: tr.size(update.total) })}
            </p>
          )}
          <div className="modal__actions">
            <Button onClick={close}>{t('dialog.update.hide')}</Button>
          </div>
        </Modal>
      );

    case 'ready':
      return (
        <Modal onClose={close} labelledBy="update-title">
          <div className="result">
            <span className="result__icon">
              <CircleCheck size={30} />
            </span>
            <h2 id="update-title" className="result__title">
              {t('dialog.update.ready.title', { version: update.version })}
            </h2>
            <p className="modal__text">{t('dialog.update.ready.text')}</p>
          </div>
          <div className="modal__actions">
            <Button onClick={close}>{t('dialog.update.later')}</Button>
            <Button
              variant="primary"
              data-action="update-install"
              onClick={() => void window.macleanfy.updates.install()}
            >
              {t('dialog.update.restart')}
            </Button>
          </div>
        </Modal>
      );

    // Só aparece com o aviso já aberto: a busca que a pessoa refez a partir de um erro.
    case 'checking':
      return (
        <Modal labelledBy="update-title">
          <div className="result">
            <Spinner size={30} />
            <h2 id="update-title" className="result__title">
              {t('update.checking')}
            </h2>
          </div>
        </Modal>
      );

    case 'error':
      return (
        <Modal onClose={close} labelledBy="update-title">
          <div className="result">
            <span className="result__icon">
              <TriangleAlert size={30} />
            </span>
            <h2 id="update-title" className="result__title">
              {t('dialog.update.error.title')}
            </h2>
            <p className="modal__text">{t('dialog.update.error.text')}</p>
          </div>
          <div className="modal__actions">
            <Button onClick={close}>{t('dialog.update.close')}</Button>
            <Button variant="primary" onClick={() => void window.macleanfy.updates.check()}>
              {t('update.action.retry')}
            </Button>
          </div>
        </Modal>
      );

    default:
      return null;
  }
}
