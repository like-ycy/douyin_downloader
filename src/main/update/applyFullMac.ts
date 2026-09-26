import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { log } from '../log'

/**
 * macOS 全量更新：替换 .app 并重启（逻辑对齐 video_cut/apply_darwin.go）。
 * bash 脚本以独立会话（detached）运行，不随主进程退出而终止。
 */
export function applyFullUpdateMac(newDirRoot: string): void {
  if (!app.isPackaged) throw new Error('开发模式不支持就地更新，请打包后测试')

  const newApp = findAppBundleInDir(newDirRoot)
  if (!newApp) throw new Error('更新包里没有找到 .app，请手动下载安装')

  const currentApp = findCurrentAppBundle()

  const shPath = path.join(path.dirname(newDirRoot), 'update.sh')
  const sh = [
    '#!/bin/bash',
    '# 全量更新：$1=当前PID $2=当前.app $3=新.app $4=清理目录(更新临时根)',
    'PID="$1"; APP="$2"; NEW="$3"; CLEAN="$4"',
    'BAK="${APP}.old-$$"',
    '',
    '# 等主应用进程完全退出（最多 60 秒）',
    'for i in $(seq 1 60); do',
    '  kill -0 "$PID" 2>/dev/null || break',
    '  sleep 1',
    'done',
    '',
    'rm -rf "$BAK"',
    'if ! mv "$APP" "$BAK"; then exit 1; fi',
    'if ! mv "$NEW" "$APP"; then mv "$BAK" "$APP"; exit 1; fi',
    '',
    '# 清除隔离属性，避免未签名应用的启动拦截',
    'xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true',
    '',
    'open "$APP"',
    'rm -rf "$BAK" "$CLEAN"',
    'exit 0',
    '',
  ].join('\n')
  fs.writeFileSync(shPath, sh, { mode: 0o755 })

  const child = spawn('/bin/bash', [shPath, String(process.pid), currentApp, newApp, newDirRoot], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  log('update', `mac 全量更新已就绪：app=${currentApp} new=${newApp}`)
}

function findCurrentAppBundle(): string {
  let curr = app.getPath('exe')
  for (let i = 0; i < 10; i++) {
    if (curr.endsWith('.app')) return curr
    const parent = path.dirname(curr)
    if (parent === curr) break
    curr = parent
  }
  throw new Error('当前程序不在 .app 包内（开发模式不支持就地替换）')
}

function findAppBundleInDir(root: string): string | null {
  const direct = path.join(root, 'douyin_downloader.app')
  if (fs.existsSync(direct)) return direct
  try {
    for (const name of fs.readdirSync(root)) {
      const sub = path.join(root, name)
      if (fs.statSync(sub).isDirectory() && name.endsWith('.app')) return sub
      // 兜底：多一层根目录的包
      try {
        for (const subName of fs.readdirSync(sub)) {
          if (subName.endsWith('.app')) return path.join(sub, subName)
        }
      } catch {
        // 下一层不可读则跳过
      }
    }
  } catch {
    // 读目录失败按未找到处理
  }
  return null
}
