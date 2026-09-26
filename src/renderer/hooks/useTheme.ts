import { useCallback, useEffect, useState } from 'react'
import {
  applyTheme,
  getThemePreference,
  resolveThemeSync,
  saveThemePreference,
  type ResolvedTheme,
  type ThemePreference,
} from '../lib/theme'

const LABELS: Record<ThemePreference, string> = {
  light: '亮色模式',
  dark: '暗色模式',
  system: '跟随系统',
}

/** 亮 / 暗 / 跟随系统切换，并同步 document 与持久化。 */
export function useTheme() {
  const [preference, setPreference] = useState<ThemePreference>(() => getThemePreference())
  const [resolved, setResolved] = useState<ResolvedTheme>(() =>
    resolveThemeSync(getThemePreference()),
  )

  // 偏好变化时立即应用
  useEffect(() => {
    if (preference === 'light' || preference === 'dark') {
      setResolved(preference)
      applyTheme(preference)
      saveThemePreference(preference)
      return
    }

    // system：跟随 media query（Electron/Chromium 下事件可靠，无需轮询）
    saveThemePreference('system')
    const apply = (): void => {
      const next = resolveThemeSync('system')
      setResolved(next)
      applyTheme(next)
    }
    apply()

    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', apply)
    return () => mq.removeEventListener('change', apply)
  }, [preference])

  const setTheme = useCallback((next: ThemePreference) => setPreference(next), [])
  const toggleTheme = useCallback(
    () => setPreference((prev) => (prev === 'light' ? 'dark' : prev === 'dark' ? 'system' : 'light')),
    [],
  )

  const themeLabel =
    preference === 'system' ? `跟随系统（当前${LABELS[resolved]}）` : LABELS[preference]

  return { preference, resolved, themeLabel, setTheme, toggleTheme }
}
