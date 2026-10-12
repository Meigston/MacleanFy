import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { captureWhenIdle } from './capture';
import { isAllowedExternal, registerIpc } from './ipc';

// Ferramenta de desenvolvimento: `MACLEANFY_CAPTURE=tela.png pnpm start` salva
// uma imagem da janela e encerra. Nunca vale no app empacotado.
const capturePath = app.isPackaged ? undefined : process.env.MACLEANFY_CAPTURE;

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
    ...(capturePath
      ? { backgroundColor: '#05001d' }
      : { vibrancy: 'under-window', visualEffectState: 'active', backgroundColor: '#00000000' }),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Fora da tela a página renderiza mesmo com o monitor apagado ou bloqueado.
      ...(capturePath ? { offscreen: { deviceScaleFactor: 2 } } : {}),
    },
  });

  if (!capturePath) win.once('ready-to-show', () => win.show());

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

  return win;
}

void app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
