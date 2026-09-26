import { httpGet, WEB_UA } from '../httpc/client'

export interface ResolveResult {
  awemeId: string | null
  finalUrl: string
}

/** 跟随短链重定向，从最终 URL 里抠出 aweme_id。 */
export async function resolveAwemeId(link: string): Promise<ResolveResult> {
  let finalUrl = link
  try {
    const res = await httpGet(link, { ua: WEB_UA, timeoutMs: 15000 })
    finalUrl = res.url
  } catch {
    // 网络异常时用原链接继续尝试匹配
  }
  const m =
    finalUrl.match(/\/(?:video|note)\/(\d+)/) ?? finalUrl.match(/aweme_id=(\d+)/)
  return { awemeId: m ? m[1] : null, finalUrl }
}
