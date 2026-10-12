import { useState } from 'react';
import { CircleCheck, TriangleAlert } from 'lucide-react';
import { CATEGORIES, type CategoryId } from '../../../core/types';
import type { CleanSummaryDTO } from '../../../shared/api';
import { useT } from '../i18n';
import { selectedOf, useStore } from '../state/store';
import { Button, Checkbox, Modal, SafetyBadge, Spinner } from './ui';

interface Props {
  /** Categorias da tela que abriu o diálogo; só as que têm seleção entram. */
  ids: CategoryId[];
  onClose(): void;
}

/** Confirmação, andamento e resultado de uma limpeza, no mesmo diálogo. */
export function CleanDialog({ ids, onClose }: Props) {
  const tr = useT();
  const { t } = tr;
  const clean = useStore((state) => state.clean);
  const cleanProgress = useStore((state) => state.cleanProgress);

  // A foto da seleção é tirada na abertura: a lista por trás é refeita depois da limpeza.
  const [plan] = useState(() => {
    const { results, selection } = useStore.getState();
    return ids
      .map((id) => ({ id, ...selectedOf(results[id], selection[id]) }))
      .filter((entry) => entry.count > 0);
  });

  const [dryRun, setDryRun] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<CleanSummaryDTO | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const totalSize = plan.reduce((sum, entry) => sum + entry.size, 0);
  const hasRisky = plan.some((entry) => CATEGORIES[entry.id].safetyLevel === 'risky');
  const notes = plan.filter((entry) => CATEGORIES[entry.id].safetyLevel !== 'safe' && tr.category(entry.id).note);
  const blocked = hasRisky && !dryRun && !acknowledged;

  const run = async () => {
    setRunning(true);
    try {
      setSummary(
        await clean(
          plan.map((entry) => entry.id),
          dryRun
        )
      );
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setRunning(false);
    }
  };

  if (summary || failure) {
    const errors = summary?.results.filter((result) => result.errors.length > 0) ?? [];
    return (
      <Modal onClose={onClose} labelledBy="clean-title">
        <div className="result">
          <span className="result__icon">
            {failure ? <TriangleAlert size={30} /> : <CircleCheck size={30} />}
          </span>
          <h2 id="clean-title" className="result__title">
            {failure ??
              t(summary!.dryRun ? 'dialog.clean.result.dryRun' : 'dialog.clean.result', {
                size: tr.size(summary!.totalFreedSpace),
              })}
          </h2>
          {summary && (
            <p className="modal__text">
              {t(summary.dryRun ? 'dialog.clean.result.items.dryRun' : 'dialog.clean.result.items', {
                count: tr.plural('item', summary.totalCleanedItems),
              })}
            </p>
          )}
        </div>
        {errors.length > 0 && (
          <div className="notice notice--warning">
            <strong>{t('dialog.clean.result.errors')}</strong>
            <ul>
              {errors.map((result) => (
                <li key={result.categoryId}>
                  {tr.category(result.categoryId).name}: {result.errors.join('; ')}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="modal__actions">
          <Button variant="primary" onClick={onClose}>
            {t('action.done')}
          </Button>
        </div>
      </Modal>
    );
  }

  if (running) {
    const current = cleanProgress?.categoryId;
    const { doneBytes = 0, totalBytes = 0 } = cleanProgress ?? {};
    // Sem bytes para contar (nada selecionado de fato), a barra anda por categoria.
    const done = !cleanProgress
      ? 0
      : totalBytes > 0
        ? doneBytes / totalBytes
        : cleanProgress.completed / Math.max(cleanProgress.total, 1);
    return (
      <Modal labelledBy="clean-title">
        <div className="result">
          <Spinner size={30} />
          <h2 id="clean-title" className="result__title">
            {t('dialog.clean.running', { name: current ? tr.category(current).name : '' })}
          </h2>
        </div>
        <div className="meter meter--accent">
          <div className="meter__fill" style={{ width: `${done * 100}%` }} />
        </div>
        {totalBytes > 0 && (
          <p className="result__progress">
            {t('dialog.clean.progress', { done: tr.size(doneBytes), total: tr.size(totalBytes) })}
          </p>
        )}
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose} labelledBy="clean-title">
      <div>
        <h2 id="clean-title" className="modal__title">
          {t('dialog.clean.title', { size: tr.size(totalSize) })}
        </h2>
        <p className="modal__text">{t('dialog.clean.text')}</p>
      </div>

      <ul className="plan">
        {plan.map((entry) => (
          <li key={entry.id} className="plan__row">
            <span className="plan__name">{tr.category(entry.id).name}</span>
            <SafetyBadge level={CATEGORIES[entry.id].safetyLevel} />
            <span className="plan__count">{tr.plural('item', entry.count)}</span>
            <span className="plan__size">{tr.size(entry.size)}</span>
          </li>
        ))}
      </ul>

      {notes.length > 0 && (
        <div className={`notice notice--${hasRisky ? 'danger' : 'warning'}`}>
          <ul>
            {notes.map((entry) => (
              <li key={entry.id}>
                <strong>{tr.category(entry.id).name}:</strong> {tr.category(entry.id).note}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="option">
        <Checkbox state={dryRun ? 'on' : 'off'} label={t('dialog.clean.dryRun')} onChange={setDryRun} />
        <span onClick={() => setDryRun(!dryRun)}>{t('dialog.clean.dryRun')}</span>
      </div>
      {hasRisky && !dryRun && (
        <div className="option">
          <Checkbox state={acknowledged ? 'on' : 'off'} label={t('dialog.clean.ack')} onChange={setAcknowledged} />
          <span onClick={() => setAcknowledged(!acknowledged)}>{t('dialog.clean.ack')}</span>
        </div>
      )}

      <div className="modal__actions">
        <Button onClick={onClose}>{t('action.cancel')}</Button>
        <Button variant={dryRun ? 'primary' : 'danger'} data-action="confirm-clean" disabled={blocked} onClick={run}>
          {t(dryRun ? 'dialog.clean.simulate' : 'dialog.clean.confirm')}
        </Button>
      </div>
    </Modal>
  );
}
