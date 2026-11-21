import { ref, watch } from 'vue'
import { defineStore } from 'pinia'

export type Theme = 'system' | 'light' | 'dark'
const KEY = 'xiaoyuzhou.settings.v1'

export const useSettingsStore = defineStore('settings', () => {
  let saved: Record<string, unknown> = {}
  try { saved = JSON.parse(globalThis.localStorage?.getItem(KEY) || '{}') || {} } catch { /* defaults */ }
  const theme = ref<Theme>(saved.theme === 'light' || saved.theme === 'dark' ? saved.theme : 'system')
  const volume = ref(typeof saved.volume === 'number' && Number.isFinite(saved.volume) ? Math.min(1, Math.max(0, saved.volume)) : 0.8)
  const rate = ref(typeof saved.rate === 'number' && [0.75, 1, 1.25, 1.5, 1.75, 2].includes(saved.rate) ? saved.rate : 1)
  const autoplay = ref(saved.autoplay !== false)
  const resume = ref(saved.resume !== false)
  const error = ref('')

  function applyTheme(): void {
    if (typeof document !== 'undefined') document.documentElement.dataset.theme = theme.value
  }
  applyTheme()
  watch(theme, applyTheme, { flush: 'sync' })
  watch([theme, volume, rate, autoplay, resume], () => {
    try {
      globalThis.localStorage?.setItem(KEY, JSON.stringify({ theme: theme.value, volume: volume.value, rate: rate.value, autoplay: autoplay.value, resume: resume.value }))
      error.value = ''
    } catch { error.value = '偏好设置未能保存，重启后可能恢复默认值。' }
  }, { flush: 'sync' })
  return { theme, volume, rate, autoplay, resume, error }
})
