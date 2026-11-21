// 二维码渲染测试：验证官方登录链接能被编码，异常输入安全退化。
import test from 'node:test'
import assert from 'node:assert/strict'

const { buildQrDataUrl } = await import('@/lib/qr')

const OFFICIAL_URL = 'https://h5.xiaoyuzhoufm.com/oauth?qrcode_id=6addadfa6c1b8642d31a6cbf'

test('官方登录链接能编码成图片 data URL', () => {
  const dataUrl = buildQrDataUrl(OFFICIAL_URL)
  assert.match(dataUrl, /^data:image\/[a-z+]+;base64,/)
  assert.ok(dataUrl.length > 200, '二维码图片应当有实际内容')
})

test('空输入返回空串，由调用方退化为只显示链接文本', () => {
  assert.equal(buildQrDataUrl(''), '')
  assert.equal(buildQrDataUrl('    '), '')
  assert.equal(buildQrDataUrl(null), '')
  assert.equal(buildQrDataUrl(undefined), '')
})

test('超长内容不抛异常（要么编码成功，要么安全返回空串）', () => {
  const huge = 'x'.repeat(12000)
  let out
  assert.doesNotThrow(() => {
    out = buildQrDataUrl(huge)
  })
  assert.ok(out === '' || out.startsWith('data:image/'))
})

test('同一链接多次生成结果稳定', () => {
  const a = buildQrDataUrl(OFFICIAL_URL)
  const b = buildQrDataUrl(OFFICIAL_URL)
  assert.equal(a, b)
})
