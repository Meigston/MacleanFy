import { app, BrowserWindow, shell } from 'electron';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { captureWhenIdle } from './capture';
import { registerDemoIpc } from './demo';
import { isAllowedExternal, registerIpc } from './ipc';
import { recordWhenReady } from './record';

// Ferramentas de desenvolvimento, que nunca valem no app empacotado:
// `MACLEANFY_CAPTURE=tela.png pnpm start` salva uma imagem da janela e encerra;
// `MACLEANFY_RECORD=tomada.mp4 MACLEANFY_RECORD_SCRIPT=cena.mjs` grava a janela
// seguindo um roteiro; `MACLEANFY_DEMO=1` troca os dados do Mac pelos de
// demonstração (a gravação sempre usa estes).
const dev = !app.isPackaged;
const capturePath = dev ? process.env.MACLEANFY_CAPTURE : undefined;
const recordPath = dev ? process.env.MACLEANFY_RECORD : undefined;
const recordScript = dev ? process.env.MACLEANFY_RECORD_SCRIPT : undefined;
const demo = dev && (process.env.MACLEANFY_DEMO === '1' || !!recordPath);
const offscreen = !!capturePath || !!recordPath;

if (demo) {
  // Preferências e histórico da demonstração não se misturam com os de quem usa o app.
  const userData = join(app.getPath('temp'), 'macleanfy-demo');
  rmSync(userData, { recursive: true, force: true });
  app.setPath('userData', userData);
}
// O idioma da interface sai do navigator.language quando não há escolha salva.
if (dev && process.env.MACLEANFY_LOCALE) app.commandLine.appendSwitch('lang', process.env.MACLEANFY_LOCALE);

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 1020,
    minHeight: 680,
    show: false,
    title: 'MacleanFy',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 22 },
    // A captura não enxerga o que está atrás da janela; nela o fundo é sólido.
    ...(offscreen
      ? { backgroundColor: '#05001d' }
      : { vibrancy: 'under-window', visualEffectState: 'active', backgroundColor: '#00000000' }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Fora da tela a página renderiza mesmo com o monitor apagado ou bloqueado.
      ...(offscreen ? { offscreen: { deviceScaleFactor: 2 } } : {}),
    },
  });

  if (!offscreen) win.once('ready-to-show', () => win.show());

  // A janela nunca sai do app: link externo permitido abre no navegador.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternal(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    // Recarregar a própria página (HMR em desenvolvimento) continua valendo.
    if (url.split('#')[0] !== win.webContents.getURL().split('#')[0]) event.preventDefault();
  });

  const devUrl = process.env.ELECTRON_RENDERER_URL;
  const route = process.env.MACLEANFY_ROUTE ?? '';
  if (devUrl) void win.loadURL(route ? `${devUrl}#${route}` : devUrl);
  else void win.loadFile(join(__dirname, '../renderer/index.html'), { hash: route });

  if (capturePath) captureWhenIdle(win, capturePath);
  else if (recordPath && recordScript) recordWhenReady(win, recordPath, recordScript);

  return win;
}

void app.whenReady().then(() => {
  if (demo) registerDemoIpc();
  else registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
