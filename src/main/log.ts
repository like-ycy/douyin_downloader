import fs from 'node:fs'
import path from 'node:path'
import { getDataDir } from './paths'

/** 轻量日志：console + 落盘 logs/app-YYYY-MM-DD.log，便于排查风控/下载问题。 */
export function log(tag: string, message: string): void {
  const line = `[${new Date().toISOString()}] [${tag}] ${message}`
  console.log(line)
  try {
    const file = path.join(
      getDataDir(),
      'logs',
      `app-${new Date().toISOString().slice(0, 10)}.log`
    )
    fs.appendFileSync(file, line + '\n')
  } catch {
    // 日志写失败不影响主流程
  }
}
