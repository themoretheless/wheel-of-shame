<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import type { Participant } from '../types'
import { identityColor } from '../utils/identity'
import { parsePastedNames } from '../utils/roster'
import { computeAngles } from '../utils/wheel'

// First visible character, upper-cased, for the round identity token.
function initialOf(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase()
}

// The first three names off the wheel earn a medal tier (gold/silver/bronze);
// in a wheel of shame, going out earliest is the standout fate. `order` is the
// 1-based spin_order, so rank 1 is the very first elimination.
const MEDAL_TIERS: Record<number, string> = {
  1: 'gold',
  2: 'silver',
  3: 'bronze',
}

function medalTier(order: number | undefined): string | null {
  return order != null ? (MEDAL_TIERS[order] ?? null) : null
}

const props = defineProps<{
  active: Participant[]
  removed: Participant[]
  // Id of the participant whose wheel segment is under the pointer mid-spin; the
  // matching row gets a transient '.ticking' flash so the roster reads the spin.
  tickingId?: string | null
  comments?: Record<string, string[]>
  lastPickedId?: string | null
  preventRepeat?: boolean
  // From roster/engine (perf): precomputed with angles to avoid duplicate work
  preparedSegments?: Array<{ id: string; angle: number; weight: number }>
}>()

// Per-participant odds using shared wheel util or prepared data (from roster/worker).
const oddsById = computed(() => {
  const map: Record<string, number> = {}
  if (!props.active.length) return map

  let angles: number[]
  if (props.preparedSegments && props.preparedSegments.length === props.active.length) {
    // Use precomputed from store/worker (avoids duplicate computeAngles)
    angles = props.preparedSegments.map(s => s.angle)
  } else {
    angles = computeAngles(props.active)
  }

  const total = angles.reduce((a, b) => a + b, 0) || (Math.PI * 2)
  props.active.forEach((p, i) => {
    map[p.id] = ((angles[i] || 0) / total) * 100
  })
  return map
})
function getOdds(p: Participant) {
  return oddsById.value[p.id] ?? (100 / props.active.length)
}

// Note: individual odds now from getOdds(p) using wheel util (weight aware).

// Last one standing: once at least one name has been picked and a single active
// row remains, that row is crowned the survivor (a gold-trimmed counterpart to
// the picked-list medals).
const survivorReached = computed(
  () => props.active.length === 1 && props.removed.length > 0,
)

const emit = defineEmits<{
  (e: 'add', name: string): void
  (e: 'add-batch', names: string[]): void
  (e: 'remove', id: string): void
  (e: 'reset'): void
  // Id of the active row the cursor is over (null on leave), so the wheel can
  // lift the matching segment as a hover peek.
  (e: 'hover-name', id: string | null): void
  (e: 'reorder', from: number, to: number): void
}>()

const nameInput = ref('')
const searchTerm = ref('')

const filteredActive = computed(() => {
  if (!searchTerm.value) return props.active
  const term = searchTerm.value.toLowerCase()
  return props.active.filter(p => p.name.toLowerCase().includes(term))
})

// Simple virtualization for large N (perf fix): fixed row height estimate,
// window the list inside a scroll viewport. TransitionGroup still used on the
// window slice (eject anims for off-window rows are skipped, acceptable trade).
const ROW_H = 34
const OVERSCAN = 4
const scrollTop = ref(0)
const viewportH = ref(320)
const listContainer = ref<HTMLDivElement | null>(null)

const virtualSlice = computed(() => {
  const list = filteredActive.value
  if (list.length <= 12) return { start: 0, end: list.length, list, padTop: 0, padBot: 0 }
  const start = Math.max(0, Math.floor(scrollTop.value / ROW_H) - OVERSCAN)
  const visibleCount = Math.ceil(viewportH.value / ROW_H) + OVERSCAN * 2
  const end = Math.min(list.length, start + visibleCount)
  return {
    start,
    end,
    list: list.slice(start, end),
    padTop: start * ROW_H,
    padBot: (list.length - end) * ROW_H,
  }
})

function onListScroll(e: Event) {
  scrollTop.value = (e.target as HTMLDivElement).scrollTop
}

function updateViewport() {
  if (listContainer.value) {
    viewportH.value = listContainer.value.clientHeight || 320
  }
}

onMounted(() => {
  updateViewport()
  window.addEventListener('resize', updateViewport)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', updateViewport)
})

// Template ref on the name field so App.vue can route a global "/" or "n"
// quick-capture keystroke straight into it without the user reaching for the
// mouse. Exposed via focusInput() below.
const nameInputEl = ref<HTMLInputElement | null>(null)

function focusInput() {
  nameInputEl.value?.focus()
}

defineExpose({ focusInput })

// Staged result of a multi-name paste, awaiting an explicit confirm so a big
// roster lands in one reviewed batch rather than silently flooding the input.
const pendingPaste = ref<string[] | null>(null)

// Intercept a paste that carries more than one name (newline/comma/tab
// separated) and stage it for confirmation instead of dumping raw text into the
// field. A single pasted name falls through to the browser's default paste so
// typing-then-Enter still works.
function onPaste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData('text') ?? ''
  if (!/[\n,\t]/.test(text)) return
  const names = parsePastedNames(text, props.active.map((p) => p.name))
  event.preventDefault()
  pendingPaste.value = names.length > 0 ? names : null
}

function confirmPaste() {
  if (pendingPaste.value && pendingPaste.value.length > 0) {
    emit('add-batch', pendingPaste.value)
  }
  pendingPaste.value = null
  nameInput.value = ''
}

let dragIndex: number | null = null

function onDragStart(index: number, ev: DragEvent) {
  dragIndex = index
  if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move'
}

function onDrop(index: number, _ev: DragEvent) {
  if (dragIndex !== null && dragIndex !== index) {
    emit('reorder', dragIndex, index)
  }
  dragIndex = null
}

function cancelPaste() {
  pendingPaste.value = null
}

// Roster filter: rows that don't match stay in the DOM (so the odds bars keep
// splitting evenly across every active name) but get a '.dimmed' class. Empty
// query matches everything.
const filterQuery = ref('')

const matchesFilter = computed(() => {
  const q = filterQuery.value.trim().toLowerCase()
  return (p: Participant): boolean =>
    q.length === 0 || p.name.toLowerCase().includes(q)
})

// Count of active rows surfaced by the current filter, for the empty-result hint.
const filterMatchCount = computed(() => {
  const match = matchesFilter.value
  return props.active.reduce((n, p) => (match(p) ? n + 1 : n), 0)
})

// A ready-made roster offered on the empty state so a first-time session can be
// populated in one click; routed through the same add-batch path as typed input.
const SAMPLE_NAMES = ['Ada', 'Alan', 'Grace', 'Linus', 'Margaret', 'Dennis']

function addSampleNames() {
  emit('add-batch', SAMPLE_NAMES)
}

function addName() {
  const value = nameInput.value.trim()
  if (!value) return

  // Support comma-separated input
  const names = value
    .split(',')
    .map((n) => n.trim())
    .filter((n) => n.length > 0)

  if (names.length > 1) {
    emit('add-batch', names)
  } else {
    emit('add', names[0])
  }
  nameInput.value = ''
}
</script>

<template>
  <div class="name-list">
    <div class="input-group">
      <input
        ref="nameInputEl"
        v-model="nameInput"
        @keyup.enter="addName"
        @paste="onPaste"
        placeholder="Name (or paste a list)"
        class="name-input"
      />
      <button @click="addName" class="btn btn-add">Add</button>
    </div>
    <input v-model="searchTerm" placeholder="Search..." class="name-input search" style="margin-top: 4px; font-size: 12px;" />

    <!-- Bulk-paste confirm: a pasted multi-name blob is parsed and deduped, then
         held here so the count can be reviewed before it lands as one batch. -->
    <div v-if="pendingPaste" class="paste-confirm" role="status">
      <template v-if="pendingPaste.length > 0">
        <span class="paste-count">
          Add {{ pendingPaste.length }} new
          {{ pendingPaste.length === 1 ? 'name' : 'names' }}?
        </span>
        <div class="paste-actions">
          <button @click="confirmPaste" class="btn btn-paste-add">Add</button>
          <button @click="cancelPaste" class="btn btn-paste-cancel">Cancel</button>
        </div>
      </template>
      <template v-else>
        <span class="paste-count">No new names in that paste.</span>
        <button @click="cancelPaste" class="btn btn-paste-cancel">Dismiss</button>
      </template>
    </div>

    <div class="participants">
      <h3>Active ({{ active.length }}) <span v-if="comments && Object.keys(comments).length" style="font-size:10px;opacity:.6">💬 {{ Object.keys(comments).length }}</span></h3>
      <!-- Roster filter: dims non-matching rows without removing them, so the
           odds bars keep splitting across every active name. -->
      <div v-if="active.length > 0" class="filter-group">
        <input
          v-model="filterQuery"
          placeholder="Filter names…"
          class="filter-input"
          aria-label="Filter active names"
        />
        <button
          v-if="filterQuery"
          @click="filterQuery = ''"
          class="filter-clear"
          title="Clear filter"
          aria-label="Clear filter"
        >
          &times;
        </button>
      </div>
      <!-- Physical eject: when a name leaves the active list (picked by a spin
           or removed by hand) the row slides out and blurs away while the rows
           below slide up to fill the gap, instead of vanishing instantly. -->
      <div
        v-if="active.length > 0"
        ref="listContainer"
        class="roster-scroll"
        @scroll="onListScroll"
      >
        <div class="virt-pad" :style="{ height: virtualSlice.padTop + 'px' }"></div>
        <TransitionGroup tag="ul" name="eject" class="roster-virtual">
          <li
            v-for="(p, i) in virtualSlice.list"
            :key="p.id"
            class="participant-item"
            :class="{
              pending: p.pending,
              error: p.error,
              ticking: p.id === tickingId,
              dimmed: !matchesFilter(p),
              survivor: survivorReached,
            }"
            :style="{
              '--odds-width': getOdds(p) + '%',
              '--odds-color': identityColor(p.name),
              '--tick-color': identityColor(p.name),
            }"
            draggable="true"
            @dragstart="onDragStart(virtualSlice.start + i, $event)"
            @dragover.prevent
            @drop="onDrop(virtualSlice.start + i, $event)"
            @dragenter.prevent
            @mouseenter="emit('hover-name', p.id)"
            @mouseleave="emit('hover-name', null)"
          >
          <span class="name-cell">
            <span class="identity-token" :style="{ background: identityColor(p.name) }">{{
              initialOf(p.name)
            }}</span>
            <span class="name-text">{{ p.name }}</span>
            <span v-if="comments && comments[p.id] && comments[p.id].length" class="comment-badge" :title="comments[p.id].slice(-1)[0]">💬{{ comments[p.id].length }}</span>
            <span v-if="lastPickedId === p.id && preventRepeat" class="last-badge" title="Last picked (prevent repeat active)">last</span>
            <span v-if="survivorReached" class="survivor-chip" title="Last one standing">
              Survivor
            </span>
          </span>
          <span class="row-end">
            <!-- Odds readout: each active name's equal chance of being picked
                 next, rolled to its new value as the roster changes. Hidden on
                 pending/error rows, which carry no odds (their bar is hidden
                 too). -->
            <span v-if="!p.pending && !p.error" class="odds-pct" aria-hidden="true">{{
              getOdds(p).toFixed(0)
            }}%</span>
            <button
              v-if="!p.pending"
              @click="emit('remove', p.id)"
              class="btn btn-remove"
              title="Remove"
            >
              &times;
            </button>
          </span>
        </li>
        </TransitionGroup>
        <div class="virt-pad" :style="{ height: virtualSlice.padBot + 'px' }"></div>
      </div>
      <p v-if="active.length > 0 && filterMatchCount === 0" class="filter-empty">
        No active names match “{{ filterQuery.trim() }}”.
      </p>
      <div v-else-if="active.length === 0" class="empty-card">
        <span class="empty-mark" aria-hidden="true">○</span>
        <p class="empty-title">No one's on the wheel yet</p>
        <p class="empty-sub">Add names above, or drop in a sample roster to try a spin.</p>
        <button @click="addSampleNames" class="btn btn-sample">Try sample names</button>
      </div>
    </div>

    <div v-if="removed.length > 0" class="participants removed-list">
      <h3>Picked ({{ removed.length }})</h3>
      <ol>
        <li
          v-for="p in removed"
          :key="p.id"
          class="participant-item picked"
          :class="medalTier(p.spin_order) ? 'medal-' + medalTier(p.spin_order) : null"
        >
          <span class="name-cell">
            <span
              class="rank-chip"
              :class="medalTier(p.spin_order) ? 'medal-' + medalTier(p.spin_order) : null"
              >#{{ p.spin_order }}</span
            >
            <span class="identity-token" :style="{ background: identityColor(p.name) }">{{
              initialOf(p.name)
            }}</span>
            <span class="name-text">{{ p.name }}</span>
            <span v-if="comments && comments[p.id] && comments[p.id].length" class="comment-badge" :title="comments[p.id].slice(-1)[0]">💬{{ comments[p.id].length }}</span>
            <span v-if="lastPickedId === p.id && preventRepeat" class="last-badge" title="Last picked (prevent repeat active)">last</span>
          </span>
        </li>
      </ol>
      <button @click="emit('reset')" class="btn btn-reset">Reset All</button>
    </div>
  </div>
</template>

<style scoped>
.name-list {
  width: 100%;
  max-width: 360px;
}

.input-group {
  display: flex;
  gap: 8px;
  margin-bottom: 16px;
}

.name-input {
  flex: 1;
  padding: 10px 14px;
  border: 2px solid #dfe6e9;
  border-radius: 8px;
  font-size: 14px;
  background: #2d3436;
  color: #dfe6e9;
}

.name-input:focus {
  border-color: #4ECDC4;
  outline: none;
}

/* Roster filter field: sits between the Active heading and the list. */
.filter-group {
  position: relative;
  margin-bottom: 8px;
}

.filter-input {
  width: 100%;
  padding: 7px 28px 7px 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 6px;
  font-size: 13px;
  background: rgba(255, 255, 255, 0.05);
  color: #dfe6e9;
  box-sizing: border-box;
}

.filter-input::placeholder {
  color: #7f8c8d;
}

.filter-input:focus {
  border-color: #4ECDC4;
  outline: none;
}

.filter-clear {
  position: absolute;
  top: 50%;
  right: 6px;
  transform: translateY(-50%);
  padding: 2px 6px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: #95a5a6;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}

.filter-clear:hover {
  color: #dfe6e9;
}

.btn {
  padding: 10px 16px;
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-weight: bold;
  font-size: 14px;
}

.btn-add {
  background: #4ECDC4;
  color: #2d3436;
}

.btn-add:hover {
  background: #45b7aa;
}

/* Bulk-paste confirm strip: a glass row between the input and the roster that
   shows the parsed count and the Add/Cancel actions before committing. */
.paste-confirm {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  flex-wrap: wrap;
  margin: -8px 0 16px;
  padding: 10px 14px;
  border-radius: 8px;
  background: rgba(78, 205, 196, 0.1);
  border: 1px solid rgba(78, 205, 196, 0.3);
  animation: paste-slide 0.22s ease both;
}

.paste-count {
  font-size: 13px;
  color: #dfe6e9;
}

.paste-actions {
  display: flex;
  gap: 8px;
}

.btn-paste-add {
  background: #4ECDC4;
  color: #2d3436;
  padding: 7px 16px;
  font-size: 13px;
}

.btn-paste-add:hover {
  background: #45b7aa;
}

.btn-paste-cancel {
  background: transparent;
  color: #95a5a6;
  border: 1px solid rgba(255, 255, 255, 0.15);
  padding: 7px 14px;
  font-size: 13px;
}

.btn-paste-cancel:hover {
  color: #dfe6e9;
  border-color: rgba(255, 255, 255, 0.3);
}

@keyframes paste-slide {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@media (prefers-reduced-motion: reduce) {
  .paste-confirm {
    animation: none;
  }
}

.btn-remove {
  position: relative;
  background: transparent;
  color: #e74c3c;
  font-size: 18px;
  padding: 4px 8px;
}

.btn-remove:hover {
  background: rgba(231, 76, 60, 0.15);
}

h3 {
  margin: 0 0 8px;
  font-size: 14px;
  color: #b2bec3;
  text-transform: uppercase;
  letter-spacing: 1px;
}

ul, ol {
  list-style: none;
  padding: 0;
  margin: 0;
}

/* Positioning context so an ejecting row (position: absolute during its leave
   transition) is measured against the list, not the page. */
ul {
  position: relative;
}

ol {
  list-style: none;
}

.participant-item {
  position: relative;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-radius: 6px;
  margin-bottom: 4px;
  background: rgba(255, 255, 255, 0.05);
  overflow: hidden;
  /* Snappy catch on the spin spotlight, easing out as the next row takes over. */
  transition:
    transform 0.18s ease-out,
    box-shadow 0.18s ease-out,
    background 0.18s ease-out;
}

/* Live odds bar: a tinted fill behind the row, its width the participant's
   chance of being picked next (equal split across active names). The width
   transitions as the roster changes, so adding a name visibly shortens every
   bar. Sits behind the content; --odds-width/--odds-color are set per row. */
.participant-item::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: var(--odds-width, 0%);
  background: var(--odds-color, transparent);
  opacity: 0.16;
  border-radius: inherit;
  transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  pointer-events: none;
}

/* Removed/optimistic rows don't carry odds, so hide their bar. */
.participant-item.picked::before,
.participant-item.pending::before,
.participant-item.error::before {
  display: none;
}

.name-cell {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.name-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.comment-badge {
  font-size: 10px;
  background: #333;
  padding: 0 4px;
  border-radius: 3px;
  margin-left: 4px;
  cursor: default;
}
.last-badge {
  font-size: 9px;
  background: #e74c3c;
  color: white;
  padding: 0 3px;
  border-radius: 2px;
  margin-left: 4px;
}

/* Right cluster: the rolled odds readout next to the remove control, kept above
   the odds bar fill so the percentage stays legible. */
.row-end {
  position: relative;
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
}

/* Per-row odds label: the tweened "n%" chance of being picked next. Tinted to
   the same identity color as the row's odds bar via --odds-color, with tabular
   figures so the digits don't jitter as the number rolls. */
.odds-pct {
  font-size: 12px;
  font-weight: bold;
  font-variant-numeric: tabular-nums;
  color: var(--odds-color, #95a5a6);
  opacity: 0.85;
}

.participant-item.ticking .odds-pct {
  opacity: 1;
}

/* Round identity token: deterministic per-name color matching the wheel
   segment, with the participant's initial. */
.identity-token {
  flex: none;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: bold;
  color: #2d3436;
  text-decoration: none;
}

.participant-item.picked {
  opacity: 0.6;
  text-decoration: line-through;
}

/* Medal tiers: the first three names off the wheel keep a little more presence
   than the rest of the picked list, lifted by a left accent in their tier color
   so the earliest exits read as a podium. --medal is set per tier below. */
.participant-item.picked.medal-gold,
.participant-item.picked.medal-silver,
.participant-item.picked.medal-bronze {
  opacity: 0.85;
  box-shadow: inset 3px 0 0 var(--medal);
}

.participant-item.medal-gold {
  --medal: #ffd54a;
}

.participant-item.medal-silver {
  --medal: #cfd8dc;
}

.participant-item.medal-bronze {
  --medal: #d99c66;
}

/* Rank chip: the 1-based elimination order, leading each picked row. Plain rows
   carry a muted chip; medal rows tint theirs to the tier color and skip the
   strike-through so the number stays legible. */
.rank-chip {
  flex: none;
  min-width: 26px;
  padding: 2px 6px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: bold;
  text-align: center;
  text-decoration: none;
  color: #b2bec3;
  background: rgba(255, 255, 255, 0.08);
}

.rank-chip.medal-gold,
.rank-chip.medal-silver,
.rank-chip.medal-bronze {
  color: #1e1e1e;
  background: var(--medal);
}

.rank-chip.medal-gold {
  --medal: #ffd54a;
}

.rank-chip.medal-silver {
  --medal: #cfd8dc;
}

.rank-chip.medal-bronze {
  --medal: #d99c66;
}

/* Survivor: the lone active row once everyone else has been picked. A gold trim
   and a small chip crown the last one standing, mirroring the picked-list gold
   medal. */
.participant-item.survivor {
  box-shadow: inset 0 0 0 1px rgba(255, 213, 74, 0.6);
  background: color-mix(in srgb, #ffd54a 12%, rgba(255, 255, 255, 0.05));
}

.survivor-chip {
  flex: none;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: bold;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #1e1e1e;
  background: #ffd54a;
}

/* Filtered out: the row stays in the DOM (so odds bars stay correct) but recedes
   so the matching rows read clearly. A ticking row overrides this to stay lit. */
.participant-item.dimmed:not(.ticking) {
  opacity: 0.32;
  filter: grayscale(0.4);
  transition: opacity 0.18s ease, filter 0.18s ease;
}

/* Spin spotlight: while a participant's wheel segment is under the pointer, its
   roster row briefly lifts and glows in the participant's identity color, so the
   list reads the spin in sync with the wheel. The class is toggled on/off as the
   pointer crosses segments, so the ease-out transition does the flashing without
   a keyframe restart. The transition stays short on the way in (snappy catch) and
   eases out as the next row takes over. */
.participant-item.ticking {
  transform: scale(1.04);
  background: color-mix(in srgb, var(--tick-color, #4ECDC4) 22%, rgba(255, 255, 255, 0.05));
  box-shadow: 0 0 0 1px var(--tick-color, #4ECDC4), 0 4px 16px rgba(0, 0, 0, 0.35);
  z-index: 1;
}

/* Reduced motion: keep the color/glow flash but drop the scale lift. */
@media (prefers-reduced-motion: reduce) {
  .participant-item.ticking {
    transform: none;
  }
}

/* Optimistic add: a settling skeleton chip that pulses until the server
   confirms, then reconciles into a normal row. */
.participant-item.pending {
  opacity: 0.5;
  animation: chip-pulse 1.1s ease-in-out infinite;
}

/* Failed add: shake briefly before the row is removed. */
.participant-item.error {
  color: #e74c3c;
  background: rgba(231, 76, 60, 0.12);
  animation: chip-shake 0.4s ease-in-out;
}

@keyframes chip-pulse {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 0.85; }
}

/* Eject (TransitionGroup): the leaving row is pulled out of flow so the rows
   below glide up to close the gap (move transition), while the row itself
   slides right, shrinks and blurs out, giving a physical "flung off the wheel"
   feel with no confetti. */
.eject-leave-active {
  position: absolute;
  width: 100%;
}

.eject-leave-to {
  opacity: 0;
  transform: translateX(40px) scale(0.85);
  filter: blur(4px);
}

.eject-leave-active,
.eject-move {
  transition:
    transform 0.4s cubic-bezier(0.4, 0, 0.2, 1),
    opacity 0.4s ease,
    filter 0.4s ease;
}

@media (prefers-reduced-motion: reduce) {
  .eject-leave-to {
    transform: none;
    filter: none;
  }

  .eject-leave-active,
  .eject-move {
    transition: opacity 0.2s ease;
  }
}

@keyframes chip-shake {
  0%, 100% { transform: translateX(0); }
  20% { transform: translateX(-5px); }
  40% { transform: translateX(5px); }
  60% { transform: translateX(-3px); }
  80% { transform: translateX(3px); }
}

/* Empty state: a glass card that invites a first roster instead of a bare line
   of italic text, with a one-click sample roster routed through add-batch. */
.empty-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 6px;
  padding: 24px 20px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px dashed rgba(255, 255, 255, 0.12);
}

/* Shown when a filter query excludes every active row. */
.filter-empty {
  margin: 4px 0 0;
  padding: 12px;
  text-align: center;
  font-size: 12px;
  color: #95a5a6;
}

.empty-mark {
  font-size: 28px;
  line-height: 1;
  color: #4ECDC4;
  opacity: 0.7;
  margin-bottom: 2px;
}

.empty-title {
  margin: 0;
  font-size: 14px;
  font-weight: bold;
  color: #dfe6e9;
}

.empty-sub {
  margin: 0;
  font-size: 12px;
  line-height: 1.4;
  color: #95a5a6;
  max-width: 240px;
}

.btn-sample {
  margin-top: 10px;
  background: rgba(78, 205, 196, 0.14);
  color: #4ECDC4;
  border: 1px solid rgba(78, 205, 196, 0.35);
  padding: 9px 18px;
  font-size: 13px;
  transition: background 0.18s ease;
}

.btn-sample:hover {
  background: rgba(78, 205, 196, 0.24);
}

.removed-list {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.btn-reset {
  width: 100%;
  margin-top: 12px;
  background: rgba(255, 234, 167, 0.15);
  color: #FFEAA7;
  padding: 10px;
  border: 1px solid rgba(255, 234, 167, 0.3);
  border-radius: 8px;
  cursor: pointer;
  font-weight: bold;
  font-size: 13px;
}

.btn-reset:hover {
  background: rgba(255, 234, 167, 0.25);
}

/* Virtualization container for roster perf with long lists. */
.roster-scroll {
  max-height: 320px;
  overflow: auto;
  contain: layout paint;
}
.roster-virtual {
  list-style: none;
  margin: 0;
  padding: 0;
}
.virt-pad {
  height: 0;
  pointer-events: none;
}
</style>
