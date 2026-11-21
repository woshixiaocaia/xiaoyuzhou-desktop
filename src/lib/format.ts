export function formatTime(value: number): string {
  const seconds = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
  const h = Math.floor(seconds / 3600)
  const m = String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')
  const s = String(seconds % 60).padStart(2, '0')
  return h ? `${h}:${m}:${s}` : `${m}:${s}`
}
export function formatDate(value: string | number | Date | null): string {
  if (!value) return ''
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
}
export function plainText(value: string): string {
  return value.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim()
}
