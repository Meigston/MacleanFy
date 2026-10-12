import { writeFile } from 'node:fs/promises';
import { app, type BrowserWindow } from 'electron';

const POLL_MS = 400;
const SETTLE_MS = 900;
const TIMEOUT_MS = 10 * 60 * 1000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Salva um PNG da janela quando a interface termina o que estiver fazendo e
 * encerra o app. Serve para gerar as imagens do README e conferir o layout.
 *
 * A interface marca `data-busy` no <html> enquanto analisa ou lista apps.
 * `MACLEANFY_CAPTURE_SCRIPT` roda na página antes da foto — para abrir um
 * diálogo ou expandir uma linha, por exemplo. Passos separados por uma linha
 * com `---` rodam um de cada vez, esperando a interface sossegar entre eles.
 */
export function captureWhenIdle(win: BrowserWindow, file: string): void {
  win.webContents.once('did-finish-load', async () => {
    try {
      const isBusy = () =>
        win.webContents.executeJavaScript('document.documentElement.dataset.busy === "1"') as Promise<boolean>;

      const waitIdle = async () => {
        const deadline = Date.now() + TIMEOUT_MS;
        await sleep(SETTLE_MS);
        while ((await isBusy()) && Date.now() < deadline) await sleep(POLL_MS);
        await sleep(SETTLE_MS);
      };

      await waitIdle();

      for (const step of (process.env.MACLEANFY_CAPTURE_SCRIPT ?? '').split(/^---$/m)) {
        if (!step.trim()) continue;
        await win.webContents.executeJavaScript(step);
        await waitIdle();
      }

      const image = await win.webContents.capturePage();
      await writeFile(file, image.toPNG());
    } catch (error) {
      console.error('capture failed:', error);
      process.exitCode = 1;
    } finally {
      app.quit();
    }
  });
}
