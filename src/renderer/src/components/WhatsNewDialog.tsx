import { ExternalLink, Sparkles } from 'lucide-react';
import { useT } from '../i18n';
import { releaseNotes } from '../lib/releases';
import { useStore } from '../state/store';
import { Button, Modal } from './ui';

const RELEASES_URL = 'https://github.com/Meigston/MacleanFy/releases';

/** As novidades da versão, na primeira abertura depois de instalar ou atualizar. */
export function WhatsNewDialog({ version }: { version: string }) {
  const { t } = useT();
  const locale = useStore((state) => state.locale);
  const notes = releaseNotes(version, locale);
  const close = () => useStore.getState().closeWhatsNew();
  if (!notes) return null;

  return (
    <Modal onClose={close} labelledBy="whats-new-title">
      <div className="result">
        <span className="result__icon">
          <Sparkles size={30} />
        </span>
        <h2 id="whats-new-title" className="result__title">
          {t('dialog.whatsNew.title', { version: version.split('-')[0] })}
        </h2>
      </div>
      <ul className="whats-new">
        {notes.map((note) => (
          <li key={note.title} className="whats-new__item">
            <strong className="whats-new__title">{note.title}</strong>
            <span className="whats-new__text">{note.text}</span>
          </li>
        ))}
      </ul>
      <div className="modal__actions whats-new__actions">
        <button
          type="button"
          className="link"
          onClick={() => void window.macleanfy.system.openExternal(RELEASES_URL)}
        >
          {t('dialog.whatsNew.history')}
          <ExternalLink size={13} />
        </button>
        <Button variant="primary" data-action="whats-new-close" onClick={close}>
          {t('dialog.whatsNew.close')}
        </Button>
      </div>
    </Modal>
  );
}
