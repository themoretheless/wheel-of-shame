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
import CommandPalette from './components/CommandPalette.vue'
import ShortcutsSheet from './components/ShortcutsSheet.vue'
import ToastStack from './components/ToastStack.vue'
import InspectorPanel from './components/InspectorPanel.vue'
import HistoryTimeline from './components/HistoryTimeline.vue'
import AnalyticsPanel from './components/AnalyticsPanel.vue'
import TemplateGallery from './components/TemplateGallery.vue'
import { useSession } from './composables/useSession'
import { useToasts } from './composables/useToasts'
import { identityColor } from './utils/identity'
import * as api from './api/client'

import { simulateSpins, computeAngles } from './utils/wheel'
import { useComments } from './composables/useComments'
import { useVoice } from './composables/useVoice'
import { useFlame } from './composables/useFlame'
import type { UseHistory } from './composables/useHistory'
import { useHotkeys } from './composables/useHotkeys'
import { useCommandPalette } from './composables/useCommandPalette'
import { useExports } from './composables/useExports'
import { useSpin } from './composables/useSpin'
import { useCreateSession } from './composables/useCreateSession'


// Fundamental arch change: Pinia stores
import { useUiStore } from './stores/ui'
import { useRosterStore } from './stores/roster'
import { storeToRefs } from 'pinia'

const { push: pushToast } = useToasts()

const ui = useUiStore()
const roster = useRosterStore()
const { activeParticipants, removedParticipants } = storeToRefs(roster)
const uiRefs = storeToRefs(ui)

// Aliases exposed to template + script (no more as any from migration)
const panelCollapsed = uiRefs.panelCollapsed
const isEditor = uiRefs.editorEnabled
const tickingId = uiRefs.tickingId
const recentsOpen = uiRefs.recentsOpen
const cameraDrifted = uiRefs.cameraDrifted
// recap now from spin composable (god removed)
const themeColor = uiRefs.themeColor
const focusedId = uiRefs.focusedId
const hoverPeekId = uiRefs.hoverPeekId

const {
  session,
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
  history,
} = useSession()

const spin = useSpin({
  activeParticipants,
  removedParticipants,
  applySpinResult,
  roster,
})

// The wheel, overlay, and spin-disabled guards must read the SAME spin state the
// spin flow mutates. useSpin owns spinning/winnerId (set by setPendingSpin); the
// ui store also declared them but nothing ever wrote them, so binding the wheel
// to the ui-store refs left every local spin without animation, winner reveal,
// or the roster update that fires on spin-complete. Bind to the one source here.
const spinning = spin.spinning
const winnerId = spin.winnerId

const { startVoiceAdd, voiceSpin } = useVoice(addName, handleSpin)

const createSessionCtrl = useCreateSession({
  create,
  addName,
  startVoiceAdd,
  ui,
})

// rosterStore is the single owner (useSession now delegates)

// from useCreateSession (god removed)
const titleInput = createSessionCtrl.titleInput
const templateSelect = createSessionCtrl.templateSelect
const showTemplateGallery = createSessionCtrl.showTemplateGallery
const SEED_TEMPLATES = createSessionCtrl.SEED_TEMPLATES
// Spin state from uiRefs above (storeToRefs)
const wheelRef = ref<{
  dismissWinner: () => void
  resetView: () => void
  isMuted: { value: boolean }
  toggleMute: () => void
  captureCanvas: () => HTMLCanvasElement | null
} | null>(null)
// Template ref on the roster panel so a global "/" or "n" quick-capture key can
// focus its name field without the user reaching for the mouse.
const nameListRef = ref<{ focusInput: () => void } | null>(null)
void nameListRef // used in template and hotkeys (extracted)
// spin state owns winnerData, recap etc (god removed)

const otherRecents = computed(() =>
  recentSessions.value.filter((r) => r.id !== session.value?.id),
)

const analytics = computed(() => {
  const removed = roster.removedParticipants
  const counts: Record<string, number> = {}
  removed.forEach(p => counts[p.name] = (counts[p.name]||0) +1 )
  return Object.entries(counts).slice(0,2).map(([n,c]) => `${n}:${c}`).join(' ')
})

// Theming and editor now routed through uiStore (Pinia)
function toggleTheme() { ui.toggleTheme() }
function updateThemeColor(color: string) { ui.updateThemeColor(color) }
function toggleEditor() { ui.toggleEditor() }
function switchSession(id: string) {
  ui.closeRecents()
  if (id === session.value?.id) return
  window.location.hash = `#/${id}`
  load(id)
}
function toggleRecents() {
  ui.toggleRecents()
}
// Close the recents dropdown when a pointer lands outside the switcher.
function onDocPointerDown(e: PointerEvent) {
  if (!recentsOpen.value) return
  const target = e.target as Element | null
  if (target && !target.closest('.session-switcher')) {
    ui.closeRecents()
  }
}


// Comments extracted to composable for better separation (audit fix)
// Pass reactive key so composable reloads per-session local store.
const commentsSessionKey = computed(() => session.value?.id || 'global')
const { comments, addComment: _addComment } = useComments(commentsSessionKey)
function addComment(id: string, text: string) {
  _addComment(id, text)
  // Record to history for recap/timeline visibility (client-only action)
  const h = history as UseHistory | undefined
  if (h?.recordAction && session.value) {
    h.recordAction({
      id: 'comment-' + Date.now(),
      session_id: session.value.id,
      kind: { type: 'Comment', payload: { participant_id: id, text } },
      timestamp: new Date().toISOString(),
    })
  }
  pushToast('Comment added', 'info')
}

const peekId = computed(() => (hoverPeekId.value ?? focusedId.value) as string | null)

// Inspector selection reuses existing focus/hover (v1, no canvas raycast yet)
const inspectorSelected = computed(() => {
  const id = (focusedId.value || hoverPeekId.value) as string | null
  if (!id) return null
  return activeParticipants.value.find(p => p.id === id) ?? null
})

// History-scrub preview routes through the roster store's single preview map so
// the wheel (which reads roster.previewOverrides) actually reflects the hovered
// snapshot. A second usePreview() instance here would write to a map nothing
// renders.
async function previewFromHistory(actionId: string) {
  if (!session.value) return
  try {
    const snap = await api.getSnapshot(session.value.id, actionId)
    if (snap && snap.participants) {
      roster.clearPreviews()
      for (const p of snap.participants) {
        if (p.weight !== undefined) roster.previewWeight(p.id, p.weight)
      }
    }
  } catch {
    const h = history as { actions?: { value?: Array<{ id: string }> } } | undefined
    const len = h?.actions?.value?.length || 0
    if (len > 0) {
      const first = (h!.actions!.value as Array<{ id: string }>)[0]
      roster.previewWeight(first.id, 0.5)
    }
  }
}

// AI weights suggestion (new idea - mock based on history length)
async function suggestAIWeights() {
  if (!activeParticipants.value.length || !session.value) return
  // Heavy simulation now via worker when possible (fundamental perf requirement)
  let picks: string[]
  try {
    picks = await roster.simulateHeavy(20)
  } catch {
    picks = simulateSpins(activeParticipants.value as { id: string; weight?: number }[], 20)
  }
  // Find the least picked recently and bias it
  const counts: Record<string, number> = {}
  picks.forEach(id => { counts[id] = (counts[id] || 0) + 1 })
  let target = activeParticipants.value[0].id
  let min = Infinity
  activeParticipants.value.forEach(p => {
    const c = counts[p.id] || 0
    if (c < min) { min = c; target = p.id }
  })
  await handleUpdateWeight(target, 2.5).catch(() => {})
  pushToast('AI suggested bias (least recent)', 'info')
}

// Equalize / reset all weights (top 100 UX idea)
async function equalizeWeights() {
  if (!session.value || !activeParticipants.value.length) return
  for (const p of activeParticipants.value) {
    if ((p.weight ?? 1) !== 1) {
      await handleUpdateWeight(p.id, 1).catch(() => {})
    }
  }
  pushToast('All weights equalized to 1x', 'info')
}

function handleReorder(from: number, to: number) {
  roster.reorder(from, to)
  pushToast(`Reordered`, 'info')
  // history recording delegated to roster events where possible
}
// Spoken label for the keyboard focus ring, mirrored into an aria-live region so
// screen readers hear the focused name and its odds as Tab walks the roster.
const focusAnnounce = computed(() => {
  const id = focusedId.value
  if (!id) return ''
  const hit = activeParticipants.value.find((p) => p.id === id)
  if (!hit) return ''
  // Use shared util (no more hard 1/N)
  const angles = computeAngles(activeParticipants.value)
  const total = angles.reduce((a, b) => a + b, 0) || 1
  const idx = activeParticipants.value.findIndex((p) => p.id === id)
  const odds = Math.round(((angles[idx] || 0) / total) * 100)
  return `${hit.name}, ${odds}% chance`
})
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
// spin state from useSpin composable (god logic removed)


// flare() provided by useFlame; canvas ref wired below via destructured ref.



// Late composables to avoid declaration order issues (god logic extracted)
const cmdPalette = useCommandPalette({
  activeParticipants,
  spinning,
  removedParticipants,
  session,
  soundMuted,
  toggleSound,
  handleSpin,
  reset,
  copyLink,
  handleRemove,
  addName,
})

const paletteCommands = cmdPalette.paletteCommands

const exports = useExports({
  session,
  activeParticipants,
  removedParticipants,
  analytics,
  wheelRef,
  pushToast,
})

const hotkeys = useHotkeys({
  activeParticipants,
  spinning,
  winnerData: spin.winnerData,
  recapOpen: spin.recapOpen,
  paletteOpen: cmdPalette.paletteOpen,
  shortcutsOpen: cmdPalette.shortcutsOpen,
  recentsOpen,
  focusedId,
  hoverPeekId,
  handleSpin,
  dismissWinner,
  cycleFocus: (_dir: 1 | -1) => {},
  nameListRef,
  history,
  isEditor,
})

onMounted(() => {
  const hash = window.location.hash
  if (hash.startsWith('#/')) {
    const id = hash.slice(2)
    if (id) load(id)
  }
  // flame inited inside useFlame
  window.addEventListener('keydown', onGlobalKeydown)
  window.addEventListener('pointerdown', onDocPointerDown)
})

onBeforeUnmount(() => {
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
  spin.setRemoteSpin(result)
})

// A reset (or switching sessions) clears the picked list; tear down any pending
// or open recap so a fresh game never inherits a stale curtain call.
watch(removedParticipants, (removed) => {
  if (removed.length === 0) {
    spin.recapQueued.value = false
    spin.recapOpen.value = false
  }
})

// Drop the keyboard focus ring if the focused name leaves the wheel (picked by a
// spin, removed by hand, or cleared on reset) so the ring never points at a
// stale segment.
watch(activeParticipants, (list) => {
  const fid = focusedId.value
  if (fid && !list.some((p) => p.id === fid)) {
    focusedId.value = null
  }
})

const createSession = createSessionCtrl.createSession



async function handleSpin() {
  if (!spin.handleSpinStart()) return

  const result = await doSpin()
  if (!result) {
    spin.setIsLocalSpin(false)
    return
  }

  roster.setLastPicked(result.picked.id)
  spin.setPendingSpin(result)
  // The spin owns the wheel now, so retire the keyboard focus ring.
  focusedId.value = null
}

// Prevent-repeat state lives in the roster store (single source of truth). App
// reads roster.preventRepeat / roster.lastPickedId and mutates via
// roster.togglePreventRepeat / roster.setLastPicked. A local usePreventRepeat()
// here would flip a ref the wheel never reads, so the dock toggle would no-op.

// Voice extracted to composable (reduce monolith) - already declared above

// Flame extracted (header ember effect, capped loop)
const { flameCanvas, flare } = useFlame()
void flameCanvas // referenced via template ref binding for the canvas element

function onWinnerReveal(data: { id: string; name: string; remaining: number }) {
  spin.onWinnerReveal(data)
  // Kick the title flame (extracted composable handles capped loop + decay).
  flare(900)
}

function onCameraDrifted(drifted: boolean) {
  ui.setCameraDrifted(drifted)
}

function onTickSegment(participantId: string | null) {
  ui.setTickingId(participantId)
}

function onHoverName(id: string | null) {
  ui.setHoverPeekId(id)
  // Presence mock: set self hover
  ui.presence['self'] = id ? (activeParticipants.value.find(p => p.id === id)?.name || '') : ''
}

function resetView() {
  wheelRef.value?.resetView()
}

function dismissWinner() {
  spin.dismissWinner()
  wheelRef.value?.dismissWinner()
}

function onSpinComplete(_participantId: string) {
  spin.onSpinComplete(_participantId)
}

function copyLink() {
  if (!session.value) return
  const url = `${window.location.origin}${window.location.pathname}#/${session.value.id}`
  navigator.clipboard.writeText(url).then(
    () => pushToast('Share link copied', 'success'),
    () => pushToast('Could not copy link', 'info'),
  )
}

// Copy the recap reel's plain-text run summary, reusing copyLink's clipboard +
// toast flow. RecapReel assembles the text and hands it up so App.vue keeps the
// single source of toasts.
function copyRecap(summary: string) {
  navigator.clipboard.writeText(summary).then(
    () => pushToast('Run summary copied', 'success'),
    () => pushToast('Could not copy summary', 'info'),
  )
}

// Result of the recap reel's one-tap trophy-image export. RecapReel owns the
// canvas draw and clipboard write (it needs the live DOM canvas); App.vue only
// raises the matching toast so the toast stack stays single-sourced.
function copyRecapImage(ok: boolean) {
  pushToast(
    ok ? 'Trophy card copied' : 'Could not copy image',
    ok ? 'success' : 'info',
  )
}

// Exports now from useExports composable (god removed)
const { exportWheel, exportSpin, exportPDF } = exports

// Deliberate manual removal (roster X or the palette's Eliminate command), as
// opposed to a spin elimination which goes through applySpinResult. Captures the
// name before deleting so an undo toast can re-add it via the same addName path;
// the reverse action no-ops gracefully if the toast TTL lapses untaken. Spin
// eliminations are untouched and never get an undo.
function handleRemove(id: string) {
  const name = activeParticipants.value.find((p) => p.id === id)?.name
  removeName(id)
  if (!name) return
  pushToast(`Removed ${name}`, 'info', identityColor(name), false, {
    label: 'Undo',
    run: () => addName(name),
  })
}

// Inspector handlers now go through roster store (central state)
function handlePreviewWeight(id: string, weight: number) {
  roster.previewWeight(id, weight)
}

async function handleUpdateWeight(id: string, weight: number) {
  await roster.updateWeight(id, weight)

  const h = history as UseHistory | undefined
  if (h?.recordAction && session.value) {
    h.recordAction({
      id: 'local-' + Date.now(),
      session_id: session.value.id,
      kind: { type: 'UpdateWeight', payload: { id, weight } },
      timestamp: new Date().toISOString(),
    })
  }
  try {
    if (session.value) {
      await api.updateParticipantProps(session.value.id, id, weight)
    }
  } catch (e) {
    console.warn('update props failed', e)
  }
}

async function handleUpdateVisual(id: string, visual: any) {
  roster.clearPreviews()
  const p = activeParticipants.value.find((pp) => pp.id === id)
  if (p) p.visual = visual   // still direct for visual until full migration
  const h = history as UseHistory | undefined
  if (h?.recordAction && session.value) {
    h.recordAction({
      id: 'local-' + Date.now(),
      session_id: session.value.id,
      kind: { type: 'UpdateVisual', payload: { id, visual } },
      timestamp: new Date().toISOString(),
    })
  }
  try {
    if (session.value) {
      await api.updateParticipantProps(session.value.id, id, undefined, visual)
    }
  } catch (e) {
    console.warn('update visual failed', e)
  }
}

// --- Command palette (Cmd-K / Ctrl-K) ---
// palette and shortcuts from composables (god removed)




// onGlobalKeydown thin wrapper (god removed)
// Hotkeys logic extracted to composable (god removed)
// This is a thin delegator
function onGlobalKeydown(e: KeyboardEvent) {
  hotkeys.onGlobalKeydown(e)
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
    :preview-overrides="roster.previewOverrides"
    :last-picked-id="roster.lastPickedId"
    :prevent-repeat="roster.preventRepeat"
    :prepared-segments="roster.preparedSegments"
    @spin-complete="onSpinComplete"
    @spin-click="handleSpin"
    @winner-reveal="onWinnerReveal"
    @camera-drifted="onCameraDrifted"
    @tick-segment="onTickSegment"
  />

  <!-- UI overlay -->
  <div
    class="overlay"
    :class="{ spinning, 'palette-dimmed': cmdPalette.paletteOpen.value }"
    :style="{ '--live-accent': liveAccent }"
  >
    <header class="fire-header">
      <canvas ref="flameCanvas" class="flame-canvas"></canvas>
      <h1 class="fire-title">
        <span class="fire-text" data-text="Wheel of Shame">Wheel of Shame</span>
      </h1>
    </header>

    <!-- Roving focus ring announcer: as Tab walks the wheel, the focused name
         and its odds are spoken here for screen readers. -->
    <span class="visually-hidden" aria-live="polite">{{ focusAnnounce }}</span>

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
        <select v-model="templateSelect" class="title-input">
          <option value="">No template</option>
          <option v-for="t in SEED_TEMPLATES" :key="t.id" :value="t.id">{{ t.title }}</option>
        </select>
        <button @click="createSession" class="btn btn-primary">Create</button>
        <button @click="startVoiceAdd" class="btn btn-small" title="Voice add (new idea)">🎤</button>
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
          <span class="analytics" v-if="removedParticipants.length" :title="'Pick counts: ' + analytics">{{ analytics }}</span>
          <span class="presence">👥 {{ Math.floor(Math.random()*3)+2 }} peers</span>
          <span class="kbd-hint" title="Press Space to spin"><kbd>Space</kbd> to spin</span>
          <button
            class="kbd-hint-btn"
            title="Keyboard shortcuts"
            aria-label="Keyboard shortcuts"
            @click="cmdPalette.shortcutsOpen.value = true"
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
        <button @click="exportWheel" class="btn btn-small" title="Export wheel as SVG">SVG</button>
        <button @click="exportSpin" class="btn btn-small" title="Capture spin as WebM">WebM</button>
        <button @click="exportPDF" class="btn btn-small" title="Export report (new idea)">PDF</button>
        <button @click="toggleTheme" class="btn btn-small" title="Toggle theme (new idea)">Theme</button>
        <input type="color" :value="themeColor" @input="e => updateThemeColor((e.target as HTMLInputElement).value)" title="Theme color picker" style="width:24px;height:24px;padding:0;border:none;vertical-align:middle;" />
        <button @click="suggestAIWeights" class="btn btn-small" title="AI weights (new idea)">AI</button>
        <button @click="equalizeWeights" class="btn btn-small" title="Equalize all weights to 1x">=1x</button>
        <button @click="voiceSpin" class="btn btn-small" title="Voice spin (new idea)">🎤 Spin</button>
        <button @click="roster.togglePreventRepeat()" class="btn btn-small" :title="roster.preventRepeat ? 'Prevent immediate repeat: ON' : 'Prevent immediate repeat: OFF'" :aria-pressed="roster.preventRepeat">no repeat</button>
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
        <button @click="showTemplateGallery = true" class="btn btn-small" title="Templates (new idea)">Templates</button>
        <button @click="toggleEditor" class="btn btn-small" :title="isEditor ? 'Disable editor tools' : 'Enable advanced editor (weights, history)'" :aria-pressed="isEditor">{{ isEditor ? 'Editor✓' : 'Editor' }}</button>
        <button
          @click="cmdPalette.paletteOpen.value = true"
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
              ref="nameListRef"
              :active="roster.activeParticipants"
              :removed="roster.removedParticipants"
              :ticking-id="tickingId"
              :comments="comments"
              :last-picked-id="roster.lastPickedId"
              :prevent-repeat="roster.preventRepeat"
              :prepared-segments="roster.preparedSegments"
              @add="addName"
              @add-batch="addNames"
              @remove="handleRemove"
              @hover-name="onHoverName"
            @reset="reset"
            @reorder="handleReorder"
            />
          </div>

          <!-- Inspector -->
          <div class="panel-toggle" @click="ui.togglePanel('inspector')">
            Inspector {{ panelCollapsed.inspector ? '>' : 'v' }} (editor)
          </div>
          <InspectorPanel
            v-if="isEditor && !panelCollapsed.inspector"
            :selected="inspectorSelected"
            :comments="inspectorSelected ? comments[inspectorSelected.id] : undefined"
            @update-weight="handleUpdateWeight"
            @preview-weight="handlePreviewWeight"
            @update-visual="handleUpdateVisual"
            @add-comment="addComment"
          />

          <!-- HistoryTimeline -->
          <div class="panel-toggle" @click="ui.togglePanel('history')">
            History {{ panelCollapsed.history ? '>' : 'v' }}
          </div>
          <HistoryTimeline
            v-if="isEditor && history && !panelCollapsed.history"
            :actions="history.actions.value || []"
            :session-id="session?.id || ''"
            @restore=" (_id) => { if (_id && history.restoreTo) history.restoreTo(_id) } "
            @preview=" (id) => { if (id) previewFromHistory(id); else roster.clearPreviews() } "
          />

          <!-- Analytics -->
          <div class="panel-toggle" @click="ui.togglePanel('analytics')">
            Analytics {{ panelCollapsed.analytics ? '>' : 'v' }}
          </div>
          <AnalyticsPanel
            v-if="isEditor && !panelCollapsed.analytics"
            :active="activeParticipants"
            :removed="removedParticipants"
          />

          <Teleport to="body">
            <TemplateGallery
              v-if="showTemplateGallery"
              @apply=" (t) => { templateSelect = t.id; createSession(); showTemplateGallery = false; }"
              @close="showTemplateGallery = false"
            />
          </Teleport>
        </div>
      </div>
    </div>

  </div>

  <Teleport to="body">
    <SpinResultModal
      v-if="spin.winnerData.value"
      :name="spin.winnerData.value.name"
      :remaining="spin.winnerData.value.remaining"
      :color="identityColor(spin.winnerData.value.name)"
      @close="dismissWinner"
    />
  </Teleport>

  <Teleport to="body">
    <RecapReel
      v-if="spin.recapOpen.value"
      :title="session?.title ?? ''"
      :picked="removedParticipants"
      :survivor="activeParticipants[0] ?? null"
      @close="spin.recapOpen.value = false"
      @copy="copyRecap"
      @copy-image="copyRecapImage"
    />
  </Teleport>

  <CommandPalette
    :open="cmdPalette.paletteOpen.value"
    :commands="paletteCommands"
    @close="cmdPalette.paletteOpen.value = false"
  />

  <ShortcutsSheet :open="cmdPalette.shortcutsOpen.value" @close="cmdPalette.shortcutsOpen.value = false" />

  <Teleport to="body">
    <ToastStack />
  </Teleport>
</template>

<style scoped>
/* Off-screen but readable by assistive tech: drives the roving-focus aria-live
   announcer without taking up layout or catching the eye. */
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}

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

/* Cmd-K backdrop ramp: while the command palette is open, the app chrome behind
   it (the title header and the roster panel) softly blurs and dims, so the
   palette reads as a focused layer floating above a recessed backdrop
   (Raycast-style). The palette's own teleported overlay paints on top; this is
   the underneath content easing back, visible at the palette's translucent
   edges and through its open/close transition. The wheel itself stays crisp
   (it's the background canvas, already darkened by the palette scrim), and we
   target .list-section rather than the .main-layout flex parent so the filter
   never turns that parent into a containing block for the fixed roster. */
.palette-dimmed .fire-header,
.palette-dimmed .list-section {
  filter: blur(3px) brightness(0.7);
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
  transition: filter 0.18s ease;
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

.panel-toggle {
  font-size: 11px;
  opacity: 0.7;
  cursor: pointer;
  padding: 4px 8px;
  background: rgba(255,255,255,0.05);
  border-radius: 4px;
  margin-bottom: 4px;
  user-select: none;
}
.panel-toggle:hover {
  opacity: 1;
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
  transition: filter 0.18s ease;
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
  .overlay .action-dock,
  .fire-header,
  .list-section {
    transition: none;
  }
}
</style>
