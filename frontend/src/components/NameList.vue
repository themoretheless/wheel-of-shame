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
}>()

const emit = defineEmits<{
  (e: 'add', name: string): void
  (e: 'add-batch', names: string[]): void
  (e: 'remove', id: string): void
  (e: 'reset'): void
}>()

const nameInput = ref('')
const searchQuery = ref('')
const bulkOpen = ref(false)
const bulkText = ref('')
const copyStatus = ref('')
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

function importBulk() {
  submitNames(parsedBulkNames.value)
  if (parsedBulkNames.value.length > 0) {
    bulkText.value = ''
    bulkOpen.value = false
  }
}

const totalCount = computed(() => props.active.length + props.removed.length)
const nextOdds = computed(() => {
  if (props.active.length === 0) return '0%'
  const odds = 100 / props.active.length
  return `${odds >= 10 ? Math.round(odds) : odds.toFixed(1)}%`
})

function participantMatches(p: Participant): boolean {
  const q = searchQuery.value.trim().toLocaleLowerCase()
  if (!q) return true
  return p.name.toLocaleLowerCase().includes(q)
}

const activeFiltered = computed(() => props.active.filter(participantMatches))
const removedFiltered = computed(() => props.removed.filter(participantMatches))

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
  <div class="name-list">
    <div class="roster-top">
      <div>
        <span class="panel-kicker">Roster</span>
        <h2>Participants</h2>
      </div>
      <div class="odds-pill">
        <strong>{{ nextOdds }}</strong>
        <span>next odds</span>
      </div>
    </div>

    <div class="stats-strip" aria-label="Roster status">
      <span><strong>{{ totalCount }}</strong>Total</span>
      <span><strong>{{ active.length }}</strong>Active</span>
      <span><strong>{{ removed.length }}</strong>Picked</span>
    </div>

    <div class="input-group">
      <input
        v-model="nameInput"
        @keyup.enter="addName"
        placeholder="Name, comma list, or pasted rows"
        class="name-input"
      />
      <button @click="addName" class="btn btn-add">Add</button>
    </div>

    <div class="tool-row">
      <button
        class="btn btn-ghost"
        :class="{ active: bulkOpen }"
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
    </div>

    <div v-if="bulkOpen" class="bulk-editor">
      <textarea
        v-model="bulkText"
        placeholder="Paste one name per line, or separate with commas"
        rows="4"
      ></textarea>
      <div class="bulk-footer">
        <span>{{ parsedBulkNames.length }} ready</span>
        <button class="btn btn-add btn-compact" :disabled="parsedBulkNames.length === 0" @click="importBulk">
          Import
        </button>
      </div>
    </div>

    <p v-if="copyStatus" class="copy-status" role="status">{{ copyStatus }}</p>

    <p v-if="duplicateNames.length > 0" class="notice">
      {{ duplicateNames.length }} duplicate name{{ duplicateNames.length === 1 ? '' : 's' }} in the roster
    </p>

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

    <div class="participants">
      <div class="section-heading">
        <h3>Active</h3>
        <span>{{ activeFiltered.length }} shown</span>
      </div>
      <ul v-if="activeFiltered.length > 0">
        <li
          v-for="p in activeFiltered"
          :key="p.id"
          class="participant-item"
          :class="{ pending: p.pending, error: p.error }"
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
            :aria-label="`Remove ${p.name}`"
          >
            &times;
          </button>
        </li>
      </ul>
      <p v-else class="empty">{{ active.length === 0 ? 'No participants yet' : 'No matches' }}</p>
    </div>

    <div v-if="removed.length > 0" class="participants removed-list">
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
        </li>
      </ol>
      <p v-else class="empty">No picked matches</p>
      <button @click="emit('reset')" class="btn btn-reset">Reset All</button>
    </div>
  </div>
</template>

<style scoped>
.name-list {
  width: 100%;
  color: #edf3f4;
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
  min-width: 82px;
  padding: 8px 10px;
  border: 1px solid rgba(78, 205, 196, 0.26);
  border-radius: 8px;
  background: rgba(78, 205, 196, 0.11);
  text-align: right;
}

.odds-pill strong {
  display: block;
  color: #4ecdc4;
  font-size: 18px;
  line-height: 1;
}

.odds-pill span {
  color: #aab7ba;
  font-size: 11px;
}

.stats-strip {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
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
  border-color: #4ecdc4;
  outline: none;
  box-shadow: 0 0 0 3px rgba(78, 205, 196, 0.16);
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
  background: #4ecdc4;
  color: #162326;
}

.btn-add:hover:not(:disabled) {
  background: #66ded6;
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
  border-color: rgba(78, 205, 196, 0.38);
  background: rgba(78, 205, 196, 0.14);
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

.copy-status,
.notice {
  margin: 0 0 10px;
  padding: 8px 10px;
  border-radius: 8px;
  font-size: 12px;
}

.copy-status {
  background: rgba(78, 205, 196, 0.14);
  color: #7ff5ec;
}

.notice {
  background: rgba(255, 234, 167, 0.12);
  color: #ffeaa7;
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

.name-cell {
  display: flex;
  align-items: center;
  gap: 9px;
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
</style>
