import { describe, expect, it } from 'vitest';
import {
  HOME_SHARES,
  WHOLE_SEGMENTS,
  type HomeShareDTO,
  type HomeShareId,
  type WholeDiskDTO,
  type WholeGroup,
  type WholePartDTO,
  type WholeSegmentDTO,
  type WholeSegmentId,
} from '../../../shared/api';
import { barWeights, groupTotals, isMeasured, isRunning, notices, segmentAction, shareAction } from './disk';

const GB = 1e9;
const HOME = '/Users/ana';

const GROUP: Record<WholeSegmentId, WholeGroup> = {
  macos: 'system',
  boot: 'system',
  vm: 'system',
  'system-data': 'system',
  unknown: 'unknown',
  pending: 'unknown',
  caches: 'yours',
  dev: 'yours',
  home: 'yours',
  apps: 'yours',
  others: 'yours',
  'other-volumes': 'yours',
};

/** Um segmento cujo total é a soma das partes, como o processo principal monta. */
function segment(id: WholeSegmentId, parts: WholePartDTO[]): WholeSegmentDTO {
  return { id, group: GROUP[id], bytes: parts.reduce((sum, part) => sum + part.bytes, 0), parts, top: [], partial: false };
}

const apfs = (label: string, bytes: number, special?: 'structure'): WholePartDTO => ({
  label,
  bytes,
  source: 'apfs',
  ...(special ? { special } : {}),
});
const du = (path: string, bytes: number): WholePartDTO => ({ label: path, path, bytes, source: 'du' });
const rest = (bytes: number): WholePartDTO => ({ label: '', bytes, source: 'rest' });

/**
 * Um disco de 500 GB medido, cuja conta fecha: Σ segmentos + livre === total.
 * O volume de dados ocupa 400 GB; fora da pasta pessoal mediram 150 GB, a pasta
 * pessoal 200 GB, e o resto (50 GB) é não identificado.
 */
function measuredDisk(overrides: Partial<WholeDiskDTO> = {}): WholeDiskDTO {
  const segments = [
    segment('macos', [apfs('Macintosh HD', 12 * GB)]),
    segment('boot', [apfs('Preboot', 10 * GB), apfs('Recovery', 2 * GB), apfs('', 1 * GB, 'structure')]),
    segment('vm', [apfs('VM', 5 * GB), du('/private/var/vm', 1 * GB)]),
    segment('system-data', [du('/private', 20 * GB), du('/System/Library', 9 * GB)]),
    segment('unknown', [rest(50 * GB)]),
    segment('caches', [du('/Library/Caches', 4 * GB)]),
    segment('dev', [du('/Library/Developer', 16 * GB), du('/opt', 8 * GB)]),
    segment('home', [{ label: '~', path: HOME, bytes: 200 * GB, source: 'du' }]),
    segment('apps', [du('/Applications', 60 * GB), du('/Library', 32 * GB)]),
  ];
  return {
    volumeName: 'Macintosh HD',
    mode: 'apfs',
    total: 500 * GB,
    free: 70 * GB,
    purgeable: 18 * GB,
    snapshots: [],
    data: 400 * GB,
    systemVolumes: 30 * GB,
    otherVolumes: 0,
    overhead: 1 * GB,
    segments,
    home: [],
    homePath: HOME,
    phases: { outside: 'done', home: 'done' },
    measuredAt: 1_000,
    overcount: 0,
    drift: 0,
    stale: false,
    homeElsewhere: false,
    otherAccounts: 0,
    fullDiskAccess: true,
    ...overrides,
  };
}

/**
 * O mesmo disco quando as pastas somam além do volume de dados: fora da pasta
 * pessoal mediram 150 GB e a pasta pessoal 300 GB, mas o volume ocupa só 400 GB.
 * O não identificado some e sobram 50 GB contados duas vezes.
 */
function overcountedDisk(): WholeDiskDTO {
  const base = measuredDisk();
  const segments = base.segments
    .filter((entry) => entry.id !== 'unknown')
    .map((entry) => (entry.id === 'home' ? segment('home', [{ label: '~', path: HOME, bytes: 300 * GB, source: 'du' }]) : entry));
  return { ...base, segments, overcount: 50 * GB };
}

const sumSegments = (dto: WholeDiskDTO) => dto.segments.reduce((sum, entry) => sum + entry.bytes, 0);
const sumWeights = (weights: Array<{ weight: number }>) => weights.reduce((sum, entry) => sum + entry.weight, 0);
const duBytes = (dto: WholeDiskDTO) =>
  dto.segments.reduce((sum, entry) => sum + entry.parts.reduce((inner, part) => inner + (part.source === 'du' ? part.bytes : 0), 0), 0);

describe('the fixtures', () => {
  it('close the account like the main process does', () => {
    const dto = measuredDisk();
    expect(sumSegments(dto) + dto.free).toBe(dto.total);
    const over = overcountedDisk();
    // Com clones contados duas vezes, os segmentos passam do usado exatamente pelo overcount.
    expect(sumSegments(over) + over.free).toBe(over.total + over.overcount);
    expect(duBytes(over)).toBe(150 * GB + 300 * GB);
    expect(duBytes(over) - over.overcount).toBe(over.data);
  });
});

describe('barWeights', () => {
  it('uses each segment as it is when nothing is counted twice, and closes on the total', () => {
    const dto = measuredDisk();
    const weights = barWeights(dto);
    expect(weights.map((entry) => entry.id)).toEqual([...dto.segments.map((entry) => entry.id), 'free']);
    for (const entry of dto.segments) {
      expect(weights.find((weight) => weight.id === entry.id)?.weight).toBe(entry.bytes);
    }
    expect(weights.at(-1)).toEqual({ id: 'free', weight: dto.free });
    expect(sumWeights(weights)).toBe(dto.total);
  });

  it('shrinks only what du measured when folders add up to more than the data volume', () => {
    const dto = overcountedDisk();
    const weights = barWeights(dto);
    const weightOf = (id: WholeSegmentId) => weights.find((entry) => entry.id === id)!.weight;
    const measured = duBytes(dto);
    const scale = (measured - dto.overcount) / measured;
    expect(scale).toBeGreaterThan(0);
    expect(scale).toBeLessThan(1);

    // O que o APFS informou fica como está.
    expect(weightOf('macos')).toBe(12 * GB);
    expect(weightOf('boot')).toBe(13 * GB);
    // Na memória virtual, o volume VM fica e só a pasta medida com du encolhe.
    expect(weightOf('vm')).toBeCloseTo(5 * GB + 1 * GB * scale, 0);
    expect(weightOf('vm')).toBeLessThan(6 * GB);
    expect(weightOf('vm')).toBeGreaterThan(5 * GB);

    // As partes medidas com du encolhem todas na mesma proporção.
    for (const id of ['system-data', 'caches', 'dev', 'home', 'apps'] as const) {
      const entry = dto.segments.find((candidate) => candidate.id === id)!;
      expect(weightOf(id)).toBeCloseTo(entry.bytes * scale, 0);
    }
    expect(weights.at(-1)).toEqual({ id: 'free', weight: dto.free });

    // E a barra fecha no total, sem os bytes contados duas vezes.
    expect(sumWeights(weights)).toBeCloseTo(dto.total, 0);
  });

  it('closes exactly on the total when the scale is exact in binary', () => {
    // 400 GB medidos com du, 100 GB a mais: escala 0,75, sem arredondamento.
    const segments = [
      segment('macos', [apfs('Macintosh HD', 20 * GB)]),
      segment('vm', [apfs('VM', 8 * GB), du('/private/var/vm', 4 * GB)]),
      segment('apps', [du('/Applications', 96 * GB)]),
      segment('home', [{ label: '~', path: HOME, bytes: 300 * GB, source: 'du' }]),
    ];
    const dto = measuredDisk({ total: 400 * GB, free: 72 * GB, data: 300 * GB, segments, overcount: 100 * GB });
    expect(sumSegments(dto) + dto.free - dto.overcount).toBe(dto.total);

    const weights = barWeights(dto);
    expect(weights).toEqual([
      { id: 'macos', weight: 20 * GB },
      { id: 'vm', weight: 8 * GB + 3 * GB },
      { id: 'apps', weight: 72 * GB },
      { id: 'home', weight: 225 * GB },
      { id: 'free', weight: 72 * GB },
    ]);
    expect(sumWeights(weights)).toBe(dto.total);
  });

  it('never gives a slice a negative width', () => {
    const dto = measuredDisk({
      segments: [segment('macos', [apfs('Macintosh HD', 10 * GB)]), segment('home', [du(HOME, 5 * GB)])],
      overcount: 9 * GB,
    });
    const weights = barWeights(dto);
    expect(weights.find((entry) => entry.id === 'home')?.weight).toBe(0);
    expect(weights.find((entry) => entry.id === 'macos')?.weight).toBe(10 * GB);
    expect(weights.every((entry) => entry.weight >= 0)).toBe(true);
  });

  it('leaves everything as it is when there is an overcount but nothing measured with du', () => {
    const dto = measuredDisk({ segments: [segment('macos', [apfs('Macintosh HD', 10 * GB)])], overcount: 3 * GB });
    expect(barWeights(dto)).toEqual([
      { id: 'macos', weight: 10 * GB },
      { id: 'free', weight: dto.free },
    ]);
  });
});

describe('groupTotals', () => {
  it('adds the segments of each group and keeps the free space apart', () => {
    const dto = measuredDisk();
    const totals = groupTotals(dto);
    expect(totals).toEqual({
      system: (12 + 13 + 6 + 29) * GB,
      unknown: 50 * GB,
      yours: (4 + 24 + 200 + 92) * GB,
      free: 70 * GB,
    });
    expect(totals.system + totals.unknown + totals.yours + totals.free).toBe(dto.total);
  });

  it('counts what is still pending as unknown, and other volumes as yours', () => {
    const dto = measuredDisk({
      segments: [
        segment('macos', [apfs('Macintosh HD', 12 * GB)]),
        segment('pending', [rest(300 * GB)]),
        segment('other-volumes', [apfs('Macintosh HD 2', 18 * GB)]),
      ],
      measuredAt: null,
    });
    expect(groupTotals(dto)).toEqual({ system: 12 * GB, unknown: 300 * GB, yours: 18 * GB, free: 70 * GB });
  });

  it('is all zero but the free space on an empty list', () => {
    expect(groupTotals(measuredDisk({ segments: [] }))).toEqual({ system: 0, unknown: 0, yours: 0, free: 70 * GB });
  });
});

describe('notices', () => {
  it('says nothing about a complete, fresh measure', () => {
    expect(notices(measuredDisk())).toEqual([]);
  });

  it('explains a stale measure and the overcount together', () => {
    expect(notices(measuredDisk({ stale: true, overcount: 5 * GB }))).toEqual(['stale', 'overcount']);
    expect(notices(measuredDisk({ stale: true }))).toEqual(['stale']);
    expect(notices(measuredDisk({ overcount: 5 * GB }))).toEqual(['overcount']);
  });

  it('tells when the disk was read without APFS and when the home folder is elsewhere', () => {
    expect(notices(measuredDisk({ mode: 'basic' }))).toEqual(['basic']);
    expect(notices(measuredDisk({ homeElsewhere: true }))).toEqual(['homeElsewhere']);
  });

  it('tells which of the measures failed', () => {
    expect(notices(measuredDisk({ phases: { outside: 'failed', home: 'done' } }))).toEqual(['error-outside']);
    expect(notices(measuredDisk({ phases: { outside: 'done', home: 'failed' } }))).toEqual(['error-home']);
    expect(notices(measuredDisk({ phases: { outside: 'running', home: 'idle' } }))).toEqual([]);
  });

  it('lists everything in a fixed order', () => {
    const dto = measuredDisk({
      mode: 'basic',
      homeElsewhere: true,
      stale: true,
      overcount: 1 * GB,
      phases: { outside: 'failed', home: 'failed' },
    });
    expect(notices(dto)).toEqual(['basic', 'homeElsewhere', 'stale', 'overcount', 'error-outside', 'error-home']);
    expect(notices({ ...dto, stale: false })).toEqual(['basic', 'homeElsewhere', 'overcount', 'error-outside', 'error-home']);
  });
});

describe('segmentAction', () => {
  const of = (id: WholeSegmentId) => segment(id, [rest(1 * GB)]);

  it('sends the virtual memory to the performance page', () => {
    expect(segmentAction(of('vm'), measuredDisk())).toEqual({ kind: 'route', route: 'performance' });
  });

  it('sends the unknown to the snapshots when there are any, even without Full Disk Access', () => {
    const snapshots = ['2026-10-25-093011'];
    expect(segmentAction(of('unknown'), measuredDisk({ snapshots }))).toEqual({ kind: 'route', route: 'maintenance' });
    expect(segmentAction(of('unknown'), measuredDisk({ snapshots, fullDiskAccess: false }))).toEqual({
      kind: 'route',
      route: 'maintenance',
    });
  });

  it('asks for Full Disk Access for the unknown when there is no snapshot and no access', () => {
    expect(segmentAction(of('unknown'), measuredDisk({ fullDiskAccess: false }))).toEqual({ kind: 'fda' });
  });

  it('does nothing with the unknown when there is no snapshot and the access is there', () => {
    expect(segmentAction(of('unknown'), measuredDisk())).toBeNull();
  });

  it('does nothing with what belongs to macOS or to other volumes', () => {
    for (const id of ['macos', 'boot', 'system-data', 'other-volumes'] as const) {
      expect(segmentAction(of(id), measuredDisk({ snapshots: ['2026-10-25-093011'], fullDiskAccess: false }))).toBeNull();
    }
  });

  it('reveals /Users for the other accounts', () => {
    expect(segmentAction(of('others'), measuredDisk())).toEqual({ kind: 'reveal', path: '/Users' });
  });

  it('measures what is still pending', () => {
    expect(segmentAction(of('pending'), measuredDisk({ measuredAt: null }))).toEqual({ kind: 'measure' });
  });

  it('takes what is yours to the page that cleans it', () => {
    const dto = measuredDisk();
    expect(segmentAction(of('caches'), dto)).toEqual({ kind: 'route', route: 'system' });
    expect(segmentAction(of('dev'), dto)).toEqual({ kind: 'route', route: 'development' });
    expect(segmentAction(of('apps'), dto)).toEqual({ kind: 'route', route: 'uninstaller' });
    expect(segmentAction(of('home'), dto)).toEqual({ kind: 'scroll-home' });
  });

  it('has an answer for every segment', () => {
    for (const id of WHOLE_SEGMENTS) expect(() => segmentAction(of(id), measuredDisk())).not.toThrow();
  });
});

describe('shareAction', () => {
  const share = (id: HomeShareId, paths: Array<{ path: string; bytes: number }> = []): HomeShareDTO => ({
    id,
    bytes: paths.reduce((sum, entry) => sum + entry.bytes, 0) || 1 * GB,
    paths,
    partial: false,
  });
  const KINDS = new Set(['route', 'explore', 'reveal', 'fda', 'measure', 'scroll-home']);

  it('has an action for every share of the home folder', () => {
    for (const id of HOME_SHARES) {
      const action = shareAction(share(id), HOME);
      expect(action, id).toBeDefined();
      expect(KINDS.has(action.kind), id).toBe(true);
      if (action.kind === 'explore') expect(action.path.startsWith(HOME), id).toBe(true);
    }
  });

  it('opens the folder that holds the photo library, not the library itself', () => {
    const library = `${HOME}/Pictures/Photos Library.photoslibrary`;
    expect(shareAction(share('photos', [{ path: library, bytes: 16.9 * GB }]), HOME)).toEqual({
      kind: 'explore',
      path: `${HOME}/Pictures`,
    });
    // Sem caminho conhecido, a pasta Imagens.
    expect(shareAction(share('photos'), HOME)).toEqual({ kind: 'explore', path: `${HOME}/Pictures` });
  });

  it('opens ~/Library for the app data and ~ for the rest', () => {
    expect(shareAction(share('app-data', [{ path: `${HOME}/Library`, bytes: 30 * GB }]), HOME)).toEqual({
      kind: 'explore',
      path: `${HOME}/Library`,
    });
    expect(shareAction(share('app-data'), HOME)).toEqual({ kind: 'explore', path: `${HOME}/Library` });
    expect(shareAction(share('rest', [{ path: HOME, bytes: 40 * GB }]), HOME)).toEqual({ kind: 'explore', path: HOME });
    expect(shareAction(share('rest'), HOME)).toEqual({ kind: 'explore', path: HOME });
  });

  it('takes the shares that a page cleans to that page', () => {
    expect(shareAction(share('dev'), HOME)).toEqual({ kind: 'route', route: 'development' });
    expect(shareAction(share('ai'), HOME)).toEqual({ kind: 'route', route: 'ai' });
    expect(shareAction(share('caches'), HOME)).toEqual({ kind: 'route', route: 'system' });
    expect(shareAction(share('mail'), HOME)).toEqual({ kind: 'route', route: 'storage' });
    expect(shareAction(share('trash'), HOME)).toEqual({ kind: 'route', route: 'storage' });
  });

  it('explores the biggest folder of the other shares', () => {
    const icloud = share('icloud', [
      { path: `${HOME}/Library/Mobile Documents`, bytes: 2 * GB },
      { path: `${HOME}/Library/CloudStorage`, bytes: 1 * GB },
    ]);
    expect(shareAction(icloud, HOME)).toEqual({ kind: 'explore', path: `${HOME}/Library/Mobile Documents` });
    expect(shareAction(share('messages'), HOME)).toEqual({ kind: 'explore', path: HOME });
  });
});

describe('isMeasured and isRunning', () => {
  it('reads the state of the two measures', () => {
    expect(isMeasured(measuredDisk())).toBe(true);
    expect(isMeasured(measuredDisk({ measuredAt: null }))).toBe(false);
    expect(isRunning(measuredDisk())).toBe(false);
    expect(isRunning(measuredDisk({ phases: { outside: 'running', home: 'done' } }))).toBe(true);
    expect(isRunning(measuredDisk({ phases: { outside: 'done', home: 'running' } }))).toBe(true);
    expect(isRunning(measuredDisk({ phases: { outside: 'failed', home: 'idle' } }))).toBe(false);
  });
});
