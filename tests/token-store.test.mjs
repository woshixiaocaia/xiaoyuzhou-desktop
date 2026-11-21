// 凭据存储测试：用假的 safeStorage，不接触真实系统密钥，也不读写项目文件。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)
const { createTokenStore } = require('../electron/token-store.cjs')

/** 假加密：把明文反转后存成 Buffer，验证的是「有加密/解密这一层」而不是算法本身 */
function fakeSafeStorage({ available = true, failDecrypt = false } = {}) {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (text) => Buffer.from([...text].reverse().join(''), 'utf8'),
    decryptString: (buffer) => {
      if (failDecrypt) throw new Error('decrypt failed')
      return [...buffer.toString('utf8')].reverse().join('')
    },
  }
}

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'xyz-token-'))
}

test('保存后能读回，且磁盘上是密文（不含明文凭据）', () => {
  const dir = tempDir()
  try {
    const store = createTokenStore({ safeStorage: fakeSafeStorage(), dir })
    const saved = store.save({ access: 'ACCESS-SECRET', refresh: 'REFRESH-SECRET', user: { uid: 'u1' } })
    assert.equal(saved.ok, true)

    const raw = fs.readFileSync(store.filePath, 'utf8')
    assert.ok(!raw.includes('ACCESS-SECRET'), '磁盘内容不应包含明文访问凭据')

    const loaded = store.load()
    assert.equal(loaded.access, 'ACCESS-SECRET')
    assert.equal(loaded.refresh, 'REFRESH-SECRET')
    assert.equal(loaded.user.uid, 'u1')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('加密不可用时保存失败，且绝不落盘明文', () => {
  const dir = tempDir()
  try {
    const store = createTokenStore({ safeStorage: fakeSafeStorage({ available: false }), dir })
    const saved = store.save({ access: 'A', refresh: 'R' })
    assert.equal(saved.ok, false)
    assert.equal(saved.code, 'STORAGE_UNAVAILABLE')
    assert.equal(fs.existsSync(store.filePath), false, '不可用时不应创建文件')
    assert.equal(store.load(), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('解密失败（换机器/文件损坏）时当作未登录，不抛异常', () => {
  const dir = tempDir()
  try {
    const writer = createTokenStore({ safeStorage: fakeSafeStorage(), dir })
    writer.save({ access: 'A', refresh: 'R' })

    const broken = createTokenStore({ safeStorage: fakeSafeStorage({ failDecrypt: true }), dir })
    assert.equal(broken.load(), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('登出后文件被删除，再次读取为空', () => {
  const dir = tempDir()
  try {
    const store = createTokenStore({ safeStorage: fakeSafeStorage(), dir })
    store.save({ access: 'A', refresh: 'R' })
    assert.equal(fs.existsSync(store.filePath), true)

    assert.equal(store.clear().ok, true)
    assert.equal(fs.existsSync(store.filePath), false)
    assert.equal(store.load(), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('缺 access 的会话被拒绝保存', () => {
  const dir = tempDir()
  try {
    const store = createTokenStore({ safeStorage: fakeSafeStorage(), dir })
    const saved = store.save({ refresh: 'R' })
    assert.equal(saved.ok, false)
    assert.equal(saved.code, 'INVALID_SESSION')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
