// 播放器 store 测试：状态机、单实例、事件清理、音频地址预检
import test from 'node:test'
import assert from 'node:assert/strict'

// ── 假 Audio 元素（Node 里没有 DOM）──────────────────────────
class FakeAudio {
  constructor() {
    FakeAudio.created += 1
    FakeAudio.instances.push(this)
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
  listenerTotal() {
    let total = 0
    for (const set of this.listeners.values()) total += set.size
    return total
  }
  load() { this.loadCalls += 1 }
  removeAttribute(name) { if (name === 'src') this.src = '' }
  pause() { this.paused = true; this.dispatch('pause') }
  play() { this.playCalls += 1; this.paused = false; return this.playImpl() }
  emitPlaying() { this.dispatch('playing') }
  emitMeta(d) { this.duration = d; this.dispatch('durationchange'); this.dispatch('loadedmetadata') }
  emitTime(t) { this.currentTime = t; this.dispatch('timeupdate') }
  emitEnded() { this.dispatch('ended') }
  emitError(code) { this.error = { code }; this.dispatch('error') }
}
FakeAudio.created = 0
FakeAudio.instances = []
globalThis.Audio = FakeAudio

const { createPinia, setActivePinia } = await import('pinia')
const { usePlayerStore, assertPlayableAudioUrl } = await import('@/stores/player')

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
const el = () => FakeAudio.instances[0]
const freshStore = () => { setActivePinia(createPinia()); return usePlayerStore() }

const EP1 = { id: 'ep-1', title: '第一集', podcast: '测试播客', duration: 100, audioUrl: 'https://cdn.example.com/a.mp3' }
const EP2 = { id: 'ep-2', title: '第二集', podcast: '测试播客', duration: 200, audioUrl: 'https://cdn.example.com/b.mp3' }

// 音频实例是模块级单例、惰性创建，所以要先用一次 play 把它建出来，
// 后面的用例才能通过 el() 拿到同一个元素并注入行为。
{
  const bootstrap = freshStore()
  bootstrap.play(EP1)
  await tick()
  bootstrap.close()
}

test('播放：先 loading，收到 playing 事件后才是 playing', async () => {
  const store = freshStore()
  el().playImpl = () => new Promise(() => {}) // 挂住，观察 loading
  store.play(EP1)

  assert.equal(store.status, 'loading')
  assert.equal(store.isPlaying, false) // 只点击不算在播
  assert.equal(el().src, 'https://cdn.example.com/a.mp3')

  el().emitPlaying()
  assert.equal(store.status, 'playing')
  assert.equal(store.isPlaying, true)
})

test('暂停/继续：状态与元素一致，续播不重置进度', async () => {
  const store = freshStore()
  el().playImpl = () => Promise.resolve()
  store.play(EP1)
  await tick()
  el().emitMeta(120)
  el().emitTime(30)

  store.toggle()
  assert.equal(store.status, 'paused')
  assert.equal(el().paused, true)

  const before = el().playCalls
  store.toggle()
  await tick()
  assert.equal(store.status, 'playing')
  assert.ok(el().playCalls > before)
  assert.equal(store.currentTime, 30)
})

test('播放结束后再播同一集从头开始', async () => {
  const store = freshStore()
  el().playImpl = () => Promise.resolve()
  store.play(EP1)
  await tick()
  el().emitMeta(100)
  el().emitTime(100)
  el().emitEnded()
  assert.equal(store.status, 'ended')

  store.play(EP1)
  await tick()
  assert.equal(store.status, 'playing')
  assert.equal(store.currentTime, 0)
})

test('error 事件映射成中文提示', async () => {
  const store = freshStore()
  el().playImpl = () => Promise.resolve()
  store.play(EP1)
  await tick()
  el().emitError(4)
  assert.equal(store.status, 'error')
  assert.ok(store.errorMessage.includes('格式'))
})

test('play() 被拒绝时进入 error，不会产生未处理拒绝', async () => {
  const store = freshStore()
  el().playImpl = () => Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }))
  store.play(EP1)
  await tick()
  await tick()
  assert.equal(store.status, 'error')
  assert.ok(store.errorMessage.includes('自动播放'))
})

test('close 之后状态清空、监听摘除，后续事件不再影响状态', async () => {
  const store = freshStore()
  el().playImpl = () => Promise.resolve()
  store.play(EP1)
  await tick()
  el().emitMeta(100)

  store.close()
  assert.equal(store.status, 'idle')
  assert.equal(store.current, null)
  assert.equal(el().listenerTotal(), 0)
  assert.equal(el().src, '')

  el().emitPlaying()
  el().emitTime(50)
  el().emitError(2)
  assert.equal(store.status, 'idle')
  assert.equal(store.currentTime, 0)
  assert.equal(store.errorMessage, null)
})

test('没有音频地址时进入 unavailable，且不调用 play()', async () => {
  const store = freshStore()
  const before = el().playCalls
  store.play({ id: 'sample', title: '示例', podcast: '示例播客', duration: 300 })

  assert.equal(store.status, 'unavailable')
  assert.equal(store.isPlaying, false)
  assert.equal(el().playCalls, before)
})

test('反复切换单集只创建一个音频实例，监听不累积', async () => {
  const store = freshStore()
  el().playImpl = () => Promise.resolve()
  store.play(EP1)
  await tick()
  const baselineListeners = el().listenerTotal()

  for (let i = 0; i < 10; i += 1) {
    store.play(i % 2 === 0 ? EP2 : EP1)
    await tick()
  }

  assert.equal(FakeAudio.created, 1)
  assert.equal(el().listenerTotal(), baselineListeners)
})

test('音频地址预检：拒绝非 http(s)、userinfo、本机与内网', () => {
  const rejected = [
    [null, 'INVALID_URL'],
    ['', 'INVALID_URL'],
    ['/relative.mp3', 'INVALID_URL'],
    ['ftp://cdn.example.com/a.mp3', 'INVALID_URL'],
    ['https://user:pass@cdn.example.com/a.mp3', 'INVALID_URL'],
    ['http://127.0.0.1:8080/a.mp3', 'BLOCKED_TARGET'],
    ['http://2130706433/a.mp3', 'BLOCKED_TARGET'], // WHATWG 归一化成 127.0.0.1
    ['http://10.1.2.3/a.mp3', 'BLOCKED_TARGET'],
    ['http://192.168.1.5/a.mp3', 'BLOCKED_TARGET'],
    ['http://169.254.169.254/latest/meta-data/', 'BLOCKED_TARGET'],
    ['http://localhost/a.mp3', 'BLOCKED_TARGET'],
    ['http://router/a.mp3', 'BLOCKED_TARGET'],
    ['http://[::1]/a.mp3', 'BLOCKED_TARGET'],
  ]
  for (const [input, code] of rejected) {
    const result = assertPlayableAudioUrl(input)
    assert.equal(result.ok, false, `应拒绝: ${input}`)
    assert.equal(result.code, code, `错误码不符: ${input}`)
  }

  for (const ok of ['https://cdn.example.com/a.mp3', 'http://cdn.example.com/a.mp3']) {
    assert.equal(assertPlayableAudioUrl(ok).ok, true, `应放行: ${ok}`)
  }
})
