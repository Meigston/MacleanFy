import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { History, HistoryEntry } from '../shared/api';

/** A lista é para mostrar as limpezas recentes; os totais guardam o resto. */
const MAX_ENTRIES = 50;

/**
 * Registro do que já foi liberado, num JSON na pasta de dados do app.
 * Um arquivo ausente ou corrompido vira histórico vazio: perder a contagem é
 * melhor do que impedir o app de abrir.
 */
export class HistoryStore {
  constructor(
    private readonly file: string,
    private readonly now: () => number = Date.now
  ) {}

  async read(): Promise<History> {
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf-8')) as Partial<History>;
      if (typeof parsed.since === 'number' && Array.isArray(parsed.entries)) {
        return {
          since: parsed.since,
          totalFreedSpace: Number(parsed.totalFreedSpace) || 0,
          totalItems: Number(parsed.totalItems) || 0,
          entries: parsed.entries,
        };
      }
    } catch {
      // cai no histórico vazio abaixo
    }
    return { since: this.now(), totalFreedSpace: 0, totalItems: 0, entries: [] };
  }

  async add(entry: Omit<HistoryEntry, 'at'>): Promise<History> {
    const history = await this.read();
    const updated: History = {
      since: history.since,
      totalFreedSpace: history.totalFreedSpace + entry.freedSpace,
      totalItems: history.totalItems + entry.items,
      entries: [{ ...entry, at: this.now() }, ...history.entries].slice(0, MAX_ENTRIES),
    };

    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, JSON.stringify(updated, null, 2));
    return updated;
  }
}
