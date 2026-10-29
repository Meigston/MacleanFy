import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { sizeOnDisk } from '../../core/utils/fs';

export interface Measure {
  /** Bytes ocupados no disco. */
  size: number;
  /** O arquivo mais recente mexido, em ms; zero se não há nenhum. */
  newest: number;
  files: number;
}

/** Pastas abertas ao mesmo tempo numa medida. */
const WORKERS = 8;

/**
 * Mede um arquivo ou uma pasta inteira: tamanho no disco, o arquivo mais
 * recente e quantos são. Nunca segue link: um link conta o próprio tamanho e
 * não leva para fora do que está sendo medido.
 */
export async function measure(path: string): Promise<Measure> {
  const total: Measure = { size: 0, newest: 0, files: 0 };
  const own = await lstat(path).catch(() => null);
  if (!own) return total;
  if (!own.isDirectory()) {
    return { size: own.isSymbolicLink() ? own.size : sizeOnDisk(own), newest: own.mtimeMs, files: 1 };
  }

  const pending = [path];
  let active = 0;
  await new Promise<void>((done) => {
    const pump = (): void => {
      while (active < WORKERS && pending.length > 0) {
        active++;
        void walk(pending.pop()!).finally(() => {
          active--;
          pump();
        });
      }
      if (active === 0) done();
    };
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const child = join(dir, entry.name);
        if (entry.isDirectory()) {
          pending.push(child);
          continue;
        }
        const stats = await lstat(child).catch(() => null);
        if (!stats) continue;
        if (stats.isDirectory()) {
          pending.push(child);
          continue;
        }
        total.size += stats.isSymbolicLink() ? stats.size : sizeOnDisk(stats);
        total.newest = Math.max(total.newest, stats.mtimeMs);
        total.files++;
      }
    };
    pump();
  });
  return total;
}
