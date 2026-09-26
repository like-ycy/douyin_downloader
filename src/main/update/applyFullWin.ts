import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { log } from '../log'

/**
 * Windows 全量更新：整目录替换。
 * 根基：文件锁只在进程存活期存在 —— 主进程 + 子进程全部退出后，
 * 整个 App 目录无任何锁，可直接改名/删除/覆盖。
 *
 * 流程（update.bat，放 %TEMP%，无自删问题）：
 *   等 PID 退出(≤60s) → move App目录 App目录.bak（原地改名，回滚用）
 *   → robocopy 新目录 App目录 /E（退出码 0-7 算成功，失败重试 3 次）
 *   → start 新 exe → 删 .bak
 *   任一步失败 → move .bak 回滚 → 启动旧 exe
 */

export function applyFullUpdateWin(newDirRoot: string): void {
  if (!app.isPackaged) throw new Error('开发模式不支持就地更新，请打包后测试')

  const exePath = app.getPath('exe')
  const appDir = path.dirname(exePath)
  const exeName = path.basename(exePath)

  // 定位新版本目录：约定解压出 win-unpacked/ 一层；兜底扫一层子目录
  const newDir = findUnpackedDir(newDirRoot, exeName)
  if (!newDir) {
    throw new Error('更新包里没有找到 win-unpacked 目录，请手动下载安装')
  }

  const batPath = path.join(path.dirname(newDirRoot), 'update.bat')
  const bat = [
    '@echo off',
    'rem 全量更新：%1=旧进程PID %2=App目录 %3=新版本目录 %4=exe文件名',
    'set PID=%~1',
    'set APP_DIR=%~2',
    'set NEW_DIR=%~3',
    'set EXE=%~4',
    'set BAK=%APP_DIR%.bak',
    '',
    'rem 1) 等旧进程退出（最多 60 秒，子进程随主进程一起退）',
    'set /a N=0',
    ':wait',
    'tasklist /FI "PID eq %PID%" 2>NUL | find /I "%PID%" >NUL',
    'if errorlevel 1 goto swap',
    'if %N% GEQ 60 exit /b 1',
    'set /a N+=1',
    'ping -n 2 127.0.0.1 >nul',
    'goto wait',
    '',
    ':swap',
    'if exist "%BAK%" rd /s /q "%BAK%" >nul 2>&1',
    'move /Y "%APP_DIR%" "%BAK%" >nul 2>&1',
    '',
    'rem 2) robocopy 镜像替换（退出码 0-7 成功），失败重试 3 次',
    'set /a TRY=0',
    ':copy',
    'set /a TRY+=1',
    'robocopy "%NEW_DIR%" "%APP_DIR%" /E /R:1 /W:1 /NFL /NDL /NJH /NJS >nul 2>&1',
    'if errorlevel 8 (',
    '  if %TRY% GEQ 3 goto restore',
    '  ping -n 3 127.0.0.1 >nul',
    '  goto copy',
    ')',
    '',
    'rem 3) 成功：启动新版并清理备份',
    'start "" "%APP_DIR%\\%EXE%"',
    'if exist "%BAK%" rd /s /q "%BAK%" >nul 2>&1',
    'exit /b 0',
    '',
    ':restore',
    'if exist "%BAK%" (',
    '  rd /s /q "%APP_DIR%" >nul 2>&1',
    '  move /Y "%BAK%" "%APP_DIR%" >nul 2>&1',
    ')',
    'start "" "%APP_DIR%\\%EXE%"',
    'exit /b 1',
    '',
  ].join('\r\n')
  fs.writeFileSync(batPath, bat)

  // 隐藏窗口、脱离父进程会话（主进程随后退出，bat 必须独立存活）
  const child = spawn('cmd.exe', ['/c', batPath, String(process.pid), appDir, newDir, exeName], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  log('update', `全量更新已就绪：bat=${batPath} appDir=${appDir} newDir=${newDir}`)
}

/** 在解压根目录下找 win-unpacked（约定一层；兜底扫子目录）。 */
function findUnpackedDir(root: string, exeName: string): string | null {
  const direct = path.join(root, 'win-unpacked')
  if (fs.existsSync(path.join(direct, exeName))) return direct

  try {
    for (const name of fs.readdirSync(root)) {
      const sub = path.join(root, name)
      if (fs.statSync(sub).isDirectory() && fs.existsSync(path.join(sub, exeName))) {
        return sub
      }
    }
  } catch {
    // 读目录失败按未找到处理
  }
  return null
}
