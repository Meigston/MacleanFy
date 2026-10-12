import { useEffect, useState } from 'react';
import { Check, Copy, CreditCard, ExternalLink, Globe, QrCode } from 'lucide-react';
import fixedQrUrl from '../../../../assets/support/pix-qr-fixed.svg';
import openQrUrl from '../../../../assets/support/pix-qr-open.svg';
import { PIX_OPTIONS, SUPPORT, readPix, type PixOption } from '../../../shared/support';
import { Button } from '../components/ui';
import { useT } from '../i18n';

const QR_URLS: Record<PixOption, string> = { fixed: fixedQrUrl, open: openQrUrl };

export function Support() {
  const { t, locale } = useT();
  const [option, setOption] = useState<PixOption>('fixed');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2500);
    return () => clearTimeout(timer);
  }, [copied]);

  const pix = readPix(SUPPORT.pix[option]);
  const money = (amount: number) => new Intl.NumberFormat(locale, { style: 'currency', currency: 'BRL' }).format(amount);
  const label = (amount: number | null | undefined, open: string) => (amount == null ? open : money(amount));

  const choose = (next: PixOption) => {
    setOption(next);
    setCopied(false);
  };
  const copy = async () => {
    await window.macleanfy.system.copyPixCode(option);
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
              <img className="support__qr" src={QR_URLS[option]} alt={t('support.pix.alt')} draggable={false} />
              <div className="support__pix-text">
                <h2 className="task__title support__heading">
                  <QrCode size={17} />
                  Pix
                </h2>
                <div className="segmented" role="radiogroup" aria-label={t('support.pix.amount')}>
                  {PIX_OPTIONS.map((id) => (
                    <button
                      key={id}
                      type="button"
                      role="radio"
                      aria-checked={option === id}
                      className={`segmented__option${option === id ? ' segmented__option--on' : ''}`}
                      data-pix={id}
                      onClick={() => choose(id)}
                    >
                      {label(readPix(SUPPORT.pix[id])?.amount, t('support.pix.other'))}
                    </button>
                  ))}
                </div>
                <p className="support__amount">{label(pix.amount, t('support.pix.open'))}</p>
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
            <Button
              variant="primary"
              icon={<ExternalLink size={15} />}
              onClick={() => void window.macleanfy.system.openExternal(SUPPORT.stripe)}
            >
              {t('support.stripe.action')}
            </Button>
          </div>
        </article>
      </div>
    </section>
  );
}
