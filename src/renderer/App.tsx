import { useCallback, useEffect, useRef, useState } from 'react'
import type { VideoInfo, DownloadProgress, DownloadDone, DownloadError } from '../shared/types'
import { SearchBar } from './components/SearchBar'
import { VideoCard } from './components/VideoCard'
import { QualityTable } from './components/QualityTable'
import { LoginPanel } from './components/LoginPanel'
import { ThemeToggle } from './components/ThemeToggle'
import { useTheme } from './hooks/useTheme'

export type DownloadState =
  | { status: 'downloading'; downloaded: number; total: number; speed: number }
  | { status: 'done'; path: string }
  | { status: 'error'; message: string }

export default function App() {
  const { preference: themePreference, themeLabel, toggleTheme } = useTheme()
  const [info, setInfo] = useState<VideoInfo | null>(null)
  const [lastLink, setLastLink] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [loggedIn, setLoggedIn] = useState(false)
  const [loginWaiting, setLoginWaiting] = useState<number | null>(null)
  const [downloadDir, setDownloadDir] = useState('')
  const [downloads, setDownloads] = useState<Record<string, DownloadState>>({})
  // taskId -> ratio（事件回填时定位对应行）
  const taskRatio = useRef<Record<string, string>>({})

  const refreshAuth = useCallback((): void => {
    window.api.authStatus().then((a) => setLoggedIn(a.loggedIn)).catch(() => {})
  }, [])

  useEffect(() => {
    refreshAuth()
    window.api.configGet().then((c) => setDownloadDir(c.downloadDir)).catch(() => {})
  }, [refreshAuth])

  useEffect(() => {
    const unW = window.api.onAuthWaiting((p) => setLoginWaiting(p.elapsed))
    const unS = window.api.onAuthSuccess(() => {
      setLoginWaiting(null)
      refreshAuth()
    })
    const unF = window.api.onAuthFailed((p) => {
      setLoginWaiting(null)
      setError(`登录未完成：${p.reason}`)
    })
    return () => { unW(); unS(); unF() }
  }, [refreshAuth])

  useEffect(() => {
    const unP = window.api.onDownloadProgress((p: DownloadProgress) => {
      const ratio = taskRatio.current[p.taskId]
      if (!ratio) return
      setDownloads((d) => ({
        ...d,
        [ratio]: { status: 'downloading', downloaded: p.downloaded, total: p.total, speed: p.speed },
      }))
    })
    const unD = window.api.onDownloadDone((p: DownloadDone) => {
      const ratio = taskRatio.current[p.taskId]
      if (!ratio) return
      setDownloads((d) => ({ ...d, [ratio]: { status: 'done', path: p.path } }))
    })
    const unE = window.api.onDownloadError((p: DownloadError) => {
      const ratio = taskRatio.current[p.taskId]
      if (!ratio) return
      setDownloads((d) => ({ ...d, [ratio]: { status: 'error', message: p.message } }))
    })
    return () => { unP(); unD(); unE() }
  }, [])

  const handleLogin = useCallback((): void => {
    setError('')
    void window.api.login()
  }, [])

  const handleCancelLogin = useCallback((): void => {
    void window.api.cancelLogin()
  }, [])

  const handleLogout = useCallback((): void => {
    void window.api.logout().then(() => refreshAuth())
  }, [refreshAuth])

  const handleInspect = useCallback(async (link: string): Promise<void> => {
    setLoading(true)
    setError('')
    setInfo(null)
    setDownloads({})
    setLastLink(link)
    try {
      const res = await window.api.inspect(link)
      if (res.ok) setInfo(res.data)
      else setError(res.message)
    } finally {
      setLoading(false)
    }
  }, [])

  const handleDownload = useCallback(async (ratio: string): Promise<void> => {
    if (!lastLink || !downloadDir) return
    const res = await window.api.downloadStart({ link: lastLink, ratio, dir: downloadDir })
    if (res.ok) {
      taskRatio.current[res.data] = ratio
      setDownloads((d) => ({ ...d, [ratio]: { status: 'downloading', downloaded: 0, total: 0, speed: 0 } }))
    } else {
      setError(res.message)
    }
  }, [lastLink, downloadDir])

  const handleCancel = useCallback(async (ratio: string): Promise<void> => {
    const taskId = Object.entries(taskRatio.current).find(([, r]) => r === ratio)?.[0]
    if (taskId) await window.api.downloadCancel(taskId)
  }, [])

  const handleChangeDir = useCallback(async (): Promise<void> => {
    const dir = await window.api.selectDir()
    if (dir) {
      setDownloadDir(dir)
      await window.api.configSet({ downloadDir: dir })
    }
  }, [])

  const handleShowInFolder = useCallback((p: string): void => {
    void window.api.showItemInFolder(p)
  }, [])

  return (
    <div className="app">
      <header className="topbar">
        <span className="title">抖音下载器</span>
        <div className="topbar-right">
          <ThemeToggle preference={themePreference} label={themeLabel} onToggle={toggleTheme} />
          <LoginPanel
            loggedIn={loggedIn}
            waiting={loginWaiting}
            onLogin={handleLogin}
            onCancelLogin={handleCancelLogin}
            onLogout={handleLogout}
          />
        </div>
      </header>

      <SearchBar disabled={loading} onSubmit={handleInspect} />

      {loading && (
        <div className="loading">
          <div className="spinner" />
          <span>解析中……（抓页面 → 兜底详情 API → 画质探测）</span>
        </div>
      )}

      {error && <div className="error">✗ {error}</div>}

      {info && (
        <div className="result">
          <VideoCard info={info} />
          <div className="dirbar">
            <span className="dir-label">保存到：{downloadDir || '（未设置）'}</span>
            <button className="btn-mini" onClick={handleChangeDir}>更改目录</button>
          </div>
          <QualityTable
            info={info}
            downloads={downloads}
            onDownload={handleDownload}
            onCancel={handleCancel}
            onShowInFolder={handleShowInFolder}
          />
        </div>
      )}

      {!info && !loading && !error && (
        <div className="empty">粘贴一个抖音视频链接开始解析（支持短链 / 完整页 / 分享口令链接）</div>
      )}
    </div>
  )
}
