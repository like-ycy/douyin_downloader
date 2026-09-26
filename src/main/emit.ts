import { BrowserWindow } from 'electron'

/** 向所有窗口广播事件（M3 期间只有主窗口）。 */
export function emit(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload)
  }
}
