import type { HomeShareDTO, WholeDiskDTO, WholeSegmentDTO, WholeSegmentId } from '../../../shared/api';
import type { Route } from '../state/store';

/** O que um clique numa parte do disco faz. */
export type WholeAction =
  | { kind: 'route'; route: Route }
  | { kind: 'explore'; path: string }
  | { kind: 'reveal'; path: string }
  | { kind: 'fda' }
  | { kind: 'measure' }
  | { kind: 'scroll-home' };

/**
 * Cor de cada segmento. O que é do macOS vai em cinzas, do mais claro ao mais
 * escuro; o não identificado vai hachurado; o que é da pessoa segue a ordem já
 * validada das séries, com a cor da tela para onde a ação leva.
 */
export const SEGMENT_COLORS: Record<WholeSegmentId, string> = {
  macos: 'var(--neutral-300)',
  boot: 'var(--neutral-400)',
  vm: 'var(--neutral-500)',
  'system-data': 'var(--neutral-600)',
  unknown: 'var(--neutral-600)',
  pending: 'var(--neutral-600)',
  caches: 'var(--series-system)',
  dev: 'var(--series-development)',
  home: 'var(--series-storage)',
  apps: 'var(--series-browsers)',
  others: 'var(--series-large)',
  'other-volumes': 'var(--violet-400)',
};

/** Segmentos sem medida própria: a amostra e a fatia vão hachuradas, nunca só pela cor. */
export const HATCHED: ReadonlySet<WholeSegmentId> = new Set(['unknown', 'pending']);

export function segmentAction(segment: WholeSegmentDTO, dto: WholeDiskDTO): WholeAction | null {
  switch (segment.id) {
    case 'vm':
      return { kind: 'route', route: 'performance' };
    case 'unknown':
      if (dto.snapshots.length > 0) return { kind: 'route', route: 'maintenance' };
      return dto.fullDiskAccess ? null : { kind: 'fda' };
    case 'pending':
      return { kind: 'measure' };
    case 'caches':
      return { kind: 'route', route: 'system' };
    case 'dev':
      return { kind: 'route', route: 'development' };
    case 'home':
      return { kind: 'scroll-home' };
    case 'apps':
      return { kind: 'route', route: 'uninstaller' };
    case 'others':
      return { kind: 'reveal', path: '/Users' };
    default:
      return null;
  }
}

const parentOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';

export function shareAction(share: HomeShareDTO, home: string): WholeAction {
  const first = share.paths[0]?.path;
  switch (share.id) {
    case 'dev':
      return { kind: 'route', route: 'development' };
    case 'ai':
      return { kind: 'route', route: 'ai' };
    case 'caches':
      return { kind: 'route', route: 'system' };
    case 'mail':
    case 'trash':
      return { kind: 'route', route: 'storage' };
    case 'photos':
      return { kind: 'explore', path: first ? parentOf(first) : `${home}/Pictures` };
    case 'app-data':
      return { kind: 'explore', path: `${home}/Library` };
    case 'rest':
      return { kind: 'explore', path: home };
    default:
      return { kind: 'explore', path: first ?? home };
  }
}

/**
 * Largura de cada fatia da barra. Quando as pastas somam mais do que o volume de
 * dados ocupa (clones contados duas vezes), só as partes medidas com du encolhem,
 * na mesma proporção, para a barra fechar no total; o que o APFS informou fica.
 */
export function barWeights(dto: WholeDiskDTO): Array<{ id: WholeSegmentId | 'free'; weight: number }> {
  const measured = dto.segments.reduce(
    (sum, segment) => sum + segment.parts.reduce((inner, part) => inner + (part.source === 'du' ? part.bytes : 0), 0),
    0
  );
  const scale = dto.overcount > 0 && measured > 0 ? Math.max(0, measured - dto.overcount) / measured : 1;
  return [
    ...dto.segments.map((segment) => ({
      id: segment.id,
      weight: segment.parts.reduce((sum, part) => sum + (part.source === 'du' ? part.bytes * scale : part.bytes), 0),
    })),
    { id: 'free' as const, weight: dto.free },
  ];
}

export function groupTotals(dto: WholeDiskDTO): { system: number; unknown: number; yours: number; free: number } {
  const totals = { system: 0, unknown: 0, yours: 0, free: dto.free };
  for (const segment of dto.segments) totals[segment.group] += segment.bytes;
  return totals;
}

export type WholeNotice = 'basic' | 'homeElsewhere' | 'stale' | 'overcount' | 'error-outside' | 'error-home';

/** Os avisos da medida, na ordem em que aparecem. Medida velha e clones contados duas vezes podem vir juntos. */
export function notices(dto: WholeDiskDTO): WholeNotice[] {
  const out: WholeNotice[] = [];
  if (dto.mode === 'basic') out.push('basic');
  if (dto.homeElsewhere) out.push('homeElsewhere');
  if (dto.stale) out.push('stale');
  if (dto.overcount > 0) out.push('overcount');
  if (dto.phases.outside === 'failed') out.push('error-outside');
  if (dto.phases.home === 'failed') out.push('error-home');
  return out;
}

/** A medida está completa: as duas fases terminaram e a conta já sabe o que é não identificado. */
export const isMeasured = (dto: WholeDiskDTO) => dto.measuredAt !== null;

/** Alguma das medidas está em curso no processo principal. */
export const isRunning = (dto: WholeDiskDTO) => dto.phases.outside === 'running' || dto.phases.home === 'running';
