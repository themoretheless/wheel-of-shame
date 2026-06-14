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
import RecapReel from './components/RecapReel.vue'
import CommandPalette, { type Command } from './components/CommandPalette.vue'
import ShortcutsSheet from './components/ShortcutsSheet.vue'
import ToastStack from './components/ToastStack.vue'
import { useSession } from './composables/useSession'
import { useToasts } from './composables/useToasts'
import { identityColor } from './utils/identity'

const { push: pushToast } = useToasts()

const {
  session,
  activeParticipants,
  removedParticipants,
  loading,
  error,
  remoteSpinResult,
  recentSessions,
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
// Curtain-call recap: when the final spin leaves a lone survivor, the recap reel
// is queued here and shown once the winner lower-third is dismissed, so the two
// overlays never stack. The flag is armed in onSpinComplete and consumed (then
// shown) in dismissWinner.
const recapQueued = ref(false)
const recapOpen = ref(false)
// True while the orbit camera has been dragged off its resting framing; drives
// the Snap-home reset pill below the header.
const cameraDrifted = ref(false)

// Recents switcher: a dropdown next to the session title listing other sessions
// this browser has visited (from localStorage via useSession), so a returning
// visitor can hop back without keeping links around. Excludes the current
// session; picking one loads it and updates the URL hash.
const recentsOpen = ref(false)
const otherRecents = computed(() =>
  recentSessions.value.filter((r) => r.id !== session.value?.id),
)
function switchSession(id: string) {
  recentsOpen.value = false
  if (id === session.value?.id) return
  window.location.hash = `#/${id}`
  load(id)
}
function toggleRecents() {
  recentsOpen.value = !recentsOpen.value
}
// Close the recents dropdown when a pointer lands outside the switcher.
function onDocPointerDown(e: PointerEvent) {
  if (!recentsOpen.value) return
  const target = e.target as Element | null
  if (target && !target.closest('.session-switcher')) {
    recentsOpen.value = false
  }
}
// Participant id whose wheel segment is currently under the pointer mid-spin;
// NameList flashes the matching roster row in sync. Null when not spinning.
const tickingId = ref<string | null>(null)
// Participant id of the roster row the cursor is hovering (null when none);
// forwarded to WheelCanvas so the matching wheel segment lifts as a hover peek.
const peekId = ref<string | null>(null)
// Identity color of the segment currently under the pointer, pulled through the
// chrome as the --live-accent CSS var: the dock gains a thin accent bar and the
// spin vignette's inner stop warms toward this hue, so the active name's color
// bleeds into the UI in sync with the wheel. Falls back to the brand teal when
// no segment is ticking (idle, or the id is no longer active).
const DEFAULT_ACCENT = '#4ECDC4'
const liveAccent = computed(() => {
  const id = tickingId.value
  if (!id) return DEFAULT_ACCENT
  const hit = activeParticipants.value.find((p) => p.id === id)
  return hit ? identityColor(hit.name) : DEFAULT_ACCENT
})
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
// Timestamp (performance.now ms) until which the title flame flares hotter:
// set on a winner reveal so the header briefly surges brighter and larger in
// sympathy with the result, then decays back to its idle blaze. Read inside
// the flame loop; module-level so onWinnerReveal can poke it.
let flareUntil = 0
const FLARE_MS = 900

interface Particle {
  x: number
  y: number
  vx: number
  vy: number
  life: number
  maxLife: number
  size: number
  drift?: boolean
  // Flare strength (0..1) captured at spawn time; biases this ember brighter
  // and whiter so a winner-reveal surge reads hotter than the idle blaze.
  flare?: number
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

  // 0 at rest, ramping to 1 right after a reveal and easing back to 0 across
  // FLARE_MS. Reduced motion stays calm, so the flare never kicks in there.
  function flareStrength(): number {
    if (reducedMotion) return 0
    const remain = flareUntil - performance.now()
    if (remain <= 0) return 0
    return Math.min(1, remain / FLARE_MS)
  }

  function spawn() {
    if (edgePoints.length === 0) return
    // During a flare, throw off up to ~2.5x the embers and start them larger.
    const flare = flareStrength()
    const count = Math.round(spawnPerFrame * (1 + flare * 1.5))
    for (let i = 0; i < count; i++) {
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
        size: (4 + Math.random() * 10) * (1 + flare * 0.6),
        drift: drifter,
        flare,
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

      // Flare bias: pull the cooler channels up toward white-hot so a reveal
      // surge glows brighter, scaled by the strength captured at spawn time.
      const f = p.flare ?? 0
      if (f > 0) {
        g += (255 - g) * 0.6 * f
        b += (200 - b) * 0.6 * f
      }

      ctx.save()
      ctx.globalAlpha = Math.min(1, alpha * (0.8 + 0.25 * f))
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
  window.addEventListener('pointerdown', onDocPointerDown)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(flameAnimId)
  flameCleanup?.()
  window.removeEventListener('keydown', onGlobalKeydown)
  window.removeEventListener('pointerdown', onDocPointerDown)
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

// A reset (or switching sessions) clears the picked list; tear down any pending
// or open recap so a fresh game never inherits a stale curtain call.
watch(removedParticipants, (removed) => {
  if (removed.length === 0) {
    recapQueued.value = false
    recapOpen.value = false
  }
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
  // Kick the title flame into a brief hotter flare in sympathy with the reveal.
  flareUntil = performance.now() + FLARE_MS
}

function onCameraDrifted(drifted: boolean) {
  cameraDrifted.value = drifted
}

function onTickSegment(participantId: string | null) {
  tickingId.value = participantId
}

function onHoverName(id: string | null) {
  peekId.value = id
}

function resetView() {
  wheelRef.value?.resetView()
}

function dismissWinner() {
  winnerData.value = null
  wheelRef.value?.dismissWinner()
  // If that was the final elimination, roll the curtain-call recap now that the
  // winner card is out of the way.
  if (recapQueued.value) {
    recapQueued.value = false
    recapOpen.value = true
  }
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
  // Game over: one name left on the wheel and at least one already picked. Arm
  // the recap so it plays when the winner lower-third is dismissed.
  if (activeParticipants.value.length <= 1 && removedParticipants.value.length > 0) {
    recapQueued.value = true
  }
}

function copyLink() {
  if (!session.value) return
  const url = `${window.location.origin}${window.location.pathname}#/${session.value.id}`
  navigator.clipboard.writeText(url).then(
    () => pushToast('Share link copied', 'success'),
    () => pushToast('Could not copy link', 'info'),
  )
}

// --- Command palette (Cmd-K / Ctrl-K) ---
const paletteOpen = ref(false)

// Keyboard cheat-sheet toggled with '?'. Its rows mirror onGlobalKeydown below.
const shortcutsOpen = ref(false)

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

  // Escape closes the recents switcher first if it's open, so the key doesn't
  // also dismiss the winner modal underneath.
  if (recentsOpen.value && e.key === 'Escape') {
    e.preventDefault()
    recentsOpen.value = false
    return
  }

  // The cheat-sheet captures Escape to close itself; everything else is inert
  // beneath it, so handle that case before the shortcuts it documents.
  if (shortcutsOpen.value) {
    if (e.key === 'Escape') {
      e.preventDefault()
      shortcutsOpen.value = false
    }
    return
  }

  if (e.key === '?' && !isEditableTarget(e.target)) {
    e.preventDefault()
    shortcutsOpen.value = true
  } else if (e.code === 'Space' && !isEditableTarget(e.target)) {
    e.preventDefault()
    // Don't spin underneath the winner modal or the recap reel: Space is inert
    // until whichever overlay is up has been dismissed.
    if (!winnerData.value && !recapOpen.value) handleSpin()
  } else if (e.key === 'Escape' && recapOpen.value) {
    e.preventDefault()
    recapOpen.value = false
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
    :peek-id="peekId"
    @spin-complete="onSpinComplete"
    @spin-click="handleSpin"
    @winner-reveal="onWinnerReveal"
    @camera-drifted="onCameraDrifted"
    @tick-segment="onTickSegment"
  />

  <!-- UI overlay -->
  <div class="overlay" :class="{ spinning }" :style="{ '--live-accent': liveAccent }">
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
        <!-- Session title doubles as a recents switcher: when this browser has
             visited other sessions, a chevron reveals a dropdown to hop back. -->
        <div class="session-switcher">
          <h2 class="session-title" :title="session.title">{{ session.title }}</h2>
          <button
            v-if="otherRecents.length > 0"
            class="btn btn-small switcher-toggle"
            :class="{ open: recentsOpen }"
            :aria-expanded="recentsOpen"
            aria-haspopup="listbox"
            title="Switch session"
            @click.stop="toggleRecents"
          >
            <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
              <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
          <Transition name="recents-menu">
            <ul
              v-if="recentsOpen && otherRecents.length > 0"
              class="recents-menu"
              role="listbox"
            >
              <li v-for="r in otherRecents" :key="r.id" role="option">
                <button class="recents-item" @click="switchSession(r.id)">
                  <span class="recents-title">{{ r.title }}</span>
                </button>
              </li>
            </ul>
          </Transition>
        </div>
        <div class="session-actions">
          <span class="ws-status" :class="{ connected: wsConnected }">
            {{ wsConnected ? 'Live' : 'Offline' }}
          </span>
          <span class="kbd-hint" title="Press Space to spin"><kbd>Space</kbd> to spin</span>
          <button
            class="kbd-hint-btn"
            title="Keyboard shortcuts"
            aria-label="Keyboard shortcuts"
            @click="shortcutsOpen = true"
          >
            <kbd>?</kbd>
          </button>
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
              @hover-name="onHoverName"
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

  <Teleport to="body">
    <RecapReel
      v-if="recapOpen"
      :picked="removedParticipants"
      :survivor="activeParticipants[0] ?? null"
      @close="recapOpen = false"
    />
  </Teleport>

  <CommandPalette
    :open="paletteOpen"
    :commands="paletteCommands"
    @close="paletteOpen = false"
  />

  <ShortcutsSheet :open="shortcutsOpen" @close="shortcutsOpen = false" />

  <Teleport to="body">
    <ToastStack />
  </Teleport>
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
  /* Identity color of the segment under the pointer mid-spin (set inline from
     liveAccent); the dock accent bar and vignette inner stop sample it. Eases
     between hues as the pointer crosses segments so the tint glides. */
  --live-accent: #4ECDC4;
  transition:
    --spin-focus 0.45s ease,
    --live-accent 0.25s ease;
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

/* Register --live-accent as a color so it interpolates between hues; without
   this browsers treat it as a discrete string and the tint snaps between
   segments. The inline value on .overlay still applies as a fallback. */
@property --live-accent {
  syntax: '<color>';
  inherits: true;
  initial-value: #4ECDC4;
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
       wheel pops. Sits first so the resting scrims below still read normally.
       The inner stop is warmed toward --live-accent (the ticking segment's hue)
       so the wheel's center subtly glows in the active name's color mid-spin;
       the tint is itself scaled by --spin-focus so it only shows while spinning. */
    radial-gradient(
      ellipse 75% 75% at center,
      color-mix(in srgb, var(--live-accent) calc(10% * var(--spin-focus)), transparent) 38%,
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
  overflow: hidden;
  transition: opacity 0.45s ease, filter 0.45s ease;
}

/* Live accent bar: a 2px gradient hairline along the top of the dock, tinted to
   the ticking segment's identity color via --live-accent. Its opacity is keyed
   to --spin-focus so it only lights up mid-spin (when a name is under the
   pointer) and stays invisible at rest. */
.action-dock::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2px;
  pointer-events: none;
  background: linear-gradient(
    90deg,
    transparent,
    var(--live-accent),
    transparent
  );
  opacity: var(--spin-focus);
  transition: opacity 0.45s ease;
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

/* The '?' chip reuses the kbd look but is a real button so the cheat sheet is
   reachable by mouse, not just the keyboard it documents. */
.kbd-hint-btn {
  display: inline-flex;
  align-items: center;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
}

.kbd-hint-btn:hover kbd {
  background: rgba(255, 255, 255, 0.18);
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

/* Switcher wrapper: holds the title and its dropdown trigger, and anchors the
   absolutely-positioned recents menu below the header. */
.session-switcher {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}

.session-title {
  margin: 0;
  min-width: 0;
  font-size: 20px;
  font-weight: 600;
  color: #dfe6e9;
  text-shadow: 0 1px 10px rgba(0,0,0,0.5);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Chevron toggle: a small glass chip reusing .btn-small, revealing the recents
   list. Rotates its caret when the menu is open. */
.switcher-toggle {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 5px 7px;
  border-radius: 8px;
}

.switcher-toggle svg {
  transition: transform 0.18s ease;
}

.switcher-toggle.open svg {
  transform: rotate(180deg);
}

/* Recents dropdown: a glass panel matching .reset-pill, listing other sessions
   this browser has visited so the user can hop back without a link. */
.recents-menu {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  z-index: 20;
  margin: 0;
  padding: 6px;
  list-style: none;
  min-width: 200px;
  max-width: 280px;
  max-height: 50vh;
  overflow-y: auto;
  border-radius: 12px;
  background: rgba(30, 30, 30, 0.92);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
}

.recents-item {
  display: flex;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #dfe6e9;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.recents-item:hover {
  background: rgba(255, 255, 255, 0.1);
}

.recents-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recents-menu-enter-active,
.recents-menu-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.recents-menu-enter-from,
.recents-menu-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

@media (prefers-reduced-motion: reduce) {
  .switcher-toggle svg,
  .recents-menu-enter-active,
  .recents-menu-leave-active {
    transition: none;
  }
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
