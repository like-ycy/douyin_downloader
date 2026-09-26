import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { registerIpc } from './ipc'
import { createMainWindow } from './windows'
import { getDataDir } from './paths'

app.whenReady().then(() => {
  void getDataDir() // 提前就位 ~/.douyin_downloader/ 及 logs/
  registerIpc()
  createMainWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
