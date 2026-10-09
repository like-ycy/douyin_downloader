import { BrowserWindow, session } from 'electron'
import { WEB_UA } from '../httpc/client'
import { readCookie } from '../auth/cookieStore'
import { log } from '../log'
import type { AwemeDetail } from './parse'

/**
 * 浏览器取数（2026-10-09 抖音 Argus 风控后的主取数通道）：
 *
 * 背景：`window._ROUTER_DATA` 已随改版消失，详情 API 纯 HTTP 调用被
 * ArgusSecurityPlugin 拦截（403 Uifid Not Found / Signature Not Found）。
 * 签名必须由页面运行时 JS 生成，伪造不出来。
 *
 * 思路：开一个隐藏 BrowserWindow 加载视频页，抖音页面自己会发出带合法
 * 签名的 aweme/detail 请求；用 webContents.debugger 的 Network 域把
 * 这个响应体捡回来。全程不改页面、不伪造签名，与 CLI 的浏览器降级
 * 同一条路（真实浏览器里已验证 200 / len≈86KB）。
 *
 * 实现要点：
 * - 非持久 partition（不带 persist: 前缀），每次现场注入 cookieStore 里的
 *   登录 cookie，窗口销毁即释放，杜绝残留 cookie 造成"假登录"。
 * - 用 CDP Network 域监听而不是 executeJavaScript 注入 XHR hook：
 *   注入时机赶不上页面最早期的 XHR，CDP 从 attach 起全量记录，无时序问题。
 * - UA 用桌面 Chrome（与登录窗口一致），页面才会走桌面版播放器并发 detail 请求。
 */

const PARTITION = 'douyin-detail'
const DETAIL_URL_RE = /aweme\/v1\/web\/aweme\/detail\//
const PAGE_TIMEOUT_MS = 30_000

let inflight: Promise<AwemeDetail> | null = null

/** 隐藏浏览器加载视频页，捡页面自带签名的 aweme/detail 响应。同一时刻只允许一个在跑。 */
export function fetchDetailViaBrowser(awemeId: string): Promise<AwemeDetail> {
  if (inflight) return inflight
  inflight = run(awemeId).finally(() => {
    inflight = null
  })
  return inflight
}

async function run(awemeId: string): Promise<AwemeDetail> {
  const win = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  const ses = session.fromPartition(PARTITION) // 非持久：App 重启即清空
  ses.setUserAgent(WEB_UA)
  await injectCookies(ses)

  const wc = win.webContents
  const dbg = wc.debugger
  let dbgAttached = false
  try {
    dbg.attach('1.3')
    dbgAttached = true
    dbg.sendCommand('Network.enable')
  } catch (e) {
    win.destroy()
    throw new Error(`调试器附加失败: ${(e as Error).message}`)
  }

  return new Promise<AwemeDetail>((resolve, reject) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    /** 已见到响应的 detail 请求：requestId -> http status（可能多次重试，取最后一个） */
    const seen = new Map<string, number>()

    const cleanup = (): void => {
      if (timer) clearTimeout(timer)
      wc.removeListener('did-fail-load', onFailLoad)
      if (dbgAttached) {
        try {
          dbg.removeAllListeners('message')
          dbg.detach()
        } catch {
          // 已分离就忽略
        }
      }
      if (!win.isDestroyed()) win.destroy()
    }

    const finish = (err: Error | null, data?: AwemeDetail): void => {
      if (settled) return
      settled = true
      cleanup()
      if (err) reject(err)
      else resolve(data as AwemeDetail)
    }

    const diagnoseTimeout = (): Error => {
      const statuses = [...seen.values()]
      const last = statuses[statuses.length - 1] ?? 0
      if (last === 403) {
        return new Error(
          '页面发出的 detail 请求被风控拦截（status=403）。' +
            'cookie 可能过期或被标记，请退出登录后重新扫码。'
        )
      }
      if (statuses.length > 0) {
        return new Error(`detail 请求未成功完成（status=${last}），请稍后重试。`)
      }
      return new Error(
        '页面加载后未发出 aweme/detail 请求（可能被风控页顶替或页面结构又变了）。'
      )
    }

    const onMessage = (_e: unknown, method: string, params: any): void => {
      if (method === 'Network.responseReceived') {
        const url: string = params?.response?.url ?? ''
        if (DETAIL_URL_RE.test(url)) {
          const reqId: string = params.requestId
          seen.set(reqId, Number(params.response?.status ?? 0))
        }
      } else if (method === 'Network.loadingFinished') {
        const reqId: string = params?.requestId
        if (reqId && seen.has(reqId)) {
          void dbg
            .sendCommand('Network.getResponseBody', { requestId: reqId })
            .then((r: any) => {
              const raw: string = r?.base64Encoded
                ? Buffer.from(r.body ?? '', 'base64').toString('utf-8')
                : (r?.body ?? '')
              const j = JSON.parse(raw)
              const item = j?.aweme_detail ?? null
              if (item && item.aweme_id) {
                log(
                  'detail-browser',
                  `捕获 aweme/detail（status=${seen.get(reqId)}，` +
                    `作者=${item.author?.nickname ?? '?'}，desc=${String(item.desc ?? '').slice(0, 30)}）`
                )
                finish(null, item)
              }
              // 没有 aweme_detail 就继续等（可能是风控壳响应，后面还有重试）
            })
            .catch((e) => {
              // 单次读体失败不终止：保留等待/超时诊断兜底
              log('detail-browser', `读响应体失败: ${(e as Error).message}`)
            })
        }
      } else if (method === 'Network.loadingFailed') {
        const reqId: string = params?.requestId
        if (reqId && seen.has(reqId)) {
          const errText: string = params?.errorText ?? ''
          if (errText === 'net::ERR_ABORTED') {
            // 页面主动取消后通常会立刻重试，不当失败处理
            seen.delete(reqId)
          } else {
            finish(new Error(`页面 detail 请求失败（${errText}）`))
          }
        }
      }
    }
    dbg.on('message', onMessage)

    const onFailLoad = (
      _e: unknown,
      code: number,
      desc: string,
      _url: string,
      isMainFrame: boolean
    ): void => {
      if (isMainFrame) finish(new Error(`视频页加载失败 code=${code} ${desc}`))
    }
    wc.on('did-fail-load', onFailLoad)

    timer = setTimeout(() => finish(diagnoseTimeout()), PAGE_TIMEOUT_MS)

    log('detail-browser', `隐藏窗口打开视频页: https://www.douyin.com/video/${awemeId}`)
    void wc.loadURL(`https://www.douyin.com/video/${awemeId}`)
  })
}

/** 把 cookieStore 里的登录 cookie 现场注入 session（'name=value; ...' 格式）。 */
async function injectCookies(ses: Electron.Session): Promise<void> {
  const raw = readCookie()
  if (!raw) {
    log('detail-browser', '无登录 cookie，匿名加载页面（未登录可能拿不到完整数据）')
    return
  }
  const pairs = raw
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
  let ok = 0
  for (const p of pairs) {
    const i = p.indexOf('=')
    if (i <= 0) continue
    const name = p.slice(0, i)
    const value = p.slice(i + 1)
    try {
      await ses.cookies.set({
        url: 'https://www.douyin.com/',
        name,
        value,
        domain: '.douyin.com',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'no_restriction',
      })
      ok++
    } catch {
      // 个别 cookie 注入失败不阻塞整体
    }
  }
  log('detail-browser', `注入 cookie ${ok}/${pairs.length}`)
}
