<script setup lang="ts">
import type { OfficialPodcast } from '@/lib/official-contract'
import CoverArt from '@/components/CoverArt.vue'
import AppIcon from '@/components/AppIcon.vue'
defineProps<{ podcast: OfficialPodcast; active?: boolean }>()
defineEmits<{ open: [pid: string] }>()
</script>
<template><button type="button" class="podcast-card" :class="{ selected: active }" :aria-expanded="active" @click="$emit('open', podcast.pid)"><div class="podcast-art"><CoverArt :src="podcast.imageUrl" :title="podcast.title" /><span class="art-action"><AppIcon name="arrow" /></span></div><h3 :title="podcast.title">{{ podcast.title || '未命名播客' }}</h3><p>{{ podcast.author || (podcast.episodeCount ? `${podcast.episodeCount} 集节目` : '探索这个声音') }}</p></button></template>
