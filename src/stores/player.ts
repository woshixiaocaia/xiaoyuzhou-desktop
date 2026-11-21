import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

/**
 * 播放器状态仓库（第一组：真实音频播放核心）。
 *
 * ── 职责边界 ────────────────────────────────────────────────
 * 这里只管「当前在放什么、放到哪、有没有出错」，以及驱动一个**唯一的**
 * HTMLAudioElement。进度条 UI、音量、倍速、跨重启记忆等属于后续分组。
 *
 * ── 为什么音频实例放在模块作用域 ─────────────────────────────
 * 底部播放条虽然常驻，但它的内容区是 v-if 控制的；把 `new Audio()` 放进组件，
 * 一旦组件重建，音频就会跟着消失。放在模块作用域里「惰性创建、全局唯一」，
 * 既保证同一时刻只有一条音频在响，也不会随路由切换被销毁。
 *
 * ── 关于静音播放（unavailable）─────────────────────────────
 * 示例数据（mock）没有音频地址。这种情况下状态是 `unavailable` 而不是
 * `playing`——界面上不能假装在播。
 */

/** 播放状态机。`idle` 表示还没有选中过任何单集 */
export type PlayerStatus =
  | 'idle'
  | 'loading'
  | 'playing'
  | 'paused'
  | 'ended'
  | 'error'
  /** 选中的单集没有可播放的音频地址（例如示例数据） */
  | 'unavailable'

/** 当前「正在播放」的单集信息 */
export interface PlayingEpisode {
  id: string
  title: string
  podcast: string
  /** 时长，单位秒。优先用音频元数据，这里只是「加入时已知」的值 */
  duration: number
  /**
   * 音频地址。可选是为了兼容示例数据与发现页/搜索页的既有调用；
   * 为 null / undefined 时播放器会进入 unavailable 状态。
   */
  audioUrl?: string | null
  /**
   * 单集来源。RSS 与官方账号是两套 ID 空间，调用方必须把 id 加上命名空间
   * （`official:<eid>`）以免和 RSS 的 id 撞车；这里只做展示与排查用。
   */
  source?: 'rss' | 'official'
  /**
   * 起播位置（秒）。只在音频元数据就绪后由播放器自己应用一次，
   * 调用方不需要（也不应该）在 play() 之前手动 seek。
   */
  startAt?: number
  podcastId?: string
  imageUrl?: string | null
}

// ── 音频地址的渲染进程侧预检 ─────────────────────────────────
//
// 背景：RSS 抓取走主进程的 assertAllowedUrl（electron/rss-fetch.cjs:122），
// 那条路径有完整的协议/userinfo/IP 字面量/主机名校验。但**音频地址是渲染进程
// 直接交给 <audio> 的**，不经过主进程，所以这里必须自己拦一道。
//
// 与主进程规则的对应关系（刻意保持一致，除 IPv6 外）：
//   - 协议只允许 http/https，禁止 userinfo            ← 与 rss-fetch.cjs:136-137 一致
//   - IPv4 字面量按同一份 15 个特殊网段拒绝            ← 与 rss-fetch.cjs:64-81 一致
//   - 单标签主机名、本地域名后缀拒绝                   ← 与 rss-fetch.cjs:160-168 一致
//   - IPv6 字面量：**一律拒绝**（比主进程更严格）
//     原因是 `net.isIP` 在渲染进程不可用，自己写 IPv6 解析器一旦有 bug 就会
//     静默放行（如 ::ffff:127.0.0.1）。fail-closed 更安全，且播客音频几乎
//     不会用 IPv6 字面量地址。
//
// 明确**没有**覆盖的风险（不要在任何地方声称已解决）：
//   - 域名解析到内网 IP（渲染进程没有 DNS 能力，主进程也刻意不做 DNS 门禁）
//   - DNS 重绑定
//   - 服务端 302 重定向到内网目标（<audio> 会跟随重定向，本层看不到）
//   - 代理背后的真实连接目标

const MAX_AUDIO_URL_LENGTH = 2048

const URL_MESSAGES = {
  INVALID_URL: '地址格式无效，请输入以 http:// 或 https:// 开头的链接',
  BLOCKED_TARGET: '该地址指向本机或内网，已按安全策略拒绝',
} as const

/** 本地/内网常用主机名后缀（纯字符串判定，不做 DNS）——同 rss-fetch.cjs:102-113 */
const BLOCKED_HOST_SUFFIXES = [
  'localhost',
  'local',
  'localdomain',
  'internal',
  'intranet',
  'lan',
  'home.arpa',
  'corp',
  'metadata.google.internal',
  'metadata',
]

/** 把点分十进制 IPv4 字面量转成 32 位无符号整数；不是合法字面量则返回 null */
function parseIpv4Literal(host: string): number | null {
  const matched = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (!matched) return null
  const octets: number[] = []
  for (let i = 1; i <= 4; i += 1) {
    const raw = matched[i]
    if (raw === undefined) return null
    const value = Number(raw)
    if (!Number.isInteger(value) || value < 0 || value > 255) return null
    octets.push(value)
  }
  if (octets.length !== 4) return null
  const a = octets[0] ?? 0
  const b = octets[1] ?? 0
  const c = octets[2] ?? 0
  const d = octets[3] ?? 0
  return (((a << 24) >>> 0) + (b << 16) + (c << 8) + d) >>> 0
}

/** 网段定义：与 electron/rss-fetch.cjs:64-80 完全一致 */
const BLOCKED_V4_RANGES: ReadonlyArray<readonly [number, number]> = [
  [parseIpv4Literal('0.0.0.0') ?? 0, 8], // 本网络
  [parseIpv4Literal('10.0.0.0') ?? 0, 8], // 私有
  [parseIpv4Literal('100.64.0.0') ?? 0, 10], // 运营商级 NAT
  [parseIpv4Literal('127.0.0.0') ?? 0, 8], // 回环
  [parseIpv4Literal('169.254.0.0') ?? 0, 16], // 链路本地（含云元数据）
  [parseIpv4Literal('172.16.0.0') ?? 0, 12], // 私有
  [parseIpv4Literal('192.0.0.0') ?? 0, 24], // IETF 协议分配
  [parseIpv4Literal('192.0.2.0') ?? 0, 24], // 文档示例
  [parseIpv4Literal('192.88.99.0') ?? 0, 24], // 6to4 中继
  [parseIpv4Literal('192.168.0.0') ?? 0, 16], // 私有
  [parseIpv4Literal('198.18.0.0') ?? 0, 15], // 基准测试（本机 fake-IP 亦在此段，仅用于拒绝）
  [parseIpv4Literal('198.51.100.0') ?? 0, 24], // 文档示例
  [parseIpv4Literal('203.0.113.0') ?? 0, 24], // 文档示例
  [parseIpv4Literal('224.0.0.0') ?? 0, 4], // 组播
  [parseIpv4Literal('240.0.0.0') ?? 0, 4], // 保留（含广播）
]

function isBlockedIpv4(ip: number): boolean {
  for (const [base, prefix] of BLOCKED_V4_RANGES) {
    if (prefix === 0) return true
    const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0
    if (((ip & mask) >>> 0) === ((base & mask) >>> 0)) return true
  }
  return false
}

/** 预检结果：通过则给出规范化后的地址，否则给出固定错误码与中文提示 */
export type AudioUrlCheck =
  | { ok: true; url: string }
  | { ok: false; code: 'INVALID_URL' | 'BLOCKED_TARGET'; message: string }

function rejectUrl(code: 'INVALID_URL' | 'BLOCKED_TARGET'): AudioUrlCheck {
  return { ok: false, code, message: URL_MESSAGES[code] }
}

/**
 * 播放前对音频地址做本机/内网初步拦截。
 * 纯函数：不联网、不做 DNS 查询（与主进程保持一致的口径）。
 */
export function assertPlayableAudioUrl(raw: unknown): AudioUrlCheck {
  if (typeof raw !== 'string') return rejectUrl('INVALID_URL')
  const input = raw.trim()
  if (input.length === 0 || input.length > MAX_AUDIO_URL_LENGTH) return rejectUrl('INVALID_URL')

  let url: URL
  try {
    // 必须用 WHATWG 归一化：它会把 2130706433 / 0x7f000001 / 0177.0.0.1 / 127.1
    // 这些特殊写法统一还原成点分十进制，否则按字符串判断会被绕过。
    url = new URL(input)
  } catch {
    return rejectUrl('INVALID_URL')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return rejectUrl('INVALID_URL')
  if (url.username !== '' || url.password !== '') return rejectUrl('INVALID_URL')

  const host = url.hostname
  if (host === '') return rejectUrl('INVALID_URL')

  // WHATWG URL 对 IPv6 字面量保留方括号（如 "[::1]"），先剥掉再判断
  const bareHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host

  // IPv6 字面量 fail-closed：见上方说明
  if (bareHost.includes(':')) return rejectUrl('BLOCKED_TARGET')

  const ipv4 = parseIpv4Literal(bareHost)
  if (ipv4 !== null) {
    return isBlockedIpv4(ipv4) ? rejectUrl('BLOCKED_TARGET') : { ok: true, url: url.toString() }
  }

  const lowerHost = bareHost.toLowerCase().replace(/\.+$/, '')
  if (lowerHost === '') return rejectUrl('INVALID_URL')

  // 单标签主机名（如 intranet、router）不是公网 FQDN，保守拒绝
  if (!lowerHost.includes('.')) return rejectUrl('BLOCKED_TARGET')

  for (const suffix of BLOCKED_HOST_SUFFIXES) {
    if (lowerHost === suffix || lowerHost.endsWith(`.${suffix}`)) return rejectUrl('BLOCKED_TARGET')
  }

  return { ok: true, url: url.toString() }
}

// ── 音频实例（模块作用域、惰性、全局唯一）─────────────────────

let audioElement: HTMLAudioElement | null = null
/** 当前这一轮加载注册的监听器解绑函数；换集/关闭时必须调用 */
let detachListeners: (() => void) | null = null
/** 加载代次：每次 load 自增，旧代次的回调一律作废 */
let loadEpoch = 0

/** 只在需要时创建；Node 等无 DOM 环境返回 null，便于离线测试不崩 */
function ensureAudioElement(): HTMLAudioElement | null {
  if (audioElement) return audioElement
  const ctor = (globalThis as { Audio?: new () => HTMLAudioElement }).Audio
  if (typeof ctor !== 'function') return null
  try {
    audioElement = new ctor()
  } catch {
    /* 构造失败当作不可用 */
    audioElement = null
  }
  return audioElement
}

/** 把 MediaError 翻成用户能懂的话 */
function describeMediaError(error: MediaError | null): string {
  switch (error?.code) {
    case 1:
      return '播放被中止'
    case 2:
      return '音频加载失败，请检查网络'
    case 3:
      return '音频解码失败，文件可能已损坏'
    case 4:
      return '音频地址不可用或格式不受支持'
    default:
      return '音频播放失败'
  }
}

export const usePlayerStore = defineStore('player', () => {
  // ── state ────────────────────────────────────────────────
  const current = ref<PlayingEpisode | null>(null)
  const status = ref<PlayerStatus>('idle')
  /** 当前播放位置（秒） */
  const currentTime = ref(0)
  const volume = ref(0.8)
  const playbackRate = ref(1)
  /** 真实时长（秒）。元数据未就绪时为 0（不返回 NaN 给界面） */
  const duration = ref(0)
  /** 给界面看的错误文案；只在 status === 'error' 时有意义 */
  const errorMessage = ref<string | null>(null)

  // ── getters ──────────────────────────────────────────────
  const hasCurrent = computed(() => current.value !== null)

  /** 与真实播放状态一致：只有音频确实在响才是 true */
  const isPlaying = computed(() => status.value === 'playing')

  /** 时长未知时不允许 seek，避免把 currentTime 设成非法值 */
  const canSeek = computed(() => {
    const total = duration.value
    if (!Number.isFinite(total) || total <= 0) return false
    return status.value === 'playing' || status.value === 'paused' || status.value === 'ended'
  })

  /** 兼容 PlayerBar 现有的显示逻辑：优先真实时长，其次加入时已知的时长 */
  const currentDurationText = computed(() => {
    if (!current.value) return ''
    const real = duration.value
    const fallback = current.value.duration
    return formatDuration(Number.isFinite(real) && real > 0 ? real : fallback)
  })

  // ── 内部工具 ──────────────────────────────────────────────
  /** 摘下监听、停掉声音、释放资源的引用（保留元素本身以便复用） */
  function releaseElement(): void {
    if (detachListeners) {
      detachListeners()
      detachListeners = null
    }
    const el = audioElement
    if (!el) return
    try {
      el.pause()
      el.removeAttribute('src')
      el.load()
    } catch {
      /* 未就绪元素上调用可能抛错，忽略 */
    }
  }

  /** 从元素同步真实时长；拿不到就退回「加入时已知」的时长 */
  function syncDuration(el: HTMLAudioElement): void {
    const real = Number(el.duration)
    if (Number.isFinite(real) && real > 0) {
      duration.value = real
      return
    }
    duration.value = current.value?.duration ?? 0
  }

  /** 为「这一代」加载注册监听器；旧代次的事件一律忽略 */
  function bindListeners(el: HTMLAudioElement, epoch: number): void {
    if (detachListeners) {
      detachListeners()
      detachListeners = null
    }
    const edge = () => epoch === loadEpoch
    const offs: Array<() => void> = []

    /**
     * 恢复上次进度：只在这一次加载里执行一次。
     * 依赖 edge() 保证旧节目的异步回调不会把位置写到新节目上；
     * 时长未知或已接近结尾时放弃恢复，避免一开播就结束。
     */
    let resumeApplied = false
    const applyResume = (media: HTMLAudioElement) => {
      if (resumeApplied) return
      resumeApplied = true
      if (!edge()) return
      const target = current.value?.startAt ?? 0
      if (!Number.isFinite(target) || target <= 0) return
      const total = Number(media.duration)
      if (!Number.isFinite(total) || total <= 0) return
      if (target >= total - 3) return
      media.currentTime = target
      currentTime.value = target
    }

    const on = (type: string, handler: EventListener) => {
      el.addEventListener(type, handler)
      offs.push(() => el.removeEventListener(type, handler))
    }

    on('playing', () => {
      if (!edge()) return
      status.value = 'playing'
      errorMessage.value = null
    })
    on('pause', () => {
      if (!edge()) return
      if (status.value === 'playing') status.value = 'paused'
    })
    on('timeupdate', () => {
      if (!edge()) return
      const t = Number(el.currentTime)
      currentTime.value = Number.isFinite(t) && t > 0 ? t : 0
    })
    on('loadedmetadata', () => {
      if (!edge()) return
      syncDuration(el)
      applyResume(el)
    })
    on('durationchange', () => {
      if (!edge()) return
      syncDuration(el)
    })
    on('ended', () => {
      if (!edge()) return
      status.value = 'ended'
      currentTime.value = duration.value
    })
    on('error', () => {
      if (!edge()) return
      status.value = 'error'
      errorMessage.value = describeMediaError(el.error)
    })

    detachListeners = () => {
      for (const off of offs) off()
    }
  }

  /**
   * 调用 play()，并吞掉「因暂停/换集产生的中断」。
   * AbortError 不算失败——那正是我们自己 pause() 造成的。
   */
  async function startPlayback(epoch: number): Promise<void> {
    const el = audioElement
    if (!el) return
    if (epoch !== loadEpoch) return
    try {
      await el.play()
      if (epoch !== loadEpoch) return
      // play() 成功即表示音频在走。除了已经进入 error/unavailable，
      // 其余状态（idle/loading/paused/ended）都应回到 playing
      // —— 尤其是 ended 后重播，否则状态会卡在 ended。
      if (status.value !== 'error' && status.value !== 'unavailable') status.value = 'playing'
    } catch (error) {
      if (epoch !== loadEpoch) return
      const name = (error as { name?: string } | null)?.name
      if (name === 'AbortError') return
      status.value = 'error'
      errorMessage.value =
        name === 'NotAllowedError'
          ? '浏览器阻止了自动播放，请点击播放按钮重试'
          : '音频播放失败，请检查网络或音频地址'
    }
  }

  /**
   * 统一的进度来源：由 App 启动时注入（history.resumePosition）。
   * 在播放器内部解析，各页面就不必各自传 startAt，也不会漏掉任何入口。
   */
  let resumeResolver: ((key: string) => number) | null = null

  function setResumeResolver(resolver: ((key: string) => number) | null): void {
    resumeResolver = resolver
  }

  /** 起播位置：显式传入优先，其次查历史，最后从头 */
  function resolveStartAt(episode: PlayingEpisode): number {
    if (typeof episode.startAt === 'number' && Number.isFinite(episode.startAt) && episode.startAt > 0) {
      return episode.startAt
    }
    if (resumeResolver === null) return 0
    try {
      const value = resumeResolver(episode.id)
      return Number.isFinite(value) && value > 0 ? value : 0
    } catch {
      return 0
    }
  }

  /** 换集/首次播放：校验地址 → 建监听 → 设 src → 开始播 */
  function loadEpisode(episode: PlayingEpisode): void {
    const rawUrl = episode.audioUrl ?? null
    current.value = { ...episode, audioUrl: rawUrl, startAt: resolveStartAt(episode) }
    currentTime.value = 0
    errorMessage.value = null

    // 先让旧代次失效并释放，避免旧音频继续响、旧事件污染新状态
    loadEpoch += 1
    releaseElement()

    if (!rawUrl) {
      // 示例数据这种情况：明确进入 unavailable，而不是假装在播
      status.value = 'unavailable'
      duration.value = episode.duration > 0 ? episode.duration : 0
      return
    }

    const checked = assertPlayableAudioUrl(rawUrl)
    if (!checked.ok) {
      status.value = 'error'
      errorMessage.value = checked.message
      duration.value = 0
      return
    }

    const el = ensureAudioElement()
    if (!el) {
      status.value = 'error'
      errorMessage.value = '当前环境不支持音频播放'
      duration.value = 0
      return
    }

    const epoch = loadEpoch
    bindListeners(el, epoch)
    status.value = 'loading'
    duration.value = episode.duration > 0 ? episode.duration : 0

    try {
      el.preload = 'auto'
      el.volume = volume.value
      el.playbackRate = playbackRate.value
      el.src = checked.url
      el.load()
    } catch {
      status.value = 'error'
      errorMessage.value = '音频地址无法加载'
      return
    }

    void startPlayback(epoch)
  }

  // ── actions ──────────────────────────────────────────────
  /**
   * 播放一集。
   * 同一集的行为：暂停→续播；已结束→从头；出错→重试；正在播→什么都不做。
   */
  function play(episode: PlayingEpisode): void {
    const sameEpisode = current.value?.id === episode.id &&
      (current.value?.audioUrl ?? null) === (episode.audioUrl ?? null)

    if (!sameEpisode) {
      loadEpisode(episode)
      return
    }

    switch (status.value) {
      case 'playing':
      case 'loading':
        return
      case 'paused':
        void startPlayback(loadEpoch)
        return
      case 'ended':
        seek(0)
        void startPlayback(loadEpoch)
        return
      case 'error':
      case 'unavailable':
        // 重试：完整重新加载一次（地址可能已变，也允许用户重新点）
        loadEpisode(episode)
        return
      default:
        loadEpisode(episode)
    }
  }

  /** 播放/暂停切换（底部播放条按钮用） */
  function toggle(): void {
    const episode = current.value
    if (!episode) return

    switch (status.value) {
      case 'playing': {
        const el = audioElement
        if (el) {
          try {
            el.pause()
          } catch {
            /* 忽略 */
          }
        }
        status.value = 'paused'
        return
      }
      case 'paused':
        void startPlayback(loadEpoch)
        return
      case 'ended':
        seek(0)
        void startPlayback(loadEpoch)
        return
      case 'error':
      case 'unavailable':
      case 'idle':
        play(episode)
        return
      default:
        return
    }
  }

  /** 跳转到指定秒数；元数据未就绪时不做任何事（避免把 currentTime 写成非法值） */
  function seek(seconds: number): void {
    const el = audioElement
    if (!el || !canSeek.value) return
    const total = duration.value
    const raw = Number.isFinite(seconds) ? seconds : 0
    // canSeek 已保证 total > 0，这里只需夹到 [0, total]
    const target = Math.min(Math.max(raw, 0), total)
    try {
      el.currentTime = target
    } catch {
      return
    }
    currentTime.value = target
  }

  /** 关闭播放器：停声、摘监听、清状态 */
  function close(): void {
    loadEpoch += 1
    releaseElement()
    current.value = null
    status.value = 'idle'
    currentTime.value = 0
    duration.value = 0
    errorMessage.value = null
  }

  function setVolume(value: number): void {
    if (!Number.isFinite(value)) return
    volume.value = Math.min(1, Math.max(0, value))
    if (audioElement) audioElement.volume = volume.value
  }

  function setPlaybackRate(value: number): void {
    if (!Number.isFinite(value) || value < 0.5 || value > 3) return
    playbackRate.value = value
    if (audioElement) audioElement.playbackRate = value
  }

  function pause(): void {
    if (status.value === 'playing') toggle()
    else if (status.value === 'loading' && audioElement) {
      audioElement.pause()
      status.value = 'paused'
    }
  }

  return {
    volume,
    playbackRate,
    setVolume,
    setPlaybackRate,
    pause,
    current,
    status,
    currentTime,
    duration,
    errorMessage,
    hasCurrent,
    isPlaying,
    canSeek,
    currentDurationText,
    play,
    toggle,
    seek,
    close,
    setResumeResolver,
  }
})

/** 把秒格式化成 mm:ss（超过 1 小时显示 h:mm:ss）；非法值按 0 处理 */
function formatDuration(totalSeconds: number): string {
  const safe = Number.isFinite(totalSeconds) && totalSeconds > 0 ? Math.floor(totalSeconds) : 0
  const hours = Math.floor(safe / 3600)
  const minutes = Math.floor((safe % 3600) / 60)
  const seconds = safe % 60
  const mm = String(minutes).padStart(2, '0')
  const ss = String(seconds).padStart(2, '0')
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`
}
