<script setup lang="ts">
import { computed, ref, watch } from 'vue'
const props = withDefaults(defineProps<{ src?: string | null; title?: string }>(), { src: null, title: '小宇宙' })
const failed = ref(false)
watch(() => props.src, () => { failed.value = false })
const safeSrc = computed(() => props.src && /^https?:\/\//i.test(props.src) ? props.src : '')
const hue = computed(() => [...props.title].reduce((n, c) => n + c.charCodeAt(0), 0) % 360)
</script>
<template><span class="cover-art" :style="{ '--cover-hue': hue }"><img v-if="safeSrc && !failed" :src="safeSrc" :alt="title" loading="lazy" referrerpolicy="no-referrer" @error="failed = true" /><span v-else class="cover-initial" aria-hidden="true">{{ Array.from(title)[0] || '宇' }}</span></span></template>
