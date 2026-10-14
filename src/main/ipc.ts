import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  nativeImage,
  shell,
  type IpcMainInvokeEvent,
  type WebContents,
} from 'electron';
import electronUpdater from 'electron-updater';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { CATEGORIES, type CategoryId } from '../core/types';
import { listInstalledApps, uninstallApps, type AppInfo } from '../core/apps';
import {
  CHANNELS,
  type CleanOptions,
  type CleanSelection,
  type InstalledAppDTO,
  type MaintenanceTask,
  type UninstallResultDTO,
  type UpdateState,
} from '../shared/api';
import { SUPPORT, isPixOption } from '../shared/support';
import { Engine } from './engine';
import { HistoryStore } from './history';
import { PerformanceMonitor } from './perf/monitor';
import { getMaintenanceInfo, getSystemInfo, runMaintenance } from './system';
import { Updater } from './updater';

const FULL_DISK_ACCESS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';
const ACTIVITY_MONITOR = '/System/Applications/Utilities/Activity Monitor.app';

/** A primeira busca por versão nova espera o app assentar; depois, uma por dia enquanto ele estiver aberto. */
const UPDATE_FIRST_CHECK_MS = 10 * 1000;
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Ferramenta de desenvolvimento: `MACLEANFY_UPDATE_DEMO=available pnpm start` mostra uma
 * etapa da atualização rodando do código-fonte, para conferir e fotografar as telas.
 * Nunca vale no app empacotado.
 */
function demoUpdate(step: string | undefined): UpdateState | null {
  const version = '9.9.9';
  switch (step) {
    case 'checking':
    case 'error':
      return { status: step };
    case 'current':
      return { status: 'current', checkedAt: Date.now() };
    case 'available':
    case 'ready':
      return { status: step, version };
    case 'downloading':
      return { status: 'downloading', version, transferred: 48_300_000, total: 117_600_000 };
    default:
      return null;
  }
}

/** O ícone aparece a 38px; o dobro cobre telas Retina. */
const APP_ICON_SIZE = { width: 76, height: 76 };

/**
 * Só o que o próprio app aponta: o repositório, o projeto de origem, quem o desenvolve (perfil e
 * outro app) e a doação.
 */
const EXTERNAL_ALLOWLIST = [
  'https://github.com/',
  'https://www.linkedin.com/in/meigston/',
  'https://airdroidfy.com/',
  SUPPORT.stripe,
];

function isCategoryId(value: unknown): value is CategoryId {
  return typeof value === 'string' && value in CATEGORIES;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

export function isAllowedExternal(url: string): boolean {
  return EXTERNAL_ALLOWLIST.some((prefix) => url.startsWith(prefix));
}

export function registerIpc(): void {
  const engine = new Engine();
  const performance = new PerformanceMonitor();
  const history = new HistoryStore(join(app.getPath('userData'), 'history.json'));
  const rendererFile = pathToFileURL(join(__dirname, '../renderer/index.html')).href;

  // Apps devolvidos pela última listagem, por caminho do bundle.
  let knownApps = new Map<string, AppInfo>();

  // Rodando do código-fonte não há instalação para atualizar: o atualizador fica inerte.
  const updater = new Updater(app.isPackaged ? electronUpdater.autoUpdater : null, (state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(CHANNELS.updateChanged, state);
    }
  });
  const updateDemo = app.isPackaged ? null : demoUpdate(process.env.MACLEANFY_UPDATE_DEMO);
  if (app.isPackaged) {
    setTimeout(() => updater.check(false), UPDATE_FIRST_CHECK_MS);
    setInterval(() => updater.check(false), UPDATE_CHECK_INTERVAL_MS);
  }

  /** Recusa chamadas que não venham da página do próprio app. */
  function handle<Args extends unknown[], Result>(
    channel: string,
    listener: (sender: WebContents, ...args: Args) => Promise<Result> | Result
  ): void {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const url = event.senderFrame?.url ?? '';
      const devUrl = process.env.ELECTRON_RENDERER_URL;
      const trusted = url.startsWith(rendererFile) || (!!devUrl && url.startsWith(devUrl));
      if (!trusted) throw new Error(`Blocked IPC from ${url}`);
      return listener(event.sender, ...(args as Args));
    });
  }

  handle(CHANNELS.systemInfo, () => getSystemInfo());
  handle(CHANNELS.historyGet, () => history.read());

  handle(CHANNELS.updateState, () => updateDemo ?? updater.current());
  handle(CHANNELS.updateCheck, () => updater.check(true));
  handle(CHANNELS.updateDownload, () => updater.download());
  handle(CHANNELS.updateInstall, () => updater.install());

  handle(CHANNELS.scanRun, (sender, categoryIds?: unknown) => {
    const ids = Array.isArray(categoryIds) ? categoryIds.filter(isCategoryId) : undefined;
    return engine.scan(ids, (progress) => {
      if (!sender.isDestroyed()) sender.send(CHANNELS.scanProgress, progress);
    });
  });

  handle(CHANNELS.cleanRun, async (sender, selection: unknown, options?: CleanOptions) => {
    const valid: CleanSelection[] = (Array.isArray(selection) ? selection : []).filter(
      (entry): entry is CleanSelection => isCategoryId(entry?.categoryId) && isStringArray(entry?.paths)
    );

    const summary = await engine.clean(valid, { dryRun: options?.dryRun === true }, (progress) => {
      if (!sender.isDestroyed()) sender.send(CHANNELS.cleanProgress, progress);
    });

    if (!summary.dryRun && summary.totalCleanedItems > 0) {
      await history.add({
        kind: 'clean',
        freedSpace: summary.totalFreedSpace,
        items: summary.totalCleanedItems,
        labels: summary.results.filter((r) => r.cleanedItems > 0).map((r) => r.categoryId),
      });
    }
    return summary;
  });

  handle(CHANNELS.appsList, async (sender): Promise<InstalledAppDTO[]> => {
    const apps = await listInstalledApps({
      onProgress: (completed, total) => {
        if (!sender.isDestroyed()) sender.send(CHANNELS.appsProgress, { completed, total });
      },
    });

    // O próprio MacleanFy não entra na lista de desinstalação.
    const self = app.getPath('exe');
    const listed = apps.filter((info) => !self.startsWith(info.path + '/'));
    knownApps = new Map(listed.map((info) => [info.path, info]));

    return Promise.all(
      listed.map(async (info) => ({
        name: info.name,
        path: info.path,
        size: info.size,
        related: info.related,
        totalSize: info.totalSize,
        // Miniatura do Quick Look: o app.getFileIcon devolve o ícone genérico para bundles.
        icon: await nativeImage
          .createThumbnailFromPath(info.path, APP_ICON_SIZE)
          .then((image) => image.toDataURL())
          .catch(() => undefined),
      }))
    );
  });

  handle(CHANNELS.appsUninstall, async (_sender, appPaths: unknown): Promise<UninstallResultDTO> => {
    const apps = (isStringArray(appPaths) ? appPaths : [])
      .map((path) => knownApps.get(path))
      .filter((info): info is AppInfo => info !== undefined);

    // Desinstalar manda para a Lixeira: dá para voltar atrás até esvaziá-la.
    const result = await uninstallApps(apps, async (path) => {
      await shell.trashItem(path);
      return true;
    });

    const removed = apps.filter((info) => !result.errors.includes(info.name));
    for (const info of removed) knownApps.delete(info.path);

    if (result.uninstalled > 0) {
      await history.add({
        kind: 'uninstall',
        freedSpace: result.freedSpace,
        items: result.uninstalled,
        labels: removed.map((info) => info.name),
      });
    }
    return result;
  });

  handle(CHANNELS.performanceSample, () => performance.sample());
  // O app só lê: encerrar um processo fica com o Monitor de Atividade, que mostra o que se perde.
  handle(CHANNELS.openActivityMonitor, async () => {
    await shell.openPath(ACTIVITY_MONITOR);
  });
  handle(CHANNELS.maintenanceInfo, () => getMaintenanceInfo());
  handle(CHANNELS.maintenanceRun, (_sender, task: MaintenanceTask) => runMaintenance(task));

  handle(CHANNELS.openFullDiskAccess, () => shell.openExternal(FULL_DISK_ACCESS_URL));

  handle(CHANNELS.openExternal, async (_sender, url: unknown) => {
    if (typeof url === 'string' && isAllowedExternal(url)) await shell.openExternal(url);
  });

  // A interface não manda texto para a área de transferência: só diz qual dos códigos do app quer.
  handle(CHANNELS.copyPixCode, (_sender, option: unknown) => {
    if (isPixOption(option)) clipboard.writeText(SUPPORT.pix[option]);
  });

  handle(CHANNELS.reveal, (_sender, path: unknown) => {
    if (typeof path !== 'string') return;
    const isRelated = [...knownApps.values()].some((info) => info.related.some((r) => r.path === path));
    if (engine.knows(path) || knownApps.has(path) || isRelated) shell.showItemInFolder(path);
  });
}
