import { useState } from 'react';
import { CircleAlert, CircleCheck, KeyRound, MemoryStick, Network, type LucideIcon } from 'lucide-react';
import type { MaintenanceResultDTO, MaintenanceTask } from '../../../shared/api';
import { Button, Spinner } from '../components/ui';
import { useT } from '../i18n';
import type { StringKey } from '../i18n/strings';

const TASKS: Array<{ id: MaintenanceTask; icon: LucideIcon; title: StringKey; text: StringKey }> = [
  { id: 'dns', icon: Network, title: 'maintenance.dns.title', text: 'maintenance.dns.text' },
  { id: 'purgeable', icon: MemoryStick, title: 'maintenance.purgeable.title', text: 'maintenance.purgeable.text' },
];

export function Maintenance() {
  const { t } = useT();
  const [running, setRunning] = useState<MaintenanceTask | null>(null);
  const [outcome, setOutcome] = useState<Partial<Record<MaintenanceTask, MaintenanceResultDTO>>>({});

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
    }
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
        {TASKS.map(({ id, icon: Icon, title, text }) => {
          const result = outcome[id];
          return (
            <article key={id} className="card task">
              <span className="task__icon">
                <Icon size={22} strokeWidth={1.7} />
              </span>
              <h2 className="task__title">{t(title)}</h2>
              <p className="task__text">{t(text)}</p>
              <span className="task__meta">
                <KeyRound size={13} />
                {t('maintenance.admin')}
              </span>
              <div className="task__footer">
                <Button
                  variant="primary"
                  disabled={running !== null}
                  icon={running === id ? <Spinner /> : undefined}
                  onClick={() => void run(id)}
                >
                  {t('action.run')}
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
