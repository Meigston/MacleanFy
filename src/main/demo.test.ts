import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHANNELS, type AiProgress, type AiScanDTO } from '../shared/api';

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
