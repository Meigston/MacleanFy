import type { UpdateState } from '../shared/api';

/** O pedaço do electron-updater que o app usa. Nos testes entra um falso. */
export interface UpdaterBackend {
  autoDownload: boolean;
  on(event: 'update-available' | 'update-downloaded', listener: (info: { version: string }) => void): unknown;
  on(event: 'update-not-available', listener: () => void): unknown;
  on(event: 'download-progress', listener: (progress: { transferred: number; total: number }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
}

/**
 * Atualização do app: busca a versão nova, baixa quando a pessoa pede e
 * instala ao reiniciar.
 *
 * Nada é baixado sem um clique — o app avisa e espera. O que garante que o
 * pacote é mesmo o nosso são duas conferências: o electron-updater compara o
 * SHA-512 publicado junto da versão, e o macOS só troca o app se a assinatura
 * Developer ID for a mesma da versão instalada.
 */
export class Updater {
  private state: UpdateState;
  /** A busca em curso foi pedida por quem usa? Só essa mostra erro. */
  private manual = false;
  /** Para onde voltar quando uma busca automática falha. */
  private resting: UpdateState = { status: 'idle' };

  constructor(
    private readonly backend: UpdaterBackend | null,
    private readonly notify: (state: UpdateState) => void,
    private readonly now: () => number = Date.now
  ) {
    this.state = backend ? { status: 'idle' } : { status: 'unsupported' };
    if (!backend) return;

    backend.autoDownload = false;
    backend.on('update-available', ({ version }) => this.set({ status: 'available', version }));
    backend.on('update-not-available', () => this.set({ status: 'current', checkedAt: this.now() }));
    backend.on('download-progress', ({ transferred, total }) => {
      if (this.state.status === 'downloading') this.set({ ...this.state, transferred, total });
    });
    backend.on('update-downloaded', ({ version }) => this.set({ status: 'ready', version }));
    backend.on('error', (error) => this.fail(error));
  }

  current(): UpdateState {
    return this.state;
  }

  /**
   * `manual` é a busca pedida no app: essa sempre termina num estado que a tela
   * mostra. A automática que falha — sem internet, GitHub fora do ar — volta
   * calada para onde estava e tenta de novo no dia seguinte.
   */
  check(manual: boolean): void {
    const { status } = this.state;
    if (!this.backend || status === 'checking' || status === 'downloading' || status === 'ready') return;

    this.manual = manual;
    this.resting = status === 'error' ? { status: 'idle' } : this.state;
    this.set({ status: 'checking' });
    this.backend.checkForUpdates().catch((error: Error) => this.fail(error));
  }

  download(): void {
    if (!this.backend || this.state.status !== 'available') return;

    this.set({ status: 'downloading', version: this.state.version, transferred: 0, total: 0 });
    this.backend.downloadUpdate().catch((error: Error) => this.fail(error));
  }

  install(): void {
    if (this.backend && this.state.status === 'ready') this.backend.quitAndInstall();
  }

  private set(state: UpdateState): void {
    this.state = state;
    this.notify(state);
  }

  /** O mesmo erro chega pelo evento e pela promessa; a segunda chegada já não encontra o que desfazer. */
  private fail(error: Error): void {
    const { status } = this.state;
    if (status !== 'checking' && status !== 'downloading' && status !== 'ready') return;

    console.error('[atualização]', error);
    this.set(status === 'checking' && !this.manual ? this.resting : { status: 'error' });
  }
}
