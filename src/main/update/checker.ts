import { app } from 'electron'
import { compareVersions } from './version'
import { log } from '../log'
import type { UpdateInfo, UpdateType } from '../../shared/types'

/** 仓库常量：release asset 命名约定见 docs/auto-update-design.md */
export const REPO_OWNER = 'like-ycy'
export const REPO_NAME = 'douyin_downloader'
/** 国内下载加速代理（可选，ghfast.top 前缀） */
export const PROXY_PREFIX = 'https://ghfast.top/'

const API_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`

interface ReleaseAsset {
  name: string
  size: number
  digest?: string
  browser_download_url: string
}

interface GitHubRelease {
  tag_name: string
  body?: string
  html_url: string
  assets: ReleaseAsset[]
}

export function withProxy(url: string, useProxy: boolean): string {
  return useProxy ? PROXY_PREFIX + url : url
}

async function fetchLatestRelease(): Promise<GitHubRelease> {
  const res = await fetch(API_URL, {
    headers: {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'douyin_downloader-update',
    },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`GitHub API 返回 ${res.status}`)
  return (await res.json()) as GitHubRelease
}

/** 按当前平台匹配更新包：优先 asar 增量包，其次全量包。 */
function matchAsset(assets: ReleaseAsset[]): { asset: ReleaseAsset; type: UpdateType } | null {
  const lower = (s: string): string => s.toLowerCase()
  if (process.platform === 'win32') {
    const asar = assets.find((a) => lower(a.name).endsWith('_win_asar.zip'))
    if (asar) return { asset: asar, type: 'asar' }
    const full = assets.find((a) => lower(a.name).endsWith('_win_full.zip'))
    return full ? { asset: full, type: 'full' } : null
  }
  if (process.platform === 'darwin') {
    const arch = process.arch // arm64 / x64
    const asar = assets.find((a) => lower(a.name).endsWith(`_macos_${arch}_asar.zip`))
    if (asar) return { asset: asar, type: 'asar' }
    const full = assets.find((a) => lower(a.name).endsWith(`_macos_${arch}.app.tar.gz`))
    return full ? { asset: full, type: 'full' } : null
  }
  return null
}

/** 取 Release 里的 Windows 全量包资产（asar 增量应用失败时降级下载用）。 */
export async function matchWinFullAsset(): Promise<ReleaseAsset | null> {
  const rel = await fetchLatestRelease()
  const lower = (s: string): string => s.toLowerCase()
  return rel.assets.find((a) => lower(a.name).endsWith('_win_full.zip')) ?? null
}

/** 查询最新 release 并与当前版本比较。任何网络/解析错误直接抛出，由调用方决定降级。 */
export async function checkUpdate(): Promise<UpdateInfo> {
  const rel = await fetchLatestRelease()
  const currentVersion = app.getVersion()
  const matched = matchAsset(rel.assets ?? [])

  // 仅当「版本更高 且 存在当前平台更新包」才算有可安装更新，
  // 避免「有新版但匹配不到资产」时误提示后在下载阶段失败。
  const hasUpdate = compareVersions(rel.tag_name, currentVersion) > 0 && matched !== null

  const info: UpdateInfo = {
    hasUpdate,
    currentVersion,
    latestVersion: rel.tag_name,
    releaseNotes: rel.body ?? '',
    releaseUrl: rel.html_url,
    updateType: hasUpdate && matched ? matched.type : null,
    downloadUrl: matched?.asset.browser_download_url ?? '',
    assetName: matched?.asset.name ?? '',
    assetSize: matched?.asset.size ?? 0,
    digest: matched?.asset.digest ?? '',
  }
  log(
    'update',
    `检查完成: latest=${info.latestVersion} current=${currentVersion} hasUpdate=${hasUpdate} type=${info.updateType}`
  )
  return info
}
