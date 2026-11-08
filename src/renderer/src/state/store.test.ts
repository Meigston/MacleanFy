import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiItemDTO, AiScanDTO } from '../../../shared/api';

// O store lê window ao carregar (a rota inicial) e fala com o processo principal por window.macleanfy.
const bridge = vi.hoisted(() => {
  const bridge = {
    ai: { remove: vi.fn() },
    system: { info: vi.fn(async () => null) },
    history: { get: vi.fn(async () => null) },
  };
  Object.assign(globalThis, { window: { location: { hash: '' }, macleanfy: bridge } });
  return bridge;
});

import { useStore } from './store';

const DAY = 24 * 60 * 60 * 1000;

function item(id: string, fields: Partial<AiItemDTO> = {}): AiItemDTO {
  return {
    id,
    tool: 'codex',
    kind: 'sessions',
    label: id,
    project: null,
    path: `/Users/ana/${id}`,
    size: 1000,
    count: 1,
    lastUsed: Date.now() - 60 * DAY,
    confidence: 'high',
    heat: 'cold',
    safety: 'moderate',
    removal: 'trash',
    ...fields,
  };
}

function load(items: AiItemDTO[], selected: string[] = []) {
  const ai: AiScanDTO = { scannedAt: Date.now(), items, failed: [] };
  useStore.setState({ ai, aiSelection: new Set(selected) });
}

describe('selectColdAi', () => {
  beforeEach(() => load([]));

  it('ticks only what is known to be cold', () => {
    load([
      item('session'),
      item('hf-model', { tool: 'hugging-face', kind: 'model', confidence: 'low', hint: 'redownload' }),
      item('never-loaded', { tool: 'lm-studio', kind: 'model', confidence: 'low', hint: 'never-loaded' }),
      item('images', { hint: 'generated-images' }),
      item('old-runtime', { tool: 'playwright', kind: 'runtime', confidence: 'low', junk: 'old-version' }),
      item('hot', { heat: 'hot' }),
    ]);
    useStore.getState().selectColdAi();
    expect([...useStore.getState().aiSelection].sort()).toEqual(['never-loaded', 'old-runtime', 'session']);
  });

  it('still lets the person tick a download-dated model by hand', () => {
    load([item('hf-model', { tool: 'hugging-face', kind: 'model', confidence: 'low' })]);
    useStore.getState().toggleAiItem('hf-model');
    expect(useStore.getState().aiSelection.has('hf-model')).toBe(true);
  });
});

describe('removeAiSelected', () => {
  it('reports a failed removal instead of throwing, and keeps the list and the selection', async () => {
    load([item('a'), item('b')], ['a', 'b']);
    bridge.ai.remove.mockRejectedValueOnce(new Error('IPC gone'));

    const result = await useStore.getState().removeAiSelected();

    expect(result).toEqual({ removed: 0, freedSpace: 0, failed: [{ id: 'a' }, { id: 'b' }], error: true });
    expect(useStore.getState().ai?.items.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect([...useStore.getState().aiSelection]).toEqual(['a', 'b']);
  });

  it('drops what went and keeps what stayed with its new lock', async () => {
    load([item('a'), item('b'), item('c')], ['a', 'b']);
    bridge.ai.remove.mockResolvedValueOnce({ removed: 1, freedSpace: 1000, failed: [{ id: 'b', blocked: 'app-open' }] });

    const result = await useStore.getState().removeAiSelected();

    expect(result.error).toBeUndefined();
    const items = useStore.getState().ai?.items ?? [];
    expect(items.map((entry) => entry.id)).toEqual(['b', 'c']);
    expect(items[0]).toMatchObject({ blocked: 'app-open', heat: 'cold' });
    expect(useStore.getState().aiSelection.size).toBe(0);
  });
});

describe('whole disk from the overview card', () => {
  it('goes to the disk screen once, asking it to measure', () => {
    useStore.setState({ route: 'overview', diskIntent: null });
    useStore.getState().openWholeDisk();
    expect(useStore.getState().route).toBe('disk');
    expect(useStore.getState().consumeDiskIntent()).toBe('whole');
    expect(useStore.getState().consumeDiskIntent()).toBeNull();
  });
});
