import { useMemo } from 'react';
import { CATEGORIES, type CategoryGroup, type CategoryId } from '../../../core/types';
import { useStore } from '../state/store';
import type { Locale } from './locale';
import { categoryEn, categoryPt, en, groupPt, pt, type StringKey } from './strings';

export { LOCALES, type Locale } from './locale';

type Vars = Record<string, string | number>;
type PluralKey = 'item' | 'category' | 'app' | 'related' | 'snapshot';

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

export interface Translator {
  locale: Locale;
  t(key: StringKey, vars?: Vars): string;
  plural(key: PluralKey, n: number): string;
  /** Unidades decimais, como o Finder mostra. */
  size(bytes: number): string;
  number(n: number): string;
  date(ms: number): string;
  ago(ms: number): string;
  category(id: CategoryId): { name: string; description: string; note?: string };
  group(group: CategoryGroup): string;
}

export function createTranslator(locale: Locale): Translator {
  const table: Record<StringKey, string> = locale === 'pt-BR' ? pt : en;
  const numberFormat = new Intl.NumberFormat(locale);
  const dateFormat = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'long', year: 'numeric' });
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });

  const t = (key: StringKey, vars?: Vars): string =>
    table[key].replace(/\{(\w+)\}/g, (match, name: string) => (vars && name in vars ? String(vars[name]) : match));

  return {
    locale,
    t,
    plural: (key, n) => t(`plural.${key}.${n === 1 ? 'one' : 'other'}`, { n: numberFormat.format(n) }),
    size(bytes) {
      if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
      const unit = Math.min(Math.floor(Math.log10(bytes) / 3), UNITS.length - 1);
      const value = bytes / 1000 ** unit;
      const digits = unit < 2 ? 0 : value < 10 ? 2 : value < 100 ? 1 : 0;
      const formatted = new Intl.NumberFormat(locale, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      }).format(value);
      return `${formatted} ${UNITS[unit]}`;
    },
    number: (n) => numberFormat.format(n),
    date: (ms) => dateFormat.format(ms),
    ago(ms) {
      const seconds = Math.round((ms - Date.now()) / 1000);
      const abs = Math.abs(seconds);
      if (abs < 60) return relative.format(Math.trunc(seconds), 'second');
      if (abs < 3600) return relative.format(Math.trunc(seconds / 60), 'minute');
      if (abs < 86400) return relative.format(Math.trunc(seconds / 3600), 'hour');
      return relative.format(Math.trunc(seconds / 86400), 'day');
    },
    category(id) {
      if (locale === 'pt-BR') return categoryPt[id];
      const base = CATEGORIES[id];
      return { name: base.name, description: base.description, note: base.safetyNote, ...categoryEn[id] };
    },
    group: (group) => (locale === 'pt-BR' ? groupPt[group] : group),
  };
}

export function useT(): Translator {
  const locale = useStore((state) => state.locale);
  return useMemo(() => createTranslator(locale), [locale]);
}
