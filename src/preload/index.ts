import { contextBridge, ipcRenderer } from 'electron'
import type {
  IpcResult,
  VideoInfo,
  AuthStatus,
  Config,
  DownloadReq,
  DownloadProgress,
  DownloadDone,
  DownloadError,
  UpdateInfo,
  UpdateProgress,
} from '../shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  authStatus: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:status'),
  login: (): Promise<void> => ipcRenderer.invoke('auth:login'),
  cancelLogin: (): Promise<void> => ipcRenderer.invoke('auth:cancel'),
  logout: (): Promise<void> => ipcRenderer.invoke('auth:logout'),
  onAuthWaiting: (cb: (p: { elapsed: number }) => void): (() => void) =>
    subscribe<{ elapsed: number }>('auth:waiting', cb),
  onAuthSuccess: (cb: (p: { message: string }) => void): (() => void) =>
    subscribe<{ message: string }>('auth:success', cb),
  onAuthFailed: (cb: (p: { reason: string }) => void): (() => void) =>
    subscribe<{ reason: string }>('auth:failed', cb),

  inspect: (link: string): Promise<IpcResult<VideoInfo>> =>
    ipcRenderer.invoke('video:inspect', link),

  downloadStart: (req: DownloadReq): Promise<IpcResult<string>> =>
    ipcRenderer.invoke('download:start', req),
  downloadCancel: (taskId: string): Promise<void> =>
    ipcRenderer.invoke('download:cancel', taskId),
  onDownloadProgress: (cb: (p: DownloadProgress) => void): (() => void) =>
    subscribe<DownloadProgress>('download:progress', cb),
  onDownloadDone: (cb: (p: DownloadDone) => void): (() => void) =>
    subscribe<DownloadDone>('download:done', cb),
  onDownloadError: (cb: (p: DownloadError) => void): (() => void) =>
    subscribe<DownloadError>('download:error', cb),

  selectDir: (): Promise<string | null> => ipcRenderer.invoke('dialog:selectDir'),
  showItemInFolder: (p: string): Promise<void> =>
    ipcRenderer.invoke('shell:showItemInFolder', p),

  configGet: (): Promise<Config> => ipcRenderer.invoke('config:get'),
  configSet: (patch: Partial<Config>): Promise<Config> =>
    ipcRenderer.invoke('config:set', patch),

  // ---------- 自动更新 ----------
  updateGetPending: (): Promise<UpdateInfo | null> =>
    ipcRenderer.invoke('update:getPending'),
  updateCheck: (): Promise<IpcResult<UpdateInfo | null>> =>
    ipcRenderer.invoke('update:check'),
  updateDownload: (useProxy: boolean): Promise<IpcResult<null>> =>
    ipcRenderer.invoke('update:download', useProxy),
  updateCancelDownload: (): Promise<void> => ipcRenderer.invoke('update:cancelDownload'),
  updateApply: (): Promise<IpcResult<null>> => ipcRenderer.invoke('update:apply'),
  onUpdateAvailable: (cb: (p: UpdateInfo) => void): (() => void) =>
    subscribe<UpdateInfo>('update:available', cb),
  onUpdateProgress: (cb: (p: UpdateProgress) => void): (() => void) =>
    subscribe<UpdateProgress>('update:progress', cb),
  onUpdateDone: (cb: () => void): (() => void) => subscribe<null>('update:done', cb),
  onUpdateFailed: (cb: (p: string) => void): (() => void) =>
    subscribe<string>('update:failed', cb),
}

export type Api = typeof api

contextBridge.exposeInMainWorld('api', api)
