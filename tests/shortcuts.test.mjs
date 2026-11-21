// 全局快捷键解析测试（纯函数，不依赖 DOM）
import test from 'node:test'
import assert from 'node:assert/strict'

const { isEditableTarget, queueShortcut } = await import('@/lib/shortcuts')

test('可编辑区域判定：输入框 / 文本域 / 下拉 / contenteditable', () => {
  assert.equal(isEditableTarget({ tagName: 'INPUT' }), true)
  assert.equal(isEditableTarget({ tagName: 'textarea' }), true)
  assert.equal(isEditableTarget({ tagName: 'SELECT' }), true)
  assert.equal(isEditableTarget({ tagName: 'DIV', isContentEditable: true }), true)
  assert.equal(isEditableTarget({ tagName: 'DIV' }), false)
  assert.equal(isEditableTarget(null), false)
  assert.equal(isEditableTarget(undefined), false)
})

test('Ctrl+Alt+方向键映射到上一集 / 下一集', () => {
  assert.equal(queueShortcut({ ctrlKey: true, altKey: true, key: 'ArrowRight' }), 'next')
  assert.equal(queueShortcut({ ctrlKey: true, altKey: true, key: 'ArrowLeft' }), 'prev')
})

test('缺少修饰键时不处理，避免影响普通方向键', () => {
  assert.equal(queueShortcut({ ctrlKey: true, key: 'ArrowRight' }), null)
  assert.equal(queueShortcut({ altKey: true, key: 'ArrowRight' }), null)
  assert.equal(queueShortcut({ key: 'ArrowRight' }), null)
})

test('焦点在输入框里时不切集', () => {
  assert.equal(
    queueShortcut({ ctrlKey: true, altKey: true, key: 'ArrowRight', target: { tagName: 'INPUT' } }),
    null,
  )
  assert.equal(
    queueShortcut({ ctrlKey: true, altKey: true, key: 'ArrowLeft', target: { tagName: 'TEXTAREA' } }),
    null,
  )
})

test('其它按键不干扰', () => {
  assert.equal(queueShortcut({ ctrlKey: true, altKey: true, key: 'ArrowUp' }), null)
  assert.equal(queueShortcut({ ctrlKey: true, altKey: true, key: 'a' }), null)
})
