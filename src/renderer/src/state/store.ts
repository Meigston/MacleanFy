import { create } from 'zustand';
import { CATEGORIES, type CategoryId } from '../../../core/types';
import type {
  AppsProgress,
  CleanProgress,
  CleanSummaryDTO,
  History,
  InstalledAppDTO,
  ScanResultDTO,
  SystemInfo,
  UninstallResultDTO,
  UpdateState,
} from '../../../shared/api';
import { initialLocale, persistLocale, type Locale } from '../i18n/locale';
import { ALL_CATEGORY_IDS, type GroupRoute } from '../lib/catalog';

export type Route = 'overview' | 'smart' | GroupRoute | 'uninstaller' | 'maintenance' | 'support' | 'about';

const ROUTES: Route[] = [
  'overview',
  'smart',
  'system',
  'development',
  'storage',
  'browsers',
  'large',
  'uninstaller',
  'maintenance',
  'support',
  'about',
];

function initialRoute(): Route {
  const hash = window.location.hash.replace(/^#/, '');
  return ROUTES.includes(hash as Route) ? (hash as Route) : 'overview';
}

type Selection = Partial<Record<CategoryId, ReadonlySet<string>>>;

interface State {
  locale: Locale;
  route: Route;
  system: SystemInfo | null;
  history: History | null;

  scanning: boolean;
  /** Categorias ainda sem resposta na análise em curso. */
  pending: CategoryId[];
  scanDone: number;
  scanTotal: number;
  results: Partial<Record<CategoryId, ScanResultDTO>>;
  scannedAt: number | null;
  selection: Selection;

  cleaning: boolean;
  cleanProgress: CleanProgress | null;

  apps: InstalledAppDTO[] | null;
  appsLoading: boolean;
  appsProgress: AppsProgress | null;
  appSelection: ReadonlySet<string>;

  update: UpdateState;
  /** O aviso de atualização está aberto? Abre sozinho uma vez por versão e quando ela fica pronta. */
  updatePrompt: boolean;

  init(): Promise<void>;
  setLocale(locale: Locale): void;
  navigate(route: Route): void;
  refresh(): Promise<void>;
  scan(categoryIds?: CategoryId[]): Promise<void>;
  setCategorySelected(id: CategoryId, selected: boolean): void;
  toggleItem(id: CategoryId, path: string): void;
  clean(categoryIds: CategoryId[], dryRun: boolean): Promise<CleanSummaryDTO>;
  loadApps(): Promise<void>;
  toggleApp(path: string): void;
  uninstallSelected(): Promise<UninstallResultDTO>;
  setUpdatePrompt(open: boolean): void;
}

/**
 * Só o que é seguro já vem marcado; o resto espera a escolha de quem usa.
 * O Docker fica de fora mesmo sendo "seguro": a limpeza dele é um prune de tudo
 * o que não está em uso — dezenas de GB de imagens num clique que ninguém pediu.
 */
function defaultSelection(result: ScanResultDTO): ReadonlySet<string> {
  const preselected = CATEGORIES[result.categoryId].safetyLevel === 'safe' && result.categoryId !== 'docker';
  return preselected ? new Set(result.items.map((item) => item.path)) : new Set();
}

let subscribed = false;
/** Versão que já teve o aviso aberto nesta sessão: fechar com "Depois" vale até o app reabrir. */
let promptedVersion: string | null = null;

export const useStore = create<State>((set, get) => ({
  locale: initialLocale(),
  route: initialRoute(),
  system: null,
  history: null,

  scanning: false,
  pending: [],
  scanDone: 0,
  scanTotal: 0,
  results: {},
  scannedAt: null,
  selection: {},

  cleaning: false,
  cleanProgress: null,

  apps: null,
  appsLoading: false,
  appsProgress: null,
  appSelection: new Set(),

  update: { status: 'idle' },
  updatePrompt: false,

  async init() {
    if (!subscribed) {
      subscribed = true;

      window.macleanfy.scan.onProgress(({ completed, result }) => {
        set((state) => ({
          scanDone: completed,
          pending: state.pending.filter((id) => id !== result.categoryId),
          results: { ...state.results, [result.categoryId]: result },
          selection: { ...state.selection, [result.categoryId]: defaultSelection(result) },
        }));
      });
      window.macleanfy.clean.onProgress((cleanProgress) => set({ cleanProgress }));
      window.macleanfy.apps.onProgress((appsProgress) => set({ appsProgress }));

      const receive = (update: UpdateState) =>
        set((state) => {
          let { updatePrompt } = state;
          if (update.status === 'available' && update.version !== promptedVersion) {
            promptedVersion = update.version;
            updatePrompt = true;
          } else if (update.status === 'ready' && state.update.status !== 'ready') {
            updatePrompt = true;
          } else if (update.status === 'current' || update.status === 'idle') {
            updatePrompt = false;
          }
          return { update, updatePrompt };
        });
      window.macleanfy.updates.onChange(receive);
      void window.macleanfy.updates.state().then(receive);
    }
    await get().refresh();
  },

  setLocale(locale) {
    persistLocale(locale);
    document.documentElement.lang = locale;
    set({ locale });
  },

  navigate(route) {
    set({ route });
  },

  async refresh() {
    const [system, history] = await Promise.all([window.macleanfy.system.info(), window.macleanfy.history.get()]);
    set({ system, history });
  },

  async scan(categoryIds) {
    if (get().scanning) return;

    const target = categoryIds ?? ALL_CATEGORY_IDS;
    set({ scanning: true, pending: target, scanDone: 0, scanTotal: target.length });
    try {
      await window.macleanfy.scan.run(categoryIds);
      set({ scannedAt: Date.now() });
    } finally {
      set({ scanning: false, pending: [] });
    }
    await get().refresh();
  },

  setCategorySelected(id, selected) {
    const result = get().results[id];
    if (!result) return;
    const paths = selected ? new Set(result.items.map((item) => item.path)) : new Set<string>();
    set((state) => ({ selection: { ...state.selection, [id]: paths } }));
  },

  toggleItem(id, path) {
    const next = new Set(get().selection[id]);
    if (!next.delete(path)) next.add(path);
    set((state) => ({ selection: { ...state.selection, [id]: next } }));
  },

  async clean(categoryIds, dryRun) {
    const { selection } = get();
    const request = categoryIds
      .map((categoryId) => ({ categoryId, paths: [...(selection[categoryId] ?? [])] }))
      .filter((entry) => entry.paths.length > 0);

    set({ cleaning: true, cleanProgress: null });
    try {
      const summary = await window.macleanfy.clean.run(request, { dryRun });
      // O que foi limpo saiu do disco: a lista dessas categorias precisa ser refeita.
      if (!dryRun) void get().scan(request.map((entry) => entry.categoryId));
      return summary;
    } finally {
      set({ cleaning: false, cleanProgress: null });
    }
  },

  async loadApps() {
    if (get().appsLoading) return;

    set({ appsLoading: true, appsProgress: null });
    try {
      const apps = await window.macleanfy.apps.list();
      set({ apps, appSelection: new Set() });
    } finally {
      set({ appsLoading: false });
    }
  },

  toggleApp(path) {
    const next = new Set(get().appSelection);
    if (!next.delete(path)) next.add(path);
    set({ appSelection: next });
  },

  async uninstallSelected() {
    const result = await window.macleanfy.apps.uninstall([...get().appSelection]);
    await Promise.all([get().loadApps(), get().refresh()]);
    return result;
  },

  setUpdatePrompt(open) {
    set({ updatePrompt: open });
  },
}));

/** Quanto de uma categoria está marcado para limpeza. */
export function selectedOf(result: ScanResultDTO | undefined, selected: ReadonlySet<string> | undefined) {
  if (!result || !selected || selected.size === 0) return { size: 0, count: 0 };
  if (selected.size === result.items.length) return { size: result.totalSize, count: result.items.length };

  let size = 0;
  let count = 0;
  for (const item of result.items) {
    if (selected.has(item.path)) {
      size += item.size;
      count++;
    }
  }
  return { size, count };
}
