import { useEffect, useState } from 'react'
import type { Preferences } from '../shared/desktop'

type Appearance = Preferences['appearance']

/** 把外观偏好落到 :root[data-theme]；跟随系统时同时监听系统深浅色切换。 */
export function useAppearanceTheme(appearance: Appearance | undefined) {
  useEffect(() => {
    const m = matchMedia('(prefers-color-scheme: dark)')
    const apply = () =>
      (document.documentElement.dataset.theme =
        // 偏好尚未读到时按系统（默认值）渲染，避免深色模式下先闪一下浅色
        !appearance || appearance === 'system'
          ? m.matches
            ? 'dark'
            : 'light'
          : appearance)
    apply()
    m.addEventListener('change', apply)
    return () => m.removeEventListener('change', apply)
  }, [appearance])
}

/** 供没有自己持有偏好的窗口使用：读取当前外观并跟随偏好实时变化。 */
export function useSyncedTheme() {
  const [appearance, setAppearance] = useState<Appearance>()
  useEffect(() => {
    let disposed = false
    let updated = false
    const off = window.opentype.desktop.onPreferences(p => { updated = true; setAppearance(p.appearance) })
    void window.opentype.desktop.snapshot()
      .then(s => { if (!disposed && !updated) setAppearance(s.preferences.appearance) })
      .catch(() => {})
    return () => { disposed = true; off() }
  }, [])
  useAppearanceTheme(appearance)
}
