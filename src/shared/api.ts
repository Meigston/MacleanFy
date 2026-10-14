import type { CategoryId } from '../core/types';
import type { PixOption } from './support';

/**
 * Contrato entre o processo principal e a interface.
 *
 * O renderer roda isolado e sem Node; tudo o que toca o disco passa por aqui.
 * Uma regra atravessa as chamadas destrutivas: a interface só devolve
 * identificadores (categoria + caminho) de coisas que o processo principal
 * acabou de listar. Caminho que não veio da última análise é ignorado.
 */

export const CHANNELS = {
  systemInfo: 'system:info',
  historyGet: 'history:get',
  scanRun: 'scan:run',
  scanProgress: 'scan:progress',
  cleanRun: 'clean:run',
  cleanProgress: 'clean:progress',
  appsList: 'apps:list',
  appsProgress: 'apps:progress',
  appsUninstall: 'apps:uninstall',
  maintenanceRun: 'maintenance:run',
  maintenanceInfo: 'maintenance:info',
  openFullDiskAccess: 'shell:full-disk-access',
  openExternal: 'shell:open-external',
  reveal: 'shell:reveal',
  copyPixCode: 'support:copy-pix',
  updateState: 'update:state',
  updateChanged: 'update:changed',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateInstall: 'update:install',
} as const;

export interface ItemDTO {
  path: string;
  name: string;
  size: number;
  isDirectory: boolean;
  /** Milissegundos desde a época. */
  modifiedAt?: number;
}

export interface ScanResultDTO {
  categoryId: CategoryId;
  items: ItemDTO[];
  totalSize: number;
  error?: string;
}

export interface ScanProgress {
  completed: number;
  total: number;
  result: ScanResultDTO;
}

export interface CleanSelection {
  categoryId: CategoryId;
  paths: string[];
}

export interface CleanOptions {
  /** Percorre tudo sem apagar nada. */
  dryRun?: boolean;
}

export interface CleanResultDTO {
  categoryId: CategoryId;
  cleanedItems: number;
  freedSpace: number;
  errors: string[];
}

export interface CleanSummaryDTO {
  results: CleanResultDTO[];
  totalFreedSpace: number;
  totalCleanedItems: number;
  totalErrors: number;
  dryRun: boolean;
}

export interface CleanProgress {
  completed: number;
  total: number;
  /** Categoria em andamento; ausente no aviso final. */
  categoryId?: CategoryId;
  /** Bytes já apagados e o total escolhido: é por eles que a barra anda. */
  doneBytes: number;
  totalBytes: number;
}

export interface SystemInfo {
  appVersion: string;
  osVersion: string;
  locale: string;
  modelName: string;
  chip: string;
  memory: string;
  disk: {
    volumeName: string;
    total: number;
    free: number;
  };
  fullDiskAccess: boolean;
}

export interface HistoryEntry {
  at: number;
  kind: 'clean' | 'uninstall';
  freedSpace: number;
  items: number;
  /** Categorias limpas, ou nomes dos apps removidos. */
  labels: string[];
}

export interface History {
  /** Primeiro uso registrado; base do "desde ...". */
  since: number;
  totalFreedSpace: number;
  totalItems: number;
  entries: HistoryEntry[];
}

export interface InstalledAppDTO {
  name: string;
  path: string;
  size: number;
  related: Array<{ path: string; size: number }>;
  totalSize: number;
  /** Ícone do app como data URL. */
  icon?: string;
}

export interface AppsProgress {
  completed: number;
  total: number;
}

export interface UninstallResultDTO {
  uninstalled: number;
  freedSpace: number;
  /** Nomes dos apps que não puderam ser removidos. */
  errors: string[];
}

export type MaintenanceTask = 'dns' | 'snapshots';

/** O que a tela de manutenção mostra antes de qualquer tarefa rodar. */
export interface MaintenanceInfo {
  /** Bytes que o macOS libera sozinho quando precisa; nulo quando não deu para medir. */
  purgeable: number | null;
  /** Datas dos snapshots locais do Time Machine no disco de inicialização. */
  snapshots: string[];
}

export interface MaintenanceResultDTO {
  success: boolean;
  cancelled?: boolean;
  error?: string;
}

/**
 * Em que pé está a atualização do app. Quem decide é o processo principal; a
 * interface só mostra e pede o próximo passo.
 */
export type UpdateState =
  /** Rodando do código-fonte: não há instalação para atualizar. */
  | { status: 'unsupported' }
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'current'; checkedAt: number }
  | { status: 'available'; version: string }
  | { status: 'downloading'; version: string; transferred: number; total: number }
  /** Baixada e conferida; entra quando o app reiniciar ou for fechado. */
  | { status: 'ready'; version: string }
  | { status: 'error' };

export type Unsubscribe = () => void;

export interface MacleanFyApi {
  system: {
    info(): Promise<SystemInfo>;
    openFullDiskAccessSettings(): Promise<void>;
    openExternal(url: string): Promise<void>;
    reveal(path: string): Promise<void>;
    /** Copia um dos códigos Pix do projeto para a área de transferência. */
    copyPixCode(option: PixOption): Promise<void>;
  };
  history: {
    get(): Promise<History>;
  };
  scan: {
    /** Sem lista, analisa todas as categorias. */
    run(categoryIds?: CategoryId[]): Promise<ScanResultDTO[]>;
    onProgress(listener: (progress: ScanProgress) => void): Unsubscribe;
  };
  clean: {
    run(selection: CleanSelection[], options?: CleanOptions): Promise<CleanSummaryDTO>;
    onProgress(listener: (progress: CleanProgress) => void): Unsubscribe;
  };
  apps: {
    list(): Promise<InstalledAppDTO[]>;
    onProgress(listener: (progress: AppsProgress) => void): Unsubscribe;
    uninstall(appPaths: string[]): Promise<UninstallResultDTO>;
  };
  maintenance: {
    info(): Promise<MaintenanceInfo>;
    run(task: MaintenanceTask): Promise<MaintenanceResultDTO>;
  };
  updates: {
    state(): Promise<UpdateState>;
    /** Busca pedida por quem usa: sempre termina num estado que a tela mostra. */
    check(): Promise<void>;
    download(): Promise<void>;
    /** Fecha o app, instala a versão baixada e abre de novo. */
    install(): Promise<void>;
    onChange(listener: (state: UpdateState) => void): Unsubscribe;
  };
}
