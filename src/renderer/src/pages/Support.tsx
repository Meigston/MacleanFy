import { useEffect, useState } from 'react';
import { Check, Copy, CreditCard, ExternalLink, Globe, Heart, QrCode } from 'lucide-react';
import pixQrUrl from '../../../../assets/support/pix-qr.svg';
import { SUPPORT, readPix } from '../../../shared/support';
import { Button } from '../components/ui';
import { useT } from '../i18n';

const pix = readPix(SUPPORT.pix.payload);

export function Support() {
  const { t, locale } = useT();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(timer);
  }, [copied]);

  const open = (url: string) => void window.macleanfy.system.openExternal(url);
  const copy = async () => {
    await window.macleanfy.system.copyPixCode();
    setCopied(true);
  };

  return (
    <section className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">{t('support.title')}</h1>
          <p className="page__subtitle">{t('support.subtitle')}</p>
        </div>
      </header>

      <div className="support">
        {pix && (
          <article className="card task support__pix">
            <span className="support__scope">
              <span aria-hidden="true">🇧🇷</span>
              {t('support.pix.scope')}
            </span>
            <div className="support__pix-body">
              <img className="support__qr" src={pixQrUrl} alt={t('support.pix.alt')} draggable={false} />
              <div className="support__pix-text">
                <h2 className="task__title support__heading">
                  <QrCode size={17} />
                  Pix
                </h2>
                <p className="support__amount">
                  {new Intl.NumberFormat(locale, { style: 'currency', currency: 'BRL' }).format(pix.amount)}
                </p>
                <p className="task__meta">{t('support.pix.recipient', { name: pix.recipient })}</p>
                <p className="task__text">{t('support.pix.text')}</p>
                <div className="task__footer">
                  <Button variant="primary" icon={copied ? <Check size={15} /> : <Copy size={15} />} onClick={() => void copy()}>
                    {t(copied ? 'support.pix.copied' : 'support.pix.copy')}
                  </Button>
                </div>
              </div>
            </div>
          </article>
        )}

        <article className="card task">
          <span className="support__scope">
            <Globe size={13} />
            {t('support.stripe.scope')}
          </span>
          <h2 className="task__title support__heading">
            <CreditCard size={17} />
            {t('support.stripe.title')}
          </h2>
          <p className="task__text">{t('support.stripe.text')}</p>
          <div className="task__footer">
            <Button variant="primary" icon={<ExternalLink size={15} />} onClick={() => open(SUPPORT.stripe)}>
              {t('support.stripe.action')}
            </Button>
          </div>
        </article>

        <article className="card task">
          <span className="support__scope">
            <Globe size={13} />
            {t('support.sponsors.scope')}
          </span>
          <h2 className="task__title support__heading">
            <Heart size={17} />
            GitHub Sponsors
          </h2>
          <p className="task__text">{t('support.sponsors.text')}</p>
          <div className="task__footer">
            <Button icon={<ExternalLink size={15} />} onClick={() => open(SUPPORT.sponsors)}>
              {t('support.sponsors.action')}
            </Button>
          </div>
        </article>
      </div>
    </section>
  );
}
