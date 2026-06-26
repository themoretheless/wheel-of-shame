<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import type { Participant } from '../types'
import { identityColor } from '../utils/identity'

// First visible character, upper-cased, for the round identity token.
function initialOf(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase()
}

const props = defineProps<{
  active: Participant[]
  removed: Participant[]
  soundEnabled: boolean
  soundIntensity: number
  themePreset: 'classic' | 'arcade' | 'minimal'
  spectatorMode: boolean
}>()

const emit = defineEmits<{
  (e: 'add', name: string): void
  (e: 'add-batch', names: string[]): void
  (e: 'remove', id: string): void
  (e: 'update-participant', id: string, patch: { pinned?: boolean; weight?: number }): void
  (e: 'reset'): void
  (e: 'update:sound-enabled', value: boolean): void
  (e: 'update:sound-intensity', value: number): void
  (e: 'update:theme-preset', value: 'classic' | 'arcade' | 'minimal'): void
  (e: 'update:spectator-mode', value: boolean): void
}>()

const nameInput = ref('')
const searchQuery = ref('')
const bulkOpen = ref(false)
const bulkText = ref('')
const copyStatus = ref('')
const viewMode = ref<'all' | 'active' | 'picked'>('all')
const sortMode = ref<'added' | 'name'>('added')
const compactRows = ref(false)
const historyReplay = ref<{ name: string; order: number | string } | null>(null)
const undoAction = ref<{ label: string; names: string[]; replaceActive: boolean } | null>(null)
let copyStatusTimer: ReturnType<typeof setTimeout> | undefined

function parseNames(value: string): string[] {
  return value
    .split(/[\n,;\t]+/)
    .map((n) => n.trim())
    .filter((n) => n.length > 0)
}

function uniqueInOrder(names: string[]): string[] {
  const seen = new Set<string>()
  return names.filter((name) => {
    const key = name.toLocaleLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function submitNames(names: string[]) {
  if (names.length === 0) return
  if (names.length > 1) {
    emit('add-batch', names)
  } else {
    emit('add', names[0])
  }
}

function addName() {
  const names = uniqueInOrder(parseNames(nameInput.value))
  submitNames(names)
  if (names.length > 0) nameInput.value = ''
}

const parsedBulkNames = computed(() => uniqueInOrder(parseNames(bulkText.value)))
const rawBulkNames = computed(() => parseNames(bulkText.value))
const bulkDuplicateCount = computed(() => rawBulkNames.value.length - parsedBulkNames.value.length)
const bulkPreviewNames = computed(() => parsedBulkNames.value.slice(0, 8))

function importBulk() {
  submitNames(parsedBulkNames.value)
  if (parsedBulkNames.value.length > 0) {
    bulkText.value = ''
    bulkOpen.value = false
  }
}

function titleCaseName(name: string): string {
  return name
    .trim()
    .toLocaleLowerCase()
    .replace(/\b\p{L}/gu, (letter) => letter.toLocaleUpperCase())
}

const normalizedActiveNames = computed(() =>
  props.active.map((participant) => titleCaseName(participant.name)),
)

const canNormalizeActive = computed(() =>
  !props.active.some((participant) => participant.pinned) &&
  props.active.some((participant, index) => participant.name !== normalizedActiveNames.value[index]),
)

function normalizeActiveNames() {
  if (props.spectatorMode || !canNormalizeActive.value) return
  undoAction.value = {
    label: 'Undo normalize',
    names: props.active.map((participant) => participant.name),
    replaceActive: true,
  }
  for (const participant of props.active) {
    emit('remove', participant.id)
  }
  submitNames(uniqueInOrder(normalizedActiveNames.value))
}

const totalCount = computed(() => props.active.length + props.removed.length)
function weightOf(participant: Participant): number {
  return participant.weight ?? 1
}

const totalWeight = computed(() =>
  props.active.reduce((sum, participant) => sum + weightOf(participant), 0),
)
const pinnedCount = computed(() => props.active.filter((participant) => participant.pinned).length)

const nextOdds = computed(() => {
  if (props.active.length === 0) return '0%'
  if (props.active.some((participant) => weightOf(participant) !== 1)) {
    return `${totalWeight.value} tickets`
  }
  const odds = 100 / props.active.length
  return `${odds >= 10 ? Math.round(odds) : odds.toFixed(1)}%`
})

const nextOddsLabel = computed(() =>
  props.active.some((participant) => weightOf(participant) !== 1) ? 'weighted pool' : 'next odds',
)

function participantMatches(p: Participant): boolean {
  const q = searchQuery.value.trim().toLocaleLowerCase()
  if (!q) return true
  return p.name.toLocaleLowerCase().includes(q)
}

function sortParticipants(list: Participant[], picked: boolean): Participant[] {
  const sorted = [...list]
  const pinnedSort = (a: Participant, b: Participant) => Number(b.pinned) - Number(a.pinned)
  if (sortMode.value === 'name') {
    return sorted.sort(
      (a, b) =>
        (picked ? 0 : pinnedSort(a, b)) ||
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
    )
  }
  if (picked) {
    return sorted.sort((a, b) => (a.spin_order ?? 0) - (b.spin_order ?? 0))
  }
  return sorted.sort(pinnedSort)
}

const activeFiltered = computed(() =>
  sortParticipants(props.active.filter(participantMatches), false),
)
const removedFiltered = computed(() =>
  sortParticipants(props.removed.filter(participantMatches), true),
)
const showActiveSection = computed(() => viewMode.value !== 'picked')
const showPickedSection = computed(() => viewMode.value !== 'active')
const visibleCount = computed(() => {
  if (viewMode.value === 'active') return activeFiltered.value.length
  if (viewMode.value === 'picked') return removedFiltered.value.length
  return activeFiltered.value.length + removedFiltered.value.length
})

const duplicateNames = computed(() => {
  const counts = new Map<string, { name: string; count: number }>()
  for (const participant of [...props.active, ...props.removed]) {
    const key = participant.name.trim().toLocaleLowerCase()
    if (!key) continue
    const entry = counts.get(key)
    if (entry) {
      entry.count++
    } else {
      counts.set(key, { name: participant.name.trim(), count: 1 })
    }
  }
  return [...counts.values()].filter((entry) => entry.count > 1)
})

const activeDuplicateIds = computed(() => {
  const seen = new Set<string>()
  const duplicateIds: string[] = []
  for (const participant of props.active) {
    const key = participant.name.trim().toLocaleLowerCase()
    if (!key) continue
    if (seen.has(key)) {
      if (!participant.pinned) duplicateIds.push(participant.id)
    } else {
      seen.add(key)
    }
  }
  return duplicateIds
})

const activeDuplicateNames = computed(() =>
  props.active
    .filter((participant) => activeDuplicateIds.value.includes(participant.id))
    .map((participant) => participant.name),
)

function removeActiveDuplicates() {
  if (props.spectatorMode || activeDuplicateIds.value.length === 0) return
  undoAction.value = {
    label: 'Undo cleanup',
    names: activeDuplicateNames.value,
    replaceActive: false,
  }
  for (const id of activeDuplicateIds.value) {
    emit('remove', id)
  }
}

function runUndoAction() {
  const action = undoAction.value
  if (props.spectatorMode || !action) return
  if (action.replaceActive) {
    for (const participant of props.active) {
      emit('remove', participant.id)
    }
  }
  submitNames(action.names)
  undoAction.value = null
}

function togglePin(participant: Participant) {
  if (props.spectatorMode) return
  emit('update-participant', participant.id, { pinned: !participant.pinned })
}

function setWeight(participant: Participant, value: number) {
  if (props.spectatorMode) return
  emit('update-participant', participant.id, { weight: Math.max(1, Math.min(5, value)) })
}

function copyReport() {
  const active = props.active
    .map((participant) => {
      const pin = participant.pinned ? ' pinned' : ''
      const weight = weightOf(participant)
      return `- ${participant.name}${pin}${weight > 1 ? ` x${weight}` : ''}`
    })
    .join('\n') || '- none'
  const picked = props.removed
    .map((participant, index) => `${participant.spin_order ?? index + 1}. ${participant.name}`)
    .join('\n') || 'none'
  void copyText(`Wheel report\n\nActive\n${active}\n\nPicked\n${picked}`, 'Report copied')
}

function replayPicked(participant: Participant, index: number) {
  historyReplay.value = {
    name: participant.name,
    order: participant.spin_order ?? index + 1,
  }
}

function showCopyStatus(message: string) {
  copyStatus.value = message
  clearTimeout(copyStatusTimer)
  copyStatusTimer = setTimeout(() => {
    copyStatus.value = ''
  }, 1400)
}

async function copyText(text: string, message: string) {
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
    showCopyStatus(message)
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', 'true')
    area.style.position = 'fixed'
    area.style.left = '-9999px'
    document.body.appendChild(area)
    area.select()
    document.execCommand('copy')
    area.remove()
    showCopyStatus(message)
  }
}

function copyActiveNames() {
  void copyText(props.active.map((p) => p.name).join('\n'), 'Active copied')
}

function copyPickedNames() {
  const text = props.removed
    .map((p, index) => `#${p.spin_order ?? index + 1} ${p.name}`)
    .join('\n')
  void copyText(text, 'Picked copied')
}

onBeforeUnmount(() => {
  clearTimeout(copyStatusTimer)
})
</script>

<template>
  <div class="name-list" :class="[`theme-${themePreset}`, { compact: compactRows }]">
    <div class="roster-top">
      <div>
        <span class="panel-kicker">Roster</span>
        <h2>Participants</h2>
      </div>
      <div class="odds-pill">
        <strong>{{ nextOdds }}</strong>
        <span>{{ nextOddsLabel }}</span>
      </div>
    </div>

    <div class="stats-strip" aria-label="Roster status">
      <span><strong>{{ totalCount }}</strong>Total</span>
      <span><strong>{{ active.length }}</strong>Active</span>
      <span><strong>{{ removed.length }}</strong>Picked</span>
      <span><strong>{{ totalWeight }}</strong>Tickets</span>
    </div>

    <div class="view-tabs" role="tablist" aria-label="Roster view">
      <button
        class="seg-btn"
        :class="{ active: viewMode === 'all' }"
        role="tab"
        :aria-selected="viewMode === 'all'"
        @click="viewMode = 'all'"
      >
        All
      </button>
      <button
        class="seg-btn"
        :class="{ active: viewMode === 'active' }"
        role="tab"
        :aria-selected="viewMode === 'active'"
        @click="viewMode = 'active'"
      >
        Active
      </button>
      <button
        class="seg-btn"
        :class="{ active: viewMode === 'picked' }"
        role="tab"
        :aria-selected="viewMode === 'picked'"
        @click="viewMode = 'picked'"
      >
        Picked
      </button>
    </div>

    <div class="control-grid" aria-label="Roster controls">
      <label class="sort-control">
        <span>Sort</span>
        <select v-model="sortMode">
          <option value="added">Added</option>
          <option value="name">Name</option>
        </select>
      </label>
      <label class="sort-control">
        <span>Theme</span>
        <select
          :value="themePreset"
          @change="emit('update:theme-preset', ($event.target as HTMLSelectElement).value as 'classic' | 'arcade' | 'minimal')"
        >
          <option value="classic">Classic</option>
          <option value="arcade">Arcade</option>
          <option value="minimal">Minimal</option>
        </select>
      </label>
      <label class="compact-toggle">
        <input v-model="compactRows" type="checkbox" />
        <span class="toggle-box" aria-hidden="true"></span>
        <span>Compact</span>
      </label>
      <label class="compact-toggle">
        <input
          :checked="spectatorMode"
          type="checkbox"
          @change="emit('update:spectator-mode', ($event.target as HTMLInputElement).checked)"
        />
        <span class="toggle-box" aria-hidden="true"></span>
        <span>Spectator</span>
      </label>
      <label class="compact-toggle sound-toggle">
        <input
          :checked="soundEnabled"
          type="checkbox"
          @change="emit('update:sound-enabled', ($event.target as HTMLInputElement).checked)"
        />
        <span class="toggle-box" aria-hidden="true"></span>
        <span>Sound</span>
      </label>
      <input
        class="sound-slider"
        :value="soundIntensity"
        type="range"
        min="0.2"
        max="1.6"
        step="0.1"
        :disabled="!soundEnabled"
        @input="emit('update:sound-intensity', Number(($event.target as HTMLInputElement).value))"
      />
    </div>

    <div class="input-group">
      <input
        v-model="nameInput"
        @keyup.enter="addName"
        placeholder="Name, comma list, or pasted rows"
        class="name-input"
        :disabled="spectatorMode"
      />
      <button @click="addName" class="btn btn-add" :disabled="spectatorMode">Add</button>
    </div>

    <div class="tool-row">
      <button
        class="btn btn-ghost"
        :class="{ active: bulkOpen }"
        :disabled="spectatorMode"
        @click="bulkOpen = !bulkOpen"
      >
        Bulk
      </button>
      <button class="btn btn-ghost" :disabled="active.length === 0" @click="copyActiveNames">
        Copy active
      </button>
      <button class="btn btn-ghost" :disabled="removed.length === 0" @click="copyPickedNames">
        Copy picked
      </button>
      <button class="btn btn-ghost" :disabled="active.length === 0" @click="copyReport">
        Report
      </button>
      <button
        class="btn btn-ghost"
        :disabled="spectatorMode || !canNormalizeActive"
        @click="normalizeActiveNames"
      >
        Normalize
      </button>
    </div>

    <div v-if="bulkOpen" class="bulk-editor">
      <textarea
        v-model="bulkText"
        placeholder="Paste one name per line, or separate with commas"
        rows="4"
        :disabled="spectatorMode"
      ></textarea>
      <div class="bulk-footer">
        <span>{{ parsedBulkNames.length }} ready<span v-if="bulkDuplicateCount > 0">, {{ bulkDuplicateCount }} duplicate</span></span>
        <button
          class="btn btn-add btn-compact"
          :disabled="spectatorMode || parsedBulkNames.length === 0"
          @click="importBulk"
        >
          Import
        </button>
      </div>
      <div v-if="bulkPreviewNames.length > 0" class="bulk-preview">
        <span v-for="name in bulkPreviewNames" :key="name">{{ name }}</span>
      </div>
    </div>

    <p v-if="copyStatus" class="copy-status" role="status">{{ copyStatus }}</p>

    <div v-if="undoAction" class="copy-status undo-status" role="status">
      <span>{{ undoAction.label }} ready</span>
      <button class="notice-action" :disabled="spectatorMode" @click="runUndoAction">
        {{ undoAction.label }}
      </button>
    </div>

    <div v-if="duplicateNames.length > 0" class="notice">
      <span>
        {{ duplicateNames.length }} duplicate name{{ duplicateNames.length === 1 ? '' : 's' }} in the roster
      </span>
      <button
        v-if="activeDuplicateIds.length > 0"
        class="notice-action"
        :disabled="spectatorMode"
        @click="removeActiveDuplicates"
      >
        Remove {{ activeDuplicateIds.length }} active
      </button>
    </div>

    <div v-if="totalCount > 4" class="search-box">
      <input
        v-model="searchQuery"
        class="search-input"
        placeholder="Search roster"
        type="search"
      />
      <button
        v-if="searchQuery"
        class="clear-search"
        title="Clear search"
        @click="searchQuery = ''"
      >
        &times;
      </button>
    </div>

    <div v-if="showActiveSection" class="participants">
      <div class="section-heading">
        <h3>Active</h3>
        <span>{{ activeFiltered.length }} shown</span>
      </div>
      <ul v-if="activeFiltered.length > 0">
        <li
          v-for="p in activeFiltered"
          :key="p.id"
          class="participant-item"
          :class="{ pending: p.pending, error: p.error, pinned: p.pinned, weighted: weightOf(p) > 1 }"
        >
          <span class="name-cell">
            <span class="identity-token" :style="{ background: identityColor(p.name) }">{{
              initialOf(p.name)
            }}</span>
            <span class="name-text">{{ p.name }}</span>
          </span>
          <span class="row-tools">
            <button
              class="mini-btn"
              :class="{ active: p.pinned }"
              :title="p.pinned ? 'Unpin' : 'Pin'"
              :aria-label="p.pinned ? `Unpin ${p.name}` : `Pin ${p.name}`"
              :aria-pressed="p.pinned"
              :disabled="spectatorMode"
              @click="togglePin(p)"
            >
              Pin
            </button>
            <button
              class="mini-btn"
              title="Decrease weight"
              :aria-label="`Decrease ${p.name} weight`"
              :disabled="spectatorMode || weightOf(p) <= 1"
              @click="setWeight(p, weightOf(p) - 1)"
            >
              -
            </button>
            <span class="weight-pill" :title="`${p.name} has ${weightOf(p)} ticket${weightOf(p) === 1 ? '' : 's'}`">
              x{{ weightOf(p) }}
            </span>
            <button
              class="mini-btn"
              title="Increase weight"
              :aria-label="`Increase ${p.name} weight`"
              :disabled="spectatorMode || weightOf(p) >= 5"
              @click="setWeight(p, weightOf(p) + 1)"
            >
              +
            </button>
          </span>
          <button
            v-if="!p.pending"
            @click="emit('remove', p.id)"
            class="btn btn-remove"
            title="Remove"
            :aria-label="`Remove ${p.name}`"
            :disabled="spectatorMode || p.pinned"
          >
            &times;
          </button>
        </li>
      </ul>
      <p v-else class="empty">{{ active.length === 0 ? 'No active participants' : 'No active matches' }}</p>
    </div>

    <div v-if="showPickedSection && (removed.length > 0 || viewMode === 'picked')" class="participants removed-list">
      <div class="section-heading">
        <h3>Picked</h3>
        <span>{{ removedFiltered.length }} shown</span>
      </div>
      <ol v-if="removedFiltered.length > 0">
        <li v-for="(p, index) in removedFiltered" :key="p.id" class="participant-item picked">
          <span class="name-cell">
            <span class="identity-token" :style="{ background: identityColor(p.name) }">{{
              initialOf(p.name)
            }}</span>
            <span class="name-text">#{{ p.spin_order ?? index + 1 }} - {{ p.name }}</span>
          </span>
          <button class="mini-btn" @click="replayPicked(p, index)">Replay</button>
        </li>
      </ol>
      <p v-else class="empty">{{ removed.length === 0 ? 'No picks yet' : 'No picked matches' }}</p>
      <p v-if="historyReplay" class="copy-status replay-status">
        Replay #{{ historyReplay.order }}: {{ historyReplay.name }}
      </p>
      <button
        @click="emit('reset')"
        class="btn btn-reset"
        :disabled="spectatorMode || removed.length === 0"
      >
        Reset All
      </button>
    </div>

    <p v-if="searchQuery" class="view-footnote">
      {{ visibleCount }} visible<span v-if="pinnedCount > 0">, {{ pinnedCount }} pinned</span>
    </p>
  </div>
</template>

<style scoped>
.name-list {
  width: 100%;
  --accent: #4ecdc4;
  --accent-hover: #66ded6;
  --accent-contrast: #162326;
  --accent-soft: rgba(78, 205, 196, 0.14);
  --accent-border: rgba(78, 205, 196, 0.38);
  --accent-ring: rgba(78, 205, 196, 0.16);
  --accent-text: #7ff5ec;
  color: #edf3f4;
}

.name-list.theme-arcade {
  --accent: #ff5c8a;
  --accent-hover: #ff7ba2;
  --accent-contrast: #210b14;
  --accent-soft: rgba(255, 92, 138, 0.15);
  --accent-border: rgba(255, 92, 138, 0.42);
  --accent-ring: rgba(255, 92, 138, 0.18);
  --accent-text: #ffc0d2;
}

.name-list.theme-minimal {
  --accent: #dfe6e9;
  --accent-hover: #ffffff;
  --accent-contrast: #111719;
  --accent-soft: rgba(223, 230, 233, 0.11);
  --accent-border: rgba(223, 230, 233, 0.28);
  --accent-ring: rgba(223, 230, 233, 0.14);
  --accent-text: #ffffff;
}

.roster-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 14px;
}

.panel-kicker {
  display: block;
  margin-bottom: 4px;
  color: #95a5a6;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0;
  text-transform: uppercase;
}

h2 {
  margin: 0;
  color: #f7fbfc;
  font-size: 20px;
  line-height: 1.15;
}

.odds-pill {
  min-width: 104px;
  padding: 8px 10px;
  border: 1px solid var(--accent-border);
  border-radius: 8px;
  background: var(--accent-soft);
  text-align: right;
}

.odds-pill strong {
  display: block;
  color: var(--accent);
  font-size: 18px;
  line-height: 1;
}

.odds-pill span {
  color: #aab7ba;
  font-size: 11px;
}

.stats-strip {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
  margin-bottom: 14px;
}

.stats-strip span {
  min-width: 0;
  padding: 8px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.055);
  color: #aab7ba;
  font-size: 11px;
}

.stats-strip strong {
  display: block;
  color: #f7fbfc;
  font-size: 16px;
  line-height: 1.1;
}

.view-tabs {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
  padding: 4px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  margin-bottom: 10px;
  background: rgba(12, 16, 18, 0.42);
}

.seg-btn {
  min-width: 0;
  min-height: 30px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #95a5a6;
  cursor: pointer;
  font: inherit;
  font-size: 12px;
  font-weight: 700;
}

.seg-btn:hover,
.seg-btn.active {
  background: var(--accent-soft);
  color: #ffffff;
}

.control-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
  padding: 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  background: rgba(12, 16, 18, 0.28);
}

.sort-control {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 8px;
  align-items: center;
  min-width: 0;
  color: #95a5a6;
  font-size: 12px;
  font-weight: 700;
}

.sort-control select {
  width: 100%;
  min-height: 32px;
  border: 1px solid rgba(223, 230, 233, 0.16);
  border-radius: 8px;
  background: rgba(12, 16, 18, 0.68);
  color: #edf3f4;
  font: inherit;
  font-size: 13px;
}

.sort-control select:focus {
  border-color: var(--accent);
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-ring);
}

.compact-toggle {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 32px;
  padding: 0 9px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.055);
  color: #dfe6e9;
  cursor: pointer;
  font-size: 12px;
  font-weight: 700;
}

.sound-toggle {
  align-self: stretch;
}

.compact-toggle input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}

.toggle-box {
  width: 14px;
  height: 14px;
  border: 1px solid rgba(223, 230, 233, 0.34);
  border-radius: 4px;
  background: rgba(12, 16, 18, 0.68);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.08) inset;
}

.compact-toggle input:checked + .toggle-box {
  border-color: var(--accent-border);
  background: var(--accent);
}

.compact-toggle input:checked + .toggle-box::after {
  content: "";
  display: block;
  width: 7px;
  height: 4px;
  margin: 3px 0 0 3px;
  border: solid var(--accent-contrast);
  border-width: 0 0 2px 2px;
  transform: rotate(-45deg);
}

.compact-toggle input:focus-visible + .toggle-box {
  box-shadow: 0 0 0 3px var(--accent-ring);
}

.sound-slider {
  min-width: 0;
  width: 100%;
  accent-color: var(--accent);
}

.sound-slider:disabled {
  opacity: 0.45;
}

.input-group {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}

.name-input,
.search-input,
.bulk-editor textarea {
  width: 100%;
  border: 1px solid rgba(223, 230, 233, 0.18);
  border-radius: 8px;
  background: rgba(12, 16, 18, 0.68);
  color: #edf3f4;
  font: inherit;
}

.name-input {
  flex: 1;
  min-width: 0;
  padding: 11px 12px;
  font-size: 14px;
}

.name-input:focus,
.search-input:focus,
.bulk-editor textarea:focus {
  border-color: var(--accent);
  outline: none;
  box-shadow: 0 0 0 3px var(--accent-ring);
}

.btn {
  border: none;
  border-radius: 8px;
  cursor: pointer;
  font-weight: 700;
  font-size: 13px;
  transition: background 0.16s ease, border-color 0.16s ease, color 0.16s ease;
}

.btn:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.btn-add {
  padding: 10px 15px;
  background: var(--accent);
  color: var(--accent-contrast);
}

.btn-add:hover:not(:disabled) {
  background: var(--accent-hover);
}

.btn-compact {
  padding: 8px 12px;
}

.tool-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}

.btn-ghost {
  padding: 8px 10px;
  border: 1px solid rgba(255, 255, 255, 0.11);
  background: rgba(255, 255, 255, 0.055);
  color: #dfe6e9;
}

.btn-ghost:hover:not(:disabled),
.btn-ghost.active {
  border-color: var(--accent-border);
  background: var(--accent-soft);
  color: #ffffff;
}

.bulk-editor {
  margin-bottom: 12px;
}

.bulk-editor textarea {
  display: block;
  min-height: 92px;
  padding: 11px 12px;
  resize: vertical;
}

.bulk-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  color: #95a5a6;
  font-size: 12px;
}

.bulk-preview {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 8px;
}

.bulk-preview span {
  max-width: 100%;
  overflow: hidden;
  padding: 4px 7px;
  border: 1px solid var(--accent-border);
  border-radius: 8px;
  background: var(--accent-soft);
  color: var(--accent-text);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.copy-status,
.notice {
  margin: 0 0 10px;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 12px;
}

.copy-status {
  background: var(--accent-soft);
  color: var(--accent-text);
}

.undo-status {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.notice {
  background: rgba(255, 234, 167, 0.12);
  color: #ffeaa7;
}

.notice {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}

.notice span {
  min-width: 0;
}

.notice-action {
  flex: none;
  min-height: 26px;
  padding: 0 8px;
  border: 1px solid rgba(255, 234, 167, 0.28);
  border-radius: 6px;
  background: rgba(255, 234, 167, 0.12);
  color: #fff5bd;
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  font-weight: 800;
}

.notice-action:hover {
  background: rgba(255, 234, 167, 0.2);
}

.notice-action:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}

.search-box {
  position: relative;
  margin-bottom: 14px;
}

.search-input {
  padding: 10px 34px 10px 12px;
  font-size: 13px;
}

.clear-search {
  position: absolute;
  top: 50%;
  right: 8px;
  width: 24px;
  height: 24px;
  transform: translateY(-50%);
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #95a5a6;
  cursor: pointer;
  font-size: 18px;
  line-height: 20px;
}

.clear-search:hover {
  background: rgba(255, 255, 255, 0.09);
  color: #ffffff;
}

.participants {
  margin-top: 12px;
}

.section-heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

h3 {
  margin: 0;
  color: #aab7ba;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0;
  text-transform: uppercase;
}

.section-heading span {
  color: #758184;
  font-size: 11px;
}

ul,
ol {
  list-style: none;
  padding: 0;
  margin: 0;
}

.participant-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  min-height: 38px;
  padding: 8px 10px;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  margin-bottom: 6px;
  background: rgba(255, 255, 255, 0.055);
}

.participant-item.pinned {
  border-color: var(--accent-border);
  background:
    linear-gradient(90deg, var(--accent-soft), rgba(255, 255, 255, 0.055) 42%),
    rgba(255, 255, 255, 0.055);
}

.participant-item.weighted:not(.pinned) {
  border-color: rgba(255, 234, 167, 0.18);
}

.name-cell {
  display: flex;
  align-items: center;
  gap: 9px;
  flex: 1 1 auto;
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
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.22) inset;
  color: #162326;
  font-size: 11px;
  font-weight: 800;
  text-decoration: none;
}

.participant-item.picked {
  opacity: 0.7;
}

.participant-item.picked .name-text {
  text-decoration: line-through;
}

.row-tools {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
}

.mini-btn {
  min-width: 26px;
  min-height: 26px;
  padding: 0 7px;
  border: 1px solid rgba(255, 255, 255, 0.11);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.055);
  color: #dfe6e9;
  cursor: pointer;
  font: inherit;
  font-size: 11px;
  font-weight: 800;
}

.mini-btn[aria-pressed="true"] {
  border-color: var(--accent-border);
  background: var(--accent-soft);
  color: #ffffff;
}

.mini-btn:hover:not(:disabled),
.mini-btn.active {
  border-color: var(--accent-border);
  background: var(--accent-soft);
  color: #ffffff;
}

.mini-btn:disabled {
  cursor: not-allowed;
  opacity: 0.42;
}

.weight-pill {
  min-width: 30px;
  padding: 4px 6px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  background: rgba(12, 16, 18, 0.52);
  color: #aab7ba;
  font-size: 11px;
  font-weight: 800;
  text-align: center;
}

.participant-item.weighted .weight-pill {
  border-color: rgba(255, 234, 167, 0.24);
  color: #ffeaa7;
}

.name-list.compact .participant-item {
  min-height: 32px;
  padding: 5px 8px;
  margin-bottom: 4px;
}

.name-list.compact .identity-token {
  width: 20px;
  height: 20px;
  font-size: 10px;
}

.name-list.compact .participants {
  margin-top: 10px;
}

.name-list.compact .section-heading {
  margin-bottom: 6px;
}

/* Optimistic add: a settling skeleton chip that pulses until the server
   confirms, then reconciles into a normal row. */
.participant-item.pending {
  opacity: 0.5;
  animation: chip-pulse 1.1s ease-in-out infinite;
}

/* Failed add: shake briefly before the row is removed. */
.participant-item.error {
  color: #ff8a7f;
  background: rgba(231, 76, 60, 0.12);
  animation: chip-shake 0.4s ease-in-out;
}

.btn-remove {
  flex: none;
  width: 28px;
  height: 28px;
  padding: 0;
  background: transparent;
  color: #ff8a7f;
  font-size: 20px;
  line-height: 1;
}

.btn-remove:hover {
  background: rgba(231, 76, 60, 0.15);
}

.btn-remove:disabled {
  cursor: not-allowed;
  opacity: 0.35;
}

@keyframes chip-pulse {
  0%,
  100% {
    opacity: 0.5;
  }
  50% {
    opacity: 0.85;
  }
}

@keyframes chip-shake {
  0%,
  100% {
    transform: translateX(0);
  }
  20% {
    transform: translateX(-5px);
  }
  40% {
    transform: translateX(5px);
  }
  60% {
    transform: translateX(-3px);
  }
  80% {
    transform: translateX(3px);
  }
}

.empty {
  margin: 8px 0 0;
  color: #6f7b7e;
  font-size: 13px;
  font-style: italic;
}

.removed-list {
  padding-top: 14px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.replay-status {
  margin-top: 8px;
}

.btn-reset {
  width: 100%;
  margin-top: 10px;
  padding: 10px;
  border: 1px solid rgba(255, 234, 167, 0.28);
  background: rgba(255, 234, 167, 0.12);
  color: #ffeaa7;
}

.btn-reset:hover {
  background: rgba(255, 234, 167, 0.2);
}

.view-footnote {
  margin: 10px 0 0;
  color: #758184;
  font-size: 12px;
  text-align: right;
}

@media (max-width: 420px) {
  .stats-strip {
    grid-template-columns: repeat(2, 1fr);
  }

  .control-grid {
    grid-template-columns: 1fr;
  }

  .participant-item {
    flex-wrap: wrap;
  }

  .row-tools {
    order: 3;
    width: 100%;
    justify-content: flex-end;
  }
}
</style>
