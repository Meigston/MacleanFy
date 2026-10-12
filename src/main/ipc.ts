import { app, clipboard, ipcMain, nativeImage, shell, type IpcMainInvokeEvent, type WebContents } from 'electron';
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
} from '../shared/api';
import { SUPPORT } from '../shared/support';
import { Engine } from './engine';
import { HistoryStore } from './history';
import { getSystemInfo, runMaintenance } from './system';

const FULL_DISK_ACCESS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

/** O ícone aparece a 38px; o dobro cobre telas Retina. */
const APP_ICON_SIZE = { width: 76, height: 76 };

/** Só o que o próprio app aponta: o repositório, o projeto de origem e o perfil de quem o desenvolve. */
const EXTERNAL_ALLOWLIST = ['https://github.com/', 'https://www.linkedin.com/in/meigston/'];

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
  const history = new HistoryStore(join(app.getPath('userData'), 'history.json'));
  const rendererFile = pathToFileURL(join(__dirname, '../renderer/index.html')).href;

  // Apps devolvidos pela última listagem, por caminho do bundle.
  let knownApps = new Map<string, AppInfo>();

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

  handle(CHANNELS.maintenanceRun, (_sender, task: MaintenanceTask) => runMaintenance(task));

  handle(CHANNELS.openFullDiskAccess, () => shell.openExternal(FULL_DISK_ACCESS_URL));

  handle(CHANNELS.openExternal, async (_sender, url: unknown) => {
    if (typeof url === 'string' && isAllowedExternal(url)) await shell.openExternal(url);
  });

  // A interface não manda texto para a área de transferência: só pede o código que o app conhece.
  handle(CHANNELS.copyPixCode, () => clipboard.writeText(SUPPORT.pix.payload));

  handle(CHANNELS.reveal, (_sender, path: unknown) => {
    if (typeof path !== 'string') return;
    const isRelated = [...knownApps.values()].some((info) => info.related.some((r) => r.path === path));
    if (engine.knows(path) || knownApps.has(path) || isRelated) shell.showItemInFolder(path);
  });
}
