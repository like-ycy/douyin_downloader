import { WebContentsView, session, shell } from 'electron'
import { WEB_UA } from '../httpc/client'
import { writeCookie } from './cookieStore'
import { loadConfig } from '../config'
import { emit } from '../emit'
import { log } from '../log'
import { getMainWindow } from '../windows'

/**
 * 内嵌登录视图（用户决策：不再开独立窗口）：
 * - 用 WebContentsView 盖在主窗口解析页上方，顶部预留 topbar（保留「取消」按钮）
 * - 非持久 partition（不带 persist: 前缀）→ 内存 session，重启即清空，杜绝"假登录"
 * - UA 覆盖为正常 Chrome，去掉 Electron 标识
 * - 导航白名单：douyin 系域名留在视图内，其余交系统浏览器
 * - 每 2s 轮询 cookie，只认 sessionid 系字段（ttwid/odin_tt 是设备标识，不是登录标志）
 * - 命中 → 写 ~/.douyin_downloader/cookie.txt(0600) → auth:success → 移除视图，自动退回解析页
 */
const LOGIN_KEYS = ['sessionid', 'sessionid_ss', 'sid_tt', 'sid_guard']
const PARTITION = 'douyin-login'
const POLL_MS = 2000
/** 顶栏高度：登录视图从这行以下开始铺，顶栏保留标题 + 取消按钮 */
const TOPBAR_RESERVED = 52

const DOUYIN_DOMAIN_RE =
  /^https:\/\/([a-z0-9-]+\.)*(douyin|amemv|snssdk|iesdouyin|zjcdn|douyinpic|byteoversea)\.(com|cn)/

let view: WebContentsView | null = null
let timer: ReturnType<typeof setInterval> | null = null
let startedAt = 0

export function openLoginView(): void {
  if (view) return
  const host = getMainWindow()
  if (!host) return
  startedAt = Date.now()

  const ses = session.fromPartition(PARTITION) // 非持久：App 重启即清空
  ses.setUserAgent(WEB_UA)

  view = new WebContentsView({
    webPreferences: {
      session: ses,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  host.contentView.addChildView(view)
  updateBounds()
  host.on('resize', updateBounds)

  const wc = view.webContents
  wc.on('will-navigate', (e, url) => {
    if (!DOUYIN_DOMAIN_RE.test(url)) {
      log('login', `非白名单跳转，交系统浏览器: ${url}`)
      e.preventDefault()
      shell.openExternal(url).catch(() => {})
    }
  })
  wc.on('did-finish-load', bestEffortClickLogin)
  wc.on('did-fail-load', (_e, code, desc, url) =>
    log('login', `加载失败 code=${code} ${desc} ${url}`)
  )

  void wc.loadURL('https://www.douyin.com/')
  log('login', '内嵌登录视图已打开 https://www.douyin.com/')
  timer = setInterval(() => void poll(), POLL_MS)
}

export function cancelLogin(): void {
  if (view) finish(false, '用户取消')
}

function updateBounds(): void {
  const host = getMainWindow()
  if (!view || !host) return
  const { width, height } = host.getContentBounds()
  view.setBounds({
    x: 0,
    y: TOPBAR_RESERVED,
    width,
    height: Math.max(0, height - TOPBAR_RESERVED),
  })
}

function detach(): void {
  const host = getMainWindow()
  if (host && view) {
    host.contentView.removeChildView(view)
    host.removeListener('resize', updateBounds)
  }
  if (view) {
    view.webContents.close() // 销毁视图，非持久 session 随之释放
    view = null
  }
  stopPoll()
}

function stopPoll(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

/** 最佳努力点击「登录 / 扫码登录」，失败不阻塞（用户可手动点）。 */
function bestEffortClickLogin(): void {
  if (!view) return
  setTimeout(() => {
    const js = `(function(){
      var els = Array.prototype.slice.call(document.querySelectorAll('button, div[role="button"], a, span, p'))
      var el = els.find(function(e){
        var t = (e.textContent || '').trim()
        return (t === '扫码登录' || t === '登录') && e.offsetParent !== null
      })
      if (el) { el.click(); return 'clicked: ' + (el.textContent || '').trim() }
      return 'not-found'
    })()`
    view?.webContents
      .executeJavaScript(js, true)
      .then((r) => log('login', `best-effort 点击: ${r}`))
      .catch(() => {})
  }, 1500)
}

async function poll(): Promise<void> {
  if (!view) return
  const timeoutSec = loadConfig().loginTimeoutSec
  const elapsed = (Date.now() - startedAt) / 1000
  if (elapsed > timeoutSec) {
    finish(false, `超时（${timeoutSec}s）未检测到登录态`)
    return
  }
  try {
    const cookies = await session.fromPartition(PARTITION).cookies.get({})
    emit('auth:waiting', { elapsed: Math.round(elapsed) })
    const hits = cookies.filter((c) => LOGIN_KEYS.includes(c.name))
    if (hits.length > 0) {
      const names = hits.map((c) => `${c.name}(httpOnly=${c.httpOnly})`).join(', ')
      log('login', `命中登录字段: ${names}`)
      writeCookie(cookies.map((c) => `${c.name}=${c.value}`).join('; '))
      finish(true, `捕获 ${cookies.length} 个 cookie`)
    }
  } catch (e) {
    log('login', `轮询异常: ${(e as Error).message}`)
  }
}

function finish(success: boolean, message: string): void {
  detach()
  if (success) {
    log('login', `登录成功: ${message}`)
    emit('auth:success', { message })
  } else {
    log('login', `登录结束: ${message}`)
    emit('auth:failed', { reason: message })
  }
}
