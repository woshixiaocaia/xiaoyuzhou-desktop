<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import AppSidebar from '@/components/AppSidebar.vue'
import PlayerBar from '@/components/PlayerBar.vue'
import QueuePanel from '@/components/QueuePanel.vue'
import AppIcon from '@/components/AppIcon.vue'
import { setAuthExpiredHandler } from '@/lib/desktop'
import { bindMediaSession } from '@/lib/media-session'
import { queueShortcut } from '@/lib/shortcuts'
import { episodeKey, useHistoryStore } from '@/stores/history'
import { usePlayerStore } from '@/stores/player'
import { queueItemFromEpisode, useQueueStore } from '@/stores/queue'
import { useAccountStore } from '@/stores/account'
import { useOfficialStore } from '@/stores/official'
import { useSettingsStore } from '@/stores/settings'
const history = useHistoryStore(), queue = useQueueStore(), player = usePlayerStore()
const account = useAccountStore(), official = useOfficialStore(), settings = useSettingsStore()
const route = useRoute(), router = useRouter(), queueOpen = ref(false), online = ref(navigator.onLine)
const pageTitle = computed(() => String(route.meta.title || '发现'))
player.setResumeResolver((id) => settings.resume ? history.resumePosition(episodeKey(id.startsWith('official:') ? 'official' : 'rss', id)) : 0)
history.bindToPlayer(); queue.bindToPlayer()
const unbindMedia = bindMediaSession(player, queue)
setAuthExpiredHandler(() => account.invalidate())
watch(() => settings.volume, (value) => player.setVolume(value), { immediate: true })
watch(() => settings.rate, (value) => player.setPlaybackRate(value), { immediate: true })
watch(() => account.user?.uid || account.isLoggedIn, () => { official.reset(); history.setAccount(account.isLoggedIn ? account.user?.uid || '' : ''); if (!account.isLoggedIn) { if (player.current?.source === 'official') player.close(); queue.removeSource('official') } }, { immediate: true, flush: 'sync' })
watch(() => official.listErrorCode, (code) => { if (code === 'AUTH_EXPIRED') { account.cancel(); official.reset() } })
watch(() => player.current?.id, () => { const item = player.current && queueItemFromEpisode(player.current); if (item) queue.syncCurrent(item) })
watch(() => route.fullPath, () => { document.querySelector('.content')?.scrollTo({ top: 0, behavior: 'instant' }); queueOpen.value = false })
function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') { queueOpen.value = false; return }
  const target = event.target as HTMLElement | null
  if (target?.closest('input, textarea, select, button, [contenteditable="true"]')) return
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); void router.push('/search'); return }
  if (event.code === 'Space') { event.preventDefault(); player.toggle(); return }
  const action = queueShortcut(event)
  if (action) { event.preventDefault(); if (action === 'next') queue.next(); else queue.prev() }
}
function save(): void { history.persist(true) }
function updateOnline(): void { online.value = navigator.onLine }
onMounted(() => { void account.restore(); window.addEventListener('keydown', onKeydown); window.addEventListener('beforeunload', save); window.addEventListener('online', updateOnline); window.addEventListener('offline', updateOnline) })
onUnmounted(() => { unbindMedia(); setAuthExpiredHandler(null); window.removeEventListener('keydown', onKeydown); window.removeEventListener('beforeunload', save); window.removeEventListener('online', updateOnline); window.removeEventListener('offline', updateOnline) })
</script>
<template><div class="shell"><div class="body"><AppSidebar /><div class="workspace"><header class="topbar"><div class="breadcrumb">我的小宇宙<span>/</span><strong>{{ pageTitle }}</strong></div><div class="topbar-right"><span class="connection" :class="{ offline: !online }"><i></i>{{ online ? '为好声音留一点时间' : '网络已断开' }}</span><RouterLink to="/search" class="top-search"><AppIcon name="search" :size="15" />搜索播客<kbd>Ctrl K</kbd></RouterLink></div></header><main id="main-content" class="content" tabindex="-1"><p v-if="!online" class="offline-banner" role="status">当前处于离线状态。联网后可继续获取节目与音频。</p><RouterView /></main></div></div><QueuePanel v-model:open="queueOpen" /><PlayerBar v-model:queue-open="queueOpen" /></div></template>

