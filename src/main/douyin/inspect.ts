import type { VideoInfo } from '../../shared/types'
import { resolveAwemeId } from './resolve'
import {
  fetchRouterData,
  fetchDetailApi,
  findAwemeDetail,
  type AwemeDetail,
} from './parse'
import { probeQualities } from './probe'
import { fetchDetailViaBrowser } from './detailBrowser'
import { log } from '../log'

/* eslint-disable @typescript-eslint/no-explicit-any */

function toVideoInfo(item: AwemeDetail, qualities: VideoInfo['qualities']): VideoInfo {
  const video = (item.video ?? {}) as any
  const stats = (item.statistics ?? {}) as any
  const music = (item.music ?? {}) as any
  const coverUrls: string[] = [
    ...(video.cover?.url_list ?? []),
    ...(video.origin_cover?.url_list ?? []),
  ]
  const musicTitle: string = music.title ?? ''
  const musicAuthor: string = music.owner_nickname ?? music.author ?? ''
  return {
    awemeId: String(item.aweme_id ?? ''),
    author: item.author?.nickname ?? '?',
    desc: item.desc ?? '',
    durationMs: Number(video.duration ?? 0),
    cover: coverUrls[0] ?? '',
    createdAt: Number(item.create_time ?? 0) * 1000,
    stats: {
      digg: Number(stats.digg_count ?? 0),
      comment: Number(stats.comment_count ?? 0),
      share: Number(stats.share_count ?? 0),
      collect: Number(stats.collect_count ?? 0),
      play: Number(stats.play_count ?? 0),
    },
    music: [musicTitle, musicAuthor].filter(Boolean).join(' - '),
    qualities,
  }
}

/** 完整解析链路：链接 -> aweme_id -> 详情（页面正则 -> 隐藏浏览器 -> 详情 API）-> 画质探测。 */
export async function inspectVideo(link: string): Promise<VideoInfo> {
  // 1) 解析 aweme_id
  const { awemeId, finalUrl } = await resolveAwemeId(link)
  if (!awemeId) {
    throw new Error(`没能从链接里解析出 aweme_id（最终 URL: ${finalUrl}），请确认是有效的抖音视频链接。`)
  }

  // 2) 取视频详情。三级链路（2026-10-09 Argus 风控后）：
  //    a. 页面内嵌 _ROUTER_DATA（改版后已死，但保留——成本仅一次 HTTP，万一恢复可秒回）
  //    b. 隐藏浏览器捡页面自带签名的 aweme/detail（现行主通道，见 detailBrowser.ts）
  //    c. 详情 API 裸 HTTP（Argus 后基本 403，仅作最后兜底）
  let item: AwemeDetail | null = null
  let pageError: string | null = null
  const router = await fetchRouterData(awemeId)
  if (router.data) {
    item = findAwemeDetail(router.data)
  }
  if (!item) {
    pageError = router.error
    try {
      item = await fetchDetailViaBrowser(awemeId)
    } catch (e) {
      pageError = `浏览器取数失败: ${(e as Error).message}`
      log('inspect', pageError)
    }
  }
  if (!item) {
    item = await fetchDetailApi(awemeId)
  }
  if (!item) {
    const hint = pageError ? `（${pageError}）` : ''
    throw new Error(
      `无法获取视频数据${hint}。建议：若提示风控/403，退出登录后重新扫码；确认链接有效、内容未下架。`
    )
  }

  // 3) 画质探测
  const playUri: string | undefined = item.video?.play_addr?.uri
  if (!playUri) {
    throw new Error('没拿到 play_addr.uri，无法探测播放接口。')
  }
  const qualities = await probeQualities(playUri)

  return toVideoInfo(item, qualities)
}
