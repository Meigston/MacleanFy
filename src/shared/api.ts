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
  maintenanceNoDsStore: 'maintenance:no-ds-store',
  startupList: 'startup:list',
  openLoginItems: 'shell:login-items',
  openFullDiskAccess: 'shell:full-disk-access',
  openExternal: 'shell:open-external',
  reveal: 'shell:reveal',
  copyPixCode: 'support:copy-pix',
  performanceSample: 'performance:sample',
  openActivityMonitor: 'shell:activity-monitor',
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
  /** Na Biblioteca da conta. `personal` são configurações e documentos, que dá para manter. */
  related: Array<{ path: string; size: number; personal: boolean }>;
  /** Fora da conta, em /Library: jobs do launchd e ajudantes. Só saem com a senha de administrador. */
  system: Array<{ path: string; size: number }>;
  totalSize: number;
  /** Ícone do app como data URL. */
  icon?: string;
}

export interface AppsProgress {
  completed: number;
  total: number;
}

export interface UninstallOptionsDTO {
  /** Deixa configurações e documentos para uma reinstalação. */
  keepPersonal?: boolean;
}

export interface UninstallResultDTO {
  uninstalled: number;
  freedSpace: number;
  /** Nomes dos apps que não puderam ser removidos. */
  errors: string[];
  /** Arquivos fora da conta: quantos saíram e quantos ficaram, se a senha foi negada ou deu erro. */
  system?: { removed: number; kept: number };
}

export type MaintenanceTask = 'dns' | 'quicklook' | 'spotlight' | 'snapshots';

/** O que a tela de manutenção mostra antes de qualquer tarefa rodar. Nulo quando não deu para saber. */
export interface MaintenanceInfo {
  /** Bytes que o macOS libera sozinho quando precisa. */
  purgeable: number | null;
  /** Datas dos snapshots locais do Time Machine no disco de inicialização. */
  snapshots: string[];
  /** Se o Spotlight indexa o disco de inicialização. */
  spotlight: boolean | null;
  /** Se o Finder deixou de gravar .DS_Store em pastas de rede e pendrives. */
  noDsStore: boolean | null;
}

export interface MaintenanceResultDTO {
  success: boolean;
  cancelled?: boolean;
  error?: string;
}

/** De quem é o item: da sua conta, de todas as contas ou do sistema. */
export type StartupScope = 'user' | 'agent' | 'daemon';
/**
 * Ao carregar (entrar na conta, ou ligar o Mac para o sistema), de tempos em tempos ou quando
 * chamado; `unknown` quando só o root lê o plist.
 */
export type StartupWhen = 'load' | 'schedule' | 'demand' | 'unknown';

/** Algo que o launchd abre sozinho. Só para ler: desligar fica com os Ajustes do Mac. */
export interface StartupItemDTO {
  label: string;
  /** O plist que cadastra o item; é ele que "Mostrar no Finder" aponta. */
  path: string;
  scope: StartupScope;
  /** Nome do app dono, quando dá para saber. */
  app: string | null;
  program: string | null;
  when: StartupWhen;
  /** O programa que ele chama não existe mais: sobra de app removido. */
  missing: boolean;
  disabled: boolean;
  running: boolean;
}

export type ThermalState = 'unknown' | 'nominal' | 'fair' | 'serious' | 'critical';
export type MemoryPressure = 'normal' | 'warning' | 'critical';

/** Um app e os ajudantes dele, somados. */
export interface ProcessGroupDTO {
  name: string;
  /** Em % de um núcleo: um app ocupando dois núcleos inteiros marca 200. */
  cpu: number;
  /** Memória residente somada; aproximada. */
  memory: number;
  count: number;
  /** Processo do próprio macOS. */
  system: boolean;
}

export interface BatteryDTO {
  percent: number;
  charging: boolean;
  plugged: boolean;
  cycles: number;
  /** Capacidade atual sobre a de fábrica, de 0 a 1. */
  health: number | null;
  /** Graus Celsius. */
  temperature: number | null;
}

/**
 * Algo que explica um Mac lento. O diagnóstico só lê: aponta o que pesa e o
 * que fazer, e nunca encerra nem muda nada.
 */
export type PerformanceFinding =
  | { id: 'memory'; severity: 'warning' | 'critical'; apps: string[] }
  | { id: 'swap'; severity: 'warning'; used: number; apps: string[] }
  | { id: 'cpu'; severity: 'warning'; load: number; cores: number; apps: string[] }
  | { id: 'runaway'; severity: 'warning'; app: string; hours: number; average: number }
  | { id: 'spotlight'; severity: 'info'; cpu: number }
  | { id: 'thermal'; severity: 'warning' | 'critical' }
  | { id: 'uptime'; severity: 'info' | 'warning'; days: number };

export type FindingSeverity = PerformanceFinding['severity'];

/** Como o Mac está agora. Taxas em bytes por segundo, medidas desde a leitura anterior. */
export interface PerformanceSample {
  at: number;
  cpu: {
    /** De 0 a 1, média de todos os núcleos. */
    usage: number;
    cores: number[];
    /** Média de 1, 5 e 15 minutos. */
    load: number[];
  };
  memory: {
    total: number;
    used: number;
    cached: number;
    pressure: MemoryPressure;
    swapUsed: number;
    swapTotal: number;
  };
  disk: { read: number; write: number };
  network: { iface: string | null; down: number; up: number };
  battery: BatteryDTO | null;
  /** Segundos desde que o Mac ligou. */
  uptime: number;
  thermal: ThermalState;
  topCpu: ProcessGroupDTO[];
  topMemory: ProcessGroupDTO[];
  findings: PerformanceFinding[];
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
    uninstall(appPaths: string[], options?: UninstallOptionsDTO): Promise<UninstallResultDTO>;
  };
  performance: {
    sample(): Promise<PerformanceSample>;
    openActivityMonitor(): Promise<void>;
  };
  startup: {
    list(): Promise<StartupItemDTO[]>;
    /** Ajustes → Geral → Itens de Início, onde se liga e desliga cada um. */
    openSettings(): Promise<void>;
  };
  maintenance: {
    info(): Promise<MaintenanceInfo>;
    run(task: MaintenanceTask): Promise<MaintenanceResultDTO>;
    /** Liga ou desliga a gravação de .DS_Store em pastas de rede e pendrives. */
    setNoDsStore(on: boolean): Promise<MaintenanceResultDTO>;
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
