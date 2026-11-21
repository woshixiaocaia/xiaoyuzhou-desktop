// 队列与收听历史测试：离线运行，用假 Audio 与假 localStorage。
import test from 'node:test'
import assert from 'node:assert/strict'

// ── 假音频元素（与 player 测试一致的最小实现）────────────────────
class FakeAudio {
  constructor() {
    FakeAudio.instance = this
    this.src = ''
    this.preload = ''
    this.duration = NaN
    this.currentTime = 0
    this.paused = true
    this.error = null
    this.listeners = new Map()
    this.playCalls = 0
    this.loadCalls = 0
    this.playImpl = () => Promise.resolve()
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type).add(fn)
  }
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn)
  }
  dispatch(type) {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn({ type, target: this })
  }
  load() { this.loadCalls += 1 }
  removeAttribute(name) { if (name === 'src') this.src = '' }
  pause() { this.paused = true; this.dispatch('pause') }
  play() { this.playCalls += 1; this.paused = false; return this.playImpl() }
  emitPlaying() { this.dispatch('playing') }
  emitEnded() { this.paused = true; this.dispatch('ended') }
  emitMeta(d) { this.duration = d; this.dispatch('durationchange'); this.dispatch('loadedmetadata') }
}
globalThis.Audio = FakeAudio

// ── 假 localStorage ──────────────────────────────────────────────
function installFakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial))
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => void map.set(k, String(v)),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size },
  }
  return map
}
installFakeStorage()

const { createPinia, setActivePinia } = await import('pinia')
const { useHistoryStore, episodeKey, readStoredHistory } = await import('@/stores/history')
const { useQueueStore, queueItemFromEpisode } = await import('@/stores/queue')
const { usePlayerStore } = await import('@/stores/player')

const tick = () => new Promise((r) => setTimeout(r, 0))
const fresh = () => {
  setActivePinia(createPinia())
  return { history: useHistoryStore(), queue: useQueueStore(), player: usePlayerStore() }
}

const EP_OFFICIAL = {
  id: 'official:e1',
  title: '官方单集',
  podcast: '官方节目',
  duration: 100,
  audioUrl: 'https://cdn.example.com/official.m4a',
  source: 'official',
}
const EP_RSS = {
  id: 'rss-guid-1',
  title: 'RSS 单集',
  podcast: 'RSS 节目',
  duration: 200,
  audioUrl: 'https://cdn.example.com/rss.mp3',
  source: 'rss',
}

// ── 节目身份 ────────────────────────────────────────────────────
test('节目身份带来源前缀，且不会重复加前缀', () => {
  assert.equal(episodeKey('official', 'e1'), 'official:e1')
  assert.equal(episodeKey('official', 'official:e1'), 'official:e1')
  assert.equal(episodeKey('rss', 'guid-1'), 'rss:guid-1')
  // 不同来源的同名单集必须是两条记录
  assert.notEqual(episodeKey('rss', 'x'), episodeKey('official', 'x'))
})

// ── 历史与进度 ──────────────────────────────────────────────────
test('记录进度后可按 key 恢复，暂停状态下也写盘', () => {
  installFakeStorage()
  const { history } = fresh()
  history.record({ key: 'rss:a', source: 'rss', id: 'a', title: 'A', podcast: 'P', position: 42, duration: 100, force: true })
  assert.equal(history.resumePosition('rss:a'), 42)
  const stored = JSON.parse(globalThis.localStorage.getItem('xiaoyuzhou.history.v1'))
  assert.equal(stored.version, 1)
  assert.equal(stored.entries[0].position, 42)
  assert.equal(stored.entries[0].audioUrl, undefined, '不应把音频地址写进历史')
})

test('听完的节目标记为 completed，下次从 0 开始', () => {
  installFakeStorage()
  const { history } = fresh()
  history.record({ key: 'official:e1', source: 'official', id: 'e1', title: 'A', podcast: 'P', position: 90, duration: 100, completed: true, force: true })
  assert.equal(history.isCompleted('official:e1'), true)
  assert.equal(history.resumePosition('official:e1'), 0)
})

test('位置太靠前不产生新记录（避免一进一出就有脏数据）', () => {
  installFakeStorage()
  const { history } = fresh()
  history.record({ key: 'rss:a', source: 'rss', id: 'a', title: 'A', podcast: 'P', position: 1, duration: 100, force: true })
  assert.equal(history.entries.length, 0)
})

test('同名但来源不同的节目是两条独立记录', () => {
  installFakeStorage()
  const { history } = fresh()
  history.record({ key: 'rss:same', source: 'rss', id: 'same', title: '同名', podcast: 'P', position: 30, duration: 60, force: true })
  history.record({ key: 'official:same', source: 'official', id: 'same', title: '同名', podcast: 'P', position: 50, duration: 60, force: true })
  assert.equal(history.entries.length, 2)
  assert.equal(history.resumePosition('rss:same'), 30)
  assert.equal(history.resumePosition('official:same'), 50)
})

test('历史条数有上限，超出后丢弃最旧的', () => {
  installFakeStorage()
  const { history } = fresh()
  for (let i = 0; i < 210; i += 1) {
    history.record({ key: `rss:${i}`, source: 'rss', id: String(i), title: `t${i}`, podcast: 'P', position: 10, duration: 100, force: true })
  }
  assert.equal(history.entries.length, 200)
})

test('本地数据损坏时退化为空历史，不抛异常', () => {
  installFakeStorage({ 'xiaoyuzhou.history.v1': '{not json' })
  const { history } = fresh()
  assert.deepEqual(history.entries, [])
  assert.deepEqual(readStoredHistory(globalThis.localStorage), [])
})

test('可以清理单条与全部历史', () => {
  installFakeStorage()
  const { history } = fresh()
  history.record({ key: 'rss:a', source: 'rss', id: 'a', title: 'A', podcast: 'P', position: 20, duration: 60, force: true })
  history.record({ key: 'rss:b', source: 'rss', id: 'b', title: 'B', podcast: 'P', position: 20, duration: 60, force: true })
  history.remove('rss:a')
  assert.equal(history.entries.length, 1)
  history.clear()
  assert.equal(history.entries.length, 0)
})

// ── 队列 ────────────────────────────────────────────────────────
test('入队、重复检测、混合来源', () => {
  installFakeStorage()
  const { queue } = fresh()
  const a = queueItemFromEpisode(EP_OFFICIAL)
  const b = queueItemFromEpisode(EP_RSS)
  assert.equal(queue.add(a), 'added')
  assert.equal(queue.add(b), 'added')
  assert.equal(queue.add(a), 'duplicate')
  assert.equal(queue.length, 2)
  assert.deepEqual(queue.items.map((i) => i.source), ['official', 'rss'])
})

test('没有音频地址的节目不入队', () => {
  const item = queueItemFromEpisode({ ...EP_RSS, audioUrl: null })
  assert.equal(item, null)
})

test('播放指定项会交给播放器，索引同步', async () => {
  installFakeStorage()
  const { queue, player } = fresh()
  queue.add(queueItemFromEpisode(EP_OFFICIAL))
  queue.add(queueItemFromEpisode(EP_RSS))

  queue.playAt(1)
  await tick()
  assert.equal(player.current.id, 'rss:rss-guid-1')
  assert.equal(queue.index, 1)
  assert.equal(queue.current.key, 'rss:rss-guid-1')
})

test('上一集 / 下一集边界：首项无上一集，末项无下一集', async () => {
  installFakeStorage()
  const { queue } = fresh()
  queue.add(queueItemFromEpisode(EP_OFFICIAL))
  queue.add(queueItemFromEpisode(EP_RSS))
  queue.playAt(0)

  assert.equal(queue.hasPrev, false)
  assert.equal(queue.prev(), false)
  assert.equal(queue.hasNext, true)
  assert.equal(queue.next(), true)
  await tick()
  assert.equal(queue.index, 1)
  assert.equal(queue.hasNext, false)
  assert.equal(queue.next(), false)
})

test('移除当前项时索引指向下一集且不会自动播放', async () => {
  installFakeStorage()
  const { queue, player } = fresh()
  queue.add(queueItemFromEpisode(EP_OFFICIAL))
  queue.add(queueItemFromEpisode(EP_RSS))
  queue.playAt(0)
  await tick()
  const before = player.current.id

  queue.removeAt(0)
  assert.equal(queue.length, 1)
  assert.equal(queue.index, 0)
  assert.equal(player.current.id, before, '仅仅移除队列项不应切换正在播放的节目')
})

test('清空队列后索引归 -1，next/prev 安全返回 false', () => {
  installFakeStorage()
  const { queue } = fresh()
  queue.add(queueItemFromEpisode(EP_OFFICIAL))
  queue.clear()
  assert.equal(queue.isEmpty, true)
  assert.equal(queue.index, -1)
  assert.equal(queue.next(), false)
  assert.equal(queue.prev(), false)
})

test('播放结束后自动播放下一集（混合来源）', async () => {
  installFakeStorage()
  const { queue, player } = fresh()
  queue.bindToPlayer()
  queue.add(queueItemFromEpisode(EP_OFFICIAL))
  queue.add(queueItemFromEpisode(EP_RSS))

  queue.playAt(0)
  await tick()
  FakeAudio.instance.emitPlaying()
  assert.equal(player.status, 'playing')

  FakeAudio.instance.emitEnded()
  await tick()
  assert.equal(queue.index, 1)
  assert.equal(player.current.id, 'rss:rss-guid-1')
})

test('队列结束时不循环，停在最后一集', async () => {
  installFakeStorage()
  const { queue, player } = fresh()
  queue.add(queueItemFromEpisode(EP_OFFICIAL))
  queue.playAt(0)
  await tick()
  FakeAudio.instance.emitEnded()
  await tick()
  assert.equal(queue.index, 0)
  assert.equal(player.current.id, 'official:e1')
})

// ── 进度恢复（阶段 C 接入播放器）────────────────────────────────

test('元数据就绪后按 startAt 恢复进度，且只应用一次', async () => {
  installFakeStorage()
  const { player } = fresh()
  player.play({ ...EP_RSS, id: 'rss:resume-1', startAt: 42 })
  await tick()
  FakeAudio.instance.emitMeta(100)
  assert.equal(player.currentTime, 42)
  // 再次触发元数据事件不应把位置重置回去
  FakeAudio.instance.currentTime = 55
  FakeAudio.instance.emitMeta(100)
  assert.equal(player.currentTime, 42, '恢复只应发生一次')
})

test('没有历史进度时不改动播放位置', async () => {
  installFakeStorage()
  const { player } = fresh()
  player.play({ ...EP_RSS, id: 'rss:no-resume' })
  await tick()
  FakeAudio.instance.emitMeta(100)
  assert.equal(player.currentTime, 0)
})

test('接近结尾的历史进度丢弃，避免一开播就结束', async () => {
  installFakeStorage()
  const { player } = fresh()
  player.play({ ...EP_RSS, id: 'rss:near-end', startAt: 99 })
  await tick()
  FakeAudio.instance.emitMeta(100)
  assert.equal(player.currentTime, 0)
})

test('时长未知时不恢复（无法判断是否接近结尾）', async () => {
  installFakeStorage()
  const { player } = fresh()
  player.play({ ...EP_RSS, id: 'rss:unknown-duration', startAt: 30 })
  await tick()
  FakeAudio.instance.duration = NaN
  FakeAudio.instance.dispatch('loadedmetadata')
  assert.equal(player.currentTime, 0)
})

test('切歌后旧的元数据回调不会覆盖新节目', async () => {
  installFakeStorage()
  const { player } = fresh()
  const first = FakeAudio.instance

  player.play({ ...EP_RSS, id: 'rss:old', startAt: 30 })
  await tick()
  const stale = FakeAudio.instance

  player.play({ ...EP_OFFICIAL, id: 'official:new', startAt: 10 })
  await tick()

  // 旧元素迟到的元数据事件：因为代次已变，必须被忽略
  stale.emitMeta(200)
  assert.notEqual(player.current?.id, 'rss:old')
  assert.equal(player.current?.id, 'official:new')

  FakeAudio.instance.emitMeta(100)
  assert.equal(player.currentTime, 10)
  assert.notEqual(first, null)
})

test('队列播放会带上历史进度，已听完的节目从头开始', async () => {  installFakeStorage()
  const { history, queue, player } = fresh()

  history.record({ key: 'rss:rss-guid-1', source: 'rss', id: 'rss-guid-1', title: 'A', podcast: 'P', position: 40, duration: 200, force: true })
  queue.add(queueItemFromEpisode(EP_RSS))
  queue.playAt(0)
  await tick()
  FakeAudio.instance.emitMeta(200)
  assert.equal(player.currentTime, 40)

  // 标记为已听完后，再播同一集应从头开始
  history.record({ key: 'rss:rss-guid-1', source: 'rss', id: 'rss-guid-1', title: 'A', podcast: 'P', position: 200, duration: 200, completed: true, force: true })
  assert.equal(history.resumePosition('rss:rss-guid-1'), 0)
})

// ── 统一进度来源（播放器内部解析）────────────────────────────────

test('未显式传 startAt 时，播放器用注入的 resolver 恢复进度', async () => {
  installFakeStorage()
  const { player } = fresh()
  player.setResumeResolver((key) => (key === 'rss:rescued' ? 55 : 0))

  player.play({ ...EP_RSS, id: 'rss:rescued' })
  await tick()
  FakeAudio.instance.emitMeta(200)
  assert.equal(player.currentTime, 55)
})

test('显式 startAt 优先于 resolver', async () => {
  installFakeStorage()
  const { player } = fresh()
  player.setResumeResolver(() => 55)

  player.play({ ...EP_RSS, id: 'rss:explicit', startAt: 12 })
  await tick()
  FakeAudio.instance.emitMeta(200)
  assert.equal(player.currentTime, 12)
})

test('resolver 抛异常时退化为从头播放，不影响播放', async () => {
  installFakeStorage()
  const { player } = fresh()
  player.setResumeResolver(() => {
    throw new Error('boom')
  })

  player.play({ ...EP_RSS, id: 'rss:broken-resolver' })
  await tick()
  FakeAudio.instance.emitMeta(200)
  assert.equal(player.currentTime, 0)
  assert.equal(player.status !== 'error', true)
})

test('resolver 返回 0（无历史或已听完）时从头播放', async () => {
  installFakeStorage()
  const { player } = fresh()
  player.setResumeResolver(() => 0)

  player.play({ ...EP_OFFICIAL, id: 'official:no-history' })
  await tick()
  FakeAudio.instance.emitMeta(120)
  assert.equal(player.currentTime, 0)
})
