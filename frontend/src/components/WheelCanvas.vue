<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import ThreeWheelRenderer from '../renderers/ThreeWheelRenderer'
import type { WheelRenderer } from '../renderers/WheelRenderer'

export interface PreparedSegment {
  id: string
  name?: string
  weight: number
  angle: number
  color: string
  isLast?: boolean
  isPrevented?: boolean
}

const props = defineProps<{
  participants?: any[]
  spinning: boolean
  winnerId: string | null
  peekId?: string | null
  previewOverrides?: Record<string, { weight?: number; visual?: any }>
  lastPickedId?: string | null
  preventRepeat?: boolean
  preparedSegments?: PreparedSegment[]
}>()

const emit = defineEmits<{
  (e: 'spin-complete', participantId: string): void
  (e: 'spin-click', direction: 'left' | 'right'): void
  (e: 'winner-reveal', data: { id: string; name: string; remaining: number }): void
  (e: 'camera-drifted', drifted: boolean): void
  (e: 'tick-segment', participantId: string | null): void
}>()

const containerRef = ref<HTMLDivElement | null>(null)
let threeRenderer: WheelRenderer | null = null

const MUTE_KEY = 'wheel-muted'
const isMuted = ref(false)
function readMuted(): boolean {
  try { return localStorage.getItem(MUTE_KEY) === '1' } catch { return false }
}
isMuted.value = readMuted()

function toggleMute() {
  isMuted.value = !isMuted.value
  if (threeRenderer && (threeRenderer as any).toggleMute) (threeRenderer as any).toggleMute()
  try { localStorage.setItem(MUTE_KEY, isMuted.value ? '1' : '0') } catch {}
}

function buildWheel() {
  if (threeRenderer && props.preparedSegments && props.preparedSegments.length) {
    threeRenderer.build(props.preparedSegments)
  }
}

watch(() => props.preparedSegments, () => buildWheel(), { deep: true })

watch(() => props.peekId, (id) => {
  if (threeRenderer) threeRenderer.setHighlight(id || null)
})

watch([() => props.spinning, () => props.winnerId], ([spinning, winnerId]) => {
  if (spinning && winnerId && threeRenderer) {
    threeRenderer.playSpin(winnerId as string, () => emit('spin-complete', winnerId as string))
  }
})

onMounted(() => {
  if (containerRef.value) {
    threeRenderer = new ThreeWheelRenderer(containerRef.value, {
      onTick: (id) => emit('tick-segment', id),
      onDrift: (d) => emit('camera-drifted', d),
      onWinner: (d) => emit('winner-reveal', d),
      onSpinComplete: (id) => emit('spin-complete', id),
      onSpinClick: (dir) => emit('spin-click', dir),
    })
  }
  if (props.preparedSegments && props.preparedSegments.length && threeRenderer) {
    threeRenderer.build(props.preparedSegments)
  }
})

onBeforeUnmount(() => {
  if (threeRenderer && (threeRenderer as any).dispose) {
    ;(threeRenderer as any).dispose()
  }
})

defineExpose({
  dismissWinner: () => { if (threeRenderer && (threeRenderer as any).dismissWinner) (threeRenderer as any).dismissWinner() },
  resetView: () => { if (threeRenderer && (threeRenderer as any).resetView) (threeRenderer as any).resetView() },
  isMuted,
  toggleMute,
  captureCanvas: () => threeRenderer && (threeRenderer as any).captureCanvas ? (threeRenderer as any).captureCanvas() : null,
})
</script>

<template>
  <div class="wheel-bg" ref="containerRef"></div>
</template>

<style scoped>
.wheel-bg {
  position: fixed;
  inset: 0;
  z-index: 0;
}
</style>
