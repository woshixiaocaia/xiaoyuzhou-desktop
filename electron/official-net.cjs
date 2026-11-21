'use strict'

/**
 * 官方 API 的网络传输层（主进程专用）。
 *
 * 用 Electron 的 net（Chromium 网络栈）而不是 Node 的 http：
 *   - 会使用系统代理，和 RSS 抓取保持一致；
 *   - 浏览器兼容性更好。
 *
 * 这一层只做「发出去 + 收回来」，不懂业务；业务在 official-client.cjs。
 */

const { net } = require('electron')

const MAX_BODY_BYTES = 2 * 1024 * 1024 // 官方 JSON 接口都很小，2MB 足够
const DEFAULT_TIMEOUT_MS = 15000

/**
 * @returns {(req: {url:string,method:string,headers:object,body?:string,timeoutMs?:number}) => Promise<{status:number,headers:object,body:string}>}
 */
function createNetTransport() {
  return function transport({ url, method, headers, body, timeoutMs }) {
    const limit = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS

    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (fn, value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        fn(value)
      }

      const timer = setTimeout(() => {
        const error = new Error('请求超时')
        error.code = 'ETIMEDOUT'
        try {
          request.abort()
        } catch {
          /* 已经结束就不用管 */
        }
        finish(reject, error)
      }, limit)

      let request
      try {
        request = net.request({ url, method, redirect: 'manual' })
      } catch (error) {
        finish(reject, error)
        return
      }

      for (const key of Object.keys(headers || {})) {
        try {
          request.setHeader(key, headers[key])
        } catch {
          /* 非法头名直接跳过，不让单个头拖垮整次请求 */
        }
      }

      request.on('response', (response) => {
        const chunks = []
        let size = 0
        response.on('data', (chunk) => {
          size += chunk.length
          if (size > MAX_BODY_BYTES) {
            try {
              request.abort()
            } catch {
              /* ignore */
            }
            const error = new Error('响应体过大')
            error.code = 'EBODYTOOLARGE'
            finish(reject, error)
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          finish(resolve, {
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          })
        })
        response.on('error', (error) => finish(reject, error))
      })

      request.on('error', (error) => finish(reject, error))

      if (typeof body === 'string') {
        request.write(body)
      }
      request.end()
    })
  }
}

module.exports = { createNetTransport, MAX_BODY_BYTES, DEFAULT_TIMEOUT_MS }
