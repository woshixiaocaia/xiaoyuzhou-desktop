import { watch } from 'vue'
import type { usePlayerStore } from '@/stores/player'
import type { useQueueStore } from '@/stores/queue'

export function bindMediaSession(player: ReturnType<typeof usePlayerStore>, queue: ReturnType<typeof useQueueStore>): () => void {
  if (typeof navigator === 'undefined' || !navigator.mediaSession) return () => {}
  const media = navigator.mediaSession
  const actions: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
    play: () => { if (player.current) player.play(player.current) },
    pause: () => player.pause(),
    stop: () => player.close(),
    previoustrack: () => { queue.prev() },
    nexttrack: () => { queue.next() },
    seekbackward: event => player.seek(player.currentTime - (event.seekOffset || 15)),
    seekforward: event => player.seek(player.currentTime + (event.seekOffset || 15)),
    seekto: event => { if (typeof event.seekTime === 'number') player.seek(event.seekTime) },
  }
  for (const [action, handler] of Object.entries(actions)) {
    try { media.setActionHandler(action as MediaSessionAction, handler) } catch { /* unsupported OS action */ }
  }
  const stopMetadata = watch(() => player.current, (episode) => {
    media.metadata = episode ? new MediaMetadata({ title: episode.title, artist: episode.podcast, album: '小宇宙 Desktop', artwork: episode.imageUrl && /^https?:\/\//i.test(episode.imageUrl) ? [{ src: episode.imageUrl }] : [] }) : null
  }, { immediate: true })
  const stopState = watch(() => player.status, status => { media.playbackState = status === 'playing' ? 'playing' : player.current ? 'paused' : 'none' }, { immediate: true })
  const stopPosition = watch(() => [player.currentTime, player.duration, player.playbackRate], () => {
    if (!Number.isFinite(player.duration) || player.duration <= 0) return
    try { media.setPositionState({ duration: player.duration, playbackRate: player.playbackRate, position: Math.min(player.duration, Math.max(0, player.currentTime)) }) } catch { /* metadata not ready */ }
  })
  return () => {
    stopMetadata(); stopState(); stopPosition()
    for (const action of Object.keys(actions)) { try { media.setActionHandler(action as MediaSessionAction, null) } catch { /* unsupported */ } }
    media.metadata = null
  }
}
