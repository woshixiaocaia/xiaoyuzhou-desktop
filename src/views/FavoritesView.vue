<script setup lang="ts">
import { onMounted, watch } from 'vue'
import AppIcon from '@/components/AppIcon.vue'
import EpisodeList from '@/components/EpisodeList.vue'
import { useAccountStore } from '@/stores/account'
import { useOfficialStore } from '@/stores/official'

const account = useAccountStore()
const official = useOfficialStore()
function refresh(): void {
  if (account.isLoggedIn && account.user?.uid) void official.loadFavorites(account.user.uid, true)
}
function loadMore(): void {
  if (account.isLoggedIn && account.user?.uid) void official.loadFavorites(account.user.uid, false)
}
onMounted(refresh)
watch(() => account.isLoggedIn, refresh)
</script>

<template>
  <section class="page">
    <header class="page-heading">
      <div>
        <span class="eyebrow">YOUR SAVED EPISODES</span>
        <h1>喜欢的单集<span class="accent">.</span></h1>
        <p>读取你在手机小宇宙里收藏的单集。</p>
      </div>
      <button v-if="account.isLoggedIn" class="button subtle" :disabled="official.favoriteStatus === 'loading'" @click="refresh">
        <AppIcon name="refresh" :size="16" />刷新收藏
      </button>
    </header>

    <div v-if="!account.isLoggedIn" class="empty-state">
      <AppIcon name="star" :size="38" /><h2>登录后同步手机收藏</h2>
      <p>连接同一个小宇宙账号，即可读取个人主页里喜欢的单集。</p>
      <RouterLink to="/official" class="button primary">连接我的账号<AppIcon name="arrow" :size="16" /></RouterLink>
    </div>
    <p v-else-if="official.favoriteStatus === 'loading'" class="loading-message" role="status">正在读取你的收藏…</p>
    <div v-else-if="official.favoriteStatus === 'error' && !official.favoriteEpisodes.length" class="notice error" role="alert">
      {{ official.favoriteError }}<button class="text-button" @click="refresh">重试</button>
    </div>
    <div v-else-if="official.favoriteEpisodes.length" class="favorites-content">
      <div class="category-tabs"><span>手机账号收藏<span class="count-pill">{{ official.favoriteEpisodes.length }}</span></span><span class="result-count">与小宇宙账号保持同步</span></div>
      <EpisodeList :items="official.favoriteEpisodes" />
      <div v-if="official.favoriteError" class="notice error" role="alert">{{ official.favoriteError }}</div>
      <button v-if="official.hasMoreFavorites" class="button subtle load-more" :disabled="official.favoriteLoadingMore" @click="loadMore">
        {{ official.favoriteLoadingMore ? '加载中…' : '加载更多收藏' }}
      </button>
    </div>
    <div v-else-if="official.favoriteStatus === 'ready'" class="empty-state compact">
      <AppIcon name="star" :size="34" /><h2>还没有收藏的单集</h2>
      <p>在小宇宙 App 收藏喜欢的单集后，可以在这里刷新查看。</p>
    </div>
  </section>
</template>
