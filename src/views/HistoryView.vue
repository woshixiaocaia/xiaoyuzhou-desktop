<script setup lang="ts">
import { computed, ref } from 'vue'
import AppIcon from '@/components/AppIcon.vue'
import { formatTime, formatDate } from '@/lib/format'
import { useHistoryStore } from '@/stores/history'
import { useOfficialStore } from '@/stores/official'
import { usePlayerStore } from '@/stores/player'
import { useSubscriptionsStore } from '@/stores/subscriptions'
const history = useHistoryStore(), official = useOfficialStore(), player = usePlayerStore(), rss = useSubscriptionsStore()
const filter = ref('all'), busy = ref(''), message = ref(''), clearing = ref(false)
const entries = computed(() => [...history.entries].filter(e => filter.value !== 'unfinished' || !e.completed).sort((a, b) => b.updatedAt - a.updatedAt))
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
<template><section class="page"><header class="page-heading"><div><span class="eyebrow">PICK UP WHERE YOU LEFT OFF</span><h1>每一段，都算数<span class="accent">.</span></h1><p>那些没听完的故事，等你接着听。</p></div><button v-if="history.entries.length" class="button subtle" @click="clearing = !clearing"><AppIcon name="trash" :size="16" />清空历史</button></header><div v-if="clearing" class="notice">清空本机的全部收听历史与进度？此操作无法撤销。<button class="text-button text-danger" @click="history.clear(); clearing = false">确认清空</button><button class="text-button" @click="clearing = false">取消</button></div><div class="category-tabs"><button :class="{ active: filter === 'all' }" @click="filter = 'all'">全部记录<span>{{ history.entries.length }}</span></button><button :class="{ active: filter === 'unfinished' }" @click="filter = 'unfinished'">还没听完</button><span class="result-count">仅保存在这台电脑</span></div><p v-if="message || history.lastError" class="notice" role="status">{{ message || history.lastError }}</p><div v-if="!entries.length" class="empty-state"><span class="feature-icon sage"><AppIcon name="history" :size="32" /></span><h2>{{ filter === 'unfinished' && history.entries.length ? '每个故事，都好好听完了' : '你的收听故事，从这里开始' }}</h2><p>播放超过几秒后，进度就会自动记在这里。</p><RouterLink to="/discover" class="button primary">去发现好声音<AppIcon name="arrow" :size="16" /></RouterLink></div><ul v-else class="history-list"><li v-for="entry in entries" :key="entry.key" class="history-row"><span class="history-symbol"><AppIcon :name="entry.completed ? 'check' : 'headphones'" :size="23" /></span><div class="grow"><h3>{{ entry.title || '未命名单集' }}</h3><p class="muted">{{ entry.podcast }} · {{ entry.source === 'rss' ? 'RSS' : '小宇宙' }} · {{ formatDate(entry.updatedAt) }}</p><div class="history-progress"><span v-if="entry.duration" class="progress-track"><i :style="{ width: Math.min(100, entry.position / entry.duration * 100) + '%' }"></i></span><small>{{ entry.completed ? '已听完' : '已听 ' + formatTime(entry.position) }}<template v-if="entry.duration"> / {{ formatTime(entry.duration) }}</template></small></div></div><button class="button subtle small" :disabled="!!busy" @click="play(entry.key)"><AppIcon name="play" :size="15" />{{ busy === entry.key ? '获取中…' : entry.completed ? '再听一次' : '继续收听' }}</button><button class="icon-button" :aria-label="'移除历史：' + entry.title" @click="history.remove(entry.key)"><AppIcon name="close" :size="16" /></button></li></ul></section></template>
