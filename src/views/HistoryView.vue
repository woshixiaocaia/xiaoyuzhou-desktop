<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import AppIcon from '@/components/AppIcon.vue'
import { formatTime, formatDate } from '@/lib/format'
import { useHistoryStore } from '@/stores/history'
import { useOfficialStore } from '@/stores/official'
import { usePlayerStore } from '@/stores/player'
import { useSubscriptionsStore } from '@/stores/subscriptions'
import { useAccountStore } from '@/stores/account'
const history = useHistoryStore(), official = useOfficialStore(), player = usePlayerStore(), rss = useSubscriptionsStore(), account = useAccountStore()
const filter = ref<'all' | 'unfinished' | 'phone'>('all'), busy = ref(''), message = ref(''), clearing = ref(false)
const entries = computed(() => [...history.entries].filter(e => filter.value === 'phone' ? e.phoneSynced === true : filter.value !== 'unfinished' || !e.completed).sort((a, b) => b.updatedAt - a.updatedAt))
function syncPhone(): void { if (account.isLoggedIn) void history.syncPhoneHistory(true) }
function loadMorePhone(): void { if (account.isLoggedIn) void history.syncPhoneHistory(false) }
onMounted(syncPhone); watch(() => account.isLoggedIn, syncPhone)
async function play(key: string): Promise<void> {
  if (busy.value) return
  const entry = entries.value.find(e => e.key === key)
  if (!entry) return
  busy.value = key; message.value = ''
  try {
    let url = ''
    if (entry.source === 'rss') {
      await rss.restore()
      for (const sub of rss.items) { const hit = sub.feed?.episodes.find(e => e.id === entry.id || 'rss:' + e.id === entry.id); if (hit?.audioUrl) { url = hit.audioUrl; break } }
    } else {
      if (entry.podcastId) await official.loadEpisodes(entry.podcastId)
      for (const state of Object.values(official.episodes)) { const hit = state.items.find(e => 'official:' + e.eid === entry.key); if (hit) { url = await official.resolveAudioUrl(hit) || ''; break } }
    }
    if (!url) { message.value = entry.source === 'rss' ? '这集不在当前订阅源中，可能已被发布者移除。请到订阅页刷新后重试。' : '请先在「我的订阅」中打开这集所在的播客，以获取最新音频地址，再回来继续收听。'; return }
    player.play({ id: entry.key, title: entry.title, podcast: entry.podcast, duration: entry.duration, audioUrl: url, source: entry.source, podcastId: entry.podcastId, startAt: entry.completed ? 0 : entry.position })
  } finally { busy.value = '' }
}
</script>
<template><section class="page"><header class="page-heading"><div><span class="eyebrow">PICK UP WHERE YOU LEFT OFF</span><h1>每一段，都算数<span class="accent">.</span></h1><p>同步手机小宇宙的收听记录，也保留这台电脑的播放进度。</p></div><div class="history-actions"><button v-if="account.isLoggedIn" class="button subtle" :disabled="history.phoneSyncStatus === 'loading'" @click="syncPhone"><AppIcon name="refresh" :size="16" />{{ history.phoneSyncStatus === 'loading' ? '同步中…' : '同步手机记录' }}</button><button v-if="history.entries.length" class="button subtle" @click="clearing = !clearing"><AppIcon name="trash" :size="16" />清空本机记录</button></div></header><div v-if="clearing" class="notice">移除这台电脑保存的收听记录？手机账号中的历史不会被删除。<button class="text-button text-danger" @click="history.clear(); clearing = false">确认移除</button><button class="text-button" @click="clearing = false">取消</button></div><p v-if="history.phoneSyncError" class="notice error" role="alert">{{ history.phoneSyncError }}<button class="text-button" @click="syncPhone">重试</button></p><div class="category-tabs"><button :class="{ active: filter === 'all' }" @click="filter = 'all'">全部记录<span>{{ history.entries.length }}</span></button><button :class="{ active: filter === 'unfinished' }" @click="filter = 'unfinished'">还没听完</button><button v-if="account.isLoggedIn" :class="{ active: filter === 'phone' }" @click="filter = 'phone'">手机同步<span>{{ history.entries.filter(e => e.phoneSynced).length }}</span></button><span class="result-count">{{ history.phoneSyncStatus === 'ready' ? '已同步账号历史' : account.isLoggedIn ? '正在连接手机历史' : '登录后可同步手机历史' }}</span></div><p v-if="message || history.lastError" class="notice" role="status">{{ message || history.lastError }}</p><p v-if="!account.isLoggedIn && !entries.length" class="notice"><AppIcon name="info" :size="18" /><span>连接小宇宙账号后，可读取同一账号的手机收听历史。</span><RouterLink to="/official" class="text-button">去登录<AppIcon name="arrow" :size="15" /></RouterLink></p><div v-if="!entries.length" class="empty-state"><span class="feature-icon sage"><AppIcon name="history" :size="32" /></span><h2>{{ filter === 'unfinished' && history.entries.length ? '每个故事，都好好听完了' : '你的收听故事，从这里开始' }}</h2><p>{{ filter === 'phone' ? '手机端还没有可同步的收听记录。' : '播放超过几秒后，进度就会自动记在这里。' }}</p><RouterLink to="/discover" class="button primary">去发现好声音<AppIcon name="arrow" :size="16" /></RouterLink></div><ul v-else class="history-list"><li v-for="entry in entries" :key="entry.key" class="history-row"><span class="history-symbol"><AppIcon :name="entry.completed ? 'check' : 'headphones'" :size="23" /></span><div class="grow"><h3>{{ entry.title || '未命名单集' }}</h3><p class="muted">{{ entry.podcast }} · {{ entry.source === 'rss' ? 'RSS' : entry.phoneSynced ? '手机同步' : '本机小宇宙' }} · {{ formatDate(entry.updatedAt) }}</p><div class="history-progress"><span v-if="entry.duration" class="progress-track"><i :style="{ width: Math.min(100, entry.position / entry.duration * 100) + '%' }"></i></span><small>{{ entry.completed ? '已听完' : '已听 ' + formatTime(entry.position) }}<template v-if="entry.duration"> / {{ formatTime(entry.duration) }}</template></small></div></div><button class="button subtle small" :disabled="!!busy" @click="play(entry.key)"><AppIcon name="play" :size="15" />{{ busy === entry.key ? '获取中…' : entry.completed ? '再听一次' : '继续收听' }}</button><button class="icon-button" :aria-label="'移除历史：' + entry.title" @click="history.remove(entry.key)"><AppIcon name="close" :size="16" /></button></li></ul><button v-if="filter === 'phone' && history.hasPhoneMore" class="button subtle load-more" :disabled="history.phoneLoadingMore" @click="loadMorePhone">{{ history.phoneLoadingMore ? '加载中…' : '加载更多手机记录' }}</button></section></template>
