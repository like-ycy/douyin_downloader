import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { getDataDir } from '../paths'
import { isWindows } from '../platform'
import { log } from '../log'

/**
 * 增量更新（只换 resources/app.asar）：
 * - 应用侧：rename app.asar -> app.asar.old（Windows 运行中允许 rename）→ 放入新 asar → 看门狗 → relaunch
 * - 启动侧：启动 5 秒后写成功标记并清理 .old；看门狗发现「旧进程退出且无成功标记」时回滚并重启
 */

interface UpdateState {
  appliedVersion: string
  appliedAt: number
  asarOld: string
  okFile: string
}

function stateFile(): string {
  return path.join(getDataDir(), 'update-state.json')
}

function okMarkerFile(): string {
  return path.join(getDataDir(), 'update-ok.flag')
}

function readUpdateState(): UpdateState | null {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as UpdateState
  } catch {
    return null
  }
}

/** 主进程启动时调用：确认上次 asar 更新成功，清理 .old 与状态文件。 */
export function startupUpdateConfirm(): void {
  if (!app.isPackaged) return
  const asarPath = path.join(process.resourcesPath, 'app.asar')
  const asarOld = asarPath + '.old'
  if (!fs.existsSync(asarOld)) return

  log('update', '发现上次更新的 asar.old，5 秒后确认成功并清理')
  setTimeout(() => {
    try {
      if (readUpdateState()) {
        fs.writeFileSync(okMarkerFile(), String(Date.now())) // 通知看门狗：新版活着
      }
      fs.rmSync(asarOld, { force: true })
      fs.rmSync(stateFile(), { force: true })
      fs.rmSync(okMarkerFile(), { force: true })
      log('update', '更新确认完成，残留清理完毕')
    } catch (e) {
      log('update', `更新残留清理失败（忽略）: ${(e as Error).message}`)
    }
  }, 5000)
}

/**
 * 应用 asar 增量更新。成功后本进程会 relaunch 并退出（不返回）。
 * asar 改名失败（EPERM/EBUSY）时抛错，由调用方降级为全量流程。
 */
export function applyAsarUpdate(newAsarPath: string, appliedVersion: string): void {
  if (!app.isPackaged) throw new Error('开发模式不支持就地更新，请打包后测试')

  const asarPath = path.join(process.resourcesPath, 'app.asar')
  const asarOld = asarPath + '.old'
  const okFile = okMarkerFile()

  // 清掉上次更新可能遗留的标记与备份（下次看门狗从干净状态开始）
  try {
    fs.rmSync(okFile, { force: true })
    fs.rmSync(asarOld, { force: true })
  } catch {
    // 清理失败不阻塞
  }

  // 1) 改名让位（NTFS 允许 rename 运行中的 asar；被占用则让用户走全量）
  try {
    fs.renameSync(asarPath, asarOld)
  } catch (e) {
    log('update', `asar 改名失败: ${(e as Error).message}`)
    throw new Error('app.asar 无法改名（可能被占用），请改用全量更新或重启后重试')
  }

  // 2) 放入新 asar；失败则立刻恢复原版本
  try {
    fs.copyFileSync(newAsarPath, asarPath)
  } catch (e) {
    try {
      fs.renameSync(asarOld, asarPath)
    } catch {
      // 恢复也失败时保留 .old，用户可手动还原
    }
    throw new Error(`新 asar 写入失败，已恢复原版本：${(e as Error).message}`)
  }

  // 3) 记录状态 + 拉起看门狗（旧 PID 退出后若新版 5 秒内没写成功标记则回滚）
  const state: UpdateState = {
    appliedVersion,
    appliedAt: Date.now(),
    asarOld,
    okFile,
  }
  fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2))
  spawnWatcher(process.pid, asarOld, asarPath)

  log('update', `asar 增量更新就绪 (v${appliedVersion})，重启生效`)
  app.relaunch()
  app.exit(0)
}

/** 看门狗：等旧进程退出 → 等成功标记；新版疑似崩溃时回滚 asar 并重启。 */
function spawnWatcher(oldPid: number, asarOld: string, asarPath: string): void {
  const okFile = okMarkerFile()
  const scriptDir = getDataDir()

  if (isWindows()) {
    const batPath = path.join(scriptDir, 'update-watch.bat')
    const exePath = app.getPath('exe')
    const bat = [
      '@echo off',
      'rem 自动更新看门狗：新版未成功启动时回滚 asar 并重启',
      'rem %1=旧进程PID %2=asar.old %3=app.asar %4=成功标记 %5=新版exe',
      'set PID=%~1',
      'set OLD=%~2',
      'set ASAR=%~3',
      'set OK=%~4',
      'set EXE=%~5',
      'for %%F in ("%EXE%") do set IMAGE=%%~nxF',
      '',
      'rem 1) 等旧进程退出（最多 60 秒）',
      'set /a N=0',
      ':wait_exit',
      'tasklist /FI "PID eq %PID%" 2>NUL | find /I "%PID%" >NUL',
      'if errorlevel 1 goto old_gone',
      'if %N% GEQ 60 goto old_gone',
      'set /a N+=1',
      'ping -n 2 127.0.0.1 >nul',
      'goto wait_exit',
      '',
      'rem 2) 等成功标记（最多 180 秒）；应用进程消失则提前进入回滚判定',
      'set /a N=0',
      ':wait_ok',
      'if exist "%OK%" exit /b 0',
      'tasklist /FI "IMAGENAME eq %IMAGE%" 2>NUL | find /I "%IMAGE%" >NUL',
      'if errorlevel 1 goto maybe_dead',
      'if %N% GEQ 90 goto maybe_dead',
      'set /a N+=1',
      'ping -n 3 127.0.0.1 >nul',
      'goto wait_ok',
      '',
      'rem 3) 回滚判定：asar 能改名说明应用进程已退出',
      ':maybe_dead',
      'if exist "%OK%" exit /b 0',
      'ren "%ASAR%" "app.asar.broken" >NUL 2>&1',
      'if errorlevel 1 exit /b 0',
      'copy /Y "%OLD%" "%ASAR%" >NUL 2>&1',
      'del /F /Q "%ASAR%.broken" >NUL 2>&1',
      'start "" "%EXE%"',
      'exit /b 0',
      '',
    ].join('\r\n')
    fs.writeFileSync(batPath, bat)
    const child = spawn(
      'cmd.exe',
      ['/c', batPath, String(oldPid), asarOld, asarPath, okFile, exePath],
      { detached: true, stdio: 'ignore', windowsHide: true }
    )
    child.unref()
    log('update', `看门狗已拉起 (bat pid=${child.pid})`)
    return
  }

  // macOS / Linux
  const shPath = path.join(scriptDir, 'update-watch.sh')
  const appBundle = findAppBundle()
  const sh = [
    '#!/bin/bash',
    '# 自动更新看门狗：新版未成功启动时回滚 asar 并重启',
    '# $1=旧进程PID $2=asar.old $3=app.asar $4=成功标记 $5=.app 路径',
    'PID="$1"; OLD="$2"; ASAR="$3"; OK="$4"; APP="$5"',
    '',
    'for i in $(seq 1 60); do',
    '  kill -0 "$PID" 2>/dev/null || break',
    '  sleep 1',
    'done',
    '',
    'for i in $(seq 1 90); do',
    '  [ -f "$OK" ] && exit 0',
    '  sleep 2',
    'done',
    '[ -f "$OK" ] && exit 0',
    '',
    'if pgrep -f "douyin_downloader.app/Contents/MacOS/douyin_downloader" >/dev/null 2>&1; then',
    '  exit 0',
    'fi',
    'mv "$ASAR" "$ASAR.broken" 2>/dev/null || exit 0',
    'cp -f "$OLD" "$ASAR"',
    'rm -f "$ASAR.broken"',
    'open "$APP"',
    'exit 0',
    '',
  ].join('\n')
  fs.writeFileSync(shPath, sh, { mode: 0o755 })
  const child = spawn('/bin/bash', [shPath, String(oldPid), asarOld, asarPath, okFile, appBundle], {
    detached: true,
    stdio: 'ignore',
  })
  child.unref()
  log('update', `看门狗已拉起 (sh pid=${child.pid})`)
}

function findAppBundle(): string {
  let curr = app.getPath('exe')
  for (let i = 0; i < 10; i++) {
    if (curr.endsWith('.app')) return curr
    const parent = path.dirname(curr)
    if (parent === curr) break
    curr = parent
  }
  return app.getPath('exe')
}
