import fs from 'node:fs'
import path from 'node:path'
import { isWindows } from '../platform'

/** Windows 保留设备名：带扩展名也非法（CON.mp4 会被系统拒绝）。 */
const WINDOWS_RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
])

/** 去掉 #话题标签（如 #崩坏星穹铁道），保留标题正文。 */
export function stripHashtags(s: string): string {
  return (s ?? '').replace(/#[^\s#]+/g, '').replace(/#/g, '')
}

/** 清洗成安全文件名：替换文件系统非法字符/控制字符、压缩空白、限长。
 *  全角符号和 emoji 双平台都合法，不过度清洗。
 *  Windows 额外处理保留设备名（命中时加下划线后缀）。 */
export function safeFilename(s: string, maxLen = 120, win = isWindows()): string {
  let out = (s ?? '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[ ._-]+|[ ._-]+$/g, '')
  if (win && out) {
    const stem = out.replace(/\.[^.]*$/, '')
    if (WINDOWS_RESERVED.has(stem.toUpperCase())) out = `${out}_`
  }
  if (!out) return ''
  return out.slice(0, maxLen)
}

/** 按 '作者 - 去标签后的标题.mp4' 生成文件名；二者皆空退回 douyin_{id}.mp4。
 *  与 python/inspect_qualities.py 的 build_output_name 规则保持一致。 */
export function buildOutputName(
  author: string,
  desc: string,
  awemeId: string,
  win = isWindows()
): string {
  const title = safeFilename(stripHashtags(desc), 80, win)
  const name = author && title
    ? safeFilename(`${safeFilename(author, 20, win)} - ${title}`, 120, win)
    : title
    ? safeFilename(title, 120, win)
    : `douyin_${awemeId}`
  return `${name}.mp4`
}

/** 目标已存在时自动加 _1/_2 后缀，避免覆盖。 */
export function avoidCollision(dest: string): string {
  if (!fs.existsSync(dest)) return dest
  const dir = path.dirname(dest)
  const ext = path.extname(dest)
  const base = path.basename(dest, ext)
  for (let i = 1; ; i++) {
    const candidate = path.join(dir, `${base}_${i}${ext}`)
    if (!fs.existsSync(candidate)) return candidate
  }
}

/** Windows MAX_PATH 约束：完整路径超限时截断文件名（保留扩展名）。 */
export function clampPathLength(dest: string, maxLen = 240): string {
  if (!isWindows() || dest.length <= maxLen) return dest
  const dir = path.dirname(dest)
  const ext = path.extname(dest)
  const base = path.basename(dest, ext)
  const room = maxLen - dir.length - 1 - ext.length - 10
  const clipped = base.slice(0, Math.max(20, room))
  return path.join(dir, `${clipped}${ext}`)
}
