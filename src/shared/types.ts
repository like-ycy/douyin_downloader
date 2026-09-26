// 主进程与渲染进程共享的类型定义

export interface Quality {
  /** 360p / 720p / default ...，default 为源片（最高画质） */
  ratio: string
  width: number
  height: number
  /** 实测字节数，0 表示未测到 */
  size: number
  /** 已签名 CDN 直链（有时效，勿跨会话缓存） */
  url: string
}

export interface VideoInfo {
  awemeId: string
  author: string
  desc: string
  durationMs: number
  cover: string
  /** 发布时间（毫秒时间戳，0 表示未知） */
  createdAt: number
  stats: {
    digg: number
    comment: number
    share: number
    collect: number
    play: number
  }
  music: string
  /** 按画质从高到低排列，default 置顶 */
  qualities: Quality[]
}

export interface AuthStatus {
  loggedIn: boolean
  source: 'file' | 'none'
}

/** IPC 统一返回包装：避免 invoke 抛错时错误信息被 Electron 二次包装 */
export type IpcResult<T> = { ok: true; data: T } | { ok: false; message: string }

export interface DownloadReq {
  link: string
  ratio: string
  dir: string
}

export interface DownloadProgress {
  taskId: string
  downloaded: number
  total: number
  /** 字节/秒 */
  speed: number
}

export interface DownloadDone {
  taskId: string
  path: string
}

export interface DownloadError {
  taskId: string
  message: string
}

export interface Config {
  downloadDir: string
  defaultRatio: string
  loginTimeoutSec: number
}

// ---------- 自动更新 ----------

export type UpdateType = 'asar' | 'full'

export interface UpdateInfo {
  hasUpdate: boolean
  currentVersion: string
  latestVersion: string
  releaseNotes: string
  releaseUrl: string
  /** null = 有新版但没匹配到当前平台的包（不提示下载） */
  updateType: UpdateType | null
  downloadUrl: string
  assetName: string
  assetSize: number
  /** GitHub API asset.digest，格式 "sha256:xxxx"，可能为空（空则跳过校验） */
  digest: string
}

export interface UpdateProgress {
  downloaded: number
  total: number
  speed: number
}
