import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { CHANNELS, type MacleanFyApi, type Unsubscribe } from '../shared/api';

function subscribe<T>(channel: string, listener: (payload: T) => void): Unsubscribe {
  const handler = (_event: IpcRendererEvent, payload: T) => listener(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

// A interface só enxerga estas funções — nunca o ipcRenderer em si.
const api: MacleanFyApi = {
  system: {
    info: () => ipcRenderer.invoke(CHANNELS.systemInfo),
    openFullDiskAccessSettings: () => ipcRenderer.invoke(CHANNELS.openFullDiskAccess),
    openExternal: (url) => ipcRenderer.invoke(CHANNELS.openExternal, url),
    reveal: (path) => ipcRenderer.invoke(CHANNELS.reveal, path),
  },
  history: {
    get: () => ipcRenderer.invoke(CHANNELS.historyGet),
  },
  scan: {
    run: (categoryIds) => ipcRenderer.invoke(CHANNELS.scanRun, categoryIds),
    onProgress: (listener) => subscribe(CHANNELS.scanProgress, listener),
  },
  clean: {
    run: (selection, options) => ipcRenderer.invoke(CHANNELS.cleanRun, selection, options),
    onProgress: (listener) => subscribe(CHANNELS.cleanProgress, listener),
  },
  apps: {
    list: () => ipcRenderer.invoke(CHANNELS.appsList),
    onProgress: (listener) => subscribe(CHANNELS.appsProgress, listener),
    uninstall: (appPaths) => ipcRenderer.invoke(CHANNELS.appsUninstall, appPaths),
  },
  maintenance: {
    run: (task) => ipcRenderer.invoke(CHANNELS.maintenanceRun, task),
  },
};

contextBridge.exposeInMainWorld('macleanfy', api);
