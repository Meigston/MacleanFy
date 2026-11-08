import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHANNELS,
  type AiProgress,
  type AiScanDTO,
  type CleanSelection,
  type CleanSummaryDTO,
  type DiskFolderDTO,
  type ScanResultDTO,
  type WholeDiskDTO,
  type WholeDiskProgress,
  type WholeSegmentId,
} from '../shared/api';

type Handler = (event: { sender: unknown }, ...args: unknown[]) => unknown;
const handlers = vi.hoisted(() => new Map<string, Handler>());

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', isPackaged: false },
  ipcMain: { handle: (channel: string, handler: Handler) => handlers.set(channel, handler) },
  nativeImage: {},
}));

import { COLLECTORS } from './ai/collectors';
import { registerDemoIpc } from './demo';

describe('demo AI scan', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    handlers.clear();
    registerDemoIpc();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  async function scan() {
    const progress: AiProgress[] = [];
    const sender = { isDestroyed: () => false, send: (_channel: string, payload: AiProgress) => progress.push(payload) };
    const pending = handlers.get(CHANNELS.aiScan)!({ sender }) as Promise<AiScanDTO>;
    await vi.runAllTimersAsync();
    return { result: await pending, progress };
  }

  it('counts one step per collector, like the real scanner', async () => {
    const { progress } = await scan();
    expect(progress.at(-1)).toEqual({ done: COLLECTORS.length, total: COLLECTORS.length });
  });

  it('follows the collectors contract for how each item goes', async () => {
    const { result } = await scan();
    const byLabel = new Map(result.items.map((item) => [item.label, item]));

    // Hugging Face sai pela Lixeira; só o Ollama sai pelo comando.
    expect(byLabel.get('openai/whisper-large-v3')).toMatchObject({ removal: 'trash', hint: 'redownload', confidence: 'low' });
    const byCommand = result.items.filter((item) => item.removal === 'command');
    expect(byCommand.length).toBeGreaterThan(0);
    expect(byCommand.every((item) => item.tool === 'ollama')).toBe(true);

    // A sessão aberta é como a do coletor: chave 'live', Lixeira, presa pelo bloqueio.
    const live = result.items.find((item) => item.blocked === 'live-session');
    expect(live).toMatchObject({ removal: 'trash', heat: 'hot' });
    expect(live?.id.endsWith('#live')).toBe(true);
  });
});

describe('demo whole disk', () => {
  const GB = 1000 ** 3;
  const HOME = '/Users/ana';

  beforeEach(() => {
    vi.useFakeTimers();
    handlers.clear();
    registerDemoIpc();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Chama um canal como o renderer, deixa os timers da demonstração correrem e guarda o que foi enviado. */
  async function call<T>(channel: string, ...args: unknown[]) {
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const sender = { isDestroyed: () => false, send: (name: string, payload: unknown) => sent.push({ channel: name, payload }) };
    const pending = handlers.get(channel)!({ sender }, ...args) as Promise<T>;
    await vi.runAllTimersAsync();
    return { result: await pending, sent };
  }

  async function whole(options?: { measure?: boolean; refresh?: boolean }) {
    const { result, sent } = await call<WholeDiskDTO>(CHANNELS.diskWhole, options);
    const progress = sent.filter((entry) => entry.channel === CHANNELS.diskWholeProgress).map((entry) => entry.payload as WholeDiskProgress);
    return { dto: result, progress };
  }

  const bytesOf = (dto: WholeDiskDTO, id: WholeSegmentId) => dto.segments.find((entry) => entry.id === id)?.bytes ?? 0;
  const closes = (dto: WholeDiskDTO) => dto.segments.reduce((sum, entry) => sum + entry.bytes, 0) + dto.free;

  it('only reads the volumes without measure: the data volume stays pending and the account closes', async () => {
    const { dto, progress } = await whole();
    expect(progress).toEqual([]);
    expect(dto.measuredAt).toBeNull();
    expect(dto.phases).toEqual({ outside: 'idle', home: 'idle' });
    expect(dto.home).toBeNull();
    const ids = dto.segments.map((entry) => entry.id);
    expect(ids).toContain('pending');
    expect(ids).not.toContain('unknown');
    expect(ids).not.toContain('home');
    expect(dto.total).toBe(Math.round(494.38 * GB));
    expect(closes(dto)).toBe(dto.total);
    expect(dto.overcount).toBe(0);
    expect(dto.stale).toBe(false);
  });

  it('measures both phases, reporting progress, and closes the account in bytes', async () => {
    const { dto, progress } = await whole({ measure: true });

    const outside = progress.filter((entry) => entry.phase === 'outside');
    const home = progress.filter((entry) => entry.phase === 'home');
    expect(outside.some((entry) => !entry.done && entry.path.startsWith('/System/Volumes/Data/'))).toBe(true);
    expect(home.some((entry) => !entry.done && entry.path.startsWith(`${HOME}/`))).toBe(true);
    expect(outside.filter((entry) => entry.done)).toHaveLength(1);
    expect(home.filter((entry) => entry.done)).toHaveLength(1);
    expect(outside.at(-1)?.done).toBe(true);
    expect(home.at(-1)?.done).toBe(true);
    // O progresso só cresce dentro de cada fase.
    for (const phase of [outside, home]) {
      for (let index = 1; index < phase.length; index++) expect(phase[index].bytes).toBeGreaterThanOrEqual(phase[index - 1].bytes);
    }

    expect(dto.measuredAt).not.toBeNull();
    expect(dto.phases).toEqual({ outside: 'done', home: 'done' });
    expect(dto.total).toBe(Math.round(494.38 * GB));
    expect(closes(dto)).toBe(dto.total);
    expect(dto.overcount).toBe(0);
    expect(dto.stale).toBe(false);
    expect(dto.segments.map((entry) => entry.id)).not.toContain('pending');
    expect(bytesOf(dto, 'unknown') / GB).toBeCloseTo(21.98, 2);
    // As fatias da pasta pessoal somam o segmento dela.
    expect(dto.home!.reduce((sum, share) => sum + share.bytes, 0)).toBe(bytesOf(dto, 'home'));
  });

  it('reuses what is already measured on a new measure', async () => {
    const first = await whole({ measure: true });
    const again = await whole({ measure: true });
    expect(again.progress).toEqual([]);
    expect(again.dto.measuredAt).toBe(first.dto.measuredAt);
    expect(again.dto.segments).toEqual(first.dto.segments);
  });

  it('turns the snapshots into free space taken from the unknown, and marks the measure as stale', async () => {
    const before = (await whole({ measure: true })).dto;
    expect(before.snapshots.length).toBeGreaterThan(0);

    const { result } = await call<{ success: boolean }>(CHANNELS.maintenanceRun, 'snapshots');
    expect(result.success).toBe(true);
    const after = (await whole()).dto;

    expect(after.snapshots).toEqual([]);
    expect(after.free - before.free).toBeCloseTo(11.4 * GB, -1);
    expect(bytesOf(before, 'unknown') - bytesOf(after, 'unknown')).toBeCloseTo(11.4 * GB, -1);
    expect((before.purgeable ?? 0) - (after.purgeable ?? 0)).toBeCloseTo(11.4 * GB, -1);
    expect(after.stale).toBe(true);
    expect(after.total).toBe(before.total);
    expect(closes(after)).toBe(after.total);

    // Medir de novo tira o aviso; o que os snapshots ocupavam continua livre.
    const remeasured = (await whole({ measure: true })).dto;
    expect(remeasured.stale).toBe(false);
    expect(remeasured.free).toBe(after.free);
    expect(bytesOf(remeasured, 'unknown')).toBe(bytesOf(after, 'unknown'));
    expect(closes(remeasured)).toBe(remeasured.total);
  });

  it('keeps the home folder total when something goes to the Trash, which grows', async () => {
    const list = async (path?: string) => (await call<DiskFolderDTO>(CHANNELS.diskList, path)).result;
    const before = await list();
    expect(before.entries.find((entry) => entry.name === '.Trash')).toBeUndefined();
    const downloads = before.entries.find((entry) => entry.name === 'Downloads')!;

    expect((await call<boolean>(CHANNELS.diskTrash, `${HOME}/Downloads/Xcode_26.xip`)).result).toBe(true);
    const once = await list();
    expect(once.home).toBe(before.home);
    expect(once.size).toBe(before.size);
    expect(once.disk.free).toBe(before.disk.free);
    const trash = once.entries.find((entry) => entry.name === '.Trash');
    expect(trash?.size).toBe(Math.round(9.8 * GB));
    expect(once.entries.find((entry) => entry.name === 'Downloads')?.size).toBe(downloads.size - Math.round(9.8 * GB));
    expect((await list(`${HOME}/.Trash`)).entries.map((entry) => entry.name)).toEqual(['Xcode_26.xip']);

    expect((await call<boolean>(CHANNELS.diskTrash, `${HOME}/Documents`)).result).toBe(true);
    const twice = await list();
    expect(twice.home).toBe(before.home);
    expect(twice.entries.find((entry) => entry.name === '.Trash')?.size).toBe(Math.round(9.8 * GB) + Math.round(9.4 * GB));
    expect(twice.entries.find((entry) => entry.name === 'Documents')).toBeUndefined();

    // O disco inteiro vê a Lixeira como fatia da pasta pessoal, sem mudar o total dela.
    const { dto } = await whole({ measure: true });
    expect(bytesOf(dto, 'home')).toBe(Math.round(before.home));
    expect(dto.home?.find((share) => share.id === 'trash')?.bytes).toBe(Math.round(9.8 * GB) + Math.round(9.4 * GB));
    expect(closes(dto)).toBe(dto.total);
    expect(dto.overcount).toBe(0);
  });

  async function cleanEverything() {
    const { result: scan } = await call<ScanResultDTO[]>(CHANNELS.scanRun);
    const selection: CleanSelection[] = scan
      .filter((entry) => entry.items.length > 0)
      .map((entry) => ({ categoryId: entry.categoryId, paths: entry.items.map((item) => item.path) }));
    expect(selection.length).toBeGreaterThan(0);
    const { result } = await call<CleanSummaryDTO>(CHANNELS.cleanRun, selection);
    expect(result.dryRun).toBe(false);
    expect(result.totalFreedSpace).toBeGreaterThan(0);
    return result;
  }

  it('does not count anything twice when a clean is followed by a new measure', async () => {
    const before = (await whole({ measure: true })).dto;
    const summary = await cleanEverything();

    const stale = (await whole()).dto;
    expect(stale.stale).toBe(true);
    expect(stale.free - before.free).toBeCloseTo(summary.totalFreedSpace, -1);

    const { dto } = await whole({ refresh: true });
    expect(dto.overcount).toBe(0);
    expect(dto.stale).toBe(false);
    expect(closes(dto)).toBe(dto.total);
    expect(dto.free).toBe(stale.free);
    expect(bytesOf(dto, 'unknown')).toBeGreaterThan(0);
  });

  it('does not count anything twice when the clean comes before the first measure', async () => {
    await cleanEverything();
    const { dto } = await whole({ measure: true });
    expect(dto.overcount).toBe(0);
    expect(closes(dto)).toBe(dto.total);
  });

  it('does not count anything twice after a small clean and a plain measure', async () => {
    await whole({ measure: true });
    const { result: scan } = await call<ScanResultDTO[]>(CHANNELS.scanRun, ['system-cache']);
    const [caches] = scan;
    const { result } = await call<CleanSummaryDTO>(CHANNELS.cleanRun, [
      { categoryId: 'system-cache', paths: caches.items.map((item) => item.path) },
    ]);
    expect(result.totalCleanedItems).toBe(caches.items.length);

    const { dto, progress } = await whole({ measure: true });
    // A limpeza invalida as duas medidas: as duas correm de novo.
    expect(progress.filter((entry) => entry.done).map((entry) => entry.phase)).toEqual(['outside', 'home']);
    expect(dto.overcount).toBe(0);
    expect(dto.stale).toBe(false);
    expect(closes(dto)).toBe(dto.total);
  });

  it('keeps the explorer adding up after a clean and a new measure', async () => {
    const list = async (path?: string) => (await call<DiskFolderDTO>(CHANNELS.diskList, path)).result;
    await whole({ measure: true });
    await cleanEverything();
    const { dto } = await whole({ refresh: true });
    expect(dto.overcount).toBe(0);

    // Cada pasta continua do tamanho do que mostra dentro dela, e nenhuma fica negativa.
    const home = await list();
    expect(bytesOf(dto, 'home')).toBe(Math.round(home.home));
    const folders = [home];
    for (const entry of home.entries.filter((candidate) => candidate.directory)) folders.push(await list(entry.path));
    const broken = folders
      .filter((folder) => folder.entries.length > 0)
      .map((folder) => ({ path: folder.path, size: folder.size, inside: folder.entries.reduce((sum, entry) => sum + entry.size, 0) }))
      .filter((folder) => folder.size < 0 || folder.size !== folder.inside);
    expect(broken).toEqual([]);
  });

  it('changes nothing on a dry run', async () => {
    const before = (await whole({ measure: true })).dto;
    const { result: scan } = await call<ScanResultDTO[]>(CHANNELS.scanRun, ['downloads']);
    await call<CleanSummaryDTO>(CHANNELS.cleanRun, [{ categoryId: 'downloads', paths: scan[0].items.map((item) => item.path) }], {
      dryRun: true,
    });
    const after = (await whole()).dto;
    expect(after.free).toBe(before.free);
    expect(after.stale).toBe(false);
    expect(after.segments).toEqual(before.segments);
  });
});
