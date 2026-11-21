<script setup lang="ts">
import { computed } from 'vue'

import { useQueueStore } from '@/stores/queue'

/**
 * 最小队列面板：查看、切歌、移除、清空。
 * 只做功能，不做视觉堆砌；默认收起，避免占用播放区域。
 */
const queue = useQueueStore()

/**
 * 面板开合状态。
 * 既支持组件内部自管（默认），也支持父组件用 v-model 控制——
 * 这样播放栏左侧的队列按钮与这里的开关共用同一个状态，不会出现两份。
 */
const open = defineModel<boolean>('open', { default: false })

const count = computed(() => queue.length)
const items = computed(() => queue.items)

function playAt(position: number): void {
  queue.playAt(position)
}

function removeAt(position: number): void {
  queue.removeAt(position)
}

function clearAll(): void {
  queue.clear()
}
</script>

<template>
  <div class="queue">
    <section v-if="open" class="queue-panel" aria-label="播放队列">
      <header class="queue-head">
        <span class="queue-title">播放队列</span>
        <button type="button" class="queue-clear" :disabled="count === 0" @click="clearAll">
          清空
        </button>
      </header>

      <p v-if="count === 0" class="queue-empty">队列为空。播放任意节目后会自动出现在这里。</p>

      <ul v-else class="queue-list">
        <li
          v-for="(item, position) in items"
          :key="item.key"
          class="queue-item"
          :class="{ 'is-current': position === queue.index }"
        >
          <button type="button" class="queue-play" :title="`播放：${item.title}`" @click="playAt(position)">
            <span class="queue-source" :data-source="item.source">
              {{ item.source === 'official' ? '官方' : 'RSS' }}
            </span>
            <span class="queue-text">
              <span class="queue-item-title">{{ item.title || '（无标题）' }}</span>
              <span class="queue-item-sub">{{ item.podcast || '未知节目' }}</span>
            </span>
          </button>
          <button type="button" class="queue-remove" title="从队列移除" @click="removeAt(position)">
            移除
          </button>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.queue {
  position: relative;
}

.queue-toggle:hover {
  color: var(--color-accent-text);
  border-color: var(--color-accent);
}

.queue-count {
  font-weight: 600;
}

.queue-panel {
  position: absolute;
  right: var(--space-4);
  bottom: 132px;
  z-index: 20;
  width: 340px;
  max-height: 46vh;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background-color: var(--color-surface);
  box-shadow: var(--shadow-2);
  overflow: hidden;
}

.queue-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--color-border);
}

.queue-title {
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--color-heading);
}

.queue-clear,
.queue-remove {
  padding: 2px 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background-color: transparent;
  color: var(--color-text-3);
  font-size: var(--text-xs);
  cursor: pointer;
}

.queue-clear:hover,
.queue-remove:hover {
  color: var(--color-danger);
  border-color: var(--color-danger);
}

.queue-clear:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.queue-empty {
  padding: var(--space-4);
  font-size: var(--text-xs);
  color: var(--color-text-3);
  line-height: 1.6;
}

.queue-list {
  list-style: none;
  margin: 0;
  padding: var(--space-1);
  overflow-y: auto;
}

.queue-item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 4px;
  border-radius: var(--radius-md);
}

.queue-item.is-current {
  background-color: var(--color-accent-soft);
}

.queue-play {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 6px;
  border: none;
  background: transparent;
  cursor: pointer;
  text-align: left;
}

.queue-source {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  background-color: var(--color-surface-2);
  color: var(--color-text-3);
  font-size: 11px;
}

.queue-source[data-source='official'] {
  background-color: var(--color-accent-soft);
  color: var(--color-accent-text);
}

.queue-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.queue-item-title,
.queue-item-sub {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-item-title {
  font-size: var(--text-sm);
  color: var(--color-text);
}

.queue-item-sub {
  font-size: var(--text-xs);
  color: var(--color-text-3);
}
</style>
