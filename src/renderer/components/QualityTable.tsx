import type { VideoInfo } from '../../shared/types'
import type { DownloadState } from '../App'

function humanSize(n: number): string {
  if (!n) return '?'
  let v = n
  for (const unit of ['B', 'KB', 'MB', 'GB']) {
    if (v < 1024) return `${v.toFixed(1)}${unit}`
    v /= 1024
  }
  return `${v.toFixed(1)}TB`
}

interface Props {
  info: VideoInfo
  downloads: Record<string, DownloadState>
  onDownload: (ratio: string) => void
  onCancel: (ratio: string) => void
  onShowInFolder: (path: string) => void
}

export function QualityTable({ info, downloads, onDownload, onCancel, onShowInFolder }: Props) {
  if (info.qualities.length === 0) {
    return <div className="error">未能探测到任何可下载画质（可能被签名/风控拦截）。</div>
  }
  return (
    <table className="quality">
      <thead>
        <tr>
          <th>档位</th>
          <th>分辨率</th>
          <th>实测大小</th>
          <th className="col-action">操作</th>
        </tr>
      </thead>
      <tbody>
        {info.qualities.map((q) => {
          const dl = downloads[q.ratio]
          return (
            <tr key={q.ratio}>
              <td>
                <span className={`ratio ${q.ratio === 'default' ? 'ratio-best' : ''}`}>
                  {q.ratio}
                </span>
                {q.ratio === 'default' && <span className="note">（源片）</span>}
              </td>
              <td>{q.width && q.height ? `${q.width}×${q.height}` : '直链'}</td>
              <td>{humanSize(q.size)}</td>
              <td className="col-action">
                {!dl && (
                  <button className="btn-dl" onClick={() => onDownload(q.ratio)}>
                    下载
                  </button>
                )}
                {dl?.status === 'downloading' && (
                  <div className="progress-wrap">
                    <div className="progress-bar">
                      <div
                        className="progress-fill"
                        style={{
                          width: dl.total
                            ? `${Math.min(100, (dl.downloaded / dl.total) * 100).toFixed(1)}%`
                            : '10%',
                        }}
                      />
                    </div>
                    <div className="progress-text">
                      {dl.total
                        ? `${humanSize(dl.downloaded)} / ${humanSize(dl.total)}  ${(100 * dl.downloaded / dl.total).toFixed(0)}%  ${humanSize(dl.speed)}/s`
                        : `${humanSize(dl.downloaded)}  ${humanSize(dl.speed)}/s`}
                    </div>
                    <button className="btn-mini" onClick={() => onCancel(q.ratio)}>
                      取消
                    </button>
                  </div>
                )}
                {dl?.status === 'done' && (
                  <div className="done-wrap">
                    <span className="done-text">✓ 已完成</span>
                    <button className="btn-mini" onClick={() => onShowInFolder(dl.path)}>
                      打开文件夹
                    </button>
                  </div>
                )}
                {dl?.status === 'error' && (
                  <div className="err-wrap">
                    <span className="err-text" title={dl.message}>✗ {dl.message}</span>
                    <button className="btn-mini" onClick={() => onDownload(q.ratio)}>
                      重试
                    </button>
                  </div>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
