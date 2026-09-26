/** 平台判断统一入口（便于测试时替换）。 */
export function isWindows(): boolean {
  return process.platform === 'win32'
}
