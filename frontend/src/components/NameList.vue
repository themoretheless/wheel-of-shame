<script setup lang="ts">
import { ref, computed } from 'vue'
import type { Participant } from '../types'
import { identityColor } from '../utils/identity'

// First visible character, upper-cased, for the round identity token.
function initialOf(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase()
}

const props = defineProps<{
  active: Participant[]
  removed: Participant[]
  // Id of the participant whose wheel segment is under the pointer mid-spin; the
  // matching row gets a transient '.ticking' flash so the roster reads the spin.
  tickingId?: string | null
}>()

// Each active name has equal odds of being picked next; this drives the tinted
// odds bar behind every active row, recomputing as names are added or ejected.
const oddsPct = computed(() =>
  props.active.length > 0 ? 100 / props.active.length : 0,
)

const emit = defineEmits<{
  (e: 'add', name: string): void
  (e: 'add-batch', names: string[]): void
  (e: 'remove', id: string): void
  (e: 'reset'): void
}>()

const nameInput = ref('')

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
        v-model="nameInput"
        @keyup.enter="addName"
        placeholder="Name (or comma-separated list)"
        class="name-input"
      />
      <button @click="addName" class="btn btn-add">Add</button>
    </div>

    <div class="participants">
      <h3>Active ({{ active.length }})</h3>
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
      <TransitionGroup v-if="active.length > 0" tag="ul" name="eject">
        <li
          v-for="p in active"
          :key="p.id"
          class="participant-item"
          :class="{
            pending: p.pending,
            error: p.error,
            ticking: p.id === tickingId,
            dimmed: !matchesFilter(p),
          }"
          :style="{
            '--odds-width': oddsPct + '%',
            '--odds-color': identityColor(p.name),
            '--tick-color': identityColor(p.name),
          }"
        >
          <span class="name-cell">
            <span class="identity-token" :style="{ background: identityColor(p.name) }">{{
              initialOf(p.name)
            }}</span>
            <span class="name-text">{{ p.name }}</span>
          </span>
          <button
            v-if="!p.pending"
            @click="emit('remove', p.id)"
            class="btn btn-remove"
            title="Remove"
          >
            &times;
          </button>
        </li>
      </TransitionGroup>
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
        <li v-for="p in removed" :key="p.id" class="participant-item picked">
          <span class="name-cell">
            <span class="identity-token" :style="{ background: identityColor(p.name) }">{{
              initialOf(p.name)
            }}</span>
            <span class="name-text">#{{ p.spin_order }} — {{ p.name }}</span>
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
</style>
