import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { app } from 'electron'
import { withProxy } from './checker'
import { emit } from '../emit'
import { log } from '../log'
import type { UpdateInfo } from '../../shared/types'

let active: AbortController | null = null

export function isDownloading(): boolean {
  return active !== null
}

/** 更新临时根目录：%TEMP%/douyin_downloader_update/ */
export function updateTempRoot(): string {
  return path.join(app.getPath('temp'), 'douyin_downloader_update')
}

/** 启动时清扫残留的更新临时目录（上次中途被杀/被跳过的下载）。 */
export function cleanUpdateTemp(): void {
  try {
    const root = updateTempRoot()
    if (!fs.existsSync(root)) return
    for (const name of fs.readdirSync(root)) {
      fs.rmSync(path.join(root, name), { recursive: true, force: true })
    }
    log('update', '已清扫更新临时目录')
  } catch (e) {
    log('update', `清扫临时目录失败（忽略）: ${(e as Error).message}`)
  }
}

export function cancelUpdateDownload(): void {
  active?.abort()
}

/** 下载更新包到 %TEMP% 并校验（size + sha256），返回压缩包路径。 */
export async function downloadUpdatePackage(
  info: UpdateInfo,
  useProxy: boolean
): Promise<string> {
  if (active) throw new Error('已有正在进行的下载')
  const abort = new AbortController()
  active = abort

  const dir = path.join(updateTempRoot(), `${info.latestVersion.replace(/[^0-9A-Za-z.-]/g, '_')}-${Date.now()}`)
  const dest = path.join(dir, info.assetName || 'update.zip')
  log('update', `开始下载: ${withProxy(info.downloadUrl, useProxy)} -> ${dest}`)

  try {
    fs.mkdirSync(dir, { recursive: true })
    await streamDownload(info, withProxy(info.downloadUrl, useProxy), dest, abort.signal)
    log('update', `下载完成: ${dest}`)
    return dest
  } catch (e) {
    // 半成品与本次临时目录一并清掉
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败不影响错误抛出
    }
    const err = e as Error
    throw new Error(err.name === 'AbortError' ? '已取消' : `下载失败：${err.message}`)
  } finally {
    active = null
  }
}

async function streamDownload(
  info: UpdateInfo,
  url: string,
  dest: string,
  signal: AbortSignal
): Promise<void> {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'douyin_downloader-update' },
    signal,
  })
  if (!res.ok || !res.body) throw new Error(`服务器返回 ${res.status}`)

  const total =
    info.assetSize > 0
      ? info.assetSize
      : parseInt(res.headers.get('content-length') ?? '0', 10) || 0

  const file = fs.createWriteStream(dest)
  const reader = res.body.getReader()
  const hasher = createHash('sha256')
  let downloaded = 0
  let lastEmit = 0
  const t0 = Date.now()

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const buf = Buffer.from(value)
      hasher.update(buf)
      downloaded += buf.byteLength
      if (!file.write(buf)) {
        await once(file, 'drain')
      }
      // 进度事件节流 ~200ms
      const now = Date.now()
      if (now - lastEmit >= 200) {
        lastEmit = now
        const elapsed = (now - t0) / 1000
        emit('update:progress', {
          downloaded,
          total,
          speed: elapsed > 0 ? downloaded / elapsed : 0,
        })
      }
    }
    await new Promise<void>((resolve, reject) => {
      file.end(() => resolve())
      file.on('error', reject)
    })
  } catch (e) {
    file.destroy()
    try {
      fs.unlinkSync(dest) // 删半成品
    } catch {
      // 清理失败不影响错误抛出
    }
    throw e
  }

  // 校验 1：文件大小
  if (info.assetSize > 0 && downloaded !== info.assetSize) {
    throw new Error(`文件大小校验失败：期望 ${info.assetSize} 字节，实际 ${downloaded} 字节`)
  }

  // 校验 2：sha256（GitHub API asset.digest，格式 "sha256:hex"）
  if (info.digest) {
    const [algo, expected] = info.digest.split(':', 2)
    if (algo?.toLowerCase() !== 'sha256' || !expected) {
      throw new Error(`不支持的摘要格式: ${info.digest}`)
    }
    const actual = hasher.digest('hex')
    if (actual.toLowerCase() !== expected.toLowerCase()) {
      throw new Error('SHA-256 校验失败，更新包可能已损坏')
    }
  }
}
