/**
 * Espaço purgável e snapshots locais do Time Machine no disco de inicialização.
 *
 * "Purgável" é o que o APFS guarda mas devolve sozinho quando falta espaço:
 * snapshots locais do Time Machine, arquivos do iCloud que podem voltar para a
 * nuvem, caches que o próprio sistema marca como descartáveis. O `statfs` não o
 * conta como livre; o Finder conta. Não há comando público que force o macOS a
 * liberar esse espaço — a parte que dá para tirar na hora são os snapshots.
 */

/** Capacidades do volume, em bytes, como a API do Foundation as informa. */
export interface VolumeCapacity {
  /** Livre de fato, sem contar o purgável — o mesmo que o `statfs`. */
  available: number;
  /** O que o Finder mostra como disponível: o livre mais o purgável. */
  important: number;
}

/**
 * Lê as capacidades pela API do Foundation, por JavaScript for Automation:
 * o Node não alcança essas chaves, e é delas que o Finder tira o "disponível".
 */
export const CAPACITY_SCRIPT = `
ObjC.import('Foundation');
const url = $.NSURL.fileURLWithPath('/');
const read = (key) => {
  const value = Ref();
  url.getResourceValueForKeyError(value, $[key], null);
  return ObjC.unwrap(value[0]);
};
JSON.stringify({
  available: read('NSURLVolumeAvailableCapacityKey'),
  important: read('NSURLVolumeAvailableCapacityForImportantUsageKey'),
});
`;

export function parseCapacity(output: string): VolumeCapacity | null {
  try {
    const { available, important } = JSON.parse(output) as Record<string, unknown>;
    if (typeof available !== 'number' || typeof important !== 'number') return null;
    return { available, important };
  } catch {
    return null;
  }
}

/** O que o Finder conta como disponível e o `statfs` não. */
export function purgeableBytes(capacity: VolumeCapacity): number {
  return Math.max(0, capacity.important - capacity.available);
}

/** Datas dos snapshots na saída do `tmutil listlocalsnapshots /`, como `2026-10-12-193412`. */
export function parseLocalSnapshots(output: string): string[] {
  return [...output.matchAll(/com\.apple\.TimeMachine\.(\d{4}-\d{2}-\d{2}-\d{6})/g)].map((match) => match[1]);
}
