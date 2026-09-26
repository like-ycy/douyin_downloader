import { ipcMain } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { checkUpdate, matchWinFullAsset } from './checker'
import {
  cleanUpdateTemp,
  cancelUpdateDownload,
  downloadUpdatePackage,
  isDownloading,
} from './downloader'
import { extractArchive } from './extract'
import { applyAsarUpdate, startupUpdateConfirm } from './applyAsar'
import { applyFullUpdateWin } from './applyFullWin'
import { applyFullUpdateMac } from './applyFullMac'
import { emit } from '../emit'
import { log } from '../log'
import { isWindows } from '../platform'
import type { IpcResult, UpdateInfo } from '../../shared/types'

/**
 * 自动更新管理器：
 * - 启动 3 秒后异步检查（失败静默），有更新则推 update:available
 * - 下载（进度/取消/校验）→ 解压 → 按类型应用（asar 增量 / 全量整目录）
 * - 检查结果缓存为 pending，渲染层可补拉（防事件早于监听注册）
 */

let latest: UpdateInfo | null = null
/** 下载 + 解压完成后的暂存信息 */
let staged: { extractedDir: string; zipPath: string } | null = null
/** 最近一次下载用的代理开关（降级补下全量包时沿用） */
let lastUseProxy = false

export function registerUpdateIpc(): void {
  ipcMain.handle('update:getPending', (): UpdateInfo | null => latest)

  ipcMain.handle(
    'update:check',
    async (): Promise<IpcResult<UpdateInfo | null>> => {
      try {
        latest = await checkUpdate()
        if (latest.hasUpdate) emit('update:available', latest)
        return { ok: true, data: latest }
      } catch (e) {
        log('update', `手动检查失败: ${(e as Error).message}`)
        return { ok: false, message: `检查更新失败：${(e as Error).message}` }
      }
    }
  )

  ipcMain.handle(
    'update:download',
    async (_e, useProxy: boolean): Promise<IpcResult<null>> => {
      lastUseProxy = useProxy
      if (!latest?.hasUpdate || !latest.downloadUrl) {
        return { ok: false, message: '当前没有可下载的更新' }
      }
      if (isDownloading()) return { ok: false, message: '已有正在进行的下载' }
      try {
        const zipPath = await downloadUpdatePackage(latest, useProxy)
        const extractedDir = path.join(path.dirname(zipPath), 'extracted')
        await extractArchive(zipPath, extractedDir)
        staged = { extractedDir, zipPath }
        emit('update:done', null)
        return { ok: true, data: null }
      } catch (e) {
        const message = (e as Error).message
        log('update', `下载/解压失败: ${message}`)
        emit('update:failed', message)
        return { ok: false, message }
      }
    }
  )

  ipcMain.handle('update:cancelDownload', (): void => {
    if (isDownloading()) cancelUpdateDownload()
  })

  ipcMain.handle('update:apply', async (): Promise<IpcResult<null>> => {
    if (!latest?.hasUpdate) return { ok: false, message: '当前没有待应用的更新' }
    if (!staged) return { ok: false, message: '更新包尚未下载完成' }
    try {
      if (latest.updateType === 'asar') {
        const newAsar = findExtractedAsar(staged.extractedDir)
        if (!newAsar) throw new Error('更新包里没有找到 app.asar')
        try {
          // 成功后进程会 relaunch 并退出（不返回）
          applyAsarUpdate(newAsar, latest.latestVersion)
        } catch (asarErr) {
          if (!isWindows()) throw asarErr
          // Windows 降级：手头是增量包（只有 app.asar，没有 win-unpacked），
          // 无法就地走全量 —— 自动补下全量包，回到「待确认」状态等用户再点一次
          log('update', `asar 增量失败，降级下载全量包: ${(asarErr as Error).message}`)
          void fallbackFullWin()
        }
      } else {
        if (isWindows()) applyFullUpdateWin(staged.extractedDir)
        else applyFullUpdateMac(staged.extractedDir)
      }
      return { ok: true, data: null }
    } catch (e) {
      const message = (e as Error).message
      log('update', `应用更新失败: ${message}`)
      emit('update:failed', message)
      return { ok: false, message }
    }
  })
}

/** asar 增量失败后的 Windows 降级：取 Release 全量包 → 下载解压 → 换回待确认状态。 */
async function fallbackFullWin(): Promise<void> {
  const base = latest
  if (!base?.hasUpdate) return
  try {
    const asset = await matchWinFullAsset()
    if (!asset) throw new Error('Release 资产里没有 *_win_full.zip')
    const fullInfo: UpdateInfo = {
      ...base,
      updateType: 'full',
      downloadUrl: asset.browser_download_url,
      assetName: asset.name,
      assetSize: asset.size,
      digest: asset.digest ?? '',
    }
    // 重置渲染层进度（applying 阶段此事件非零时会显示进度条）
    emit('update:progress', { downloaded: 0, total: 0, speed: 0 })
    const zipPath = await downloadUpdatePackage(fullInfo, lastUseProxy)
    const extractedDir = path.join(path.dirname(zipPath), 'extracted')
    await extractArchive(zipPath, extractedDir)
    latest = fullInfo
    staged = { extractedDir, zipPath }
    emit('update:available', fullInfo) // 渲染层回 idle
    emit('update:done', null) // 再推到 ready，等用户点「重启并更新」
    log('update', '全量降级包已就绪，等待用户确认应用')
  } catch (e) {
    log('update', `全量降级失败: ${(e as Error).message}`)
    emit('update:failed', `全量更新包准备失败：${(e as Error).message}，请到 Release 页手动下载安装`)
  }
}

/** 主进程启动时调用：清理残留 + 延迟 3 秒后台检查更新。 */
export function startUpdateWatch(): void {
  startupUpdateConfirm() // 上次 asar 更新的成功确认与 .old 清理
  cleanUpdateTemp() // %TEMP% 残留清扫

  setTimeout(() => {
    void checkUpdate()
      .then((info) => {
        latest = info
        if (info.hasUpdate) emit('update:available', info)
      })
      .catch((e: Error) => {
        // 启动检查失败完全静默（无网/GitHub 不可达都是正常场景）
        log('update', `启动检查失败（忽略）: ${e.message}`)
      })
  }, 3000)
}

function findExtractedAsar(root: string): string | null {
  const direct = path.join(root, 'app.asar')
  if (fs.existsSync(direct)) return direct
  try {
    for (const name of fs.readdirSync(root)) {
      const sub = path.join(root, name)
      if (fs.statSync(sub).isDirectory()) {
        const nested = path.join(sub, 'app.asar')
        if (fs.existsSync(nested)) return nested
      }
      if (name === 'app.asar') return sub
    }
  } catch {
    // 读目录失败按未找到处理
  }
  return null
}
