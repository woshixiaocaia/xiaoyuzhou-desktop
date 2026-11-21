<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 20 })
const paths: Record<string, string> = {
  discover: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM16.3 7.7l-2.8 5.8-5.8 2.8 2.8-5.8 5.8-2.8Z',
  search: 'M21 21l-5-5M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15Z',
  library: 'M4 4v16M9 4v16M14 4v16M18 4l4 15',
  history: 'M3 11a9 9 0 1 1 2.3 7M3 4v7h7M12 7v5l3 2',
  star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z',
  user: 'M20 21v-2a6 6 0 0 0-6-6h-4a6 6 0 0 0-6 6v2M12 10a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  settings: 'M9 3h6l.5 3 2 1.2 2.8-1 3 5.2-2.3 2v2.3l2.3 2-3 5.2-2.8-1-2 1.2L15 23H9l-.5-3-2-1.2-2.8 1-3-5.2 2.3-2v-2.3l-2.3-2 3-5.2 2.8 1 2-1.2L9 3ZM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  play: 'm9 5 11 7-11 7V5Z', pause: 'M8 5v14M16 5v14',
  next: 'm5 5 10 7-10 7V5ZM19 5v14', prev: 'm19 5-10 7 10 7V5ZM5 5v14',
  back: 'M5 8v-5M5 8h5M5.3 8a8 8 0 1 1-1.2 8M10 11v6M13 11h3v3h-3v3h3',
  forward: 'M19 8v-5M19 8h-5M18.7 8a8 8 0 1 0 1.2 8M9 11v6M12 11h3v3h-3v3h3',
  queue: 'M4 5h16M4 11h16M4 17h9m4-2 5 3-5 3v-6Z',
  volume: 'M11 4 5 9H2v6h3l6 5V4ZM15 8a6 6 0 0 1 0 8M18 4a11 11 0 0 1 0 16',
  mute: 'M11 4 5 9H2v6h3l6 5V4ZM16 9l6 6m0-6-6 6',
  plus: 'M12 5v14M5 12h14', close: 'm6 6 12 12M6 18 18 6',
  arrow: 'M5 12h14m-6-6 6 6-6 6', chevron: 'm9 5 7 7-7 7',
  refresh: 'M20 7a9 9 0 1 0 1 9M20 2v6h-6',
  rss: 'M4 4a16 16 0 0 1 16 16M4 10a10 10 0 0 1 10 10M5 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z',
  headphones: 'M3 14v-3a9 9 0 0 1 18 0v3M3 12h4v9H3v-9ZM17 12h4v9h-4v-9Z',
  moon: 'M20.5 14A9 9 0 0 1 10 3.5 9 9 0 1 0 20.5 14Z',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 1v3M12 20v3M1 12h3M20 12h3M4 4l2 2M18 18l2 2M4 20l2-2M18 6l2-2',
  monitor: 'M3 3h18v14H3V3ZM8 22h8M12 17v5',
  check: 'm5 12 4 4L19 6', trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 6v6l4 2',
  logout: 'M9 3H3v18h6M9 12h13m-5-5 5 5-5 5',
  stop: 'M6 6h12v12H6V6Z', info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 11v6M12 7v.1',
}
</script>
<template><svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name] || paths.headphones" /></svg></template>
