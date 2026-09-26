import { httpGet, WEB_UA } from '../httpc/client'

/* eslint-disable @typescript-eslint/no-explicit-any */

export type AwemeDetail = Record<string, any>

/** 1:1 移植 python/inspect_qualities.py 的 extract_router_data：
 *  抖音内嵌数据有三种形态，全部失败返回 null。 */
export function extractRouterData(html: string): AwemeDetail | null {
  // 形态 1）对象字面量: window._ROUTER_DATA = {...};
  for (const pat of [
    /window\._ROUTER_DATA\s*=\s*(\{.*?\})\s*<\/script>/s,
    /window\._ROUTER_DATA\s*=\s*(\{.*?\})\s*;/s,
  ]) {
    const m = html.match(pat)
    if (m) {
      try {
        return JSON.parse(m[1])
      } catch {
        // 尝试下一种形态
      }
    }
  }
  // 形态 2）JSON.parse("...")：参数是「一段 JSON 文本的字符串」，双重解析
  for (const q of ['"', "'"]) {
    const esc = q === '"' ? /(?:\\.|[^"\\])*/ : /(?:\\.|[^'\\])*/
    const pat = new RegExp(
      `window\\._ROUTER_DATA\\s*=\\s*JSON\\.parse\\(\\s*${q}(${esc.source})${q}\\s*\\)`,
      's'
    )
    const m = html.match(pat)
    if (m) {
      try {
        const inner = JSON.parse(q + m[1] + q) // 还原 JS 字符串转义 -> JSON 文本
        return JSON.parse(inner) // 再解析 JSON 文本 -> 对象
      } catch {
        // 尝试下一种引号
      }
    }
  }
  // 形态 3）RENDER_DATA（URL-encoded JSON，放在 <script> 标签里）
  const m = html.match(
    /<script[^>]*id=["']RENDER_DATA["'][^>]*>(.*?)<\/script>/s
  )
  if (m) {
    try {
      return JSON.parse(decodeURIComponent(m[1]))
    } catch {
      // 全部形态失败
    }
  }
  return null
}

/** 解析失败时给出可读诊断（对应 Python 的 diagnose_page）。 */
function diagnosePage(html: string, status: number): string {
  const hints: string[] = []
  const lower = html.toLowerCase()
  for (const kw of [
    '验证', 'verify', 'slider', '滑块', '登录', 'login',
    'captcha', '访问过于频繁', '网络异常', '未能', 'unauthorized',
  ]) {
    if (lower.includes(kw.toLowerCase())) hints.push(kw)
  }
  let msg = `页面已返回（status=${status}, 长度=${html.length}）但解析不出视频数据。`
  msg += hints.length
    ? ` 页面疑似含风控/登录关键词: ${hints.join(', ')}。`
    : ' 页面无风控关键词，可能是网站结构变了。'
  return msg
}

export interface FetchRouterResult {
  data: AwemeDetail | null
  error: string | null
}

/** 抓取抖音视频页 HTML，解析内嵌的 window._ROUTER_DATA。 */
export async function fetchRouterData(awemeId: string): Promise<FetchRouterResult> {
  const url = `https://www.douyin.com/video/${awemeId}/`
  try {
    const res = await httpGet(url, {
      ua: WEB_UA,
      headers: { Referer: 'https://www.douyin.com/' },
    })
    if (res.status !== 200) {
      return { data: null, error: `视频页请求失败 status=${res.status}` }
    }
    const html = await res.text()
    const data = extractRouterData(html)
    if (data) return { data, error: null }
    return { data: null, error: diagnosePage(html, res.status) }
  } catch (e) {
    return { data: null, error: `视频页请求异常: ${(e as Error).message}` }
  }
}

/** 兜底：直接用网页版详情 API 取 aweme_detail。 */
export async function fetchDetailApi(awemeId: string): Promise<AwemeDetail | null> {
  const url =
    'https://www.douyin.com/aweme/v1/web/aweme/detail/' +
    `?aweme_id=${awemeId}&aid=6383&version_code=270100&device_platform=web`
  try {
    const res = await httpGet(url, {
      ua: WEB_UA,
      headers: {
        Referer: 'https://www.douyin.com/',
        Accept: 'application/json',
      },
    })
    if (res.status !== 200) return null
    const j = await res.json()
    if (j.status_code === 0 && j.aweme_detail) return j.aweme_detail
    return null
  } catch {
    return null
  }
}

/** 在嵌套的 ROUTER_DATA 里递归找同时含 aweme_id 和 video 的节点。 */
export function findAwemeDetail(data: unknown): AwemeDetail | null {
  let found: AwemeDetail | null = null

  const rec = (o: unknown): void => {
    if (found) return
    if (Array.isArray(o)) {
      for (const v of o) rec(v)
    } else if (o && typeof o === 'object') {
      const obj = o as AwemeDetail
      if ('aweme_id' in obj && 'video' in obj) {
        found = obj
        return
      }
      for (const v of Object.values(obj)) rec(v)
    }
  }
  rec(data)
  return found
}
