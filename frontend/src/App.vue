<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount, defineAsyncComponent } from 'vue'
import WheelSkeleton from './components/WheelSkeleton.vue'
const WheelCanvas = defineAsyncComponent({
  loader: () => import('./components/WheelCanvas.vue'),
  // Show the ring shimmer immediately so the wheel's slot is never blank while
  // its three.js chunk downloads and the scene initializes.
  loadingComponent: WheelSkeleton,
  delay: 0,
})
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
const wheelRef = ref<{
  dismissWinner: () => void
  resetView: () => void
  isMuted: { value: boolean }
  toggleMute: () => void
} | null>(null)
const winnerData = ref<{ id: string; name: string; remaining: number } | null>(null)
// True while the orbit camera has been dragged off its resting framing; drives
// the Snap-home reset pill below the header.
const cameraDrifted = ref(false)
// Participant id whose wheel segment is currently under the pointer mid-spin;
// NameList flashes the matching roster row in sync. Null when not spinning.
const tickingId = ref<string | null>(null)
// Mirror of WheelCanvas's persisted spin-sound mute flag, seeded from the same
// localStorage key so the dock button shows the right state before the canvas
// mounts. The toggle below drives the canvas, which owns persistence.
const soundMuted = ref(readMutedPref())
function readMutedPref(): boolean {
  try {
    return localStorage.getItem('wheel-muted') === '1'
  } catch {
    return false
  }
}
function toggleSound() {
  wheelRef.value?.toggleMute()
  soundMuted.value = wheelRef.value?.isMuted.value ?? !soundMuted.value
}
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
  drift?: boolean
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
  // The canvas extends EMBER_DRIFT px below the header so the rare drifting
  // ember can fade out over the wheel region. The title text and its edge
  // points stay anchored to the header band (the top headerH px), so this
  // extra height never repositions the flame.
  const EMBER_DRIFT = 280
  let headerH = 0

  function resize() {
    const header = canvas.parentElement
    if (!header) return
    headerH = header.clientHeight
    canvas.width = header.clientWidth
    canvas.height = headerH + EMBER_DRIFT
    // Display the canvas buffer 1:1 so the flame isn't stretched: width fills
    // the header (== buffer width), height matches the buffer's drift-extended
    // height and spills below the header band.
    canvas.style.height = `${canvas.height}px`
    edgePoints = getTextEdgePoints(canvas.width, headerH)
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
      // ~2% of embers break loose and drift down past the header into the
      // wheel region: a gentle downward drift and a much longer life so they
      // survive the fall before fading. Reduced motion keeps the flame calm,
      // so no drifters there.
      const drifter = !reducedMotion && Math.random() < 0.02
      particles.push({
        x: pt[0],
        y: pt[1],
        vx: (Math.random() - 0.5) * 0.6,
        vy: drifter ? 0.3 + Math.random() * 0.5 : -(0.8 + Math.random() * 1.8),
        life: 0,
        maxLife: drifter ? 160 + Math.random() * 80 : 20 + Math.random() * 30,
        size: 4 + Math.random() * 10,
        drift: drifter,
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
      if (p.drift) {
        // Drifters keep falling: a touch of downward pull (capped) instead of
        // the rising flame's drag, and a far gentler shrink so they reach the
        // wheel before winking out.
        p.vy = Math.min(p.vy + 0.012, 1.0)
        p.size *= 0.995
      } else {
        p.vy *= 0.97
        p.size *= 0.98
      }
      p.vx += (Math.random() - 0.5) * 0.1

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

function onCameraDrifted(drifted: boolean) {
  cameraDrifted.value = drifted
}

function onTickSegment(participantId: string | null) {
  tickingId.value = participantId
}

function resetView() {
  wheelRef.value?.resetView()
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
    group: 'Actions',
    disabled: spinning.value || activeParticipants.value.length === 0,
    run: () => {
      handleSpin()
    },
  },
  {
    id: 'add',
    label: 'Add a name',
    hint: 'New participant',
    group: 'Actions',
    disabled: !session.value,
    // Opens an inline glass field in the palette rather than a native prompt;
    // returning false keeps it open so several names can be added in a row.
    run: () => {},
    inline: {
      placeholder: 'Name to add...',
      submit: (name) => {
        addName(name)
        return false
      },
    },
  },
  {
    id: 'reset',
    label: 'Reset the wheel',
    hint: 'Restore everyone',
    group: 'Actions',
    disabled: !session.value || removedParticipants.value.length === 0,
    run: () => {
      reset()
    },
  },
  {
    id: 'copy-link',
    label: 'Copy share link',
    hint: 'Share',
    group: 'Actions',
    disabled: !session.value,
    run: () => {
      copyLink()
    },
  },
  {
    id: 'toggle-sound',
    label: soundMuted.value ? 'Unmute spin sound' : 'Mute spin sound',
    hint: soundMuted.value ? 'Unmute' : 'Mute',
    group: 'Actions',
    run: () => {
      toggleSound()
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
      group: 'Eliminate',
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
    @camera-drifted="onCameraDrifted"
    @tick-segment="onTickSegment"
  />

  <!-- UI overlay -->
  <div class="overlay" :class="{ spinning }">
    <header class="fire-header">
      <canvas ref="flameCanvas" class="flame-canvas"></canvas>
      <h1 class="fire-title">
        <span class="fire-text" data-text="Wheel of Shame">Wheel of Shame</span>
      </h1>
    </header>

    <!-- Snap-home pill: appears when the orbit camera is dragged off its
         resting framing, restoring the default view on click. -->
    <Transition name="reset-pill">
      <button
        v-if="cameraDrifted"
        @click="resetView"
        class="btn btn-small reset-pill"
        title="Reset camera view"
      >
        <svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
          <path
            d="M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z"
            fill="currentColor"
          />
        </svg>
        Reset view
      </button>
    </Transition>

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
        <h2 class="session-title" :title="session.title">{{ session.title }}</h2>
        <div class="session-actions">
          <span class="ws-status" :class="{ connected: wsConnected }">
            {{ wsConnected ? 'Live' : 'Offline' }}
          </span>
          <span class="kbd-hint" title="Press Space to spin"><kbd>Space</kbd> to spin</span>
        </div>
      </div>

      <!-- Floating action dock: the primary controls (spin, share, command
           palette) collected into one glass bar centered over the wheel
           column, offset for the 340px right-side panel. -->
      <div class="action-dock">
        <button
          @click="handleSpin"
          class="btn btn-small dock-spin"
          :disabled="spinning || activeParticipants.length === 0"
          title="Spin the wheel"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path
              d="M12 4V1L8 5l4 4V6a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8z"
              fill="currentColor"
            />
          </svg>
          Spin
        </button>
        <button @click="copyLink" class="btn btn-small" title="Copy share link">
          Share
        </button>
        <button
          @click="toggleSound"
          class="btn btn-small dock-mute"
          :title="soundMuted ? 'Unmute spin sound' : 'Mute spin sound'"
          :aria-pressed="soundMuted"
        >
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
            <path
              d="M3 9v6h4l5 5V4L7 9H3z"
              fill="currentColor"
            />
            <template v-if="soundMuted">
              <path
                d="M16 9l6 6M22 9l-6 6"
                stroke="currentColor"
                stroke-width="2"
                fill="none"
                stroke-linecap="round"
              />
            </template>
            <template v-else>
              <path
                d="M16 8.5a5 5 0 0 1 0 7"
                stroke="currentColor"
                stroke-width="2"
                fill="none"
                stroke-linecap="round"
              />
            </template>
          </svg>
        </button>
        <button
          @click="paletteOpen = true"
          class="btn btn-small"
          title="Open command palette"
        >
          <kbd class="dock-kbd">⌘K</kbd>
        </button>
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
              :ticking-id="tickingId"
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
  /* Drives the pre-spin focus vignette: the scrim and roster/dock dimming all
     ramp off this single value, lerped 0 -> 1 while the wheel is spinning so
     the chrome recedes and the wheel reads as the subject (keynote-style). */
  --spin-focus: 0;
  transition: --spin-focus 0.45s ease;
}

.overlay.spinning {
  --spin-focus: 1;
}

/* Register the custom property so it can be animated; without an @property
   declaration browsers treat it as a discrete string and the transition snaps.
   The class toggle still works as a fallback where @property is unsupported. */
@property --spin-focus {
  syntax: '<number>';
  inherits: true;
  initial-value: 0;
}

/* Frosted scrim: a fixed darkening layer that sits above the 3D wheel
   (z-index 0) but behind the overlay content. As a z-index:-1 child of the
   overlay's own stacking context it paints behind the panels yet above the
   canvas, deepening contrast under the right-side roster and bottom dock the
   way a keynote vignette pushes the subject forward. pointer-events:none lets
   wheel drags pass straight through. */
.overlay::before {
  content: '';
  position: fixed;
  inset: 0;
  z-index: -1;
  pointer-events: none;
  background:
    /* Pre-spin focus layer: a center-weighted vignette that fades up only while
       spinning (alpha keyed to --spin-focus), pulling edge contrast down so the
       wheel pops. Sits first so the resting scrims below still read normally. */
    radial-gradient(
      ellipse 75% 75% at center,
      transparent 40%,
      rgba(0, 0, 0, calc(0.5 * var(--spin-focus))) 100%
    ),
    radial-gradient(
      ellipse at right,
      rgba(0, 0, 0, 0.45),
      transparent 60%
    ),
    linear-gradient(
      to top,
      rgba(0, 0, 0, 0.4),
      transparent 28%
    );
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
  top: 0;
  left: 0;
  right: 0;
  /* Spills below the header band so the rare drifting ember can fall over the
     wheel; the script sets an explicit pixel height (header + drift) so the
     buffer renders 1:1. Pointer events stay off, so nothing below the header
     is blocked. z-index:-1 keeps it behind the overlay's panels and title (and
     above the scrim/wheel), so a drifting ember reads as ambient depth rather
     than overlapping the session UI. */
  width: 100%;
  pointer-events: none;
  z-index: -1;
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

/* Floating snap-home pill, centered over the wheel below the header. */
.reset-pill {
  position: fixed;
  top: 92px;
  left: calc((100% - 340px) / 2);
  transform: translateX(-50%);
  z-index: 5;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: 16px;
  background: rgba(30, 30, 30, 0.78);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
}

.reset-pill svg {
  flex: 0 0 auto;
}

.reset-pill-enter-active,
.reset-pill-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.reset-pill-enter-from,
.reset-pill-leave-to {
  opacity: 0;
  transform: translate(-50%, -8px);
}

@media (max-width: 700px) {
  .reset-pill {
    left: 50%;
  }
}

/* Floating action dock, anchored to the bottom of the wheel column. Shares the
   glass pill styling with .reset-pill and the same 340px panel-offset centering
   so it sits over the wheel rather than the screen center. */
.action-dock {
  position: fixed;
  bottom: 28px;
  left: calc((100% - 340px) / 2);
  transform: translateX(-50%);
  z-index: 5;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-radius: 18px;
  background: rgba(30, 30, 30, 0.78);
  backdrop-filter: blur(8px);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.4);
  transition: opacity 0.45s ease, filter 0.45s ease;
}

.action-dock .btn-small {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border-radius: 12px;
}

.action-dock .btn-small:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.action-dock .btn-small:disabled:hover {
  background: rgba(255, 255, 255, 0.1);
}

.dock-spin {
  color: #4ECDC4;
  font-weight: bold;
}

/* Muted state dims the speaker glyph so the slash reads as "off" at a glance. */
.dock-mute[aria-pressed='true'] {
  color: rgba(223, 230, 233, 0.5);
}

.dock-kbd {
  font-size: 11px;
  font-family: inherit;
  color: rgba(223, 230, 233, 0.85);
}

@media (max-width: 700px) {
  .action-dock {
    left: 50%;
    bottom: calc(50vh + 12px);
  }
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
  gap: 16px;
  margin-bottom: 24px;
}

.session-title {
  margin: 0;
  min-width: 0;
  flex: 1;
  font-size: 20px;
  font-weight: 600;
  color: #dfe6e9;
  text-shadow: 0 1px 10px rgba(0,0,0,0.5);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-shrink: 0;
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
  transition: opacity 0.45s ease, filter 0.45s ease;
}

/* While spinning, the roster and dock recede so attention stays on the wheel.
   They keep pointer-events so a mid-spin edit still works, just visually muted. */
.overlay.spinning .panel,
.overlay.spinning .action-dock {
  opacity: 0.55;
  filter: saturate(0.7) brightness(0.85);
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

/* Honor reduced-motion: keep the focus dim as a static state but drop the
   ramp so it snaps instead of animating. */
@media (prefers-reduced-motion: reduce) {
  .overlay,
  .overlay .panel,
  .overlay .action-dock {
    transition: none;
  }
}
</style>
