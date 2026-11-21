<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import AppIcon from '@/components/AppIcon.vue'
import CoverArt from '@/components/CoverArt.vue'
import { formatTime } from '@/lib/format'
import { usePlayerStore } from '@/stores/player'
import { useQueueStore } from '@/stores/queue'
import { useSettingsStore } from '@/stores/settings'
const player = usePlayerStore(), queue = useQueueStore(), settings = useSettingsStore()
const queueOpen = defineModel<boolean>('queueOpen', { default: false })
const scrub = ref<number | null>(null), sleepMinutes = ref(0)
let timer: ReturnType<typeof setTimeout> | null = null
const shownTime = computed(() => scrub.value ?? player.currentTime)
const statusText = computed(() => ({ idle: '选一集喜欢的，让声音陪你', loading: '正在缓冲…', playing: '正在播放', paused: '已暂停', ended: '已听完', error: '播放遇到问题', unavailable: '暂无可用音频' })[player.status])
const percent = computed(() => player.duration > 0 ? Math.min(100, Math.max(0, shownTime.value / player.duration * 100)) : 0)
function commit(event: Event): void { player.seek(Number((event.target as HTMLInputElement).value)); scrub.value = null }
function setSleep(): void {
  if (timer) clearTimeout(timer)
  timer = null
  if (sleepMinutes.value) timer = setTimeout(() => { player.pause(); sleepMinutes.value = 0; timer = null }, sleepMinutes.value * 60000)
}
onUnmounted(() => { if (timer) clearTimeout(timer) })
</script>
<template><footer class="player" aria-label="播放器"><div class="player-meta"><CoverArt :src="player.current?.imageUrl" :title="player.current?.podcast || '听'" /><div><strong :title="player.current?.title">{{ player.current?.title || '此刻，等一个好声音' }}</strong><span>{{ player.current?.podcast || '小宇宙 · 让陪伴继续' }}</span><small :class="{ 'text-danger': player.status === 'error' }" :title="player.errorMessage || ''">{{ player.errorMessage || statusText }}</small></div></div><div class="player-center"><div class="player-controls"><button class="icon-button" :disabled="!queue.hasPrev" aria-label="上一集" title="上一集 · Ctrl Alt ←" @click="queue.prev()"><AppIcon name="prev" :size="18" /></button><button class="icon-button" :disabled="!player.canSeek" aria-label="后退15秒" title="后退 15 秒" @click="player.seek(player.currentTime - 15)"><AppIcon name="back" :size="21" /></button><button class="player-main" :disabled="!player.current || player.status === 'loading' || player.status === 'unavailable'" :aria-label="player.isPlaying ? '暂停' : player.status === 'error' ? '重试播放' : '播放'" title="播放 / 暂停 · Space" @click="player.toggle()"><AppIcon :name="player.isPlaying ? 'pause' : 'play'" :size="23" /></button><button class="icon-button" :disabled="!player.canSeek" aria-label="前进15秒" title="前进 15 秒" @click="player.seek(player.currentTime + 15)"><AppIcon name="forward" :size="21" /></button><button class="icon-button" :disabled="!queue.hasNext" aria-label="下一集" title="下一集 · Ctrl Alt →" @click="queue.next()"><AppIcon name="next" :size="18" /></button></div><div class="player-timeline"><span>{{ formatTime(shownTime) }}</span><input class="progress-input" type="range" min="0" :max="player.duration || 1" step="1" :value="shownTime" :style="{ '--progress': percent + '%' }" :disabled="!player.canSeek" aria-label="播放进度" :aria-valuetext="formatTime(shownTime) + ' / ' + formatTime(player.duration)" @input="scrub = Number(($event.target as HTMLInputElement).value)" @change="commit" /><span>{{ formatTime(player.duration) }}</span></div></div><div class="player-tools"><select v-model.number="settings.rate" class="rate-select" aria-label="播放倍速" title="播放速度"><option v-for="rate in [0.75, 1, 1.25, 1.5, 1.75, 2]" :key="rate" :value="rate">{{ rate }}×</option></select><div class="volume-control"><button class="icon-button" :aria-label="settings.volume ? '静音' : '取消静音'" @click="settings.volume = settings.volume ? 0 : 0.8"><AppIcon :name="settings.volume ? 'volume' : 'mute'" :size="18" /></button><input v-model.number="settings.volume" type="range" min="0" max="1" step="0.01" aria-label="音量" /></div><label class="sleep-control" :class="{ active: sleepMinutes }" title="定时停止"><AppIcon name="moon" :size="17" /><select v-model.number="sleepMinutes" aria-label="定时停止" @change="setSleep"><option :value="0">定时关闭</option><option v-for="minutes in [15, 30, 45, 60, 90]" :key="minutes" :value="minutes">{{ minutes }} 分钟</option></select></label><button class="icon-button queue-button" :class="{ active: queueOpen }" :aria-expanded="queueOpen" aria-label="播放队列" title="播放队列" @click="queueOpen = !queueOpen"><AppIcon name="queue" :size="21" /><span v-if="queue.length">{{ queue.length }}</span></button><button v-if="player.current" class="icon-button stop-button" aria-label="停止播放" title="停止播放" @click="player.close()"><AppIcon name="stop" :size="15" /></button></div></footer></template>
