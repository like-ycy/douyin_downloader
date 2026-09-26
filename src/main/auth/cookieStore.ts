import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { getDataDir } from '../paths'
import { log } from '../log'

/** 登录态判定字段（与 Python 脚本、M0 探针一致）。
 *  ttwid / odin_tt 是设备标识不是登录标志，绝不参与判定。 */
const LOGIN_KEYS = ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard']

let cached: string | null = null

function cookieFile(): string {
  return path.join(getDataDir(), 'cookie.txt')
}

/** 读 cookie 字符串（'name=value; ...'），带缓存。找不到返回空串。 */
export function readCookie(): string {
  if (cached !== null) return cached
  // 主路径存在即以其为准——包括空文件（表示已退出登录，不再回退到开发期 cookie）
  try {
    const s = fs.readFileSync(cookieFile(), 'utf-8').trim()
    cached = s
    return s
  } catch {
    // 主路径不存在（从未登录过），才允许开发期回退
  }
  // 开发期回退：M0 探针抓到的登录 cookie（打包后不启用）
  if (!app.isPackaged) {
    try {
      const s = fs
        .readFileSync(path.join(app.getAppPath(), 'm0-probe', 'cookie.txt'), 'utf-8')
        .trim()
      if (s) {
        cached = s
        return s
      }
    } catch {
      // 没有就返回空
    }
  }
  cached = ''
  return cached
}

/** 登录成功后写入 cookie（0600 权限）。 */
export function writeCookie(cookieStr: string): void {
  fs.writeFileSync(cookieFile(), cookieStr, { mode: 0o600 })
  cached = cookieStr
  log('cookie', `已写入 ${cookieFile()}`)
}

/** 退出登录：写入空文件占位（只动主路径，不动开发期回退文件）。
 *  不能直接删文件——删了之后 readCookie 会回退读到 m0-probe 的登录 cookie，
 *  造成"退出后立刻又变已登录"的假象。 */
export function clearCookie(): void {
  try {
    fs.writeFileSync(cookieFile(), '', { mode: 0o600 })
    log('cookie', '已清除本地登录态')
  } catch {
    // 写失败也照常清缓存
  }
  cached = ''
}

export function cookieStatus(): { loggedIn: boolean; source: 'file' | 'none' } {
  const cookie = readCookie()
  const loggedIn = LOGIN_KEYS.some((k) =>
    new RegExp(`(?:^|;\\s*)${k}=`).test(cookie)
  )
  return { loggedIn, source: loggedIn ? 'file' : 'none' }
}
