import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { isWindows } from './platform'

/**
 * 应用数据目录（cookie / 日志 / 配置统一落这里）：
 * - macOS / Linux: ~/.douyin_downloader/
 * - Windows:       C:\Users\xxxx\douyin_downloader\（用户指定，不带点前缀）
 */
let cached: string | null = null

export function getDataDir(): string {
  if (!cached) {
    cached = path.join(os.homedir(), isWindows() ? 'douyin_downloader' : '.douyin_downloader')
    try {
      fs.mkdirSync(path.join(cached, 'logs'), { recursive: true })
    } catch {
      // 目录已存在或创建失败（后续写文件时会再报错）
    }
  }
  return cached
}
