<script setup lang="ts">
import type { OfficialPodcast } from '@/lib/official-contract'
import CoverArt from '@/components/CoverArt.vue'
import AppIcon from '@/components/AppIcon.vue'
import { useRoute, useRouter } from 'vue-router'
defineProps<{ podcast: OfficialPodcast }>()
const route = useRoute(), router = useRouter()
function open(podcast: OfficialPodcast): void {
  void router.push({
    name: 'podcast',
    params: { pid: podcast.pid },
    query: {
      title: podcast.title,
      author: podcast.author,
      brief: podcast.brief,
      image: podcast.imageUrl ?? '',
      from: route.fullPath,
    },
  })
}
</script>
<template><button type="button" class="podcast-card" @click="open(podcast)"><div class="podcast-art"><CoverArt :src="podcast.imageUrl" :title="podcast.title" /><span class="art-action"><AppIcon name="arrow" /></span></div><h3 :title="podcast.title">{{ podcast.title || '未命名播客' }}</h3><p>{{ podcast.author || (podcast.episodeCount ? `${podcast.episodeCount} 集节目` : '探索这个声音') }}</p></button></template>
