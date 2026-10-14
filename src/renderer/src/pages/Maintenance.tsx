import { useEffect, useState } from 'react';
import {
  CircleAlert,
  CircleCheck,
  FolderX,
  History,
  Images,
  KeyRound,
  LockOpen,
  Network,
  Search,
  type LucideIcon,
} from 'lucide-react';
import type { MaintenanceInfo, MaintenanceResultDTO, MaintenanceTask } from '../../../shared/api';
import { Button, Spinner, Switch } from '../components/ui';
import { useT } from '../i18n';
import type { StringKey } from '../i18n/strings';

interface Task {
  id: MaintenanceTask;
  icon: LucideIcon;
  title: StringKey;
  text: StringKey;
  action: StringKey;
  /** Roda como root: o macOS pede a senha. */
  admin: boolean;
  /** Apaga algo que não volta: o botão sai em vermelho. */
  destructive?: boolean;
  /** Quando "Concluído" diria menos do que aconteceu. */
  done?: StringKey;
}

const TASKS: Task[] = [
  { id: 'dns', icon: Network, title: 'maintenance.dns.title', text: 'maintenance.dns.text', action: 'action.run', admin: true },
  {
    id: 'quicklook',
    icon: Images,
    title: 'maintenance.quicklook.title',
    text: 'maintenance.quicklook.text',
    action: 'action.run',
    admin: false,
  },
  {
    id: 'spotlight',
    icon: Search,
    title: 'maintenance.spotlight.title',
    text: 'maintenance.spotlight.text',
    action: 'maintenance.spotlight.action',
    admin: true,
    done: 'maintenance.spotlight.ok',
  },
  {
    id: 'snapshots',
    icon: History,
    title: 'maintenance.snapshots.title',
    text: 'maintenance.snapshots.text',
    action: 'maintenance.snapshots.action',
    admin: true,
    destructive: true,
  },
];

const UNKNOWN: MaintenanceInfo = { purgeable: null, snapshots: [], spotlight: null, noDsStore: null };

function Outcome({ result, done }: { result: MaintenanceResultDTO; done?: StringKey }) {
  const { t } = useT();
  return (
    <span className={`task__result task__result--${result.success ? 'ok' : 'fail'}`}>
      {result.success ? <CircleCheck size={15} /> : <CircleAlert size={15} />}
      {result.success
        ? t(done ?? 'maintenance.ok')
        : result.cancelled
          ? t('maintenance.cancelled')
          : t('maintenance.failed', { error: result.error ?? '' })}
    </span>
  );
}

function Meta({ admin }: { admin: boolean }) {
  const { t } = useT();
  return (
    <span className="task__meta">
      {admin ? <KeyRound size={13} /> : <LockOpen size={13} />}
      {t(admin ? 'maintenance.admin' : 'maintenance.noAdmin')}
    </span>
  );
}

export function Maintenance() {
  const tr = useT();
  const { t } = tr;
  const [running, setRunning] = useState<MaintenanceTask | 'dsstore' | null>(null);
  const [outcome, setOutcome] = useState<Partial<Record<MaintenanceTask | 'dsstore', MaintenanceResultDTO>>>({});
  const [info, setInfo] = useState<MaintenanceInfo | null>(null);

  const inspect = () =>
    void window.macleanfy.maintenance
      .info()
      .then(setInfo)
      .catch(() => setInfo(UNKNOWN));

  useEffect(inspect, []);

  const perform = async (key: MaintenanceTask | 'dsstore', work: () => Promise<MaintenanceResultDTO>) => {
    setRunning(key);
    try {
      const result = await work();
      setOutcome((current) => ({ ...current, [key]: result }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setOutcome((current) => ({ ...current, [key]: { success: false, error: message } }));
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

  const detail = (id: MaintenanceTask) => {
    if (id === 'snapshots') return <p className="task__detail">{snapshotDetail()}</p>;
    if (id === 'spotlight' && info?.spotlight != null) {
      return <p className="task__detail">{t(info.spotlight ? 'maintenance.spotlight.on' : 'maintenance.spotlight.off')}</p>;
    }
    return null;
  };

  /** Sem snapshots não há o que apagar; com o Spotlight desligado, não há índice para refazer. */
  const nothingToDo = (id: MaintenanceTask) =>
    (id === 'snapshots' && (info?.snapshots.length ?? 0) === 0) || (id === 'spotlight' && info?.spotlight === false);

  const dsStoreResult = outcome.dsstore;

  return (
    <section className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">{t('nav.maintenance')}</h1>
          <p className="page__subtitle">{t('maintenance.subtitle')}</p>
        </div>
      </header>

      <div className="page__body">
        <div className="tasks">
          {TASKS.map(({ id, icon: Icon, title, text, action, admin, destructive, done }) => {
            const result = outcome[id];
            return (
              <article key={id} className="card task">
                <span className="task__icon">
                  <Icon size={22} strokeWidth={1.7} />
                </span>
                <h2 className="task__title">{t(title)}</h2>
                <p className="task__text">{t(text)}</p>
                {detail(id)}
                <Meta admin={admin} />
                <div className="task__footer">
                  <Button
                    variant={destructive ? 'danger' : 'primary'}
                    disabled={running !== null || nothingToDo(id)}
                    icon={running === id ? <Spinner /> : undefined}
                    onClick={() => void perform(id, () => window.macleanfy.maintenance.run(id))}
                  >
                    {t(action)}
                  </Button>
                  {result && running !== id && <Outcome result={result} done={done} />}
                </div>
              </article>
            );
          })}

          <article className="card task task--setting">
            <span className="task__icon">
              <FolderX size={22} strokeWidth={1.7} />
            </span>
            <div className="task__setting-body">
              <h2 className="task__title">{t('maintenance.dsstore.title')}</h2>
              <p className="task__text">{t('maintenance.dsstore.text')}</p>
              <div className="task__setting-meta">
                <Meta admin={false} />
                {dsStoreResult && !dsStoreResult.success && running !== 'dsstore' && <Outcome result={dsStoreResult} />}
              </div>
            </div>
            {info === null || running === 'dsstore' ? (
              <Spinner size={18} />
            ) : (
              <Switch
                on={info.noDsStore === true}
                label={t('maintenance.dsstore.title')}
                disabled={running !== null || info.noDsStore === null}
                onChange={(on) => void perform('dsstore', () => window.macleanfy.maintenance.setNoDsStore(on))}
              />
            )}
          </article>
        </div>
      </div>
    </section>
  );
}
