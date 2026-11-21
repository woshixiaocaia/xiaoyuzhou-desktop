// 官方 API 客户端测试：全部用假 transport / 假 storage，不发任何网络请求。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createOfficialClient, ENDPOINTS } = require('../electron/official-client.cjs')

/** 可编程的假传输层；记录每次请求，便于断言参数 */
function fakeTransport(handler) {
  const calls = []
  const transport = async (request) => {
    calls.push(request)
    return handler(request, calls.length)
  }
  transport.calls = calls
  return transport
}

/** 假凭据存储 */
function fakeStorage(initial = null) {
  const state = { session: initial, saves: 0, clears: 0, failSave: false }
  return {
    load: () => state.session,
    save: (value) => {
      state.saves += 1
      if (state.failSave) return { ok: false, code: 'STORAGE_WRITE_FAILED', message: '保存失败' }
      state.session = value
      return { ok: true }
    },
    clear: () => {
      state.clears += 1
      state.session = null
      return { ok: true }
    },
    state,
  }
}

const json = (status, body, headers = {}) => ({ status, headers, body: JSON.stringify(body) })

// ── 二维码创建 ──────────────────────────────────────────────────

test('创建二维码：200 且返回 id/url 时成功', async () => {
  const transport = fakeTransport(() =>
    json(200, { id: 'qr-1', url: 'https://h5.xiaoyuzhoufm.com/oauth?qrcode_id=qr-1' }),
  )
  const client = createOfficialClient({ transport, storage: fakeStorage() })

  const result = await client.startLogin()
  assert.equal(result.ok, true)
  assert.equal(result.id, 'qr-1')
  assert.match(result.url, /qrcode_id=qr-1/)

  // 请求必须打到 web-api 主机，且带账号中心的 Origin/Referer
  const request = transport.calls[0]
  assert.equal(request.method, 'POST')
  assert.ok(request.url.startsWith('https://web-api.xiaoyuzhoufm.com/v1/auth/qrcode/create'))
  assert.equal(request.headers.Origin, 'https://accounts.xiaoyuzhoufm.com')
  assert.equal(JSON.parse(request.body).clientId, 'xyz-web')
})

test('创建二维码：HTTP 500 → HTTP_STATUS；网络异常 → NETWORK；超时 → TIMEOUT', async () => {
  const server = createOfficialClient({
    transport: fakeTransport(() => json(500, {})),
    storage: fakeStorage(),
  })
  assert.equal((await server.startLogin()).code, 'HTTP_STATUS')

  const offline = createOfficialClient({
    transport: fakeTransport(() => {
      throw new Error('boom')
    }),
    storage: fakeStorage(),
  })
  assert.equal((await offline.startLogin()).code, 'NETWORK')

  const timeout = createOfficialClient({
    transport: fakeTransport(() => {
      const error = new Error('timeout')
      error.code = 'ETIMEDOUT'
      throw error
    }),
    storage: fakeStorage(),
  })
  assert.equal((await timeout.startLogin()).code, 'TIMEOUT')
})

// ── 扫码状态机 ──────────────────────────────────────────────────

test('轮询：WAITTING / SCANNED 原样透传并继续', async () => {
  let round = 0
  const client = createOfficialClient({
    transport: fakeTransport(() => {
      round += 1
      return json(200, { status: round === 1 ? 'WAITTING' : 'SCANNED' })
    }),
    storage: fakeStorage(),
  })

  assert.deepEqual((await client.pollLogin('qr-1')).status, 'WAITTING')
  assert.deepEqual((await client.pollLogin('qr-1')).status, 'SCANNED')
})

test('轮询：400/401 归一化为 EXPIRED（二维码被消费或过期）', async () => {
  for (const status of [400, 401]) {
    const client = createOfficialClient({
      transport: fakeTransport(() => ({ status, headers: {}, body: '' })),
      storage: fakeStorage(),
    })
    const result = await client.pollLogin('qr-x')
    assert.equal(result.ok, true)
    assert.equal(result.status, 'EXPIRED')
  }
})

test('轮询：CONFIRMED 时从响应头取凭据并保存，用户信息来自 getMe', async () => {
  const storage = fakeStorage()
  const transport = fakeTransport((request) => {
    if (request.url.includes('/v1/auth/qrcode/login')) {
      return {
        status: 200,
        headers: {
          'x-jike-access-token': 'access-1',
          'x-jike-refresh-token': 'refresh-1',
        },
        body: JSON.stringify({ status: 'CONFIRMED' }),
      }
    }
    // getMe
    return json(200, { data: { uid: 'u1', nickname: '小明', avatarUrl: 'https://img/a.png' } })
  })
  const client = createOfficialClient({ transport, storage })

  const result = await client.pollLogin('qr-1')
  assert.equal(result.ok, true)
  assert.equal(result.status, 'CONFIRMED')
  assert.equal(result.user.nickname, '小明')
  // 至少保存一次；拿到用户信息后会把 user 一起补写进去，所以次数可能 > 1
  assert.ok(storage.state.saves >= 1)
  assert.equal(storage.state.session.access, 'access-1')
  assert.equal(storage.state.session.refresh, 'refresh-1')
  assert.equal(storage.state.session.user.nickname, '小明')
  assert.equal(client.hasSession(), true)
})

test('轮询：CONFIRMED 但响应里没有凭据 → PARSE 错误，不写入会话', async () => {
  const storage = fakeStorage()
  const transport = fakeTransport((request) => {
    if (request.url.includes('/v1/auth/qrcode/login')) {
      return json(200, { status: 'CONFIRMED' })
    }
    return json(200, { data: { uid: 'u1' } })
  })
  const client = createOfficialClient({ transport, storage })

  const result = await client.pollLogin('qr-1')
  assert.equal(result.ok, false)
  assert.equal(result.code, 'PARSE')
  assert.equal(client.hasSession(), false)
})

// ── 会话与刷新 ──────────────────────────────────────────────────

test('未登录时读取订阅返回 NOT_LOGGED_IN，且不发请求', async () => {
  const transport = fakeTransport(() => json(200, {}))
  const client = createOfficialClient({ transport, storage: fakeStorage(null) })

  const result = await client.fetchSubscriptions()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'NOT_LOGGED_IN')
  assert.equal(transport.calls.length, 0)
})

test('订阅分页游标原样放进请求体，响应原样返回给上层', async () => {
  const transport = fakeTransport(() => json(200, { data: [{ pid: 'p1' }], loadMoreKey: 'next' }))
  const client = createOfficialClient({
    transport,
    storage: fakeStorage({ access: 'a', refresh: 'r', user: null }),
  })

  const result = await client.fetchSubscriptions('cursor-1')
  assert.equal(result.ok, true)
  assert.equal(JSON.parse(transport.calls[0].body).loadMoreKey, 'cursor-1')
  assert.equal(result.payload.loadMoreKey, 'next')
  assert.equal(transport.calls[0].headers['x-jike-access-token'], 'a')
})

test('401 时自动刷新一次并重试原请求', async () => {
  let subscriptionCalls = 0
  const transport = fakeTransport((request) => {
    if (request.url.includes('/app_auth_tokens.refresh')) {
      return {
        status: 200,
        headers: { 'x-jike-access-token': 'access-2', 'x-jike-refresh-token': 'refresh-2' },
        body: JSON.stringify({}),
      }
    }
    subscriptionCalls += 1
    if (subscriptionCalls === 1) return { status: 401, headers: {}, body: '' }
    return json(200, { data: [] })
  })
  const storage = fakeStorage({ access: 'access-1', refresh: 'refresh-1', user: null })
  const client = createOfficialClient({ transport, storage })

  const result = await client.fetchSubscriptions()
  assert.equal(result.ok, true)
  assert.equal(subscriptionCalls, 2)
  assert.equal(storage.state.session.access, 'access-2')
})

test('刷新失败 → AUTH_EXPIRED，并清空本地会话', async () => {
  const transport = fakeTransport((request) => {
    if (request.url.includes('/app_auth_tokens.refresh')) return { status: 401, headers: {}, body: '' }
    return { status: 401, headers: {}, body: '' }
  })
  const storage = fakeStorage({ access: 'a', refresh: 'r', user: null })
  const client = createOfficialClient({ transport, storage })

  const result = await client.fetchSubscriptions()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'AUTH_EXPIRED')
  assert.equal(storage.state.clears, 1)
  assert.equal(client.hasSession(), false)
})

test('登出会清空存储并让后续请求变成 NOT_LOGGED_IN', async () => {
  const storage = fakeStorage({ access: 'a', refresh: 'r', user: null })
  const client = createOfficialClient({ transport: fakeTransport(() => json(200, {})), storage })

  client.logout()
  assert.equal(storage.state.clears, 1)
  assert.equal(client.hasSession(), false)
  assert.equal((await client.fetchSubscriptions()).code, 'NOT_LOGGED_IN')
})

// ── 单集与媒体地址 ──────────────────────────────────────────────

test('单集列表：pid 与游标都进请求体', async () => {
  const transport = fakeTransport(() => json(200, { data: [] }))
  const client = createOfficialClient({
    transport,
    storage: fakeStorage({ access: 'a', refresh: 'r', user: null }),
  })

  await client.fetchEpisodes('pid-1', 'cursor-2')
  const body = JSON.parse(transport.calls[0].body)
  assert.equal(body.pid, 'pid-1')
  assert.equal(body.order, 'desc')
  assert.equal(body.loadMoreKey, 'cursor-2')
})

test('媒体地址：取 data.data.url；空地址返回 NO_MEDIA', async () => {
  const okClient = createOfficialClient({
    transport: fakeTransport(() => json(200, { data: { url: 'https://cdn.example.com/a.m4a' } })),
    storage: fakeStorage({ access: 'a', refresh: 'r', user: null }),
  })
  const ok = await okClient.fetchMediaUrl('e1')
  assert.equal(ok.ok, true)
  assert.equal(ok.url, 'https://cdn.example.com/a.m4a')

  const emptyClient = createOfficialClient({
    transport: fakeTransport(() => json(200, { data: {} })),
    storage: fakeStorage({ access: 'a', refresh: 'r', user: null }),
  })
  assert.equal((await emptyClient.fetchMediaUrl('e1')).code, 'NO_MEDIA')
})

test('端点表覆盖登录、刷新、订阅、单集与媒体地址', () => {
  assert.equal(ENDPOINTS.qrCreate.path, '/v1/auth/qrcode/create')
  assert.equal(ENDPOINTS.qrPoll.path, '/v1/auth/qrcode/login')
  assert.equal(ENDPOINTS.refresh.path, '/app_auth_tokens.refresh')
  assert.equal(ENDPOINTS.subscriptions.path, '/v1/subscription/list')
  assert.equal(ENDPOINTS.episodes.path, '/v1/episode/list')
  assert.equal(ENDPOINTS.media.path, '/v1/private-media/get')
})

// ── 异常与边界（本轮补充） ──────────────────────────────────────

test('创建二维码：200 但没有 id → PARSE 错误，不返回半成品', async () => {
  const client = createOfficialClient({
    transport: fakeTransport(() => json(200, { url: 'https://h5.xiaoyuzhoufm.com/oauth?qrcode_id=x' })),
    storage: fakeStorage(),
  })
  const result = await client.startLogin()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'PARSE')
})

test('创建二维码：非 JSON 响应 → PARSE 错误', async () => {
  const client = createOfficialClient({
    transport: fakeTransport(() => ({ status: 200, headers: {}, body: '<html>not json</html>' })),
    storage: fakeStorage(),
  })
  assert.equal((await client.startLogin()).code, 'PARSE')
})

test('轮询：缺少二维码标识时直接拒绝，不发请求', async () => {
  const transport = fakeTransport(() => json(200, { status: 'WAITTING' }))
  const client = createOfficialClient({ transport, storage: fakeStorage() })

  for (const bad of ['', null, undefined, 123]) {
    const result = await client.pollLogin(bad)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'INVALID_ARGUMENT')
  }
  assert.equal(transport.calls.length, 0)
})

test('轮询：服务端 500 → HTTP_STATUS；网络异常 → NETWORK', async () => {
  const server = createOfficialClient({
    transport: fakeTransport(() => json(500, {})),
    storage: fakeStorage(),
  })
  assert.equal((await server.pollLogin('qr-1')).code, 'HTTP_STATUS')

  const offline = createOfficialClient({
    transport: fakeTransport(() => {
      throw new Error('boom')
    }),
    storage: fakeStorage(),
  })
  assert.equal((await offline.pollLogin('qr-1')).code, 'NETWORK')
})

test('轮询：未知状态值按 WAITTING 处理，不会误判成登录成功', async () => {
  const client = createOfficialClient({
    transport: fakeTransport(() => json(200, { status: 'SOMETHING_NEW' })),
    storage: fakeStorage(),
  })
  const result = await client.pollLogin('qr-1')
  assert.equal(result.ok, true)
  assert.equal(result.status, 'WAITTING')
})

test('二维码返回的 url 会被原样保留（不做拼接或改写）', async () => {
  const officialUrl = 'https://h5.xiaoyuzhoufm.com/oauth?qrcode_id=abc123&from=web'
  const client = createOfficialClient({
    transport: fakeTransport(() => json(200, { id: 'abc123', url: officialUrl })),
    storage: fakeStorage(),
  })
  const result = await client.startLogin()
  assert.equal(result.url, officialUrl)
})
