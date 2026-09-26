import { httpGet, MOBILE_UA } from '../httpc/client'
import type { Quality } from '../../shared/types'

/* eslint-disable @typescript-eslint/no-explicit-any */

interface ProbeResult {
  direct: boolean
  url?: string
  width?: number
  height?: number
  dataSize?: number
}

/** 用移动端播放接口探测某个 ratio 的画质。
 *  ratio=default 即源片；必须带移动端 UA，否则被 302 跳到普通网页。 */
export async function probePlay(
  uri: string,
  ratio: string
): Promise<ProbeResult | null> {
  const url =
    `https://aweme.snssdk.com/aweme/v1/play/?video_id=${encodeURIComponent(uri)}` +
    `&ratio=${ratio}&line=0&aid=6383`
  try {
    const res = await httpGet(url, { ua: MOBILE_UA, redirect: 'manual' })
    // 期望拿到 302 的 Location（源片直链）
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location')
      if (loc) return { direct: true, url: loc }
    }
    if (res.status === 200) {
      const j: any = await res.json().catch(() => null)
      if (j && j.status_code === 0 && j.play_addr) {
        const pa = j.play_addr
        const list: string[] = pa.url_list ?? []
        return {
          direct: false,
          width: pa.width,
          height: pa.height,
          dataSize: pa.data_size,
          url: list[0],
        }
      }
    }
  } catch {
    // manual 模式失败则走 follow 兜底
  }
  // 兜底：跟随重定向，最终 URL 即签名直链（不读 body，只取 res.url）
  try {
    const res2 = await httpGet(url, { ua: MOBILE_UA })
    if (res2.url && res2.url !== url && res2.url.includes('douyinvod')) {
      return { direct: true, url: res2.url }
    }
  } catch {
    // 兜底也失败，返回 null
  }
  return null
}

/** 对已签名 CDN 直链发 Range: bytes=0-0，只读响应头取真实总大小。 */
export async function measureSize(url: string): Promise<number> {
  if (!url) return 0
  try {
    const res = await httpGet(url, {
      ua: MOBILE_UA,
      headers: {
        Range: 'bytes=0-0',
        Referer: 'https://www.douyin.com/',
      },
    })
    // 优先 Content-Range（Range 请求时），其次 Content-Length
    const cr = res.headers.get('content-range')
    if (cr && cr.includes('/')) {
      const n = parseInt(cr.slice(cr.lastIndexOf('/') + 1), 10)
      if (Number.isFinite(n)) return n
    }
    const cl = res.headers.get('content-length')
    if (cl) {
      const n = parseInt(cl, 10)
      if (Number.isFinite(n)) return n
    }
    return 0
  } catch {
    return 0
  }
}

const RATIOS = ['default', '1080p', '2k', '4k', '720p', '540p', '360p']

/** 并发探测全部档位 + 实测体积，产出排序后的画质表。
 *  default 置顶（标注源片），其余按分辨率/体积从高到低。 */
export async function probeQualities(
  playUri: string
): Promise<Quality[]> {
  const qualities = await Promise.all(
    RATIOS.map(async (ratio): Promise<Quality | null> => {
      const r = await probePlay(playUri, ratio)
      if (!r || !r.url) return null
      const size = await measureSize(r.url)
      return {
        ratio,
        width: r.width ?? 0,
        height: r.height ?? 0,
        size,
        url: r.url,
      }
    })
  )
  return qualities
    .filter((q): q is Quality => q !== null)
    .sort((a, b) => {
      if (a.ratio === 'default') return -1
      if (b.ratio === 'default') return 1
      const pa = a.width * a.height || a.size
      const pb = b.width * b.height || b.size
      return pb - pa
    })
}
