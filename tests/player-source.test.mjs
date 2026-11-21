// 播放器来源隔离测试：RSS 与官方单集的 ID 不能互相干扰。
// 仍然使用假的 Audio 元素——这验证的是状态机与 ID 语义，不是真实解码。
import test from 'node:test'
import assert from 'node:assert/strict'

class FakeAudio {
  constructor() {
    FakeAudio.created += 1
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
    const set = this.listeners.get(type)
    if (set) set.delete(fn)
  }
  dispatch(type) {
    const set = this.listeners.get(type)
    if (!set) return
    for (const fn of [...set]) fn({ type, target: this })
  }
  load() { this.loadCalls += 1 }
  removeAttribute(name) { if (name === 'src') this.src = '' }
  pause() { this.paused = true; this.dispatch('pause') }
  play() { this.playCalls += 1; this.paused = false; return this.playImpl() }
  emitPlaying() { this.dispatch('playing') }
  emitMeta(d) { this.duration = d; this.dispatch('durationchange'); this.dispatch('loadedmetadata') }
}
FakeAudio.created = 0
globalThis.Audio = FakeAudio

const { createPinia, setActivePinia } = await import('pinia')
const { usePlayerStore } = await import('@/stores/player')

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const fresh = () => { setActivePinia(createPinia()); return usePlayerStore() }

// 音频元素是模块级单例、惰性创建：先跑一次把实例建出来，后面才能拿到它注入行为
{
  const bootstrap = fresh()
  bootstrap.play({ id: 'bootstrap', title: '引导', podcast: 'x', duration: 1, audioUrl: 'https://cdn.example.com/boot.mp3' })
  await tick()
  bootstrap.close()
}

const OFFICIAL = {
  id: 'official:e1',
  title: '官方单集',
  podcast: '官方节目',
  duration: 100,
  audioUrl: 'https://cdn.example.com/official.m4a',
  source: 'official',
}
const RSS = {
  id: 'rss-guid-1',
  title: 'RSS 单集',
  podcast: 'RSS 节目',
  duration: 200,
  audioUrl: 'https://cdn.example.com/rss.mp3',
  source: 'rss',
}

test('官方单集可以进入同一播放器，且状态机照常工作', async () => {
  const store = fresh()
  FakeAudio.instance.playImpl = () => Promise.resolve()
  store.play(OFFICIAL)
  await tick()
  FakeAudio.instance.emitPlaying()

  assert.equal(store.status, 'playing')
  assert.equal(store.current.id, 'official:e1')
  assert.equal(store.current.source, 'official')
  assert.equal(FakeAudio.instance.src, 'https://cdn.example.com/official.m4a')
})

test('RSS 与官方单集可以互相切换（不同 ID 会重新加载）', async () => {
  const store = fresh()
  FakeAudio.instance.playImpl = () => Promise.resolve()
  store.play(OFFICIAL)
  await tick()
  const loadsAfterOfficial = FakeAudio.instance.loadCalls

  store.play(RSS)
  await tick()
  assert.ok(FakeAudio.instance.loadCalls > loadsAfterOfficial, '切换到另一来源应重新加载')
  assert.equal(store.current.id, 'rss-guid-1')
  assert.equal(store.current.source, 'rss')

  store.play(OFFICIAL)
  await tick()
  assert.equal(store.current.id, 'official:e1')
})

test('同一 ID 重复播放不会重新加载（暂停时是继续）', async () => {
  const store = fresh()
  FakeAudio.instance.playImpl = () => Promise.resolve()
  store.play(OFFICIAL)
  await tick()
  FakeAudio.instance.emitPlaying()
  store.toggle() // 暂停
  assert.equal(store.status, 'paused')

  const loads = FakeAudio.instance.loadCalls
  store.play(OFFICIAL)
  await tick()
  assert.equal(FakeAudio.instance.loadCalls, loads, '同集继续播放不应重新加载')
  assert.equal(store.status, 'playing')
})

test('命名的 ID 空间能避免两个来源撞车：official:e1 与 e1 被视为不同单集', async () => {
  const store = fresh()
  FakeAudio.instance.playImpl = () => Promise.resolve()
  store.play({ ...OFFICIAL, id: 'official:e1' })
  await tick()
  const loads = FakeAudio.instance.loadCalls

  store.play({ ...RSS, id: 'e1' })
  await tick()
  assert.ok(FakeAudio.instance.loadCalls > loads, '去掉前缀后应被视为另一个单集')
  assert.equal(store.current.id, 'e1')
})

test('官方单集没有音频地址时进入 unavailable，不会假装在播', async () => {
  const store = fresh()
  store.play({ ...OFFICIAL, audioUrl: null })
  assert.equal(store.status, 'unavailable')
  assert.equal(store.isPlaying, false)
})
