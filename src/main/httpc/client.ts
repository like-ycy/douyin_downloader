import { readCookie } from '../auth/cookieStore'

/**
 * 网络层说明（重要，实测结论 2026-09-26）：
 * Electron 的 net.fetch 有两个致命坑：
 *   1) redirect: 'manual' 直接抛异常 "Redirect was cancelled"；
 *   2) redirect: 'follow' 时 Response.url 是空字符串，拿不到最终重定向 URL。
 * 短链解析和播放接口探测都依赖这两点，因此主进程网络请求改用 Node 原生 fetch
 * （同样运行在主进程、无 CORS 限制、UA/Cookie 完全可控），不违背"网络请求走主进程"的约束。
 */

/** 桌面 Chrome UA：抓页面 / 详情 API 用（与后续登录窗口 UA 保持一致） */
export const WEB_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 移动端 UA：播放接口探测 / CDN 下载用。缺了会被 302 跳普通网页，拿不到源片。 */
export const MOBILE_UA =
  'com.ss.android.ugc.aweme/220701 (Linux; U; Android 11; en_US; ' +
  'Pixel 5; Build/RQ3A; Cronet/58.0.0.0)'

export interface HttpGetOptions {
  ua: string
  /** 额外请求头（Cookie 自动附带，无需传） */
  headers?: Record<string, string>
  timeoutMs?: number
  redirect?: 'follow' | 'manual' | 'error'
}

/** 统一的 GET：自动带 cookie、可控制 UA 与重定向。所有网络请求一律走主进程。 */
export async function httpGet(
  url: string,
  { ua, headers = {}, timeoutMs = 20000, redirect = 'follow' }: HttpGetOptions
): Promise<Response> {
  return fetch(url, {
    method: 'GET',
    redirect,
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'User-Agent': ua,
      Cookie: readCookie(),
      'Accept-Language': 'zh-CN,zh;q=0.9',
      ...headers,
    },
  })
}
