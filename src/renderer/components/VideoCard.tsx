import type { VideoInfo } from '../../shared/types'

function formatDuration(ms: number): string {
  if (!ms) return '-'
  const s = ms > 1000 ? Math.round(ms / 1000) : Math.round(ms)
  const m = Math.floor(s / 60)
  const r = s % 60
  return m > 0 ? `${m}分${r}秒` : `${r}秒`
}

function formatDate(ts: number): string {
  if (!ts) return '-'
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

function formatCount(n: number): string {
  if (n >= 10000) return `${(n / 10000).toFixed(1)}w`
  return String(n)
}

interface Props {
  info: VideoInfo
}

export function VideoCard({ info }: Props) {
  return (
    <div className="videocard">
      {info.cover && <img className="cover" src={info.cover} alt="封面" />}
      <div className="meta">
        <div className="author">{info.author}</div>
        <div className="desc" title={info.desc}>
          {info.desc || '（无标题）'}
        </div>
        <div className="sub">
          时长 {formatDuration(info.durationMs)} ｜ 发布 {formatDate(info.createdAt)}
        </div>
        <div className="stats">
          <span>赞 {formatCount(info.stats.digg)}</span>
          <span>评论 {formatCount(info.stats.comment)}</span>
          <span>分享 {formatCount(info.stats.share)}</span>
          <span>收藏 {formatCount(info.stats.collect)}</span>
          {info.stats.play > 0 && <span>播放 {formatCount(info.stats.play)}</span>}
        </div>
        {info.music && <div className="music">♪ {info.music}</div>}
      </div>
    </div>
  )
}
