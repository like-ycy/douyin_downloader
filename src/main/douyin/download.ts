import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { readCookie } from '../auth/cookieStore'
import { MOBILE_UA } from '../httpc/client'
import { resolveAwemeId } from './resolve'
import { fetchRouterData, fetchDetailApi, findAwemeDetail, type AwemeDetail } from './parse'
import { probePlay } from './probe'
import { buildOutputName, avoidCollision, clampPathLength } from './naming'
import { emit } from '../emit'
import { log } from '../log'
import type { DownloadProgress } from '../../shared/types'

interface ActiveTask {
  abort: AbortController
  canceled: boolean
}

const active = new Map<string, ActiveTask>()

export interface DownloadParams {
  link: string
  ratio: string
  dir: string
}

/** 启动下载（异步执行，立即返回 taskId，进度走事件）。 */
export function startDownload(params: DownloadParams): string {
  const taskId = randomUUID()
  // 后台执行：IPC 立刻拿到 taskId，渲染进程开始等进度事件
  log('download', `开始下载 ratio=${params.ratio} dir=${params.dir}`)
  void run(taskId, params).catch(() => {})
  return taskId
}

export function cancelDownload(taskId: string): void {
  const task = active.get(taskId)
  if (task) {
    task.canceled = true
    task.abort.abort()
  }
}

/** 下载前的完整链路：重新解析 -> 重新探测该档位直链。
 *  CDN 直链带签名有时效，必须探测与下载连续完成，不复用上次 inspect 的 URL。 */
async function run(taskId: string, { link, ratio, dir }: DownloadParams): Promise<void> {
  const abort = new AbortController()
  const task: ActiveTask = { abort, canceled: false }
  active.set(taskId, task)
  try {
    // 1) 解析 + 取视频信息（为了拿作者/标题命名 + play_addr.uri）
    const { awemeId } = await resolveAwemeId(link)
    if (!awemeId) throw new Error('解析 aweme_id 失败，无法下载')
    const router = await fetchRouterData(awemeId)
    let item: AwemeDetail | null = router.data ? findAwemeDetail(router.data) : null
    if (!item) item = await fetchDetailApi(awemeId)
    if (!item) throw new Error('获取视频信息失败，无法下载')

    const uri: string | undefined = item.video?.play_addr?.uri
    if (!uri) throw new Error('没有 play_addr.uri，无法下载')

    // 2) 探测指定档位的直链
    const probe = await probePlay(uri, ratio)
    if (!probe?.url) throw new Error(`ratio=${ratio} 拿不到直链，无法下载`)

    // 3) 命名 + 防覆盖 + 路径长度校验
    const dest = avoidCollision(
      clampPathLength(
        path.join(dir, buildOutputName(item.author?.nickname ?? '', item.desc ?? '', awemeId))
      )
    )
    fs.mkdirSync(path.dirname(dest), { recursive: true })

    // 4) 流式写盘
    log('download', `输出文件: ${dest}`)
    await streamToFile(taskId, task, probe.url, dest)
    log('download', `下载完成: ${dest}`)
    emit('download:done', { taskId, path: dest })
  } catch (e) {
    const err = e as Error
    const message = task.canceled || err.name === 'AbortError'
      ? '已取消'
      : readableError(err)
    log('download', `下载失败: ${message}`)
    emit('download:error', { taskId, message })
  } finally {
    active.delete(taskId)
  }
}

function readableError(err: Error): string {
  const msg = err.message || String(err)
  if (/403/.test(msg)) return 'CDN 拒绝访问（403）：直链可能已过期或触发风控，请重新解析后重试。'
  if (/timeout|abort/i.test(msg)) return '请求超时/中断：' + msg
  return msg
}

async function streamToFile(
  taskId: string,
  task: ActiveTask,
  url: string,
  dest: string
): Promise<void> {
  const res = await fetch(url, {
    headers: {
      'User-Agent': MOBILE_UA,
      Cookie: readCookie(),
      Referer: 'https://www.douyin.com/',
    },
    signal: task.abort.signal,
  })
  if (!res.ok || !res.body) {
    throw new Error(`CDN 返回 ${res.status}`)
  }

  // 总大小：优先 Content-Range（206 时），其次 Content-Length
  const cr = res.headers.get('content-range')
  const cl = res.headers.get('content-length')
  let total = 0
  if (cr && cr.includes('/')) total = parseInt(cr.slice(cr.lastIndexOf('/') + 1), 10) || 0
  else if (cl) total = parseInt(cl, 10) || 0

  const file = fs.createWriteStream(dest)
  const reader = res.body.getReader()
  let downloaded = 0
  let lastEmit = 0
  const t0 = Date.now()

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      downloaded += value.byteLength
      if (!file.write(Buffer.from(value))) {
        await once(file, 'drain')
      }
      // 进度事件节流 ~200ms，避免刷爆渲染进程
      const now = Date.now()
      if (now - lastEmit >= 200) {
        lastEmit = now
        const elapsed = (now - t0) / 1000
        const payload: DownloadProgress = {
          taskId,
          downloaded,
          total,
          speed: elapsed > 0 ? downloaded / elapsed : 0,
        }
        emit('download:progress', payload)
      }
    }
    await new Promise<void>((resolve, reject) => {
      file.end(() => resolve())
      file.on('error', reject)
    })
  } catch (e) {
    file.destroy()
    try {
      fs.unlinkSync(dest) // 删半成品
    } catch {
      // 清理失败不影响错误抛出
    }
    throw e
  }
}
