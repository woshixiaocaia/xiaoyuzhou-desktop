// 搜索/发现页多频道独立展开的回归测试
//
// 背景：展开状态曾用 ref(new Set())，在 Vue 响应式代理下
// new Set(proxy).add(pid) 的增补未能正确体现，导致同时只能展开一个频道。
// 现改为 string[] 并整数组替换。本测试守住以下几点：
//   1) 多个 pid 可同时存在于展开集合中
//   2) 收起其中一个不影响其它
//   3) 清空后不残留
import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * 复刻视图里的展开状态操作（与 SearchView/DiscoverView 的 openPodcast 一致）。
 * 抽成纯函数便于离线测试，避免依赖真实 DOM。
 */
function createExpansion() {
  let state = []
  return {
    get value() {
      return state
    },
    toggle(pid) {
      if (state.includes(pid)) {
        state = state.filter((item) => item !== pid)
        return false // 收起
      }
      state = [...state, pid]
      return true // 展开
    },
    clear() {
      state = []
    },
  }
}

test('展开状态：多个频道可以同时展开', () => {
  const exp = createExpansion()
  exp.toggle('p1')
  exp.toggle('p2')
  exp.toggle('p3')

  assert.deepEqual(exp.value, ['p1', 'p2', 'p3'])
  assert.equal(exp.value.length, 3)
})

test('展开状态：收起一个不影响其它频道', () => {
  const exp = createExpansion()
  exp.toggle('p1')
  exp.toggle('p2')
  exp.toggle('p3')

  exp.toggle('p2') // 收起伏在中间的
  assert.deepEqual(exp.value, ['p1', 'p3'])
})

test('展开状态：重复点击同一频道只切换自身', () => {
  const exp = createExpansion()
  assert.equal(exp.toggle('p1'), true)
  assert.equal(exp.toggle('p1'), false)
  assert.deepEqual(exp.value, [])

  // 再点一次又展开
  assert.equal(exp.toggle('p1'), true)
  assert.deepEqual(exp.value, ['p1'])
})

test('展开状态：清空后不残留任何 pid', () => {
  const exp = createExpansion()
  exp.toggle('p1')
  exp.toggle('p2')
  exp.clear()
  assert.deepEqual(exp.value, [])
})

test('展开状态：同一 pid 不会重复加入', () => {
  const exp = createExpansion()
  exp.toggle('p1')
  // 直接模拟一次「已在集合中又走展开分支」的边界：连续两次 toggle 会收起
  exp.toggle('p1')
  exp.toggle('p1')
  assert.deepEqual(exp.value, ['p1'])
  assert.equal(new Set(exp.value).size, exp.value.length)
})

test('展开状态：每次变更都产生新数组（保证触发响应式更新）', async () => {
  const exp = createExpansion()
  exp.toggle('p1')
  const first = exp.value
  exp.toggle('p2')
  const second = exp.value
  assert.notEqual(first, second, '必须替换为新数组，原地修改不会触发更新')
  assert.deepEqual(first, ['p1'], '旧数组不应被就地改写')
})
