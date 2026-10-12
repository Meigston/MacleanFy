import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach } from 'vitest';
import type { UpdateState } from '../shared/api';
import { Updater, type UpdaterBackend } from './updater';

/** Faz o papel do electron-updater: guarda o que foi pedido e emite o que o teste mandar. */
class FakeBackend extends EventEmitter implements UpdaterBackend {
  autoDownload = true;
  checks = 0;
  downloads = 0;
  installs = 0;
  /** Quando preenchido, a próxima chamada rejeita, além de emitir `error` como a biblioteca faz. */
  failure: Error | null = null;

  private run(): Promise<unknown> {
    if (!this.failure) return Promise.resolve(null);
    const error = this.failure;
    this.failure = null;
    this.emit('error', error);
    return Promise.reject(error);
  }

  checkForUpdates(): Promise<unknown> {
    this.checks++;
    return this.run();
  }

  downloadUpdate(): Promise<unknown> {
    this.downloads++;
    return this.run();
  }

  quitAndInstall(): void {
    this.installs++;
  }
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('Updater', () => {
  let backend: FakeBackend;
  let seen: UpdateState[];
  let updater: Updater;

  beforeEach(() => {
    backend = new FakeBackend();
    seen = [];
    updater = new Updater(backend, (state) => seen.push(state), () => 1234);
  });

  it('never downloads on its own', () => {
    expect(backend.autoDownload).toBe(false);

    updater.check(false);
    backend.emit('update-available', { version: '0.2.0' });

    expect(updater.current()).toEqual({ status: 'available', version: '0.2.0' });
    expect(backend.downloads).toBe(0);
  });

  it('reports the latest version when there is nothing newer', () => {
    updater.check(true);
    backend.emit('update-not-available');

    expect(seen).toEqual([{ status: 'checking' }, { status: 'current', checkedAt: 1234 }]);
  });

  it('walks from available to downloading to ready, then installs', () => {
    updater.check(true);
    backend.emit('update-available', { version: '0.2.0' });

    updater.download();
    expect(updater.current()).toEqual({ status: 'downloading', version: '0.2.0', transferred: 0, total: 0 });

    backend.emit('download-progress', { transferred: 50, total: 200 });
    expect(updater.current()).toEqual({ status: 'downloading', version: '0.2.0', transferred: 50, total: 200 });

    backend.emit('update-downloaded', { version: '0.2.0' });
    expect(updater.current()).toEqual({ status: 'ready', version: '0.2.0' });

    updater.install();
    expect(backend.installs).toBe(1);
  });

  it('only downloads and installs from the right state', () => {
    updater.download();
    updater.install();
    expect(backend.downloads).toBe(0);
    expect(backend.installs).toBe(0);

    updater.check(true);
    backend.emit('update-available', { version: '0.2.0' });
    updater.install();
    expect(backend.installs).toBe(0);
  });

  it('does not start a second check while one is running, downloading or ready', () => {
    updater.check(false);
    updater.check(true);
    expect(backend.checks).toBe(1);

    backend.emit('update-available', { version: '0.2.0' });
    updater.download();
    updater.check(true);
    backend.emit('update-downloaded', { version: '0.2.0' });
    updater.check(true);
    expect(backend.checks).toBe(1);
  });

  it('shows the error of a check the person asked for, once', async () => {
    backend.failure = new Error('offline');
    updater.check(true);
    await settle();

    expect(seen).toEqual([{ status: 'checking' }, { status: 'error' }]);
  });

  it('keeps a failed background check quiet and goes back to where it was', async () => {
    updater.check(true);
    backend.emit('update-not-available');
    seen.length = 0;

    backend.failure = new Error('offline');
    updater.check(false);
    await settle();

    expect(seen).toEqual([{ status: 'checking' }, { status: 'current', checkedAt: 1234 }]);
  });

  it('does not go back to an old error after a failed background check', async () => {
    backend.failure = new Error('offline');
    updater.check(true);
    await settle();

    backend.failure = new Error('offline');
    updater.check(false);
    await settle();

    expect(updater.current()).toEqual({ status: 'idle' });
  });

  it('reports a failed download, and a retry finds the update again', async () => {
    updater.check(true);
    backend.emit('update-available', { version: '0.2.0' });

    backend.failure = new Error('connection reset');
    updater.download();
    await settle();
    expect(updater.current()).toEqual({ status: 'error' });

    updater.check(true);
    backend.emit('update-available', { version: '0.2.0' });
    expect(updater.current()).toEqual({ status: 'available', version: '0.2.0' });
  });

  it('reports an error that arrives after the download, when macOS refuses the package', () => {
    updater.check(true);
    backend.emit('update-available', { version: '0.2.0' });
    updater.download();
    backend.emit('update-downloaded', { version: '0.2.0' });

    backend.emit('error', new Error('code signature did not pass validation'));

    expect(updater.current()).toEqual({ status: 'error' });
  });

  it('is inert when running from source', () => {
    const idle = new Updater(null, (state) => seen.push(state));

    idle.check(true);
    idle.download();
    idle.install();

    expect(idle.current()).toEqual({ status: 'unsupported' });
    expect(seen).toEqual([]);
  });
});
