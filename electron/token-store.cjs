'use strict'

/**
 * 官方登录凭据的加密存储（主进程专用）。
 *
 * 设计要点：
 *   - 只接受一个「safeStorage 兼容对象」，便于测试时注入假的实现；
 *   - 加密不可用或加密失败时**直接报错**，绝不退回明文落盘；
 *   - 解密失败（文件损坏、换机器、系统密钥变化）时当作未登录，而不是抛给上层；
 *   - 落盘内容是 safeStorage 产出的密文 Buffer，不含任何可读凭据。
 */

const fs = require('node:fs')
const path = require('node:path')

const FILE_NAME = 'official-auth.bin'

/**
 * @param {object} options
 * @param {{ isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string }} options.safeStorage
 * @param {string} options.dir 存放目录（通常是 app.getPath('userData')）
 */
function createTokenStore({ safeStorage, dir }) {
  const file = path.join(dir, FILE_NAME)

  function available() {
    try {
      return Boolean(safeStorage && safeStorage.isEncryptionAvailable())
    } catch {
      return false
    }
  }

  /** 读回会话；任何异常都当作「没有登录」 */
  function load() {
    if (!available()) return null
    let buffer
    try {
      buffer = fs.readFileSync(file)
    } catch {
      return null // 文件不存在也算未登录
    }
    try {
      const json = safeStorage.decryptString(buffer)
      const parsed = JSON.parse(json)
      if (parsed === null || typeof parsed !== 'object') return null
      const access = typeof parsed.access === 'string' ? parsed.access : ''
      const refresh = typeof parsed.refresh === 'string' ? parsed.refresh : ''
      if (access === '') return null
      return {
        access,
        refresh,
        user: parsed.user && typeof parsed.user === 'object' ? parsed.user : null,
        savedAt: typeof parsed.savedAt === 'number' ? parsed.savedAt : 0,
      }
    } catch {
      // 解密失败：视为无效会话，保持文件不动，等用户重新登录时覆盖
      return null
    }
  }

  /** 保存会话；加密不可用时返回失败，调用方必须据此提示用户 */
  function save(session) {
    if (!available()) {
      return { ok: false, code: 'STORAGE_UNAVAILABLE', message: '当前系统不支持安全存储，无法保存登录状态' }
    }
    if (session === null || typeof session !== 'object' || typeof session.access !== 'string' || session.access === '') {
      return { ok: false, code: 'INVALID_SESSION', message: '登录凭据不完整' }
    }
    try {
      fs.mkdirSync(dir, { recursive: true })
      const payload = JSON.stringify({
        access: session.access,
        refresh: typeof session.refresh === 'string' ? session.refresh : '',
        user: session.user && typeof session.user === 'object' ? session.user : null,
        savedAt: Date.now(),
      })
      const encrypted = safeStorage.encryptString(payload)
      fs.writeFileSync(file, encrypted, { mode: 0o600 })
      return { ok: true }
    } catch {
      return { ok: false, code: 'STORAGE_WRITE_FAILED', message: '登录状态保存失败' }
    }
  }

  function clear() {
    try {
      fs.rmSync(file, { force: true })
      return { ok: true }
    } catch {
      return { ok: false, code: 'STORAGE_CLEAR_FAILED', message: '清理登录状态失败' }
    }
  }

  return { available, load, save, clear, filePath: file }
}

module.exports = { createTokenStore, FILE_NAME }
