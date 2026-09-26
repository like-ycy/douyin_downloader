import { app } from 'electron'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { isWindows } from './platform'

/**
 * 应用数据目录（cookie / 日志 / 配置统一落这里）：
 * - macOS / Linux: ~/.douyin_downloader/（点前缀 = Unix 隐藏约定）
 * - Windows:       %APPDATA%\douyin_downloader\
 *   （C:\Users\xxx\AppData\Roaming\douyin_downloader，Windows 标准数据目录，
 *    点前缀在 Windows 上没有隐藏效果，故不加）
 */
let cached: string | null = null

export function getDataDir(): string {
  if (!cached) {
    cached = isWindows()
      ? path.join(app.getPath('appData'), 'douyin_downloader')
      : path.join(os.homedir(), '.douyin_downloader')
    migrateLegacyHomeDir(cached)
    try {
      fs.mkdirSync(path.join(cached, 'logs'), { recursive: true })
    } catch {
      // 目录已存在或创建失败（后续写文件时会再报错）
    }
  }
  return cached
}

/**
 * 迁移旧版目录（早期 Windows 版本曾放在 ~/douyin_downloader/）：
 * 新目录尚不存在且旧目录存在时，整体搬过来。一次性 best-effort，失败不阻塞启动。
 */
function migrateLegacyHomeDir(newDir: string): void {
  try {
    const legacy = path.join(os.homedir(), 'douyin_downloader')
    if (!isWindows() || fs.existsSync(newDir) || !fs.existsSync(legacy)) return
    fs.cpSync(legacy, newDir, { recursive: true, errorOnExist: false, force: false })
    fs.rmSync(legacy, { recursive: true, force: true })
  } catch {
    // 迁移失败就放弃，新目录照常初始化（大不了重新扫码登录）
  }
}
