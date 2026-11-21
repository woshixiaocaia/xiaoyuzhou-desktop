import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'

import { useSettingsStore } from '@/stores/settings'
import { episodeKey, useHistoryStore } from '@/stores/history'
import { usePlayerStore, type PlayingEpisode } from '@/stores/player'

/**
 * 播放队列（RSS 与官方可混合）。
 *
 * 约定：
 *  - 队列项的 id 统一使用「带来源前缀的 key」（`official:<eid>` / `rss:<id>`），
 *    与播放器、收听历史使用同一套身份，避免同名节目互相干扰；
 *  - 队列只保存已知音频地址（入队时必须有地址），地址失效由播放器报错，不在这里伪造；
 *  - 播放完成后自动播放下一集；队列结束时停在最后一集，不会循环。
 */

export type QueueSource = 'rss' | 'official'

export interface QueueItem {
  /** 带来源前缀的唯一键，同时也是交给播放器的 id */
  key: string
  source: QueueSource
  /** 原始单集 ID（官方 eid / RSS guid 或派生 id） */
  id: string
  title: string
  podcast: string
  duration: number
  audioUrl: string
  podcastId?: string
  imageUrl?: string | null
}

/** 从播放器里的单集构造队列项；没有音频地址的节目不入队 */
export function queueItemFromEpisode(episode: PlayingEpisode): QueueItem | null {
  const url = typeof episode.audioUrl === 'string' ? episode.audioUrl : ''
  if (url === '') return null
  const source: QueueSource = episode.source === 'official' ? 'official' : 'rss'
  const key = episodeKey(source, episode.id)
  return {
    key,
    source,
    id: episode.id,
    title: episode.title,
    podcast: episode.podcast,
    duration: episode.duration,
    audioUrl: url,
    podcastId: episode.podcastId,
    imageUrl: episode.imageUrl,
  }
}

export const useQueueStore = defineStore('queue', () => {
  const items = ref<QueueItem[]>([])
  /** 当前播放项在队列中的位置；-1 表示当前播放的不在队列里 */
  const index = ref(-1)

  let bound = false

  const current = computed<QueueItem | null>(() => {
    const i = index.value
    return i >= 0 && i < items.value.length ? (items.value[i] ?? null) : null
  })
  const length = computed(() => items.value.length)
  const hasNext = computed(() => index.value >= 0 && index.value < items.value.length - 1)
  const hasPrev = computed(() => index.value > 0)
  const isEmpty = computed(() => items.value.length === 0)

  function indexOf(key: string): number {
    return items.value.findIndex((item) => item.key === key)
  }

  /** 追加到队尾；已存在则不重复添加（返回 duplicate） */
  function add(item: QueueItem): 'added' | 'duplicate' {
    if (indexOf(item.key) >= 0) return 'duplicate'
    items.value = [...items.value, item]
    if (index.value === -1) index.value = 0
    return 'added'
  }

  /**
   * 播放指定队列项。
   * 当前项从队首开始时，若队列里还没有它，会先补进队列。
   */
  function playAt(position: number): boolean {
    if (position < 0 || position >= items.value.length) return false
    const item = items.value[position]
    if (!item) return false
    index.value = position
    const player = usePlayerStore()
    // 从收听历史恢复进度：交给播放器在元数据就绪后应用，不在这里直接 seek
    const startAt = useSettingsStore().resume ? useHistoryStore().resumePosition(item.key) : 0
    player.play({
      id: item.key,
      title: item.title,
      podcast: item.podcast,
      duration: item.duration,
      audioUrl: item.audioUrl,
      podcastId: item.podcastId,
      imageUrl: item.imageUrl,
      source: item.source,
      startAt,
    })
    return true
  }

  function next(): boolean {
    if (!hasNext.value) return false
    return playAt(index.value + 1)
  }

  function prev(): boolean {
    if (!hasPrev.value) return false
    return playAt(index.value - 1)
  }

  /**
   * 移除队列项。
   * 删除当前项时：索引停在原位（自然指向下一集），不自动开始播放——
   * 避免用户只是想移除、结果突然换了节目。
   */
  function removeAt(position: number): boolean {
    if (position < 0 || position >= items.value.length) return false
    const nextItems = items.value.filter((_, i) => i !== position)
    items.value = nextItems
    if (nextItems.length === 0) {
      index.value = -1
      return true
    }
    if (position < index.value) index.value -= 1
    else if (position === index.value) index.value = Math.min(index.value, nextItems.length - 1)
    return true
  }

  function remove(key: string): boolean {
    const position = indexOf(key)
    return position >= 0 ? removeAt(position) : false
  }

  function clear(): void {
    items.value = []
    index.value = -1
  }

  function removeSource(source: QueueSource): void {
    const key = current.value?.key
    items.value = items.value.filter(item => item.source !== source)
    index.value = key ? items.value.findIndex(item => item.key === key) : -1
  }

  /** 当前播放项不在队列里时，把它插到队首并标记为当前项 */
  function syncCurrent(item: QueueItem): void {
    const existing = indexOf(item.key)
    if (existing >= 0) {
      index.value = existing
      return
    }
    items.value = [item, ...items.value]
    index.value = 0
  }

  /** 绑定播放器：播放结束后自动续播下一集；只绑定一次 */
  function bindToPlayer(): void {
    if (bound) return
    bound = true
    const player = usePlayerStore()

    watch(
      () => player.status,
      (status) => {
        if (status !== 'ended' || !useSettingsStore().autoplay) return
        if (!hasNext.value) return
        playAt(index.value + 1)
      },
    )

    // 用户从别处切歌时，如果新歌在队列里，同步索引
    watch(
      () => player.current?.id ?? '',
      (id) => {
        if (id === '') return
        const position = indexOf(id)
        if (position >= 0) index.value = position
      },
    )
  }

  return {
    items,
    index,
    current,
    length,
    hasNext,
    hasPrev,
    isEmpty,
    add,
    playAt,
    next,
    prev,
    removeAt,
    remove,
    clear,
    removeSource,
    syncCurrent,
    bindToPlayer,
  }
})
