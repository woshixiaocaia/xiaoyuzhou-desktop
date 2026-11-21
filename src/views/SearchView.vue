<script setup lang="ts">
import { ref } from 'vue'
import AppIcon from '@/components/AppIcon.vue'
import EpisodeList from '@/components/EpisodeList.vue'
import PodcastCard from '@/components/PodcastCard.vue'
import { useOfficialStore } from '@/stores/official'
import { useAccountStore } from '@/stores/account'

const official = useOfficialStore()
const account = useAccountStore()
const input = ref(official.searchKeyword)

async function search(): Promise<void> {
  await official.runSearch(input.value, official.searchType)
}

async function setType(type: 'EPISODE' | 'PODCAST' | 'ALL'): Promise<void> {
  official.searchType = type
  if (input.value.trim()) await search()
}
</script>

<template>
  <section class="page">
    <header class="page-heading">
      <div>
        <span class="eyebrow">FIND YOUR NEXT FAVORITE</span>
        <h1>寻找，心动的声音<span class="accent">.</span></h1>
        <p>输入一个关键词，让好奇心带路。</p>
      </div>
    </header>

    <form class="search-form" @submit.prevent="search">
      <AppIcon name="search" :size="23" />
      <input v-model="input" type="search" aria-label="搜索播客或单集" placeholder="搜索单集标题、播客或话题" maxlength="200" />
      <button class="button primary" :disabled="!input.trim() || official.searchStatus === 'loading' || !account.isLoggedIn">
        {{ official.searchStatus === 'loading' ? '搜索中…' : '搜索' }}
      </button>
    </form>

    <div v-if="!account.isLoggedIn" class="notice">
      <AppIcon name="info" :size="18" /><span>搜索需要连接你的小宇宙账号。</span>
      <RouterLink to="/official" class="text-button">去登录<AppIcon name="arrow" :size="15" /></RouterLink>
    </div>

    <template v-else>
      <div class="category-tabs">
        <button :class="{ active: official.searchType === 'EPISODE' }" @click="setType('EPISODE')">单集</button>
        <button :class="{ active: official.searchType === 'PODCAST' }" @click="setType('PODCAST')">播客</button>
        <button :class="{ active: official.searchType === 'ALL' }" @click="setType('ALL')">全部内容</button>
        <span v-if="official.searchStatus === 'ready'" class="result-count">
          {{ official.searchType === 'PODCAST' ? official.searchPodcasts.length : official.searchType === 'EPISODE' ? official.searchEpisodes.length : official.searchPodcasts.length + official.searchEpisodes.length }} 条结果
        </span>
      </div>

      <p v-if="official.searchStatus === 'loading'" class="loading-message" role="status">正在搜索「{{ official.searchKeyword }}」…</p>
      <p v-else-if="official.searchStatus === 'error'" class="notice error" role="alert">{{ official.searchError }}</p>
      <div v-else-if="official.searchStatus === 'empty'" class="empty-state">
        <AppIcon name="search" :size="38" /><h2>还没找到这个声音</h2>
        <p>试试更简短的关键词，或者换一个话题。</p>
      </div>

      <div v-if="official.searchPodcasts.length" class="podcast-grid">
        <PodcastCard v-for="podcast in official.searchPodcasts" :key="podcast.pid" :podcast="podcast" />
      </div>
      <section v-if="official.searchEpisodes.length" class="section-block">
        <h2 class="section-title">{{ official.searchType === 'ALL' ? '相关单集' : '单集搜索结果' }}</h2>
        <EpisodeList :items="official.searchEpisodes" />
      </section>
    </template>

    <div v-if="official.searchStatus === 'idle' || !account.isLoggedIn" class="search-suggestions">
      <span class="eyebrow">A FEW IDEAS TO START</span><h2>此刻，对什么好奇？</h2>
      <div class="suggestion-chips">
        <button v-for="word in ['科技与未来', '生活方式', '商业观察', '故事', '读书', '电影']" :key="word" :disabled="!account.isLoggedIn" @click="input = word; search()">
          {{ word }}<AppIcon name="arrow" :size="14" />
        </button>
      </div>
      <p class="muted">{{ account.isLoggedIn ? '默认搜索单集，也可以切换到播客或全部内容。' : '连接账号后，点击话题即可开始搜索。' }}</p>
    </div>
  </section>
</template>
