import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'

import { usePlayerStore } from '@/stores/player'
import { officialListenHistory } from '@/lib/desktop'
import { normalizeOfficialEpisode, pickOfficialPage } from '@/lib/official-contract'

/**
 * 收听历史与播放进度。
 *
 * 设计要点：
 *  - 节目身份用「来源 + 稳定 ID」组成 key，绝不用标题（同名节目会互相覆盖）；
 *  - 只保存业务数据（标题、位置、时长），不保存音频地址——官方地址有时效性，
 *    过期地址存下来毫无意义且会把临时 URL 落到磁盘；
 *  - 写入节流：播放中每 5 秒最多一次，暂停/切换/结束/关闭时强制写入；
 *  - 存储损坏时按空历史处理，不抛异常、不影响播放。
 */

const STORAGE_KEY = 'xiaoyuzhou.history.v1'
const SCHEMA_VERSION = 1
/** 历史条数上限，超出后丢弃最久未更新的 */
const MAX_ENTRIES = 200
/** 播放中写盘的最小间隔 */
const SAVE_INTERVAL_MS = 5000
/** 位置小于该值视为「刚开始」，不记录，避免一进一出就产生脏数据 */
const MIN_POSITION = 3

export type EpisodeSource = 'rss' | 'official'

export interface HistoryEntry {
  key: string
  source: EpisodeSource
  id: string
  title: string
  podcast: string
  podcastId?: string
  /** 上次播放位置（秒） */
  position: number
  /** 已知时长（秒），0 表示未知 */
  duration: number
  /** 是否已听完：听完的节目下次从头开始，不回到旧位置 */
  completed: boolean
  updatedAt: number
  /** 标记该单集已从小宇宙账号同步过 */
  phoneSynced?: boolean
}

/** 由「来源 + 稳定 ID」生成唯一键；已经带前缀的 id 不会重复加前缀 */
export function episodeKey(source: EpisodeSource, id: string): string {
  if (typeof id !== 'string' || id === '') return ''
  return id.startsWith(`${source}:`) ? id : `${source}:${id}`
}

function toSource(value: unknown): EpisodeSource {
  return value === 'official' ? 'official' : 'rss'
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function normalizeEntry(raw: unknown): HistoryEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const record = raw as Record<string, unknown>
  const key = typeof record.key === 'string' ? record.key : ''
  if (key === '') return null
  return {
    key,
    source: toSource(record.source),
    id: typeof record.id === 'string' ? record.id : '',
    title: typeof record.title === 'string' ? record.title : '',
    podcast: typeof record.podcast === 'string' ? record.podcast : '',
    podcastId: typeof record.podcastId === 'string' ? record.podcastId : undefined,
    position: toNumber(record.position),
    duration: toNumber(record.duration),
    completed: record.completed === true,
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : 0,
    phoneSynced: record.phoneSynced === true,
  }
}

/** 读取本地存储；任何异常或结构不符都退化成空列表 */
export function readStoredHistory(storage: Storage | undefined): HistoryEntry[] {
  if (!storage) return []
  try {
    const raw = storage.getItem(STORAGE_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    // 兼容「裸数组」的历史格式
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === 'object' && Array.isArray((parsed as Record<string, unknown>).entries)
        ? ((parsed as Record<string, unknown>).entries as unknown[])
        : []
    const result: HistoryEntry[] = []
    for (const item of list) {
      const entry = normalizeEntry(item)
      if (entry !== null) result.push(entry)
    }
    return result.slice(0, MAX_ENTRIES)
  } catch {
    return []
  }
}

export const useHistoryStore = defineStore('history', () => {
  const storage = (): Storage | undefined => {
    try {
      return globalThis.localStorage
    } catch {
      return undefined
    }
  }

  const entries = ref<HistoryEntry[]>(readStoredHistory(storage()))
  const lastSaveAt = ref(0)
  /** 最近一次写入是否成功，供界面提示「进度没能保存」 */
  const lastError = ref('')
  const phoneSyncStatus = ref<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const phoneSyncError = ref('')
  const phoneLoadMoreKey = ref<unknown>(null)
  const phoneLoadingMore = ref(false)
  let phoneSyncEpoch = 0

  let bound = false

  const recent = computed(() =>
    [...entries.value].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50),
  )

  function find(key: string): HistoryEntry | null {
    return entries.value.find((item) => item.key === key) ?? null
  }

  function upsert(entry: HistoryEntry): void {
    const list = entries.value.filter((item) => item.key !== entry.key)
    list.unshift(entry)
    list.sort((a, b) => b.updatedAt - a.updatedAt)
    entries.value = list.slice(0, MAX_ENTRIES)
  }

  /** 写盘；force=true 时忽略节流（暂停、切换、结束、关闭） */
  function persist(force = false): boolean {
    const now = Date.now()
    if (!force && now - lastSaveAt.value < SAVE_INTERVAL_MS) return false
    lastSaveAt.value = now
    const target = storage()
    if (!target) {
      lastError.value = '当前环境不支持本地存储，播放进度无法保存'
      return false
    }
    try {
      target.setItem(STORAGE_KEY, JSON.stringify({ version: SCHEMA_VERSION, entries: entries.value }))
      lastError.value = ''
      return true
    } catch {
      lastError.value = '播放进度保存失败（本地存储不可写）'
      return false
    }
  }

  /** 记录一条进度；position 过小时不写，避免刚开始播放就产生记录 */
  function record(input: {
    key: string
    source: EpisodeSource
    id: string
    title: string
    podcast: string
    podcastId?: string
    position: number
    duration: number
    completed?: boolean
    force?: boolean
  }): void {
    if (typeof input.key !== 'string' || input.key === '') return
    const position = toNumber(input.position)
    const previous = find(input.key)
    if (position < MIN_POSITION && input.completed !== true) {
      // 位置太靠前：只有本来就有记录时才保留旧记录，不新增
      return
    }
    upsert({
      key: input.key,
      source: input.source,
      id: input.id,
      title: input.title,
      podcast: input.podcast,
      podcastId: input.podcastId || previous?.podcastId,
      position,
      duration: toNumber(input.duration) || previous?.duration || 0,
      completed: input.completed === true,
      updatedAt: Date.now(),
      phoneSynced: previous?.phoneSynced,
    })
    persist(input.force === true)
  }

  /** 某节目应从哪里开始播放：已听完的从 0 开始 */
  function resumePosition(key: string): number {
    const entry = find(key)
    if (entry === null) return 0
    return entry.completed ? 0 : entry.position
  }

  function isCompleted(key: string): boolean {
    return find(key)?.completed === true
  }

  function remove(key: string): void {
    entries.value = entries.value.filter((item) => item.key !== key)
    persist(true)
  }

  function clear(): void {
    entries.value = []
    persist(true)
  }

  const hasPhoneMore = computed(() => phoneLoadMoreKey.value !== null && phoneLoadMoreKey.value !== undefined)

  /** 从当前登录的小宇宙账号拉取手机端历史，只读取账号数据并合并到本机记录。 */
  async function syncPhoneHistory(reset = true): Promise<void> {
    if (phoneSyncStatus.value === 'loading' || phoneLoadingMore.value) return
    if (!reset && !hasPhoneMore.value) return
    const request = ++phoneSyncEpoch
    if (reset) {
      phoneSyncStatus.value = 'loading'
      phoneSyncError.value = ''
      phoneLoadMoreKey.value = null
    } else {
      phoneLoadingMore.value = true
      phoneSyncError.value = ''
    }
    const result = await officialListenHistory(reset ? undefined : phoneLoadMoreKey.value)
    if (request !== phoneSyncEpoch) return
    if (!result.ok) {
      phoneSyncStatus.value = reset ? 'error' : 'ready'
      phoneSyncError.value = result.message
      phoneLoadingMore.value = false
      return
    }
    const page = pickOfficialPage(result.payload)
    const remote: HistoryEntry[] = []
    for (const raw of page.items) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue
      const row = raw as Record<string, unknown>
      const episodeData = row.episode && typeof row.episode === 'object' && !Array.isArray(row.episode)
        ? row.episode as Record<string, unknown>
        : row
      const episode = normalizeOfficialEpisode(episodeData)
      if (!episode || !episode.pid) continue
      const podcast = episodeData.podcast && typeof episodeData.podcast === 'object' && !Array.isArray(episodeData.podcast)
        ? episodeData.podcast as Record<string, unknown>
        : null
      const playedAt = typeof row.playedAt === 'string' ? row.playedAt : typeof episodeData.playedAt === 'string' ? episodeData.playedAt : ''
      const parsedTime = playedAt ? Date.parse(playedAt) : Number.NaN
      const pubTime = episode.pubDate ? Date.parse(episode.pubDate) : Number.NaN
      const rawProgress = typeof row.progress === 'number' ? row.progress : episodeData.progress
      const position = typeof rawProgress === 'number' && Number.isFinite(rawProgress) && rawProgress > 0 ? rawProgress : 0
      const completed = episodeData.isFinished === true
      remote.push({
        key: episodeKey('official', episode.eid),
        source: 'official',
        id: episode.eid,
        title: episode.title,
        podcast: typeof podcast?.title === 'string' ? podcast.title : '小宇宙播客',
        podcastId: episode.pid,
        position,
        duration: episode.durationSeconds,
        completed,
        updatedAt: Number.isFinite(parsedTime) ? parsedTime : Number.isFinite(pubTime) ? pubTime : 0,
        phoneSynced: true,
      })
    }
    const merged: HistoryEntry[] = [...entries.value]
    for (const incoming of remote) {
      const index = merged.findIndex((entry) => entry.key === incoming.key)
      if (index < 0) {
        merged.push(incoming)
        continue
      }
      const current = merged[index]
      if (!current) {
        merged[index] = incoming
        continue
      }
      // 同一集以更新的进度为准；保留本机最近操作，避免旧手机快照回退进度。
      merged[index] = incoming.updatedAt >= current.updatedAt
        ? incoming
        : { ...current, phoneSynced: true }
    }
    merged.sort((a, b) => b.updatedAt - a.updatedAt)
    entries.value = merged.slice(0, MAX_ENTRIES)
    persist(true)
    phoneLoadMoreKey.value = page.loadMoreKey
    phoneSyncStatus.value = 'ready'
    phoneSyncError.value = ''
    phoneLoadingMore.value = false
  }

  /** 把 store 绑定到播放器：只绑定一次，避免重复 watcher */
  function bindToPlayer(): void {
    if (bound) return
    bound = true
    const player = usePlayerStore()

    interface Track {
      key: string
      source: EpisodeSource
      id: string
      title: string
      podcast: string
      podcastId?: string
    }

    let track: Track | null = null
    /** 上一刻的真实位置：切换节目时 currentTime 会被重置，必须用快照 */
    let lastPosition = 0
    let lastDuration = 0

    function trackOf(): Track | null {
      const episode = player.current
      if (episode === null) return null
      const source: EpisodeSource = episode.source === 'official' ? 'official' : 'rss'
      return {
        key: episodeKey(source, episode.id),
        source,
        id: episode.id,
        title: episode.title,
        podcast: episode.podcast,
        podcastId: episode.podcastId,
      }
    }

    // 播放进度：节流由 record 内部处理
    watch(
      () => player.currentTime,
      (value) => {
        lastPosition = typeof value === 'number' && Number.isFinite(value) ? value : 0
        if (player.duration > 0) lastDuration = player.duration
        if (track === null || player.status !== 'playing') return
        record({ ...track, position: lastPosition, duration: lastDuration })
      },
    )

    // 切换节目：先把上一集的位置落盘，再开始跟踪新节目
    watch(
      () => player.current?.id ?? '',
      () => {
        if (track !== null) {
          record({ ...track, position: lastPosition, duration: lastDuration, force: true })
        }
        track = trackOf()
        lastPosition = player.currentTime
        lastDuration = player.duration
      },
      { immediate: true },
    )

    // 状态变化：暂停 / 出错 / 结束 / 关闭时立刻保存
    watch(
      () => player.status,
      (status) => {
        if (track === null) return
        if (status === 'ended') {
          record({ ...track, position: lastDuration, duration: lastDuration, completed: true, force: true })
          return
        }
        if (status === 'paused' || status === 'error' || status === 'idle') {
          record({ ...track, position: lastPosition, duration: lastDuration, force: true })
        }
      },
    )
  }

  return {
    entries,
    recent,
    lastError,
    phoneSyncStatus,
    phoneSyncError,
    phoneLoadingMore,
    hasPhoneMore,
    syncPhoneHistory,
    record,
    resumePosition,
    isCompleted,
    remove,
    clear,
    persist,
    bindToPlayer,
  }
})
