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
  whatsNew: 'system:whats-new',
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
  diskList: 'disk:list',
  diskProgress: 'disk:progress',
  diskTrash: 'disk:trash',
  aiScan: 'ai:scan',
  aiProgress: 'ai:progress',
  aiRemove: 'ai:remove',
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

export interface DiskEntryDTO {
  name: string;
  path: string;
  /** Bytes ocupados no disco. */
  size: number;
  directory: boolean;
}

/** Uma pasta da conta e o que tem dentro, do maior para o menor. */
export interface DiskFolderDTO {
  path: string;
  /** Da pasta pessoal até aqui. */
  crumbs: Array<{ name: string; path: string }>;
  size: number;
  entries: DiskEntryDTO[];
  /** Quando a pasta pessoal foi medida. */
  scannedAt: number;
  /** Tamanho da pasta pessoal inteira. */
  home: number;
  disk: { total: number; free: number };
}

/** Enquanto mede: quanto do primeiro nível já está somado e por onde o du anda. */
export interface DiskProgress {
  bytes: number;
  path: string;
}

/** Dias sem uso para o que uma ferramenta de IA deixou contar como frio. */
export const AI_COLD_DAYS = 7;

/** Como a tela de IA agrupa as ferramentas. */
export type AiFamily = 'assistant' | 'editor' | 'model' | 'automation';

/** As ferramentas que a tela de IA conhece. O nome é a marca: igual nos dois idiomas. */
export const AI_TOOLS = {
  'claude-code': { name: 'Claude Code', family: 'assistant' },
  'claude-desktop': { name: 'Claude', family: 'assistant' },
  codex: { name: 'Codex', family: 'assistant' },
  chatgpt: { name: 'ChatGPT', family: 'assistant' },
  'gemini-cli': { name: 'Gemini CLI', family: 'assistant' },
  copilot: { name: 'GitHub Copilot', family: 'assistant' },
  opencode: { name: 'opencode', family: 'assistant' },
  aider: { name: 'Aider', family: 'assistant' },
  goose: { name: 'Goose', family: 'assistant' },
  amp: { name: 'Amp', family: 'assistant' },
  'qwen-code': { name: 'Qwen Code', family: 'assistant' },
  crush: { name: 'Crush', family: 'assistant' },
  granola: { name: 'Granola', family: 'assistant' },
  conductor: { name: 'Conductor', family: 'assistant' },
  'claude-squad': { name: 'Claude Squad', family: 'assistant' },
  'vibe-kanban': { name: 'Vibe Kanban', family: 'assistant' },
  crystal: { name: 'Crystal', family: 'assistant' },
  vscode: { name: 'VS Code', family: 'editor' },
  cursor: { name: 'Cursor', family: 'editor' },
  windsurf: { name: 'Windsurf', family: 'editor' },
  antigravity: { name: 'Antigravity', family: 'editor' },
  trae: { name: 'Trae', family: 'editor' },
  kiro: { name: 'Kiro', family: 'editor' },
  zed: { name: 'Zed', family: 'editor' },
  cline: { name: 'Cline', family: 'editor' },
  'roo-code': { name: 'Roo Code', family: 'editor' },
  'kilo-code': { name: 'Kilo Code', family: 'editor' },
  continue: { name: 'Continue', family: 'editor' },
  jetbrains: { name: 'JetBrains AI', family: 'editor' },
  'lm-studio': { name: 'LM Studio', family: 'model' },
  ollama: { name: 'Ollama', family: 'model' },
  'hugging-face': { name: 'Hugging Face', family: 'model' },
  jan: { name: 'Jan', family: 'model' },
  gpt4all: { name: 'GPT4All', family: 'model' },
  'chrome-ai': { name: 'Chrome (Gemini Nano)', family: 'model' },
  rembg: { name: 'rembg', family: 'model' },
  torch: { name: 'PyTorch', family: 'model' },
  whisper: { name: 'Whisper', family: 'model' },
  remotion: { name: 'Remotion', family: 'automation' },
  'chrome-headless': { name: 'Chrome headless', family: 'automation' },
  playwright: { name: 'Playwright', family: 'automation' },
  puppeteer: { name: 'Puppeteer', family: 'automation' },
  npx: { name: 'npx', family: 'automation' },
} as const satisfies Record<string, { name: string; family: AiFamily }>;

export type AiToolId = keyof typeof AI_TOOLS;

/** O que é cada coisa que uma ferramenta de IA deixou no disco. */
export type AiKind =
  /** Conversas e transcrições. */
  | 'sessions'
  /** Cópia do repositório onde um agente trabalhou. */
  | 'worktree'
  /** Pontos de volta: rewind, snapshots de edição, histórico de arquivos. */
  | 'checkpoints'
  /** Sessões que rodaram em segundo plano e o rascunho delas. */
  | 'jobs'
  /** Rascunho de sessão em /tmp. */
  | 'scratch'
  | 'cache'
  /** Índice de busca do código, refeito sozinho. */
  | 'index'
  | 'logs'
  | 'model'
  /** Motores e runtimes baixados pela ferramenta (Python, llama.cpp, Node). */
  | 'runtime'
  /** Versão antiga de um binário ou de uma extensão. */
  | 'versions'
  /** Temporário de automação: perfil de navegador, sobra de render. */
  | 'temp'
  /** Pacote baixado pelo npx, quase sempre para rodar um servidor MCP. */
  | 'packages'
  /** Disco de máquina virtual. */
  | 'vm'
  /** O que ficou de um app que já foi desinstalado. */
  | 'leftovers';

/** Por que um item não pode sair agora. */
export type AiBlock =
  /** Um processo vivo está usando. */
  | 'in-use'
  /** O app está aberto: feche-o para remover. */
  | 'app-open'
  /** Sessão aberta agora. */
  | 'live-session'
  /** Worktree com mudança que não foi commitada. */
  | 'uncommitted'
  /** Worktree com commits que não estão em nenhum branch. */
  | 'detached'
  /** Worktree com um segredo ignorado pelo git (.env, chave) que só existe nela. */
  | 'env-only'
  /** Worktree trancada por uma ferramenta que ainda roda. */
  | 'locked'
  /** Worktree com submódulo: o git só a tira à força, e o repositório do submódulo iria junto. */
  | 'submodule'
  /** Worktree com arquivo ignorado pelo git que é trabalho (render, imagem, outro repositório) ou que não deu para ler inteiro. */
  | 'ignored-work'
  /** É a versão em uso. */
  | 'current'
  /** O macOS ou a própria ferramenta apaga sozinho. */
  | 'self-cleaning'
  /** Só sai pelo próprio app, que sabe o que mais limpar junto. */
  | 'via-app'
  /** Está no git do projeto. */
  | 'tracked'
  /** Não deu para conferir agora (o git falhou, ou o item mudou desde a análise). */
  | 'unverified'
  /** Mexido há menos de uma hora: pode ser de algo que ainda está rodando. */
  | 'recent'
  /** Sai pelo app da ferramenta, que precisa estar aberto (o ollama rm fala com o servidor). */
  | 'app-closed';

/** Um aviso a mais, quando o texto do tipo não basta. */
export type AiHint =
  /** O Claude Code apaga sozinho as sessões mais velhas que cleanupPeriodDays. */
  | 'cleanup-period'
  /** O modelo volta se a IA no dispositivo do Chrome continuar ligada. */
  | 'chrome-ai'
  /** O disco da VM do Cowork sai pelo app Claude. */
  | 'cowork-vm'
  /** O macOS apaga o que fica três dias sem uso em /tmp. */
  | 'tmp-cleaner'
  /** O branch e os commits ficam no repositório. */
  | 'branch-kept'
  /** A ferramenta baixa de novo quando precisar. */
  | 'redownload'
  /** Sai pelo comando da própria ferramenta (ollama rm). */
  | 'tool-command'
  /** Arquive no app antes: apagar direto deixa a conversa na lista, sem abrir. */
  | 'archive-first'
  /** Depois de remover, /chronicle reindex no Copilot CLI acerta a busca. */
  | 'reindex'
  /** O modelo nunca foi carregado desde o download. */
  | 'never-loaded'
  /** Leva junto as imagens geradas na conversa, que podem ser a única cópia. */
  | 'generated-images'
  /** Conversa guardada de propósito (/chat save da Gemini CLI). */
  | 'saved-chat';

export interface AiItemDTO {
  /** Identifica o item na última análise; é o que a interface devolve para remover. */
  id: string;
  tool: AiToolId;
  kind: AiKind;
  /** Nome do que está ali (projeto, modelo, versão, worktree), como está no disco. */
  label: string;
  /** Pasta do projeto a que pertence, quando dá para saber. */
  project: string | null;
  /** O caminho que "Mostrar no Finder" aponta. */
  path: string;
  /** Bytes no disco. Clones do APFS contam inteiros, então o que volta pode ser menos. */
  size: number;
  /** Quantas sessões, arquivos ou pastas o item junta. */
  count: number;
  /** Último uso, em ms; zero quando não há como saber. */
  lastUsed: number;
  /** `low` quando a data é a do download ou da instalação, e não a do uso. */
  confidence: 'high' | 'low';
  /** Frio: mais de AI_COLD_DAYS sem uso, ou lixo em qualquer idade. */
  heat: 'hot' | 'cold';
  /** Lixo em qualquer idade: temporário sem dono vivo, ou versão que nada mais usa. */
  junk?: 'orphan' | 'old-version';
  safety: 'safe' | 'moderate';
  /** Como sai: para a Lixeira, pelo git, pelo comando da ferramenta, ou não sai (só se mostra). */
  removal: 'trash' | 'git' | 'command' | 'none';
  blocked?: AiBlock;
  hint?: AiHint;
}

export interface AiScanDTO {
  scannedAt: number;
  items: AiItemDTO[];
  /** Ferramentas cuja leitura falhou; o resto da lista vale. */
  failed: string[];
}

export interface AiProgress {
  done: number;
  total: number;
}

export interface AiRemoveResultDTO {
  removed: number;
  freedSpace: number;
  /** O que não saiu e, quando se sabe, por quê. */
  failed: Array<{ id: string; blocked?: AiBlock }>;
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
    /** A versão recém-instalada ou atualizada, só na primeira abertura dela; senão, nulo. */
    whatsNew(): Promise<string | null>;
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
  disk: {
    /**
     * Sem caminho, a pasta pessoal. `cachedOnly` não mede nada: devolve nulo se
     * ainda não houver medida. `refresh` mede tudo de novo.
     */
    list(path?: string, options?: { refresh?: boolean; cachedOnly?: boolean }): Promise<DiskFolderDTO | null>;
    onProgress(listener: (progress: DiskProgress) => void): Unsubscribe;
    /** Só algo que a última listagem mostrou. */
    trash(path: string): Promise<boolean>;
  };
  ai: {
    /** Lê o que as ferramentas de IA deixaram no disco. Só lê: nada muda. */
    scan(): Promise<AiScanDTO>;
    onProgress(listener: (progress: AiProgress) => void): Unsubscribe;
    /** Só itens da última análise; cada um é conferido de novo antes de sair. */
    remove(ids: string[]): Promise<AiRemoveResultDTO>;
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
