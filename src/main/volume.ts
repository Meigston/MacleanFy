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

// ---------------------------------------------------------------------------
// Volumes do APFS: o que o macOS informa na hora, sem senha.
// ---------------------------------------------------------------------------

/** O que interessa do `diskutil info -plist <caminho>`, depois de passar pelo `plutil -convert json`. */
export interface DiskInfo {
  /** `disk3s1s1` em `/` (o snapshot selado), `disk3s5` no volume de dados. */
  device: string;
  container: string | null;
  volumeName: string;
  fsType: string;
  groupId: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

export function parseDiskInfo(json: unknown): DiskInfo | null {
  if (!isRecord(json)) return null;
  const device = text(json.DeviceIdentifier);
  if (!device) return null;
  return {
    device,
    container: text(json.APFSContainerReference),
    volumeName: text(json.VolumeName) ?? '',
    fsType: text(json.FilesystemType) ?? text(json.FilesystemName) ?? '',
    groupId: text(json.APFSVolumeGroupID),
  };
}

export interface ApfsVolume {
  device: string;
  name: string;
  roles: string[];
  /** CapacityInUse, em bytes. */
  inUse: number;
}

export interface ApfsContainer {
  reference: string;
  /** CapacityCeiling: o tamanho do contêiner, o mesmo total do statfs. */
  ceiling: number;
  free: number;
  volumes: ApfsVolume[];
}

const bytes = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** O contêiner `reference` no `diskutil apfs list -plist`; os outros (iSC, Recovery do firmware, imagens montadas) ficam de fora. */
export function parseApfsContainer(json: unknown, reference: string): ApfsContainer | null {
  if (!isRecord(json) || !Array.isArray(json.Containers)) return null;
  const found = json.Containers.find((entry) => isRecord(entry) && entry.ContainerReference === reference);
  if (!isRecord(found)) return null;
  const ceiling = bytes(found.CapacityCeiling);
  const free = bytes(found.CapacityFree);
  if (ceiling === null || free === null || !Array.isArray(found.Volumes)) return null;

  const volumes: ApfsVolume[] = [];
  for (const volume of found.Volumes) {
    if (!isRecord(volume)) continue;
    const device = text(volume.DeviceIdentifier);
    const inUse = bytes(volume.CapacityInUse);
    if (!device || inUse === null) continue;
    volumes.push({
      device,
      name: text(volume.Name) ?? device,
      roles: Array.isArray(volume.Roles) ? volume.Roles.filter((role): role is string => typeof role === 'string') : [],
      inUse,
    });
  }
  return { reference, ceiling, free, volumes };
}

/**
 * O volume de um dispositivo: `/` está montado num snapshot selado (`disk3s1s1`),
 * que pertence ao volume `disk3s1` — e nunca ao `disk3s10`.
 */
export function volumeOf(device: string, volumes: ApfsVolume[]): ApfsVolume | null {
  const exact = volumes.find((volume) => volume.device === device);
  if (exact) return exact;
  return volumes.find((volume) => new RegExp(`^${volume.device}s\\d+$`).test(device)) ?? null;
}

/** Volumes que o Mac usa para ligar, se recuperar e se atualizar. */
export const BOOT_ROLES: readonly string[] = ['Preboot', 'Recovery', 'Update', 'xART', 'Hardware'];

/** Pastas do volume de dados que aparecem na raiz do disco, lidas de `/usr/share/firmlinks`. */
export function parseFirmlinks(content: string): string[] {
  const out: string[] = [];
  for (const line of content.split('\n')) {
    const [, relative] = line.split('\t');
    const clean = relative?.trim().replace(/^\/+|\/+$/g, '');
    if (clean) out.push(clean);
  }
  return out;
}
