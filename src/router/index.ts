import { createRouter, createWebHashHistory, type RouteRecordRaw } from 'vue-router'

import DiscoverView from '@/views/DiscoverView.vue'
import HistoryView from '@/views/HistoryView.vue'
import OfficialView from '@/views/OfficialView.vue'
import SearchView from '@/views/SearchView.vue'
import SubscriptionsView from '@/views/SubscriptionsView.vue'
import SettingsView from '@/views/SettingsView.vue'

/**
 * 路由表：URL 与组件的对应关系。
 *
 * 这里刻意使用 createWebHashHistory（地址形如 /#/discover）而不是 createWebHistory。
 * 原因：下一步接入 Electron 后页面会以 file:// 协议加载，
 * HTML5 History 模式在 file:// 下刷新会 404，而 hash 模式不需要服务端配合。
 */
const routes: RouteRecordRaw[] = [
  { path: '/settings', name: 'settings', component: SettingsView, meta: { title: '设置' } },
  {
    // 访问根路径时直接跳到「发现」，避免出现空白页
    path: '/',
    redirect: { name: 'discover' },
  },
  {
    path: '/discover',
    name: 'discover',
    component: DiscoverView,
    meta: { title: '发现' },
  },
  {
    path: '/search',
    name: 'search',
    component: SearchView,
    meta: { title: '搜索' },
  },
  {
    path: '/subscriptions',
    name: 'subscriptions',
    component: SubscriptionsView,
    meta: { title: '订阅' },
  },
  {
    path: '/official',
    name: 'official',
    component: OfficialView,
    meta: { title: '官方账号' },
  },
  {
    path: '/history',
    name: 'history',
    component: HistoryView,
    meta: { title: '播放历史' },
  },
  {
    // 兜底：任何人手动输错路径都退回「发现」
    path: '/:pathMatch(.*)*',
    redirect: { name: 'discover' },
  },
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
  // 切换页面时把滚动位置回到顶部，符合桌面端预期
  scrollBehavior: () => ({ top: 0 }),
})

// 把 meta.title 同步到浏览器 / 窗口标题
router.afterEach((to) => {
  const title = to.meta.title
  document.title = typeof title === 'string' ? `${title} · 小宇宙` : '小宇宙'
})

export default router
