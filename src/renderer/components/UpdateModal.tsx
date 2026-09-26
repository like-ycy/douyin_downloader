import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { UpdateInfo, UpdateProgress } from '../../shared/types'

type Phase =
  | { kind: 'hidden' }
  | { kind: 'idle'; info: UpdateInfo }
  | { kind: 'downloading' }
  | { kind: 'ready'; info: UpdateInfo }
  | { kind: 'applying' }
  | { kind: 'latest'; info: UpdateInfo } // 手动检查但已是最新（3 秒后自动消失）

function fmtBytes(n: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

/** 右下角更新卡片：检测到新版 -> 下载 -> 重启应用（增量 asar / 全量目录替换）。 */
export function UpdateModal(): ReactElement | null {
  const [phase, setPhase] = useState<Phase>({ kind: 'hidden' })
  const [progress, setProgress] = useState<UpdateProgress>({ downloaded: 0, total: 0, speed: 0 })
  const [useProxy, setUseProxy] = useState(false)
  const [error, setError] = useState('')
  const latestRef = useRef<UpdateInfo | null>(null)

  useEffect(() => {
    // 补拉启动检查结果（防事件早于监听注册）
    void window.api.updateGetPending().then((info) => {
      if (info?.hasUpdate) setPhase({ kind: 'idle', info })
    })
    const unA = window.api.onUpdateAvailable((info) => {
      latestRef.current = info
      setPhase((p) => {
        if (p.kind === 'downloading') return p
        // applying 中收到新 available：asar 增量失败，主进程已补好全量包 → 直接回待确认
        if (p.kind === 'applying') return { kind: 'ready', info }
        return { kind: 'idle', info }
      })
    })
    const unP = window.api.onUpdateProgress((p) => setProgress(p))
    const unD = window.api.onUpdateDone(() => {
      setPhase((p) => (p.kind === 'downloading' && latestRef.current ? { kind: 'ready', info: latestRef.current } : p))
    })
    const unF = window.api.onUpdateFailed((msg) => {
      setError(msg)
      // downloading / applying 中失败都要回到 ready，避免卡死在进度或替换界面
      setPhase((p) =>
        (p.kind === 'downloading' || p.kind === 'applying') && latestRef.current
          ? { kind: 'ready', info: latestRef.current }
          : p
      )
    })
    return () => {
      unA()
      unP()
      unD()
      unF()
    }
  }, [])

  // "已是最新版本"提示 3 秒后自动消失
  useEffect(() => {
    if (phase.kind !== 'latest') return
    const t = setTimeout(() => setPhase({ kind: 'hidden' }), 3000)
    return () => clearTimeout(t)
  }, [phase])

  const handleCheck = useCallback(async (): Promise<void> => {
    setError('')
    const res = await window.api.updateCheck()
    if (!res.ok) {
      setError(res.message)
      return
    }
    if (res.data?.hasUpdate) {
      latestRef.current = res.data
      setPhase({ kind: 'idle', info: res.data })
    } else {
      latestRef.current = null
      setPhase({ kind: 'latest', info: { hasUpdate: false } as UpdateInfo })
    }
  }, [])

  const handleDownload = useCallback(async (): Promise<void> => {
    setError('')
    setProgress({ downloaded: 0, total: 0, speed: 0 })
    setPhase({ kind: 'downloading' })
    const res = await window.api.updateDownload(useProxy)
    if (!res.ok) {
      setError(res.message)
      const info = latestRef.current
      setPhase(info ? { kind: 'idle', info } : { kind: 'hidden' })
    }
  }, [useProxy])

  const handleCancel = useCallback(async (): Promise<void> => {
    await window.api.updateCancelDownload()
  }, [])

  const handleApply = useCallback(async (): Promise<void> => {
    setError('')
    setProgress({ downloaded: 0, total: 0, speed: 0 }) // 清掉上次下载的进度残留
    const res = await window.api.updateApply()
    if (!res.ok) {
      setError(res.message)
      const info = latestRef.current
      setPhase(info ? { kind: 'ready', info } : { kind: 'hidden' })
      return
    }
    setPhase({ kind: 'applying' })
  }, [])

  const handleDismiss = useCallback(async (): Promise<void> => {
    if (phase.kind === 'downloading') await window.api.updateCancelDownload()
    setPhase({ kind: 'hidden' })
  }, [phase])

  if (phase.kind === 'hidden') {
    // 无卡片时保留一个不显眼的手动检查入口
    return (
      <button className="update-entry" onClick={() => void handleCheck()} title="检查更新">
        ↻
      </button>
    )
  }

  if (phase.kind === 'latest') {
    return (
      <div className="update-card">
        <div className="update-title">已是最新版本（{phase.info.currentVersion}）</div>
      </div>
    )
  }

  const info = 'info' in phase ? phase.info : null
  if (!info) return null

  return (
    <div className="update-card">
      <div className="update-head">
        <span className="update-title">发现新版本 {info.latestVersion}</span>
        <button className="update-close" onClick={() => void handleDismiss()} title="关闭">
          ×
        </button>
      </div>
      <div className="update-sub">
        当前 v{info.currentVersion} · {info.updateType === 'asar' ? '增量更新' : '全量更新'}（
        {fmtBytes(info.assetSize)}）
      </div>

      {info.releaseNotes && <div className="update-notes">{info.releaseNotes}</div>}

      {phase.kind === 'idle' && (
        <div className="update-actions">
          {error && <div className="update-error">{error}</div>}
          <label className="update-proxy">
            <input type="checkbox" checked={useProxy} onChange={(e) => setUseProxy(e.target.checked)} />
            下载加速（国内代理）
          </label>
          <div className="update-btns">
            <button className="btn-mini" onClick={() => void handleDismiss()}>
              稍后再说
            </button>
            <button className="btn-dl" onClick={() => void handleDownload()}>
              下载更新
            </button>
          </div>
        </div>
      )}

      {phase.kind === 'downloading' && (
        <div className="update-actions">
          <div className="progress-wrap">
            <div className="progress-bar">
              <div
                className="progress-fill"
                style={{ width: progress.total > 0 ? `${Math.min(100, (progress.downloaded / progress.total) * 100)}%` : '0%' }}
              />
            </div>
            <span className="progress-text">
              {fmtBytes(progress.downloaded)}
              {progress.total > 0 && ` / ${fmtBytes(progress.total)}`} · {fmtBytes(progress.speed)}/s
            </span>
          </div>
          <div className="update-btns">
            <button className="btn-mini" onClick={() => void handleCancel()}>
              取消
            </button>
          </div>
        </div>
      )}

      {(phase.kind === 'ready' || phase.kind === 'applying') && (
        <div className="update-actions">
          {error && <div className="update-error">{error}</div>}
          {phase.kind === 'ready' ? (
            <div className="update-btns">
              <button className="btn-mini" onClick={() => void handleDismiss()}>
                稍后重启
              </button>
              <button className="btn-dl" onClick={() => void handleApply()}>
                重启并更新
              </button>
            </div>
          ) : progress.total > 0 ? (
            // asar 增量失败自动降级：主进程正在补下全量包，进度实时可见
            <div className="progress-wrap">
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{ width: `${Math.min(100, (progress.downloaded / progress.total) * 100)}%` }}
                />
              </div>
              <span className="progress-text">
                {fmtBytes(progress.downloaded)}
                {progress.total > 0 && ` / ${fmtBytes(progress.total)}`} · {fmtBytes(progress.speed)}/s
              </span>
            </div>
          ) : (
            <div className="update-sub">正在替换文件并重启……</div>
          )}
        </div>
      )}
    </div>
  )
}
