<script setup lang="ts">
import { ref } from 'vue'
import AppIcon from '@/components/AppIcon.vue'
import CoverArt from '@/components/CoverArt.vue'
import { formatTime, formatDate, plainText } from '@/lib/format'
import type { OfficialEpisode } from '@/lib/official-contract'
import { useOfficialStore } from '@/stores/official'
import { usePlayerStore } from '@/stores/player'
import { queueItemFromEpisode, useQueueStore } from '@/stores/queue'
const props = withDefaults(defineProps<{ items: OfficialEpisode[]; podcast?: string }>(), { podcast: '' })
const official = useOfficialStore(), player = usePlayerStore(), queue = useQueueStore()
const busy = ref(''), message = ref('')
async function act(episode: OfficialEpisode, enqueue = false): Promise<void> {
  if (busy.value) return
  busy.value = episode.eid; message.value = ''
  try {
    const url = await official.resolveAudioUrl(episode)
    if (!url) { message.value = '暂时无法获取音频。请确认登录状态；付费内容需先在小宇宙 App 内购买。'; return }
    const podcast = props.podcast || official.podcasts.find(p => p.pid === episode.pid)?.title || official.searchPodcasts.find(p => p.pid === episode.pid)?.title || official.discoverPodcasts.find(p => p.pid === episode.pid)?.title || '小宇宙'
    const entry = { id: `official:${episode.eid}`, title: episode.title || '未命名单集', podcast, duration: episode.durationSeconds, audioUrl: url, source: 'official' as const, podcastId: episode.pid, imageUrl: episode.imageUrl }
    if (enqueue) {
      const item = queueItemFromEpisode(entry)
      if (item) message.value = queue.add(item) === 'added' ? '已加入播放队列' : '这集已经在队列中了'
    } else player.play(entry)
  } finally { busy.value = '' }
}
</script>
<template><div><p v-if="message" class="notice compact" role="status">{{ message }}</p><ul class="episode-list"><li v-for="(episode, index) in items" :key="episode.eid" class="episode-row"><span class="episode-index">{{ String(index + 1).padStart(2, '0') }}</span><CoverArt :src="episode.imageUrl" :title="episode.title" /><div class="episode-copy"><h3>{{ episode.title || '未命名单集' }}</h3><p class="muted">{{ formatDate(episode.pubDate) }}<span v-if="episode.durationSeconds"> · {{ formatTime(episode.durationSeconds) }}</span><span v-if="episode.isPrivate"> · 付费单集</span></p><details v-if="episode.description" class="episode-description"><summary>单集简介</summary><p>{{ plainText(episode.description) }}</p></details></div><button class="icon-button" type="button" :disabled="!!busy" :aria-label="`加入队列：${episode.title}`" title="加入播放队列" @click="act(episode, true)"><AppIcon name="plus" :size="18" /></button><button class="round-play" type="button" :disabled="!!busy" :aria-label="`播放：${episode.title}`" @click="act(episode)"><AppIcon :name="busy === episode.eid ? 'clock' : 'play'" :size="18" /></button></li></ul></div></template>
