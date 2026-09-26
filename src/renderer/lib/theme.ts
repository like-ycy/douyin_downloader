/**
 * 主题偏好：亮色 / 暗色 / 跟随系统。
 * 逻辑与 video_cut 项目保持一致；Electron 渲染层是 Chromium，
 * prefers-color-scheme 可靠跟随系统（nativeTheme），无需原生轮询。
 */

export type ThemePreference = 'light' | 'dark' | 'system'
export type ResolvedTheme = 'light' | 'dark'

const STORAGE_KEY = 'douyin-theme'

const darkQuery = (): MediaQueryList | null =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null

export function getThemePreference(): ThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === 'light' || raw === 'dark' || raw === 'system') return raw
  } catch {
    /* 隐私模式等场景下忽略 */
  }
  return 'system'
}

/** 同步解析：显式 light/dark 直接返回；system 用 media query 读当前系统外观。 */
export function resolveThemeSync(preference: ThemePreference): ResolvedTheme {
  if (preference === 'light' || preference === 'dark') return preference
  return darkQuery()?.matches ? 'dark' : 'light'
}

export function applyTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement
  root.classList.toggle('dark', resolved === 'dark')
  root.style.colorScheme = resolved

  let meta = document.querySelector<HTMLMetaElement>('meta[name="color-scheme"]')
  if (!meta) {
    meta = document.createElement('meta')
    meta.name = 'color-scheme'
    document.head.appendChild(meta)
  }
  meta.content = resolved
}

export function saveThemePreference(preference: ThemePreference): void {
  try {
    localStorage.setItem(STORAGE_KEY, preference)
  } catch {
    /* 同上 */
  }
}

export function cycleTheme(preference: ThemePreference): ThemePreference {
  if (preference === 'light') return 'dark'
  if (preference === 'dark') return 'system'
  return 'light'
}

/** 启动时立刻套用主题，减少白闪。 */
export function initThemeFromStorage(): void {
  applyTheme(resolveThemeSync(getThemePreference()))
}
