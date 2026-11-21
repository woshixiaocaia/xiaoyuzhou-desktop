<script setup lang="ts">
import { computed } from 'vue'
import AppIcon from '@/components/AppIcon.vue'
import EpisodeList from '@/components/EpisodeList.vue'
import { useOfficialStore } from '@/stores/official'
import type { OfficialPodcast } from '@/lib/official-contract'
const props = defineProps<{ podcast: OfficialPodcast }>()
defineEmits<{ close: [] }>()
const official = useOfficialStore()
const state = computed(() => official.episodes[props.podcast.pid])
</script>
<template><section class="detail-panel"><header class="section-heading"><div><span class="eyebrow">PODCAST EPISODES</span><h2>{{ podcast.title }}</h2></div><button type="button" class="icon-button" aria-label="收起单集" @click="$emit('close')"><AppIcon name="close" /></button></header><p v-if="podcast.brief" class="detail-brief">{{ podcast.brief }}</p><p v-if="state?.status === 'loading'" class="loading-message" role="status">正在寻找这个频道的声音…</p><div v-else-if="state?.status === 'error'" class="notice error" role="alert">{{ state.error }}<button class="text-button" @click="official.loadEpisodes(podcast.pid, true)">重新加载</button></div><EpisodeList v-else-if="state?.items.length" :items="state.items" :podcast="podcast.title" /><p v-else class="muted">这里暂时还没有单集。</p><button v-if="state?.loadMoreKey != null" class="button subtle load-more" :disabled="state.loadingMore" @click="official.loadMoreEpisodes(podcast.pid)">{{ state.loadingMore ? '加载中…' : '加载更多单集' }}</button></section></template>
