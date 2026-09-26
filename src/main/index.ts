import { app, BrowserWindow, Menu } from 'electron'
import path from 'node:path'
import { registerIpc } from './ipc'
import { registerUpdateIpc, startUpdateWatch } from './update'
import { createMainWindow } from './windows'
import { getDataDir } from './paths'

// Windows/Linux 上默认菜单栏（File/Edit/View/Window）没有实际用途，直接移除；
// macOS 保留默认菜单，否则 Cmd+C/V/Q 等系统快捷键会失效。
if (process.platform !== 'darwin') Menu.setApplicationMenu(null)

app.whenReady().then(() => {
  void getDataDir() // 提前就位 ~/.douyin_downloader/ 及 logs/
  registerIpc()
  registerUpdateIpc()
  createMainWindow()
  startUpdateWatch() // 更新残留清理 + 3 秒后后台检查
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
