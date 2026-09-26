import type { VideoInfo } from '../../shared/types'
import { resolveAwemeId } from './resolve'
import {
  fetchRouterData,
  fetchDetailApi,
  findAwemeDetail,
  type AwemeDetail,
} from './parse'
import { probeQualities } from './probe'

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

/** 完整解析链路：链接 -> aweme_id -> 详情（页面正则优先，详情 API 兜底）-> 画质探测。 */
export async function inspectVideo(link: string): Promise<VideoInfo> {
  // 1) 解析 aweme_id
  const { awemeId, finalUrl } = await resolveAwemeId(link)
  if (!awemeId) {
    throw new Error(`没能从链接里解析出 aweme_id（最终 URL: ${finalUrl}），请确认是有效的抖音视频链接。`)
  }

  // 2) 取 ROUTER_DATA，失败则详情 API 兜底
  let item: AwemeDetail | null = null
  let pageError: string | null = null
  const router = await fetchRouterData(awemeId)
  if (router.data) {
    item = findAwemeDetail(router.data)
  }
  if (!item) {
    pageError = router.error
    item = await fetchDetailApi(awemeId)
  }
  if (!item) {
    const hint = pageError ? `（页面解析失败: ${pageError}）` : ''
    throw new Error(`无法获取视频数据${hint}。建议：确认链接有效、内容未下架，必要时重新抓取登录 Cookie。`)
  }

  // 3) 画质探测
  const playUri: string | undefined = item.video?.play_addr?.uri
  if (!playUri) {
    throw new Error('没拿到 play_addr.uri，无法探测播放接口。')
  }
  const qualities = await probeQualities(playUri)

  return toVideoInfo(item, qualities)
}
