import { useEffect, useState } from 'react';
import { CircleAlert, CircleCheck, History, KeyRound, Network, type LucideIcon } from 'lucide-react';
import type { MaintenanceInfo, MaintenanceResultDTO, MaintenanceTask } from '../../../shared/api';
import { Button, Spinner } from '../components/ui';
import { useT } from '../i18n';
import type { StringKey } from '../i18n/strings';

interface Task {
  id: MaintenanceTask;
  icon: LucideIcon;
  title: StringKey;
  text: StringKey;
  action: StringKey;
  /** Apaga algo que não volta: o botão sai em vermelho. */
  destructive?: boolean;
}

const TASKS: Task[] = [
  { id: 'dns', icon: Network, title: 'maintenance.dns.title', text: 'maintenance.dns.text', action: 'action.run' },
  {
    id: 'snapshots',
    icon: History,
    title: 'maintenance.snapshots.title',
    text: 'maintenance.snapshots.text',
    action: 'maintenance.snapshots.action',
    destructive: true,
  },
];

export function Maintenance() {
  const tr = useT();
  const { t } = tr;
  const [running, setRunning] = useState<MaintenanceTask | null>(null);
  const [outcome, setOutcome] = useState<Partial<Record<MaintenanceTask, MaintenanceResultDTO>>>({});
  const [info, setInfo] = useState<MaintenanceInfo | null>(null);

  const inspect = () =>
    void window.macleanfy.maintenance
      .info()
      .then(setInfo)
      .catch(() => setInfo({ purgeable: null, snapshots: [] }));

  useEffect(inspect, []);

  const run = async (task: MaintenanceTask) => {
    setRunning(task);
    try {
      const result = await window.macleanfy.maintenance.run(task);
      setOutcome((current) => ({ ...current, [task]: result }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setOutcome((current) => ({ ...current, [task]: { success: false, error: message } }));
    } finally {
      setRunning(null);
      inspect();
    }
  };

  /** O que há para apagar, e quanto o macOS ainda segura como purgável. */
  const snapshotDetail = () => {
    if (!info) return <Spinner size={13} />;
    const count = info.snapshots.length;
    return (
      <>
        <span>{count > 0 ? tr.plural('snapshot', count) : t('maintenance.snapshots.none')}</span>
        {info.purgeable !== null && (
          <>
            <span aria-hidden="true">·</span>
            <span data-tip={t('maintenance.snapshots.purgeable.tip')}>
              {t('maintenance.snapshots.purgeable', { size: tr.size(info.purgeable) })}
            </span>
          </>
        )}
      </>
    );
  };

  return (
    <section className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">{t('nav.maintenance')}</h1>
          <p className="page__subtitle">{t('maintenance.subtitle')}</p>
        </div>
      </header>

      <div className="tasks">
        {TASKS.map(({ id, icon: Icon, title, text, action, destructive }) => {
          const result = outcome[id];
          // Sem snapshots não há o que apagar: o cartão fica só informando o purgável.
          const nothingToDo = id === 'snapshots' && (info?.snapshots.length ?? 0) === 0;
          return (
            <article key={id} className="card task">
              <span className="task__icon">
                <Icon size={22} strokeWidth={1.7} />
              </span>
              <h2 className="task__title">{t(title)}</h2>
              <p className="task__text">{t(text)}</p>
              {id === 'snapshots' && <p className="task__detail">{snapshotDetail()}</p>}
              <span className="task__meta">
                <KeyRound size={13} />
                {t('maintenance.admin')}
              </span>
              <div className="task__footer">
                <Button
                  variant={destructive ? 'danger' : 'primary'}
                  disabled={running !== null || nothingToDo}
                  icon={running === id ? <Spinner /> : undefined}
                  onClick={() => void run(id)}
                >
                  {t(action)}
                </Button>
                {result && running !== id && (
                  <span className={`task__result task__result--${result.success ? 'ok' : 'fail'}`}>
                    {result.success ? <CircleCheck size={15} /> : <CircleAlert size={15} />}
                    {result.success
                      ? t('maintenance.ok')
                      : result.cancelled
                        ? t('maintenance.cancelled')
                        : t('maintenance.failed', { error: result.error ?? '' })}
                  </span>
                )}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
