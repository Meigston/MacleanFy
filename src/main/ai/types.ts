import type { AiBlock, AiHint, AiItemDTO, AiKind, AiToolId } from '../../shared/api';
import type { Measure } from './measure';

/** Um processo vivo no começo da análise. */
export interface ProcessInfo {
  pid: number;
  /** Caminho do executável, como o `ps -o comm` mostra. */
  exe: string;
  /** A linha de comando inteira. */
  args: string;
  /** Pasta de trabalho, quando o lsof conseguiu ver. */
  cwd?: string;
}

/** Uma sessão do Claude Code aberta agora (~/.claude/sessions/<pid>.json com o processo vivo). */
export interface LiveSession {
  pid: number;
  sessionId: string;
  cwd: string;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * O que cada coletor recebe. Tudo o que toca o sistema passa por aqui, para os
 * testes trocarem por uma pasta temporária e processos de mentira.
 */
export interface AiContext {
  home: string;
  /** O $TMPDIR da conta (/var/folders/…/T). */
  tmp: string;
  uid: number;
  now: number;
  /** As variáveis que mudam onde as ferramentas guardam as coisas (CLAUDE_CONFIG_DIR, CODEX_HOME, HF_HOME…). */
  env: Readonly<Record<string, string | undefined>>;
  processes: readonly ProcessInfo[];
  /** Falso quando o ps ou o lsof falhou: sem saber quem roda, nada pode sair. */
  processesKnown: boolean;
  claudeSessions: readonly LiveSession[];
  /** Pastas de projeto conhecidas: o cwd gravado nas sessões e jobs do Claude Code e nos workspaces do VS Code. */
  projects: readonly string[];
  /** Mais de AI_COLD_DAYS antes de `now`. Zero (data desconhecida) conta como frio. */
  isCold(ms: number): boolean;
  /** Algum processo vivo roda um executável de dentro do caminho, trabalha nele ou o cita nos argumentos. */
  inUse(path: string): boolean;
  /** Algum processo vivo cujo executável casa com o padrão. */
  running(exe: RegExp): boolean;
  /** Tamanho, arquivo mais novo e contagem; nunca segue link. */
  measure(path: string): Promise<Measure>;
  /** Só o tamanho, pelo `du`: bem mais rápido em pastas com milhões de arquivos. */
  du(path: string): Promise<number>;
  /** Roda um programa sem shell, com tempo-limite. Nunca rejeita: o código de saída diz como foi. */
  exec(file: string, args: string[], options?: { cwd?: string; timeoutMs?: number; env?: Record<string, string> }): Promise<ExecResult>;
  /** Manda para a Lixeira. */
  trash(path: string): Promise<void>;
}

/** O que um coletor achou: o item da tela, mais o que o processo principal precisa para removê-lo. */
export interface Found extends Omit<AiItemDTO, 'id' | 'heat' | 'confidence' | 'tool' | 'kind'> {
  tool: AiToolId;
  kind: AiKind;
  /** Padrão: `high`. */
  confidence?: 'high' | 'low';
  /** Tudo o que sai junto. Padrão: só `path`. */
  paths?: string[];
  /** Separa dois itens com o mesmo `path`, como as sessões frias e as quentes de um projeto. */
  key?: string;
  /**
   * Confere de novo logo antes de remover, com os processos daquele momento. Devolve o motivo
   * para não remover, ou nulo. Processo vivo usando algum dos `paths` o scanner já confere sozinho.
   */
  recheck?(ctx: AiContext): Promise<AiBlock | null>;
  /** Remoção própria (`git`, `command`); rejeita se não deu. Sem ela, `paths` vão para a Lixeira. */
  remove?(ctx: AiContext): Promise<void>;
  hint?: AiHint;
}

export interface Collector {
  /** Aparece em `failed` quando a leitura dá erro. */
  id: string;
  collect(ctx: AiContext): Promise<Found[]>;
}
