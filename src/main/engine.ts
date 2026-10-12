import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CategoryId, CleanableItem, ScanResult, Scanner } from '../core/types';
import { ALL_SCANNERS } from '../core/scanners';
import { validatePathSafety } from '../core/utils';
import type {
  CleanOptions,
  CleanProgress,
  CleanResultDTO,
  CleanSelection,
  CleanSummaryDTO,
  ScanProgress,
  ScanResultDTO,
} from '../shared/api';

const SCAN_CONCURRENCY = 4;
/** Intervalo mínimo entre dois avisos de progresso da limpeza. */
const PROGRESS_INTERVAL_MS = 80;

/**
 * Um temporário só é oferecido para limpeza depois de um dia parado. Os scanners
 * herdados listam tudo o que está em /tmp e em /var/folders, e ali moram soquetes
 * e arquivos de programas abertos agora — apagar isso derruba ssh-agent, tmux,
 * editores. Numa interface em que "limpar" é um clique, o filtro fica aqui.
 */
const TEMP_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const LIVENESS_MAX_DEPTH = 4;
const LIVENESS_ENTRY_BUDGET = 2000;

type ScannerRegistry = Partial<Record<CategoryId, Scanner>>;

/**
 * mtime mais recente dentro de `path`. Devolve Infinity — "em uso" — quando
 * encontra um soquete ou FIFO, ou quando a árvore é grande demais para conferir:
 * na dúvida, o item fica de fora da limpeza.
 */
async function newestMtime(path: string, budget: { left: number }, depth = 0): Promise<number> {
  if (budget.left-- <= 0) return Infinity;

  const stats = await lstat(path);
  if (stats.isSocket() || stats.isFIFO()) return Infinity;

  let newest = stats.mtimeMs;
  if (!stats.isDirectory() || depth >= LIVENESS_MAX_DEPTH) return newest;

  for (const entry of await readdir(path)) {
    newest = Math.max(newest, await newestMtime(join(path, entry), budget, depth + 1));
    if (newest === Infinity) break;
  }
  return newest;
}

async function isLiveTempItem(item: CleanableItem, now: number): Promise<boolean> {
  try {
    const newest = await newestMtime(item.path, { left: LIVENESS_ENTRY_BUDGET });
    return now - newest < TEMP_MIN_AGE_MS;
  } catch {
    return true;
  }
}

function toDTO(categoryId: CategoryId, result: ScanResult): ScanResultDTO {
  return {
    categoryId,
    items: result.items.map((item) => ({
      path: item.path,
      name: item.name,
      size: item.size,
      isDirectory: item.isDirectory,
      modifiedAt: item.modifiedAt?.getTime(),
    })),
    totalSize: result.totalSize,
    error: result.error,
  };
}

/**
 * Executa as análises e as limpezas, e guarda o que a última análise encontrou.
 * Não depende do Electron: recebe os scanners por parâmetro para ser testável.
 */
export class Engine {
  private readonly lastScan = new Map<CategoryId, Map<string, CleanableItem>>();

  constructor(private readonly scanners: ScannerRegistry = ALL_SCANNERS) {}

  /** O caminho veio da última análise? Usado antes de qualquer ação sobre ele. */
  knows(path: string): boolean {
    for (const items of this.lastScan.values()) {
      if (items.has(path)) return true;
    }
    return false;
  }

  async scan(
    categoryIds: CategoryId[] | undefined,
    onProgress?: (progress: ScanProgress) => void
  ): Promise<ScanResultDTO[]> {
    const all = Object.keys(this.scanners) as CategoryId[];
    const queue = categoryIds ? all.filter((id) => categoryIds.includes(id)) : all;
    const total = queue.length;
    const results: ScanResultDTO[] = [];
    let next = 0;

    const worker = async (): Promise<void> => {
      while (next < queue.length) {
        const id = queue[next++];
        const scanner = this.scanners[id]!;

        let result: ScanResult;
        try {
          result = await this.sanitize(await scanner.scan());
        } catch (error) {
          result = {
            category: scanner.category,
            items: [],
            totalSize: 0,
            error: error instanceof Error ? error.message : String(error),
          };
        }

        this.lastScan.set(id, new Map(result.items.map((item) => [item.path, item])));

        const dto = toDTO(id, result);
        results.push(dto);
        onProgress?.({ completed: results.length, total, result: dto });
      }
    };

    await Promise.all(Array.from({ length: Math.min(SCAN_CONCURRENCY, total) }, worker));
    return results;
  }

  async clean(
    selection: CleanSelection[],
    options: CleanOptions = {},
    onProgress?: (progress: CleanProgress) => void
  ): Promise<CleanSummaryDTO> {
    const dryRun = options.dryRun ?? false;
    const results: CleanResultDTO[] = [];
    const total = selection.length;

    // Só entra o que a última análise devolveu: a interface nunca dita caminhos.
    const plan = selection.map(({ categoryId, paths }) => {
      const scanner = this.scanners[categoryId];
      const known = this.lastScan.get(categoryId);
      const items =
        scanner && known
          ? paths.map((path) => known.get(path)).filter((item): item is CleanableItem => item !== undefined)
          : [];
      return { categoryId, scanner, items, bytes: items.reduce((sum, item) => sum + item.size, 0) };
    });
    const totalBytes = plan.reduce((sum, step) => sum + step.bytes, 0);

    let settledBytes = 0;
    let lastReport = 0;

    for (const { categoryId, scanner, items, bytes } of plan) {
      onProgress?.({ completed: results.length, total, categoryId, doneBytes: settledBytes, totalBytes });

      const result: CleanResultDTO = { categoryId, cleanedItems: 0, freedSpace: 0, errors: [] };

      if (scanner && items.length > 0) {
        // A remoção avisa a cada arquivo; a interface só precisa de alguns avisos por segundo.
        let freed = 0;
        const onFreed = (amount: number): void => {
          freed = Math.min(freed + amount, bytes);
          const now = Date.now();
          if (now - lastReport < PROGRESS_INTERVAL_MS) return;
          lastReport = now;
          onProgress?.({ completed: results.length, total, categoryId, doneBytes: settledBytes + freed, totalBytes });
        };

        try {
          const cleaned = await scanner.clean(items, dryRun, onFreed);
          result.cleanedItems = cleaned.cleanedItems;
          result.freedSpace = cleaned.freedSpace;
          result.errors = cleaned.errors;
        } catch (error) {
          result.errors = [error instanceof Error ? error.message : String(error)];
        }

        // O que foi listado deixou de valer; a categoria precisa de nova análise.
        if (!dryRun) this.lastScan.delete(categoryId);
      }

      settledBytes += bytes;
      results.push(result);
    }

    onProgress?.({ completed: total, total, doneBytes: totalBytes, totalBytes });

    return {
      results,
      totalFreedSpace: results.reduce((sum, r) => sum + r.freedSpace, 0),
      totalCleanedItems: results.reduce((sum, r) => sum + r.cleanedItems, 0),
      totalErrors: results.reduce((sum, r) => sum + r.errors.length, 0),
      dryRun,
    };
  }

  private async sanitize(result: ScanResult): Promise<ScanResult> {
    // Itens em caminhos protegidos nunca seriam apagados; mostrá-los só infla o total.
    let items = result.items.filter((item) => validatePathSafety(item.path) === null);

    if (result.category.id === 'temp-files') {
      const now = Date.now();
      const idle: CleanableItem[] = [];
      for (const item of items) {
        if (!(await isLiveTempItem(item, now))) idle.push(item);
      }
      items = idle;
    }

    return { ...result, items, totalSize: items.reduce((sum, item) => sum + item.size, 0) };
  }
}
