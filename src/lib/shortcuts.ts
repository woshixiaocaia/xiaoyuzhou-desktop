/**
 * 全局快捷键解析（纯函数，便于离线测试）。
 *
 * 规则：Ctrl+Alt+←/→ 切上一集 / 下一集。
 * 焦点在输入类元素里时一律不触发，避免用户在搜索框里用方向键被抢走。
 */

export type QueueShortcut = 'next' | 'prev'

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT'])

/** 焦点是否落在可编辑区域（输入框、文本域、下拉、contenteditable） */
export function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== 'object') return false
  const element = target as { tagName?: unknown; isContentEditable?: unknown }
  const tag = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : ''
  if (EDITABLE_TAGS.has(tag)) return true
  return element.isContentEditable === true
}

export interface ShortcutEventLike {
  ctrlKey?: boolean
  altKey?: boolean
  key?: string
  target?: unknown
}

/** 返回要执行的队列动作；不需要处理时返回 null */
export function queueShortcut(event: ShortcutEventLike): QueueShortcut | null {
  if (event.ctrlKey !== true || event.altKey !== true) return null
  if (isEditableTarget(event.target)) return null
  if (event.key === 'ArrowRight') return 'next'
  if (event.key === 'ArrowLeft') return 'prev'
  return null
}
