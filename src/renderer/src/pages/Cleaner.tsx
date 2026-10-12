import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, CircleAlert, FolderOpen, Sparkles } from 'lucide-react';
import { CATEGORIES, type CategoryGroup, type CategoryId } from '../../../core/types';
import type { ScanResultDTO } from '../../../shared/api';
import { CleanDialog } from '../components/CleanDialog';
import { BrandSymbol, Button, Checkbox, SafetyBadge, Spinner, shortPath, type CheckState } from '../components/ui';
import { useT } from '../i18n';
import { CATEGORY_ICONS, GROUPS, GROUP_BY_NAME, categoriesOf } from '../lib/catalog';
import { selectedOf, useStore } from '../state/store';

/** Uma categoria pode ter milhares de itens; a lista aberta mostra os maiores. */
const VISIBLE_ITEMS = 200;

interface CategoryRowProps {
  id: CategoryId;
  result: ScanResultDTO | undefined;
  pending: boolean;
  open: boolean;
  onToggleOpen(): void;
}

function CategoryRow({ id, result, pending, open, onToggleOpen }: CategoryRowProps) {
  const tr = useT();
  const { t } = tr;
  const selected = useStore((state) => state.selection[id]);
  const setCategorySelected = useStore((state) => state.setCategorySelected);
  const toggleItem = useStore((state) => state.toggleItem);

  const category = CATEGORIES[id];
  const text = tr.category(id);
  const Icon = CATEGORY_ICONS[id];

  const count = result?.items.length ?? 0;
  const chosen = selectedOf(result, selected);
  const state: CheckState = chosen.count === 0 ? 'off' : chosen.count === count ? 'on' : 'mixed';
  const expandable = count > 0 && !pending;

  const items = useMemo(
    () => (open && result ? [...result.items].sort((a, b) => b.size - a.size).slice(0, VISIBLE_ITEMS) : []),
    [open, result]
  );

  const classes = ['cat', state !== 'off' && 'cat--selected', result && count === 0 && !pending && 'cat--empty'];

  return (
    <div className={classes.filter(Boolean).join(' ')} data-category={id}>
      <div
        className="cat__row"
        role={expandable ? 'button' : undefined}
        tabIndex={expandable ? 0 : undefined}
        aria-expanded={expandable ? open : undefined}
        onClick={expandable ? onToggleOpen : undefined}
        onKeyDown={(event) => {
          if (expandable && (event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) {
            event.preventDefault();
            onToggleOpen();
          }
        }}
      >
        <Checkbox
          state={state}
          disabled={!expandable}
          label={text.name}
          onChange={(checked) => setCategorySelected(id, checked)}
        />
        <span className="cat__icon">
          <Icon size={18} strokeWidth={1.8} />
        </span>
        <span className="cat__text">
          <span className="cat__name">{text.name}</span>
          <span className="cat__desc">{text.description}</span>
        </span>
        <SafetyBadge level={category.safetyLevel} />
        <span className="cat__numbers">
          {pending ? (
            <span className="cat__pending">
              <Spinner size={14} />
              {t('cleaner.pending')}
            </span>
          ) : result?.error ? (
            <span className="cat__pending" data-tip={result.error} data-tip-pos="left">
              <CircleAlert size={14} />
              {t('cleaner.error')}
            </span>
          ) : !result ? (
            <span className="cat__count">—</span>
          ) : count === 0 ? (
            <span className="cat__count">{t('cleaner.empty')}</span>
          ) : (
            <>
              <span className="cat__size">{tr.size(result.totalSize)}</span>
              <span className="cat__count">{tr.plural('item', count)}</span>
            </>
          )}
        </span>
        <span className="cat__chevron">
          {expandable && (open ? <ChevronDown size={16} /> : <ChevronRight size={16} />)}
        </span>
      </div>

      {open && result && (
        <div className="cat__items">
          {text.note && <p className={`cat__note cat__note--${category.safetyLevel}`}>{text.note}</p>}
          {items.map((item) => (
            <div key={item.path} className="item" onClick={() => toggleItem(id, item.path)}>
              <Checkbox
                state={selected?.has(item.path) ? 'on' : 'off'}
                label={item.name}
                onChange={() => toggleItem(id, item.path)}
              />
              <span className="item__text">
                <span className="item__name">{item.name}</span>
                <span className="item__path">{shortPath(item.path)}</span>
              </span>
              <span className="item__size">{tr.size(item.size)}</span>
              {item.path.startsWith('/') ? (
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
              ) : (
                <span />
              )}
            </div>
          ))}
          {count > items.length && <p className="cat__more">{t('cleaner.more', { count: count - items.length })}</p>}
        </div>
      )}
    </div>
  );
}

export function Cleaner({ group }: { group?: CategoryGroup }) {
  const tr = useT();
  const { t } = tr;
  const results = useStore((state) => state.results);
  const selection = useStore((state) => state.selection);
  const scanning = useStore((state) => state.scanning);
  const pending = useStore((state) => state.pending);
  const scanDone = useStore((state) => state.scanDone);
  const scanTotal = useStore((state) => state.scanTotal);
  const scan = useStore((state) => state.scan);

  const [open, setOpen] = useState<CategoryId | null>(null);
  const [confirming, setConfirming] = useState(false);

  const ids = useMemo(() => categoriesOf(group), [group]);
  const title = group ? tr.group(group) : t('nav.smart');

  const scanned = ids.filter((id) => results[id]);
  const busy = ids.some((id) => pending.includes(id));
  const totalSize = scanned.reduce((sum, id) => sum + results[id]!.totalSize, 0);
  const withItems = scanned.filter((id) => results[id]!.items.length > 0).length;

  const chosen = ids.map((id) => selectedOf(results[id], selection[id]));
  const selectedSize = chosen.reduce((sum, c) => sum + c.size, 0);
  const selectedCount = chosen.reduce((sum, c) => sum + c.count, 0);

  const runScan = () => void scan(group ? ids : undefined);

  const scanButton = (size: 'md' | 'lg', primary: boolean) => (
    <Button
      variant={primary ? 'primary' : 'default'}
      size={size}
      data-action="scan"
      disabled={scanning}
      icon={scanning ? <Spinner /> : <Sparkles size={16} />}
      onClick={runScan}
    >
      {scanning
        ? t('action.scanning', { done: scanDone, total: scanTotal })
        : t(scanned.length > 0 ? 'action.rescan' : 'action.scan')}
    </Button>
  );

  const showList = scanned.length > 0 || busy;
  const sections = group ? [GROUP_BY_NAME[group]] : GROUPS;

  return (
    <section className="page">
      <header className="page__header">
        <div>
          <h1 className="page__title">{title}</h1>
          <p className="page__subtitle">
            {scanned.length > 0
              ? t('cleaner.subtitle.done', { size: tr.size(totalSize), count: tr.plural('category', withItems) })
              : t('cleaner.subtitle.idle', { count: tr.plural('category', ids.length) })}
          </p>
        </div>
        {showList && <div className="page__actions">{scanButton('md', false)}</div>}
      </header>

      {!showList ? (
        <div className="stage">
          <div className="orb">
            <BrandSymbol size={132} />
          </div>
          <h2 className="stage__title">{t('cleaner.stage.title')}</h2>
          <p className="stage__text">{t('cleaner.stage.text')}</p>
          {scanButton('lg', true)}
          <ul className="stage__chips">
            {ids.map((id) => (
              <li key={id} className="chip">
                {tr.category(id).name}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <>
          <div className="page__body">
            <div className="catlist">
              {sections.map((section) => (
                <div key={section.group} className="catlist__section">
                  {!group && (
                    <h2 className="group-label">
                      <span className="legend__dot" style={{ background: section.color }} />
                      {tr.group(section.group)}
                    </h2>
                  )}
                  {categoriesOf(section.group).map((id) => (
                    <CategoryRow
                      key={id}
                      id={id}
                      result={results[id]}
                      pending={pending.includes(id)}
                      open={open === id}
                      onToggleOpen={() => setOpen(open === id ? null : id)}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>

          <footer className="actionbar">
            <div className="actionbar__text">
              {selectedCount > 0 ? (
                <>
                  <strong>{t('cleaner.selected', { size: tr.size(selectedSize) })}</strong>
                  <span>{t('cleaner.selected.in', { count: tr.plural('item', selectedCount) })}</span>
                </>
              ) : (
                <>
                  <strong>{t('cleaner.selected.none')}</strong>
                  <span>{t('cleaner.selected.hint')}</span>
                </>
              )}
            </div>
            <Button
              variant="primary"
              size="lg"
              data-action="clean"
              disabled={selectedCount === 0 || scanning}
              onClick={() => setConfirming(true)}
            >
              {t('action.clean')}
            </Button>
          </footer>
        </>
      )}

      {confirming && <CleanDialog ids={ids} onClose={() => setConfirming(false)} />}
    </section>
  );
}
