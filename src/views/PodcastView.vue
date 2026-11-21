<script setup lang="ts">
import { computed, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import AppIcon from '@/components/AppIcon.vue'
import CoverArt from '@/components/CoverArt.vue'
import EpisodeList from '@/components/EpisodeList.vue'
import { useAccountStore } from '@/stores/account'
import { useOfficialStore } from '@/stores/official'
import type { OfficialPodcast } from '@/lib/official-contract'

const route = useRoute()
const account = useAccountStore()
const official = useOfficialStore()
const pid = computed(() => typeof route.params.pid === 'string' ? route.params.pid : '')
const state = computed(() => official.episodes[pid.value])
const podcast = computed<OfficialPodcast>(() => {
  const cached = [
    ...official.podcasts,
    ...official.searchPodcasts,
    ...official.discoverPodcasts,
  ].find((item) => item.pid === pid.value)
  const title = typeof route.query.title === 'string' ? route.query.title : ''
  const author = typeof route.query.author === 'string' ? route.query.author : ''
  const brief = typeof route.query.brief === 'string' ? route.query.brief : ''
  const imageUrl = typeof route.query.image === 'string' && route.query.image.startsWith('https://') ? route.query.image : null
  return cached ?? {
    pid: pid.value,
    title,
    author,
    brief,
    imageUrl,
    episodeCount: 0,
    subscriptionCount: 0,
    latestEpisodePubDate: null,
    starred: false,
  }
})
const backTo = computed(() => {
  const from = route.query.from
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') ? from : '/discover'
})

async function loadEpisodes(refresh = false): Promise<void> {
  if (account.isLoggedIn && pid.value) await official.loadEpisodes(pid.value, refresh)
}

watch([pid, () => account.isLoggedIn], () => { void loadEpisodes() }, { immediate: true })
</script>

<template>
  <section class="page podcast-page">
    <RouterLink class="text-button podcast-back" :to="backTo"><AppIcon name="arrow" :size="15" />返回列表</RouterLink>
    <header class="podcast-hero-card">
      <CoverArt :src="podcast.imageUrl" :title="podcast.title || '播客'" />
      <div class="podcast-hero-copy">
        <span class="eyebrow">PODCAST · {{ podcast.episodeCount || state?.items.length || 0 }} 集</span>
        <h1>{{ podcast.title || '播客单集' }}</h1>
        <p v-if="podcast.author" class="podcast-author">{{ podcast.author }}</p>
        <p v-if="podcast.brief" class="detail-brief">{{ podcast.brief }}</p>
      </div>
    </header>

    <section class="podcast-episodes">
      <header class="section-heading">
        <div><span class="eyebrow">EPISODE LIBRARY</span><h2>全部单集</h2></div>
        <button v-if="account.isLoggedIn" class="text-button" :disabled="state?.status === 'loading'" @click="loadEpisodes(true)">
          <AppIcon name="refresh" :size="15" />刷新
        </button>
      </header>

      <div v-if="!account.isLoggedIn" class="notice">
        <AppIcon name="info" :size="18" /><span>连接小宇宙账号后即可查看这个播客的单集。</span>
        <RouterLink to="/official" class="text-button">去登录<AppIcon name="arrow" :size="15" /></RouterLink>
      </div>
      <p v-else-if="state?.status === 'loading'" class="loading-message" role="status">正在加载播客单集…</p>
      <div v-else-if="state?.status === 'error'" class="notice error" role="alert">
        {{ state.error }}<button class="text-button" @click="loadEpisodes(true)">重试</button>
      </div>
      <template v-else-if="state?.items.length">
        <EpisodeList :items="state.items" :podcast="podcast.title" />
        <div v-if="state.error" class="notice error" role="alert">
          {{ state.error }}<button class="text-button" @click="official.loadMoreEpisodes(pid)">重试加载更多</button>
        </div>
        <button v-if="state.loadMoreKey != null" class="button subtle load-more" :disabled="state.loadingMore" @click="official.loadMoreEpisodes(pid)">
          {{ state.loadingMore ? '加载中…' : '加载更多单集' }}
        </button>
      </template>
      <div v-else-if="state?.status === 'ready'" class="empty-state compact">
        <AppIcon name="headphones" :size="32" /><h2>暂时还没有单集</h2><p>可以刷新列表，稍后再来看看。</p>
      </div>
      <p v-else class="loading-message" role="status">正在准备单集列表…</p>
    </section>
  </section>
</template>
