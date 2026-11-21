// 官方账号 store 与官方数据 store 的测试：用假的 window.desktop 桥，不联网。
import test from 'node:test'
import assert from 'node:assert/strict'

const { createPinia, setActivePinia } = await import('pinia')
const { useAccountStore, phaseForQrStatus } = await import('@/stores/account')
const { useOfficialStore } = await import('@/stores/official')

/** 每个用例可定制的假桥 */
function installBridge(overrides = {}) {
  const calls = []
  const base = {
    officialAuthStart: async () => {
      calls.push(['start'])
      return { ok: true, id: 'qr-1', url: 'https://h5.xiaoyuzhoufm.com/oauth?qrcode_id=qr-1' }
    },
    officialAuthPoll: async (id) => {
      calls.push(['poll', id])
      return { ok: true, status: 'WAITTING', user: null, storage: 'ok' }
    },
    officialAuthStatus: async () => {
      calls.push(['status'])
      return { ok: true, loggedIn: false, user: null, storageAvailable: true }
    },
    officialAuthLogout: async () => {
      calls.push(['logout'])
      return { ok: true }
    },
    officialSubscriptions: async (cursor) => {
      calls.push(['subscriptions', cursor])
      return { ok: true, payload: { data: [], loadMoreKey: null } }
    },
    officialEpisodes: async (pid, cursor) => {
      calls.push(['episodes', pid, cursor])
      return { ok: true, payload: { data: [], loadMoreKey: null } }
    },
    officialMediaUrl: async (eid) => {
      calls.push(['media', eid])
      return { ok: true, url: 'https://cdn.example.com/x.m4a' }
    },
  }
  globalThis.desktop = { ...base, ...overrides }
  return calls
}

function freshAccount() {
  setActivePinia(createPinia())
  return useAccountStore()
}

function freshOfficial() {
  setActivePinia(createPinia())
  return useOfficialStore()
}

// ── 状态映射 ────────────────────────────────────────────────────

test('扫码状态映射：WAITTING/SCANNED/CONFIRMED/EXPIRED → 对应阶段', () => {
  assert.equal(phaseForQrStatus('WAITTING'), 'waiting')
  assert.equal(phaseForQrStatus('SCANNED'), 'scanned')
  assert.equal(phaseForQrStatus('CONFIRMED'), 'authorized')
  assert.equal(phaseForQrStatus('EXPIRED'), 'expired')
})

// ── 账号 store ──────────────────────────────────────────────────

test('恢复登录状态：桥说已登录时进入 authorized', async () => {
  installBridge({
    officialAuthStatus: async () => ({
      ok: true,
      loggedIn: true,
      user: { uid: 'u1', nickname: '小明', avatar: '' },
      storageAvailable: true,
    }),
  })
  const account = freshAccount()
  await account.restore()
  assert.equal(account.phase, 'authorized')
  assert.equal(account.isLoggedIn, true)
  assert.equal(account.nickname, '小明')
})

test('恢复登录状态：桥报告不支持安全存储时如实反映', async () => {
  installBridge({
    officialAuthStatus: async () => ({ ok: true, loggedIn: false, user: null, storageAvailable: false }),
  })
  const account = freshAccount()
  await account.restore()
  assert.equal(account.phase, 'idle')
  assert.equal(account.storageAvailable, false)
})

test('开始登录：拿到二维码后进入 waiting，取消后回到 idle 并清空地址', async () => {
  const calls = installBridge()
  const account = freshAccount()

  await account.startLogin()
  assert.equal(account.phase, 'waiting')
  assert.match(account.qrUrl, /qrcode_id=qr-1/)
  assert.equal(account.qrId, 'qr-1')
  assert.deepEqual(calls[0], ['start'])

  account.cancel()
  assert.equal(account.phase, 'idle')
  assert.equal(account.qrUrl, '')
  assert.equal(account.qrId, '')
})

test('开始登录失败：进入 error 并保留可读提示', async () => {
  installBridge({
    officialAuthStart: async () => ({ ok: false, code: 'NETWORK', message: '网络请求失败，请检查网络或代理设置' }),
  })
  const account = freshAccount()
  await account.startLogin()
  assert.equal(account.phase, 'error')
  assert.match(account.errorMessage, /网络/)
})

test('退出登录：调用桥并回到 idle', async () => {
  const calls = installBridge({
    officialAuthStatus: async () => ({
      ok: true,
      loggedIn: true,
      user: { uid: 'u1', nickname: '小明', avatar: '' },
      storageAvailable: true,
    }),
  })
  const account = freshAccount()
  await account.restore()
  assert.equal(account.isLoggedIn, true)

  await account.logout()
  assert.equal(account.phase, 'idle')
  assert.equal(account.isLoggedIn, false)
  assert.ok(calls.some((call) => call[0] === 'logout'))
})

test('没有桌面桥时，登录直接给出 NO_BRIDGE 错误', async () => {
  globalThis.desktop = undefined
  const account = freshAccount()
  await account.startLogin()
  assert.equal(account.phase, 'error')
  assert.match(account.errorMessage, /桌面应用/)
})

// ── 官方数据 store ──────────────────────────────────────────────

test('订阅列表：首次加载归一化并保留游标，加载更多会带上游标', async () => {
  const calls = installBridge({
    officialSubscriptions: async (cursor) => {
      calls.push(['subscriptions', cursor])
      if (cursor === null || cursor === undefined) {
        return {
          ok: true,
          payload: {
            data: [{ pid: 'p1', title: '节目一' }, { pid: 'p2', title: '节目二' }],
            loadMoreKey: 'cursor-2',
          },
        }
      }
      return { ok: true, payload: { data: [{ pid: 'p3', title: '节目三' }], loadMoreKey: null } }
    },
  })
  const official = freshOfficial()

  await official.loadSubscriptions(true)
  assert.equal(official.count, 2)
  assert.equal(official.hasMore, true)
  assert.deepEqual(official.podcasts.map((p) => p.pid), ['p1', 'p2'])

  await official.loadMoreSubscriptions()
  assert.equal(official.count, 3)
  assert.equal(official.hasMore, false)

  const secondCall = calls.filter((c) => c[0] === 'subscriptions')[1]
  assert.equal(secondCall[1], 'cursor-2', '加载更多必须带上上一页的游标')
})

test('订阅列表：接口失败时进入 error 且保留提示', async () => {
  installBridge({
    officialSubscriptions: async () => ({ ok: false, code: 'AUTH_EXPIRED', message: '登录状态已失效，请重新登录' }),
  })
  const official = freshOfficial()
  await official.loadSubscriptions(true)
  assert.equal(official.listStatus, 'error')
  assert.match(official.listError, /登录状态已失效/)
  // 错误码要单独保留，界面据此把账号状态一并切回未登录，避免"已过期但仍显示已登录"
  assert.equal(official.listErrorCode, 'AUTH_EXPIRED')
})

test('单集列表：加载后可按 pid 取回，空列表也不报错', async () => {
  installBridge({
    officialEpisodes: async (pid) => ({
      ok: true,
      payload: {
        data: [
          { eid: 'e1', pid, title: '第一集', duration: 60 },
          { eid: 'e2', pid, title: '第二集', duration: 120 },
        ],
        loadMoreKey: null,
      },
    }),
  })
  const official = freshOfficial()
  await official.loadEpisodes('p1', true)
  official.select('p1')

  assert.equal(official.selectedPid, 'p1')
  assert.equal(official.selectedEpisodes.items.length, 2)
  assert.equal(official.selectedEpisodes.items[0].durationSeconds, 60)

  const empty = freshOfficial()
  installBridge({
    officialEpisodes: async () => ({ ok: true, payload: { data: [], loadMoreKey: null } }),
  })
  await empty.loadEpisodes('p2', true)
  empty.select('p2')
  assert.equal(empty.selectedEpisodes.items.length, 0)
  assert.equal(empty.selectedEpisodes.status, 'ready')
})

test('播放地址解析：自带地址直接用，付费单集向桥索取，普通单集没有地址就返回 null', async () => {
  const calls = installBridge()
  const official = freshOfficial()

  const withUrl = await official.resolveAudioUrl({
    eid: 'e1',
    pid: 'p1',
    title: '',
    description: '',
    durationSeconds: 0,
    pubDate: null,
    audioUrl: 'https://cdn.example.com/inline.m4a',
    mimeType: 'audio/mp4',
    isPrivate: false,
    imageUrl: null,
  })
  assert.equal(withUrl, 'https://cdn.example.com/inline.m4a')
  assert.equal(calls.length, 0, '自带地址时不应调用桥')

  const privateOne = await official.resolveAudioUrl({
    eid: 'e2',
    pid: 'p1',
    title: '',
    description: '',
    durationSeconds: 0,
    pubDate: null,
    audioUrl: null,
    mimeType: 'audio/mp4',
    isPrivate: true,
    imageUrl: null,
  })
  assert.equal(privateOne, 'https://cdn.example.com/x.m4a')
  assert.ok(calls.some((c) => c[0] === 'media' && c[1] === 'e2'))

  const plainMissing = await official.resolveAudioUrl({
    eid: 'e3',
    pid: 'p1',
    title: '',
    description: '',
    durationSeconds: 0,
    pubDate: null,
    audioUrl: null,
    mimeType: 'audio/mp4',
    isPrivate: false,
    imageUrl: null,
  })
  assert.equal(plainMissing, null)
})

test('reset 会清空官方数据（登出后不残留）', async () => {
  installBridge({
    officialSubscriptions: async () => ({
      ok: true,
      payload: { data: [{ pid: 'p1', title: 'A' }], loadMoreKey: null },
    }),
  })
  const official = freshOfficial()
  await official.loadSubscriptions(true)
  assert.equal(official.count, 1)

  official.reset()
  assert.equal(official.count, 0)
  assert.equal(official.selectedPid, '')
  assert.equal(official.listStatus, 'idle')
})
