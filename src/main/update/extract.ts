import { execFile } from 'node:child_process'
import fs from 'node:fs'
import { log } from '../log'

/**
 * 解压更新包（zip / tar.gz）。零依赖实现：
 * macOS 与 Windows 10+ 都自带 bsdtar（tar -xf 可同时处理两种格式）。
 */
export function extractArchive(archivePath: string, destDir: string): Promise<void> {
  fs.mkdirSync(destDir, { recursive: true })
  return new Promise((resolve, reject) => {
    execFile(
      'tar',
      ['-xf', archivePath, '-C', destDir],
      { windowsHide: true, timeout: 120_000 },
      (err, _stdout, stderr) => {
        if (err) {
          log('update', `解压失败: ${stderr || err.message}`)
          reject(new Error(`解压更新包失败：${(stderr || err.message).trim()}`))
        } else {
          resolve()
        }
      }
    )
  })
}
