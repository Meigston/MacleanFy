import { useMemo, useState } from 'react';
import {
  Bot,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Flame,
  FolderGit2,
  FolderOpen,
  Ghost,
  History,
  Info,
  Layers,
  LockKeyhole,
  Radio,
  RefreshCw,
  Snowflake,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { AI_COLD_DAYS, type AiItemDTO, type AiRemoveResultDTO } from '../../../shared/api';
import { Button, Checkbox, Modal, SafetyBadge, Spinner, shortPath, type CheckState } from '../components/ui';
import { useT, type Translator } from '../i18n';
import {
  AI_FAMILIES,
  AI_FAMILY_ICONS,
  AI_KINDS,
  aiStateOf,
  aiTool,
  isInUse,
  isRemovable,
  projectName,
  sumSize,
  type AiState,
} from '../lib/ai';
import { useStore } from '../state/store';

type View = 'tool' | 'project';
type Filter = 'all' | 'cold' | 'hot';

// A visão e o filtro valem até o app fechar, como a pasta aberta no Espaço em disco.
let rememberedView: View = 'tool';
let rememberedFilter: Filter = 'all';

/** O estado nunca é só cor: cada selo tem ícone e nome. */
const STATE_ICONS: Record<AiState, LucideIcon> = {
  'in-use': Radio,
  orphan: Ghost,
  'old-version': History,
  cold: Snowflake,
  hot: Flame,
};

interface Group {
  key: string;
  name: string;
  /** Caminho completo do projeto, ou o que cabe em "Sem projeto". */
  tip?: string;
  icon: LucideIcon;
  items: AiItemDTO[];
  size: number;
}

interface Section {
  key: string;
  label: string | null;
  size: number;
  groups: Group[];
}

const bySize = (a: { size: number }, b: { size: number }) => b.size - a.size;

/** Linhas de um grupo aberto antes de juntar o resto em "menores": o Copilot passa de cem. */
const SHOWN = 30;

function makeGroup(key: string, name: string, icon: LucideIcon, items: AiItemDTO[], tip?: string): Group {
  return { key, name, icon, tip, items: [...items].sort(bySize), size: sumSize(items) };
}

/** Por ferramenta: uma seção por família. Por projeto: uma lista só, com "Sem projeto" no fim. */
function groupItems(items: AiItemDTO[], view: View, tr: Translator): Section[] {
  if (view === 'tool') {
    const byTool = new Map<string, AiItemDTO[]>();
    for (const item of items) byTool.set(item.tool, [...(byTool.get(item.tool) ?? []), item]);
    return AI_FAMILIES.map((family) => {
      const groups = [...byTool]
        .filter(([tool]) => aiTool(tool).family === family)
        .map(([tool, list]) => makeGroup(`tool:${tool}`, aiTool(tool).name, AI_FAMILY_ICONS[family], list))
        .sort(bySize);
      return { key: family, label: tr.t(`ai.family.${family}`), size: sumSize(groups.flatMap((g) => g.items)), groups };
    }).filter((section) => section.groups.length > 0);
  }

  const byProject = new Map<string, AiItemDTO[]>();
  const loose: AiItemDTO[] = [];
  for (const item of items) {
    if (item.project) byProject.set(item.project, [...(byProject.get(item.project) ?? []), item]);
    else loose.push(item);
  }
  const groups = [...byProject]
    .map(([path, list]) => makeGroup(`project:${path}`, projectName(path), FolderGit2, list, shortPath(path)))
    .sort(bySize);
  if (loose.length > 0) groups.push(makeGroup('project:', tr.t('ai.noProject'), Layers, loose, tr.t('ai.noProject.tip')));
  return groups.length > 0 ? [{ key: 'projects', label: null, size: sumSize(items), groups }] : [];
}

interface SegmentedProps<T extends string> {
  label: string;
  name: string;
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange(value: T): void;
}

function Segmented<T extends string>({ label, name, value, options, onChange }: SegmentedProps<T>) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          data-option={`${name}-${option.id}`}
          className={`segmented__option${value === option.id ? ' segmented__option--on' : ''}`}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ItemRow({ item, view, selected }: { item: AiItemDTO; view: View; selected: boolean }) {
  const tr = useT();
  const { t } = tr;
  const toggle = useStore((state) => state.toggleAiItem);

  const removable = isRemovable(item);
  const state = aiStateOf(item);
  const StateIcon = STATE_ICONS[state];
  // Na visão por ferramenta, a segunda linha diz de que projeto é; na por projeto, de que ferramenta.
  // Sessões têm o nome do próprio projeto: aí o nome vira a ferramenta, para não repetir.
  const project = item.project ? projectName(item.project) : null;
  const tool = aiTool(item.tool).name;
  const named = view === 'project' && item.label === project;
  const name = named ? tool : item.label;
  const owner = view === 'tool' ? (project === item.label ? null : project) : named ? null : tool;
  const lowConfidence = item.lastUsed > 0 && item.confidence === 'low';
  const when =
    item.lastUsed === 0
      ? t('ai.noDate')
      : t(lowConfidence ? 'ai.downloaded' : 'ai.used', { ago: tr.ago(item.lastUsed) });
  // Sessões e pastas de temporário dizem algo; o número de arquivos de uma worktree ou de um modelo, não.
  const count =
    item.kind === 'sessions'
      ? tr.plural('session', item.count)
      : item.kind === 'temp' && item.count > 1
        ? tr.plural('folder', item.count)
        : '';

  return (
    <div
      className={`item ai-item${removable ? '' : ' ai-item--locked'}`}
      data-ai-item={item.id}
      onClick={removable ? () => toggle(item.id) : undefined}
    >
      <Checkbox state={selected ? 'on' : 'off'} disabled={!removable} label={name} onChange={() => toggle(item.id)} />
      <span className="item__text">
        <span className="ai-item__name">
          <span className="ai-item__label" data-tip={shortPath(item.path)} data-tip-pos="top">
            {name}
          </span>
          <span className="item__tag">{t(`ai.kind.${item.kind}`)}</span>
        </span>
        <span className="item__path">
          {owner && <>{owner} · </>}
          <span data-tip={lowConfidence ? t('ai.downloaded.tip') : undefined} data-tip-pos="top">
            {when}
          </span>
        </span>
        {item.blocked ? (
          <span className="ai-item__reason ai-item__reason--blocked">
            <LockKeyhole size={11} />
            <span data-tip={t(`ai.block.${item.blocked}`)} data-tip-pos="top">
              {t(`ai.block.${item.blocked}`)}
            </span>
          </span>
        ) : item.hint ? (
          <span className="ai-item__reason">
            <Info size={11} />
            <span data-tip={t(`ai.hint.${item.hint}`)} data-tip-pos="top">
              {t(`ai.hint.${item.hint}`)}
            </span>
          </span>
        ) : null}
      </span>
      <span className="ai-item__badges">
        {item.safety === 'moderate' && <SafetyBadge level="moderate" />}
        <span
          className={`badge ai-state ai-state--${state}`}
          data-tip={t(`ai.state.${state}.tip`, { days: AI_COLD_DAYS })}
          data-tip-pos="top"
        >
          <StateIcon size={12} />
          {t(`ai.state.${state}`)}
        </span>
      </span>
      <span className="ai-item__count">{count}</span>
      <span className="item__size">{tr.size(item.size)}</span>
      <button
        type="button"
        className="item__reveal"
        aria-label={t('action.reveal')}
        data-tip={t('action.reveal')}
        data-tip-pos="left"
        onClick={(event) => {
          event.stopPropagation();
          void window.macleanfy.system.reveal(item.path);
        }}
      >
        <FolderOpen size={14} />
      </button>
    </div>
  );
}

interface GroupCardProps {
  group: Group;
  view: View;
  open: boolean;
  onToggleOpen(): void;
}

function GroupCard({ group, view, open, onToggleOpen }: GroupCardProps) {
  const tr = useT();
  const { t } = tr;
  const selection = useStore((state) => state.aiSelection);
  const setAiSelected = useStore((state) => state.setAiSelected);

  // O marcador do grupo só alcança o que pode sair; o resto aparece, mas não se marca.
  const removable = group.items.filter(isRemovable);
  const chosen = removable.filter((item) => selection.has(item.id)).length;
  const state: CheckState = chosen === 0 ? 'off' : chosen === removable.length ? 'on' : 'mixed';
  const cold = sumSize(group.items.filter((item) => item.heat === 'cold'));
  const count = tr.plural('item', group.items.length);
  const Icon = group.icon;
  const [all, setAll] = useState(false);
  const shown = all ? group.items : group.items.slice(0, SHOWN);
  const rest = group.items.slice(shown.length);

  return (
    <div className={`cat${state !== 'off' ? ' cat--selected' : ''}`} data-group={group.key}>
      <div
        className="cat__row cat__row--app"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggleOpen}
        onKeyDown={(event) => {
          if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) {
            event.preventDefault();
            onToggleOpen();
          }
        }}
      >
        <Checkbox
          state={state}
          disabled={removable.length === 0}
          label={group.name}
          onChange={(checked) => setAiSelected(removable.map((item) => item.id), checked)}
        />
        <span className="cat__icon">
          <Icon size={18} strokeWidth={1.8} />
        </span>
        <span className="cat__text">
          <span className="cat__name">
            <span data-tip={group.tip} data-tip-pos="top">
              {group.name}
            </span>
          </span>
          <span className="cat__desc">{cold > 0 ? t('ai.group.desc', { count, cold: tr.size(cold) }) : count}</span>
        </span>
        <span className="cat__numbers">
          <span className="cat__size">{tr.size(group.size)}</span>
        </span>
        <span className="cat__chevron">{open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}</span>
      </div>

      {open && (
        <div className="cat__items">
          {shown.map((item) => (
            <ItemRow key={item.id} item={item} view={view} selected={selection.has(item.id)} />
          ))}
          {rest.length > 0 && (
            <p className="cat__more">
              {t('disk.smaller', { count: tr.plural('item', rest.length), size: tr.size(sumSize(rest)) })} ·{' '}
              <button type="button" className="link" onClick={() => setAll(true)}>
                {t('ai.showAll')}
              </button>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function Ai() {
  const tr = useT();
  const { t } = tr;
  const scan = useStore((state) => state.ai);
  const loading = useStore((state) => state.aiLoading);
  const progress = useStore((state) => state.aiProgress);
  const error = useStore((state) => state.aiError);
  const selection = useStore((state) => state.aiSelection);
  const loadAi = useStore((state) => state.loadAi);
  const selectColdAi = useStore((state) => state.selectColdAi);
  const clearAiSelection = useStore((state) => state.clearAiSelection);
  const removeAiSelected = useStore((state) => state.removeAiSelected);

  const [view, setView] = useState<View>(rememberedView);
  const [filter, setFilter] = useState<Filter>(rememberedFilter);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  // O que foi pedido fica guardado: ao voltar da remoção, a lista do store já não tem o que saiu.
  const [asked, setAsked] = useState<AiItemDTO[] | null>(null);
  const [result, setResult] = useState<{ dto: AiRemoveResultDTO; asked: Map<string, AiItemDTO> } | null>(null);

  const items = useMemo(() => scan?.items ?? [], [scan]);
  const visible = useMemo(() => items.filter((item) => filter === 'all' || item.heat === filter), [items, filter]);
  const sections = useMemo(() => groupItems(visible, view, tr), [visible, view, tr]);

  const totals = useMemo(() => {
    const sum = { cold: 0, hot: 0, inUse: 0, reclaim: 0, reclaimCount: 0 };
    for (const item of items) {
      if (isInUse(item)) sum.inUse += item.size;
      else if (item.heat === 'cold') sum.cold += item.size;
      else sum.hot += item.size;
      if (item.heat === 'cold' && isRemovable(item)) {
        sum.reclaim += item.size;
        sum.reclaimCount++;
      }
    }
    return { ...sum, total: sum.cold + sum.hot + sum.inUse };
  }, [items]);

  const chosen = items.filter((item) => selection.has(item.id));
  const chosenSize = sumSize(chosen);
  const canMarkCold = visible.some((item) => item.heat === 'cold' && isRemovable(item) && !selection.has(item.id));
  const plan = asked ?? chosen;
  const losses = AI_KINDS.filter((kind) => plan.some((item) => item.kind === kind && item.safety === 'moderate'));

  const changeView = (next: View) => {
    rememberedView = next;
    setView(next);
  };
  const changeFilter = (next: Filter) => {
    rememberedFilter = next;
    setFilter(next);
  };
  const toggleOpen = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const closeDialog = () => {
    setConfirming(false);
    setResult(null);
  };

  const run = async () => {
    setAsked(chosen);
    setRunning(true);
    try {
      setResult({ dto: await removeAiSelected(), asked: new Map(chosen.map((item) => [item.id, item])) });
    } finally {
      setRunning(false);
      setAsked(null);
    }
  };

  const loadingText = t('ai.loading', { done: progress?.done ?? 0, total: progress?.total ?? 0 });

  const header = (
    <header className="page__header">
      <div>
        <h1 className="page__title">{t('nav.ai')}</h1>
        <p className="page__subtitle">
          {loading && scan
            ? t('ai.subtitle.loading', { done: progress?.done ?? 0, total: progress?.total ?? 0 })
            : scan
              ? t('ai.subtitle', {
                  size: tr.size(totals.total),
                  count: tr.plural('item', items.length),
                  cold: tr.size(totals.cold),
                })
              : t('ai.subtitle.idle')}
        </p>
      </div>
      {scan && (
        <div className="page__actions ai__actions">
          <Segmented
            label={t('ai.view')}
            name="view"
            value={view}
            options={[
              { id: 'tool', label: t('ai.view.tool') },
              { id: 'project', label: t('ai.view.project') },
            ]}
            onChange={changeView}
          />
          <Segmented
            label={t('ai.filter')}
            name="filter"
            value={filter}
            options={[
              { id: 'all', label: t('ai.filter.all') },
              { id: 'cold', label: t('ai.filter.cold') },
              { id: 'hot', label: t('ai.filter.hot') },
            ]}
            onChange={changeFilter}
          />
          <Button
            disabled={loading}
            aria-label={t('action.rescan')}
            data-tip={t('action.rescan')}
            data-tip-pos="bottom"
            data-action="ai-scan"
            icon={loading ? <Spinner /> : <RefreshCw size={15} />}
            onClick={() => void loadAi()}
          />
        </div>
      )}
    </header>
  );

  if (!scan) {
    return (
      <section className="page">
        {header}
        <div className="stage">
          {loading ? (
            <>
              <Spinner size={34} />
              <p className="stage__text">{loadingText}</p>
              <div className="meter meter--accent stage__meter">
                <div
                  className="meter__fill"
                  style={{ width: `${progress ? (progress.done / Math.max(progress.total, 1)) * 100 : 0}%` }}
                />
              </div>
              <p className="disk__current">{t('ai.loading.note')}</p>
            </>
          ) : (
            <div className="disk__intro">
              <span className="task__icon">
                <Bot size={22} strokeWidth={1.7} />
              </span>
              <h2 className="task__title">{t('ai.intro.title')}</h2>
              <p className="task__text">{error ? t('ai.error') : t('ai.intro.text', { days: AI_COLD_DAYS })}</p>
              <Button variant="primary" data-action="ai-scan" onClick={() => void loadAi()}>
                {t('action.scan')}
              </Button>
            </div>
          )}
        </div>
      </section>
    );
  }

  const parts = [
    { id: 'cold', label: t('ai.legend.cold'), size: totals.cold },
    { id: 'hot', label: t('ai.legend.hot'), size: totals.hot },
    { id: 'in-use', label: t('ai.legend.inUse'), size: totals.inUse },
  ];

  return (
    <section className="page">
      {header}
      <div className="page__body ai">
        <article className="card ai__summary">
          <div>
            <span className="card__label">{t('ai.reclaimable')}</span>
            <div className={`card__value${totals.reclaim === 0 ? ' card__value--muted' : ''}`}>{tr.size(totals.reclaim)}</div>
            <span className="card__sub">
              {totals.reclaimCount > 0
                ? t('ai.reclaimable.sub', { count: tr.plural('item', totals.reclaimCount) })
                : t('ai.reclaimable.none')}
            </span>
          </div>
          {totals.total > 0 && (
            <div className="ai__split">
              <div
                className="segbar ai__segbar"
                role="img"
                aria-label={t('ai.bar', {
                  cold: tr.size(totals.cold),
                  hot: tr.size(totals.hot),
                  inUse: tr.size(totals.inUse),
                })}
              >
                {parts
                  .filter((part) => part.size > 0)
                  .map((part) => (
                    <span
                      key={part.id}
                      className={`segbar__seg ai__fill--${part.id}`}
                      style={{ flexGrow: part.size }}
                      data-tip={`${part.label} · ${tr.size(part.size)}`}
                      data-tip-pos="top"
                    />
                  ))}
              </div>
              <div className="disk__legend">
                {parts.map((part) => (
                  <span key={part.id}>
                    <i className={`disk__swatch ai__fill--${part.id}`} />
                    {part.label} <strong>{tr.size(part.size)}</strong>
                  </span>
                ))}
              </div>
            </div>
          )}
          <div className="ai__notes">
            <p className="ai__note">
              <Info size={13} />
              {t('ai.trashNote')}
            </p>
            {scan.failed.length > 0 && (
              <p className="ai__note">
                <CircleAlert size={13} />
                {t('ai.failed', { names: tr.list(scan.failed.map((id) => aiTool(id).name)) })}
              </p>
            )}
          </div>
        </article>

        {error && <div className="notice notice--warning">{t('ai.error')}</div>}

        {sections.length === 0 ? (
          <p className="card__empty card__empty--center">
            {t(filter === 'cold' ? 'ai.empty.cold' : filter === 'hot' ? 'ai.empty.hot' : 'ai.empty.all', {
              days: AI_COLD_DAYS,
            })}
          </p>
        ) : (
          <div className="catlist">
            {sections.map((section) => (
              <div key={section.key} className="catlist__section">
                {section.label && (
                  <h2 className="group-label">
                    {section.label}
                    <span className="ai__section-size">{tr.size(section.size)}</span>
                  </h2>
                )}
                {section.groups.map((group) => (
                  <GroupCard
                    key={group.key}
                    group={group}
                    view={view}
                    open={open.has(group.key)}
                    onToggleOpen={() => toggleOpen(group.key)}
                  />
                ))}
              </div>
            ))}
          </div>
        )}
      </div>

      <footer className="actionbar">
        <div className="actionbar__text">
          {chosen.length > 0 ? (
            <>
              <strong>{t('cleaner.selected', { size: tr.size(chosenSize) })}</strong>
              <span>
                {t('cleaner.selected.in', { count: tr.plural('item', chosen.length) })}
                {' · '}
                <button type="button" className="link ai__clear" onClick={clearAiSelection}>
                  {t('ai.clearSelection')}
                </button>
              </span>
            </>
          ) : (
            <>
              <strong>{t('cleaner.selected.none')}</strong>
              <span>{t('ai.selected.hint')}</span>
            </>
          )}
        </div>
        <div className="ai__bar-actions">
          <Button
            size="lg"
            data-action="ai-cold"
            disabled={!canMarkCold || loading}
            icon={<Snowflake size={16} />}
            onClick={() => selectColdAi(visible.map((item) => item.id))}
          >
            {t('ai.markCold')}
          </Button>
          <Button
            variant="danger"
            size="lg"
            data-action="ai-remove"
            disabled={chosen.length === 0 || loading}
            icon={<Trash2 size={16} />}
            onClick={() => setConfirming(true)}
          >
            {t('ai.action')}
          </Button>
        </div>
      </footer>

      {confirming && (
        <Modal onClose={running ? undefined : closeDialog} labelledBy="ai-remove-title">
          {result ? (
            <>
              <div className="result">
                <span className="result__icon">
                  {result.dto.removed > 0 ? <CircleCheck size={30} /> : <CircleAlert size={30} />}
                </span>
                <h2 id="ai-remove-title" className="result__title">
                  {result.dto.removed > 0 ? tr.plural('removed', result.dto.removed) : t('ai.result.none')}
                </h2>
                {result.dto.removed > 0 && <p className="modal__text">{tr.size(result.dto.freedSpace)}</p>}
              </div>
              {result.dto.failed.length > 0 && (
                <div className="notice notice--warning ai__failed">
                  <strong>{t('ai.result.failed')}</strong>
                  <ul>
                    {result.dto.failed.map((entry) => (
                      <li key={entry.id}>
                        {result.asked.get(entry.id)?.label ?? entry.id}
                        {' · '}
                        {entry.blocked ? t(`ai.block.${entry.blocked}`) : t('ai.result.unknown')}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {result.dto.removed > 0 && <p className="ai__note ai__note--center">{t('ai.result.trash')}</p>}
              <div className="modal__actions">
                <Button variant="primary" onClick={closeDialog}>
                  {t('action.done')}
                </Button>
              </div>
            </>
          ) : (
            <>
              <div>
                <h2 id="ai-remove-title" className="modal__title">
                  {t('ai.dialog.title', { count: tr.plural('item', plan.length) })}
                </h2>
                <p className="modal__text">
                  {[
                    t('ai.dialog.text'),
                    plan.some((item) => item.removal === 'git') && t('ai.dialog.git'),
                    plan.some((item) => item.removal === 'command') && t('ai.dialog.command'),
                  ]
                    .filter(Boolean)
                    .join(' ')}
                </p>
              </div>
              <ul className="plan ai__plan">
                {[...plan].sort(bySize).map((item) => (
                  <li key={item.id} className="plan__row">
                    <span className="plan__name">{item.label}</span>
                    <span className="plan__count">
                      {aiTool(item.tool).name} · {t(`ai.kind.${item.kind}`)}
                    </span>
                    <span className="plan__size">{tr.size(item.size)}</span>
                  </li>
                ))}
              </ul>
              {losses.length > 0 && (
                <div className="notice notice--warning ai__loss">
                  <strong>{t('ai.dialog.loss')}</strong>
                  <ul>
                    {losses.map((kind) => (
                      <li key={kind}>
                        <strong>{t(`ai.kind.${kind}`)}</strong>: {t(`ai.loss.${kind}`)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="modal__actions">
                <Button disabled={running} onClick={closeDialog}>
                  {t('action.cancel')}
                </Button>
                <Button
                  variant="danger"
                  disabled={running || plan.length === 0}
                  icon={running ? <Spinner /> : <Trash2 size={15} />}
                  onClick={() => void run()}
                >
                  {t('ai.action')}
                </Button>
              </div>
            </>
          )}
        </Modal>
      )}
    </section>
  );
}
