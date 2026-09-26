import { ipcMain, dialog, shell } from 'electron'
import fs from 'node:fs'
import type {
  AuthStatus,
  Config,
  IpcResult,
  VideoInfo,
  DownloadReq,
} from '../shared/types'
import { cookieStatus, clearCookie } from './auth/cookieStore'
import { openLoginView, cancelLogin } from './auth/loginWindow'
import { inspectVideo } from './douyin/inspect'
import { startDownload, cancelDownload } from './douyin/download'
import { loadConfig, saveConfig } from './config'

export function registerIpc(): void {
  ipcMain.handle('auth:status', (): AuthStatus => cookieStatus())
  ipcMain.handle('auth:login', (): void => openLoginView())
  ipcMain.handle('auth:cancel', (): void => cancelLogin())
  ipcMain.handle('auth:logout', (): void => clearCookie())

  ipcMain.handle(
    'video:inspect',
    async (_e, link: string): Promise<IpcResult<VideoInfo>> => {
      try {
        const trimmed = (link ?? '').trim()
        if (!trimmed) return { ok: false, message: '请先输入视频链接' }
        const data = await inspectVideo(trimmed)
        return { ok: true, data }
      } catch (e) {
        return { ok: false, message: (e as Error).message }
      }
    }
  )

  ipcMain.handle(
    'download:start',
    (_e, req: DownloadReq): IpcResult<string> => {
      try {
        if (!fs.existsSync(req.dir) || !fs.statSync(req.dir).isDirectory()) {
          return { ok: false, message: `下载目录不存在：${req.dir}` }
        }
        const taskId = startDownload(req)
        return { ok: true, data: taskId }
      } catch (e) {
        return { ok: false, message: (e as Error).message }
      }
    }
  )

  ipcMain.handle('download:cancel', (_e, taskId: string): void => {
    cancelDownload(taskId)
  })

  ipcMain.handle('dialog:selectDir', async (): Promise<string | null> => {
    const r = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
    })
    return r.canceled || r.filePaths.length === 0 ? null : r.filePaths[0]
  })

  ipcMain.handle('shell:showItemInFolder', (_e, p: string): void => {
    shell.showItemInFolder(p)
  })

  ipcMain.handle('config:get', (): Config => loadConfig())

  ipcMain.handle('config:set', (_e, patch: Partial<Config>): Config =>
    saveConfig(patch)
  )
}
