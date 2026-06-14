<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, defineAsyncComponent } from 'vue'
const WheelCanvas = defineAsyncComponent(() => import('./components/WheelCanvas.vue'))
import NameList from './components/NameList.vue'
import SpinResultModal from './components/SpinResult.vue'
import CommandPalette, { type Command } from './components/CommandPalette.vue'
import { useSession } from './composables/useSession'
import { identityColor } from './utils/identity'

const {
  session,
  activeParticipants,
  removedParticipants,
  loading,
  error,
  remoteSpinResult,
  wsConnected,
  create,
  load,
  addName,
  addNames,
  removeName,
  doSpin,
  applySpinResult,
  reset,
} = useSession()

const titleInput = ref('')
const spinning = ref(false)
const winnerId = ref<string | null>(null)
const wheelRef = ref<{ dismissWinner: () => void } | null>(null)
const winnerData = ref<{ id: string; name: string; remaining: number } | null>(null)
let isLocalSpin = false
let pendingSpinResult: import('./types').SpinResult | null = null

const flameCanvas = ref<HTMLCanvasElement | null>(null)
let flameAnimId = 0
let flameCleanup: (() => void) | null = null

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  maxLife: number
  size: number
}

// Scanning the full canvas with getImageData on every resize is expensive;
// the edge points only depend on the canvas size, so cache by dimensions.
// Bounded: a long session with many window sizes would otherwise keep every
// point array forever.
const edgePointsCache = new Map<string, [number, number][]>()
const EDGE_POINTS_CACHE_LIMIT = 12

function getTextEdgePoints(w: number, h: number): [number, number][] {
  const key = `${w}x${h}`
  const cached = edgePointsCache.get(key)
  if (cached) return cached
  const points = computeTextEdgePoints(w, h)
  if (edgePointsCache.size >= EDGE_POINTS_CACHE_LIMIT) {
    edgePointsCache.delete(edgePointsCache.keys().next().value!)
  }
  edgePointsCache.set(key, points)
  return points
}

function computeTextEdgePoints(w: number, h: number): [number, number][] {
  const off = document.createElement('canvas')
  off.width = w
  off.height = h
  const octx = off.getContext('2d')!
  octx.clearRect(0, 0, w, h)
  octx.font = 'bold 42px Inter, system-ui, sans-serif'
  octx.textAlign = 'center'
  octx.textBaseline = 'middle'
  octx.fillStyle = '#fff'
  octx.fillText('Wheel of Shame', w / 2, h / 2)

  const imgData = octx.getImageData(0, 0, w, h)
  const pixels = imgData.data
  const points: [number, number][] = []

  // Find edge pixels: alpha > 0 but has a transparent neighbor
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const idx = (y * w + x) * 4
      const a = pixels[idx + 3]
      if (a < 80) continue

      const top = pixels[((y - 1) * w + x) * 4 + 3]
      const bot = pixels[((y + 1) * w + x) * 4 + 3]
      const lft = pixels[(y * w + x - 1) * 4 + 3]
      const rgt = pixels[(y * w + x + 1) * 4 + 3]

      if (top < 80 || bot < 80 || lft < 80 || rgt < 80) {
        points.push([x, y])
      }
    }
  }
  return points
}

function initFlame() {
  const canvasEl = flameCanvas.value
  if (!canvasEl) return
  const canvas: HTMLCanvasElement = canvasEl
  const ctx = canvas.getContext('2d')!

  const particles: Particle[] = []
  let edgePoints: [number, number][] = []

  function resize() {
    const header = canvas.parentElement
    if (!header) return
    canvas.width = header.clientWidth
    canvas.height = header.clientHeight
    edgePoints = getTextEdgePoints(canvas.width, canvas.height)
  }
  resize()

  // Debounce: a window drag fires resize continuously; only recompute once it
  // settles. Cleanup removes the listener and pending timer on unmount.
  let resizeTimer: ReturnType<typeof setTimeout> | undefined
  const onResize = () => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(resize, 150)
  }
  window.addEventListener('resize', onResize)
  flameCleanup = () => {
    window.removeEventListener('resize', onResize)
    clearTimeout(resizeTimer)
  }

  // Reduced motion: thin the flame to a low flicker rather than a full blaze.
  const reducedMotion = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const spawnPerFrame = reducedMotion ? 1 : 4

  function spawn() {
    if (edgePoints.length === 0) return
    for (let i = 0; i < spawnPerFrame; i++) {
      const pt = edgePoints[Math.floor(Math.random() * edgePoints.length)]
      particles.push({
        x: pt[0],
        y: pt[1],
        vx: (Math.random() - 0.5) * 0.6,
        vy: -(0.8 + Math.random() * 1.8),
        life: 0,
        maxLife: 20 + Math.random() * 30,
        size: 4 + Math.random() * 10,
      })
    }
  }

  function loop() {
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    spawn()

    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]
      p.life++
      p.x += p.vx + (Math.random() - 0.5) * 0.4
      p.y += p.vy
      p.vy *= 0.97
      p.vx += (Math.random() - 0.5) * 0.1
      p.size *= 0.98

      if (p.life >= p.maxLife || p.size < 0.5) {
        particles.splice(i, 1)
        continue
      }

      const t = p.life / p.maxLife
      const alpha = t < 0.15 ? t / 0.15 : 1 - ((t - 0.15) / 0.85)

      let r: number, g: number, b: number
      if (t < 0.2) {
        r = 255; g = 255 - t * 400; b = 50 * (1 - t * 5)
      } else if (t < 0.5) {
        const st = (t - 0.2) / 0.3
        r = 255; g = 155 * (1 - st); b = 0
      } else if (t < 0.8) {
        const st = (t - 0.5) / 0.3
        r = 255 - st * 120; g = 0; b = 0
      } else {
        const st = (t - 0.8) / 0.2
        r = 135 - st * 80; g = st * 20; b = st * 20
      }

      ctx.save()
      ctx.globalAlpha = alpha * 0.8
      ctx.translate(p.x, p.y)

      const s = p.size
      ctx.beginPath()
      ctx.moveTo(0, -s * 1.2)
      ctx.bezierCurveTo(s * 0.5, -s * 0.4, s * 0.4, s * 0.3, 0, s * 0.5)
      ctx.bezierCurveTo(-s * 0.4, s * 0.3, -s * 0.5, -s * 0.4, 0, -s * 1.2)
      ctx.closePath()

      const grad = ctx.createRadialGradient(0, -s * 0.3, 0, 0, -s * 0.3, s)
      grad.addColorStop(0, `rgba(${r},${g},${b},1)`)
      grad.addColorStop(0.5, `rgba(${r},${g},${b},0.4)`)
      grad.addColorStop(1, `rgba(${r},${g},${b},0)`)
      ctx.fillStyle = grad
      ctx.fill()

      ctx.restore()
    }

    flameAnimId = requestAnimationFrame(loop)
  }

  flameAnimId = requestAnimationFrame(loop)
}

onMounted(() => {
  const hash = window.location.hash
  if (hash.startsWith('#/')) {
    const id = hash.slice(2)
    if (id) load(id)
  }
  initFlame()
  window.addEventListener('keydown', onGlobalKeydown)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(flameAnimId)
  flameCleanup?.()
  window.removeEventListener('keydown', onGlobalKeydown)
})

// A SpinResult from another client: drive the wheel to that winner with the
// same animation as a local spin, instead of jumping to the result. The picked
// participant is still active in activeParticipants (useSession defers the
// removal), so animateSpin can land on its segment; applySpinResult marks it
// removed on spin-complete.
watch(remoteSpinResult, (result) => {
  if (!result) return
  // Ignore our own spin (handled by the local path) and don't interrupt an
  // animation already in flight; apply the latter directly so it isn't lost.
  if (isLocalSpin) {
    remoteSpinResult.value = null
    return
  }
  if (spinning.value) {
    applySpinResult(result)
    remoteSpinResult.value = null
    return
  }
  pendingSpinResult = result
  winnerId.value = result.picked.id
  spinning.value = true
})

async function createSession() {
  const title = titleInput.value.trim()
  if (!title) return
  await create(title)
  titleInput.value = ''
}

async function handleSpin() {
  if (spinning.value || activeParticipants.value.length === 0) return

  isLocalSpin = true
  const result = await doSpin()
  if (!result) {
    isLocalSpin = false
    return
  }

  // Store result but don't apply yet — participant stays active during animation
  pendingSpinResult = result
  winnerId.value = result.picked.id
  spinning.value = true
}

function onWinnerReveal(data: { id: string; name: string; remaining: number }) {
  winnerData.value = data
}

function dismissWinner() {
  winnerData.value = null
  wheelRef.value?.dismissWinner()
}

function onSpinComplete(_participantId: string) {
  if (pendingSpinResult) {
    applySpinResult(pendingSpinResult)
    pendingSpinResult = null
  }
  spinning.value = false
  winnerId.value = null
  isLocalSpin = false
  remoteSpinResult.value = null
}

function copyLink() {
  if (!session.value) return
  const url = `${window.location.origin}${window.location.pathname}#/${session.value.id}`
  navigator.clipboard.writeText(url)
}

// --- Command palette (Cmd-K / Ctrl-K) ---
const paletteOpen = ref(false)

const paletteCommands = computed<Command[]>(() => [
  {
    id: 'spin',
    label: 'Spin the wheel',
    hint: 'Spin',
    disabled: spinning.value || activeParticipants.value.length === 0,
    run: () => {
      handleSpin()
    },
  },
  {
    id: 'add',
    label: 'Add a name',
    hint: 'New participant',
    disabled: !session.value,
    run: () => {
      const name = window.prompt('Name to add')?.trim()
      if (name) addName(name)
    },
  },
  {
    id: 'reset',
    label: 'Reset the wheel',
    hint: 'Restore everyone',
    disabled: !session.value || removedParticipants.value.length === 0,
    run: () => {
      reset()
    },
  },
  {
    id: 'copy-link',
    label: 'Copy share link',
    hint: 'Share',
    disabled: !session.value,
    run: () => {
      copyLink()
    },
  },
  // One spotlight command per active participant: type a name into Cmd-K and
  // the fuzzy scorer floats the match to the top, then Enter eliminates them.
  ...activeParticipants.value.map((p): Command => {
    const odds = Math.round(100 / activeParticipants.value.length)
    return {
      id: `remove-${p.id}`,
      label: `Eliminate ${p.name}`,
      subtitle: `${odds}% to be picked next`,
      hint: 'Remove',
      run: () => {
        removeName(p.id)
      },
    }
  }),
])

// True when the keystroke targets a text field (name input, palette, etc.),
// so global shortcuts don't hijack normal typing: a space in a name should
// insert a space, not spin the wheel.
function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
}

function onGlobalKeydown(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault()
    paletteOpen.value = !paletteOpen.value
    return
  }
  // The command palette owns the keyboard while it's open (Escape closes it).
  if (paletteOpen.value) return

  if (e.code === 'Space' && !isEditableTarget(e.target)) {
    e.preventDefault()
    // Don't spin underneath the winner modal: Space is inert until dismissed.
    if (!winnerData.value) handleSpin()
  } else if (e.key === 'Escape' && winnerData.value) {
    e.preventDefault()
    dismissWinner()
  }
}
</script>

<template>
  <!-- 3D background — fullscreen, behind everything -->
  <WheelCanvas
    ref="wheelRef"
    :participants="activeParticipants"
    :spinning="spinning"
    :winner-id="winnerId"
    @spin-complete="onSpinComplete"
    @spin-click="handleSpin"
    @winner-reveal="onWinnerReveal"
  />

  <!-- UI overlay -->
  <div class="overlay">
    <header class="fire-header">
      <canvas ref="flameCanvas" class="flame-canvas"></canvas>
      <h1 class="fire-title">
        <span class="fire-text" data-text="Wheel of Shame">Wheel of Shame</span>
      </h1>
    </header>

    <div v-if="loading" class="loading">Loading...</div>
    <div v-if="error" class="error">{{ error }}</div>

    <!-- Create session screen -->
    <div v-if="!session && !loading" class="create-screen">
      <p>Create a session to get started</p>
      <div class="create-form">
        <input
          v-model="titleInput"
          @keyup.enter="createSession"
          placeholder="Session title (e.g. Sprint Retro)"
          class="title-input"
        />
        <button @click="createSession" class="btn btn-primary">Create</button>
      </div>
    </div>

    <!-- Session screen -->
    <div v-if="session" class="session-screen">
      <div class="session-header">
        <div class="session-actions">
          <span class="ws-status" :class="{ connected: wsConnected }">
            {{ wsConnected ? 'Live' : 'Offline' }}
          </span>
          <span class="kbd-hint" title="Press Space to spin"><kbd>Space</kbd> to spin</span>
          <button @click="copyLink" class="btn btn-small" title="Copy link">Share</button>
        </div>
      </div>

      <div class="main-layout">
        <!-- Left side: spin button only (wheel is the background) -->
        <div class="wheel-section">
        </div>

        <!-- Right side: name list panel -->
        <div class="list-section">
          <div class="panel">
            <NameList
              :active="activeParticipants"
              :removed="removedParticipants"
              @add="addName"
              @add-batch="addNames"
              @remove="removeName"
            @reset="reset"
            />
          </div>
        </div>
      </div>
    </div>

  </div>

  <Teleport to="body">
    <SpinResultModal
      v-if="winnerData"
      :name="winnerData.name"
      :remaining="winnerData.remaining"
      :color="identityColor(winnerData.name)"
      @close="dismissWinner"
    />
  </Teleport>

  <CommandPalette
    :open="paletteOpen"
    :commands="paletteCommands"
    @close="paletteOpen = false"
  />
</template>

<style scoped>
.overlay {
  position: relative;
  z-index: 1;
  min-height: 100vh;
  padding: 20px;
  pointer-events: none;
}

/* All interactive elements get pointer-events back */
.overlay .fire-header,
.overlay .loading,
.overlay .error,
.overlay .create-screen,
.overlay .session-header,
.overlay .btn,
.overlay .panel,
.overlay input,
.overlay .ws-status {
  pointer-events: auto;
}

.fire-header {
  text-align: center;
  margin-bottom: 32px;
  position: relative;
  height: 80px;
  padding-right: 340px;
}

.flame-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 0;
}

.fire-title {
  margin: 0;
  font-size: 42px;
  position: relative;
  display: inline-block;
  z-index: 1;
}

.fire-text {
  position: relative;
  background: linear-gradient(
    0deg,
    #ffee55 0%,
    #ff8800 30%,
    #ff3300 60%,
    #cc0000 100%
  );
  background-size: 100% 200%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: fireShift 1.5s ease-in-out infinite alternate;
}

@keyframes fireShift {
  0% { background-position: 0% 100%; }
  100% { background-position: 0% 0%; }
}

.loading {
  text-align: center;
  color: #b2bec3;
  padding: 40px;
}

.error {
  background: rgba(231, 76, 60, 0.2);
  backdrop-filter: blur(10px);
  color: #e74c3c;
  padding: 12px 16px;
  border-radius: 8px;
  margin-bottom: 16px;
  text-align: center;
}

.create-screen {
  text-align: center;
  padding: 60px 20px;
}

.create-screen p {
  color: #b2bec3;
  margin-bottom: 24px;
  font-size: 18px;
  text-shadow: 0 1px 8px rgba(0,0,0,0.5);
}

.create-form {
  display: flex;
  gap: 8px;
  justify-content: center;
  max-width: 400px;
  margin: 0 auto;
}

.title-input {
  flex: 1;
  padding: 12px 16px;
  border: 2px solid rgba(255,255,255,0.15);
  border-radius: 8px;
  font-size: 16px;
  background: rgba(30, 30, 50, 0.8);
  backdrop-filter: blur(10px);
  color: #dfe6e9;
}

.title-input:focus {
  border-color: #4ECDC4;
  outline: none;
}

.btn {
  padding: 12px 24px;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-weight: bold;
  font-size: 16px;
}

.btn-primary {
  background: #4ECDC4;
  color: #2d3436;
}

.btn-primary:hover {
  background: #45b7aa;
}

.btn-small {
  padding: 6px 14px;
  font-size: 12px;
  background: rgba(255, 255, 255, 0.1);
  backdrop-filter: blur(8px);
  color: #dfe6e9;
}

.btn-small:hover {
  background: rgba(255, 255, 255, 0.2);
}

.btn-warning {
  color: #FFEAA7;
}

.ws-status {
  font-size: 11px;
  padding: 4px 10px;
  border-radius: 12px;
  background: rgba(231, 76, 60, 0.2);
  color: #e74c3c;
}

.ws-status.connected {
  background: rgba(78, 205, 196, 0.2);
  color: #4ECDC4;
}

.kbd-hint {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: rgba(223, 230, 233, 0.6);
}

@media (max-width: 700px) {
  .kbd-hint {
    display: none;
  }
}

.session-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
}

.session-header h2 {
  margin: 0;
  color: #dfe6e9;
  text-shadow: 0 1px 10px rgba(0,0,0,0.5);
}

.session-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.main-layout {
  display: flex;
  gap: 40px;
  align-items: flex-start;
}

.wheel-section {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-end;
  min-height: 70vh;
  padding-bottom: 40px;
  margin-right: 340px;
}

.list-section {
  position: fixed;
  top: 80px;
  right: 20px;
  width: 320px;
  max-height: calc(100vh - 100px);
  overflow-y: auto;
}

.panel {
  background: rgba(60, 60, 60, 0.75);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 16px;
  padding: 20px;
}


@media (max-width: 700px) {
  .list-section {
    position: fixed;
    top: auto;
    bottom: 0;
    right: 0;
    left: 0;
    width: 100%;
    max-height: 50vh;
  }
  .panel {
    border-radius: 16px 16px 0 0;
  }
  .fire-header {
    padding-right: 0;
  }
  .wheel-section {
    min-height: 40vh;
    margin-right: 0;
  }
}
</style>
