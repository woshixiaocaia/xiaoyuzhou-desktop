import qrcode from 'qrcode-generator'

/**
 * 把官方登录链接画成二维码（data URL）。
 *
 * 为什么需要这一步：官方 `qrcode/create` 返回的 `url` 是「供小宇宙 App 识别的链接」，
 * 不是可以在桌面浏览器里打开展示的登录页。官方网页端同样是自己把这个 url 编码成二维码，
 * 用户用 App 扫码后才会跳到确认页。
 *
 * 空输入、超长输入或编码失败时一律返回空字符串，由调用方退化为「只显示链接文本」，
 * 不抛异常。
 */
export function buildQrDataUrl(payload: string, cellSize = 6, margin = 8): string {
  if (typeof payload !== 'string') return ''
  const value = payload.trim()
  if (value === '') return ''
  try {
    const qr = qrcode(0, 'M')
    qr.addData(value)
    qr.make()
    return qr.createDataURL(cellSize, margin)
  } catch {
    return ''
  }
}
