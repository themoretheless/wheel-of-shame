<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'

// An inline value-entry mode: when present, activating the command swaps the
// command list for a single text field (Raycast-style) instead of running
// immediately. submit() receives the typed value; returning false keeps the
// field open for another entry, anything else closes the palette.
export interface CommandInline {
  placeholder: string
  submit: (value: string) => void | boolean
}

export interface Command {
  id: string
  label: string
  hint?: string
  // A secondary line under the label (e.g. a participant's win odds).
  subtitle?: string
  // A section label (e.g. 'Actions' / 'Eliminate'); commands sharing one get a
  // sticky group header above the first row of that group.
  group?: string
  // Returning false keeps the palette open (e.g. an inline name entry that
  // wants another value); anything else closes it.
  run: () => void | boolean
  // When set, the command opens an inline input instead of running on Enter.
  inline?: CommandInline
  disabled?: boolean
}

// Subsequence fuzzy match: every query char must appear in order. Returns a
// score (higher is better) or -1 when there's no match. Consecutive hits and
// matches at a word boundary are rewarded so close labels rank first.
function fuzzyScore(text: string, query: string): number {
  let score = 0
  let ti = 0
  let prevMatch = -2
  for (let qi = 0; qi < query.length; qi++) {
    const qc = query[qi]
    let found = -1
    for (; ti < text.length; ti++) {
      if (text[ti] === qc) {
        found = ti
        break
      }
    }
    if (found === -1) return -1
    score += 1
    if (found === prevMatch + 1) score += 2
    if (found === 0 || text[found - 1] === ' ') score += 2
    prevMatch = found
    ti = found + 1
  }
  return score
}

// Frecency: a per-command {count, lastUsed} map persisted to localStorage and
// updated each time a command runs. It powers two things: a tiebreaker so that,
// among equal fuzzy scores, the commands you reach for most float up; and, with
// an empty query, a 'Recent' group of your habitual commands above the rest.
const FRECENCY_KEY = 'wheel-palette-frecency'
interface FrecencyEntry {
  count: number
  lastUsed: number
}
function loadFrecency(): Record<string, FrecencyEntry> {
  try {
    if (typeof localStorage === 'undefined') return {}
    const raw = localStorage.getItem(FRECENCY_KEY)
    const parsed = raw ? JSON.parse(raw) : {}
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
// Recency half-life in milliseconds: a command's recency weight halves once a
// day passes since its last use, so yesterday's habit yields to today's.
const FRECENCY_HALFLIFE = 24 * 60 * 60 * 1000
function frecencyScore(entry: FrecencyEntry | undefined): number {
  if (!entry) return 0
  const age = Date.now() - entry.lastUsed
  const recency = Math.pow(0.5, Math.max(0, age) / FRECENCY_HALFLIFE)
  return entry.count * (0.5 + recency)
}

const props = defineProps<{
  open: boolean
  commands: Command[]
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const query = ref('')
const activeIndex = ref(0)
const inputRef = ref<HTMLInputElement | null>(null)
const frecency = ref<Record<string, FrecencyEntry>>(loadFrecency())

// Bump a command's frecency on use and persist. Called from both the regular
// run path and the inline-submit path so inline commands count too.
function recordUse(id: string) {
  const prev = frecency.value[id]
  frecency.value = {
    ...frecency.value,
    [id]: { count: (prev?.count ?? 0) + 1, lastUsed: Date.now() },
  }
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(FRECENCY_KEY, JSON.stringify(frecency.value))
    }
  } catch {
    // Persistence is best-effort; an exception (quota/private mode) is non-fatal.
  }
}

// The command currently in inline-entry mode, plus its field value. When set,
// the list is replaced by a single text input bound to inlineValue.
const inlineCommand = ref<Command | null>(null)
const inlineValue = ref('')
const inlineInputRef = ref<HTMLInputElement | null>(null)

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  const list = props.commands.filter((c) => !c.disabled)
  if (!q) {
    // No query: keep the declared order but lift commands with frecency history
    // to the top (most-frecent first), so habitual actions are one Enter away.
    const ranked = list
      .map((c, i) => ({ c, i, fr: frecencyScore(frecency.value[c.id]) }))
      .sort((a, b) => (b.fr - a.fr) || (a.i - b.i))
    return ranked.map((entry) => entry.c)
  }
  // Fuzzy-match against the best of label/hint/subtitle, then rank by score so
  // the closest command floats to the top regardless of source field, breaking
  // ties by frecency so the command you pick most among equals wins.
  return list
    .map((c) => {
      const fields = [c.label, c.hint, c.subtitle].filter(Boolean) as string[]
      const score = Math.max(...fields.map((f) => fuzzyScore(f.toLowerCase(), q)))
      return { c, score, fr: frecencyScore(frecency.value[c.id]) }
    })
    .filter((entry) => entry.score >= 0)
    .sort((a, b) => (b.score - a.score) || (b.fr - a.fr))
    .map((entry) => entry.c)
})

// The command under the highlight, surfaced in the footer's action hint.
const activeCommand = computed(() => filtered.value[activeIndex.value] ?? null)

// Pair each filtered command with the group header to show above it: a label is
// rendered only when the command's effective group differs from the previous
// visible row, so contiguous groups get a single sticky separator (and ungrouped
// rows none). With an empty query, commands that have frecency history are shown
// under a leading 'Recent' group regardless of their declared group.
const rows = computed(() => {
  const showRecent = query.value.trim() === ''
  let prevGroup: string | undefined
  return filtered.value.map((c) => {
    const group =
      showRecent && frecencyScore(frecency.value[c.id]) > 0 ? 'Recent' : c.group
    const header = group && group !== prevGroup ? group : null
    prevGroup = group
    return { c, header }
  })
})

// Reset to a clean state and focus the input each time the palette opens.
watch(
  () => props.open,
  (open) => {
    if (open) {
      query.value = ''
      activeIndex.value = 0
      inlineCommand.value = null
      inlineValue.value = ''
      void nextTick(() => inputRef.value?.focus())
    }
  },
)

// Keep the highlighted row in range as the filtered set shrinks while typing.
watch(filtered, (list) => {
  if (activeIndex.value >= list.length) {
    activeIndex.value = Math.max(0, list.length - 1)
  }
})

function runActive() {
  const cmd = filtered.value[activeIndex.value]
  if (!cmd) return
  // Commands with an inline config swap the list for a single field instead of
  // running straight away.
  if (cmd.inline) {
    inlineCommand.value = cmd
    inlineValue.value = ''
    void nextTick(() => inlineInputRef.value?.focus())
    return
  }
  recordUse(cmd.id)
  const keepOpen = cmd.run()
  if (keepOpen !== false) emit('close')
}

function submitInline() {
  const cmd = inlineCommand.value
  if (!cmd?.inline) return
  const value = inlineValue.value.trim()
  if (!value) return
  recordUse(cmd.id)
  const keepOpen = cmd.inline.submit(value)
  if (keepOpen === false) {
    // Stay in inline mode for another entry (e.g. adding several names).
    inlineValue.value = ''
    void nextTick(() => inlineInputRef.value?.focus())
    return
  }
  emit('close')
}

// Leave inline mode and return focus to the command list's search field.
function cancelInline() {
  inlineCommand.value = null
  inlineValue.value = ''
  void nextTick(() => inputRef.value?.focus())
}

function onInlineKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter') {
    e.preventDefault()
    submitInline()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    cancelInline()
  }
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (filtered.value.length) {
      activeIndex.value = (activeIndex.value + 1) % filtered.value.length
    }
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (filtered.value.length) {
      activeIndex.value =
        (activeIndex.value - 1 + filtered.value.length) % filtered.value.length
    }
  } else if (e.key === 'Enter') {
    e.preventDefault()
    runActive()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="palette-overlay" @click.self="emit('close')">
      <div class="palette" role="dialog" aria-modal="true">
        <!-- Inline value-entry mode: a single field replaces the command list,
             with the originating command's label as a breadcrumb. -->
        <template v-if="inlineCommand">
          <div class="palette-inline-bar">
            <button class="palette-inline-back" @click="cancelInline" aria-label="Back to commands">
              {{ inlineCommand.label }}
            </button>
            <input
              ref="inlineInputRef"
              v-model="inlineValue"
              class="palette-input palette-inline-input"
              type="text"
              :placeholder="inlineCommand.inline?.placeholder"
              @keydown="onInlineKeydown"
            />
          </div>
          <ul class="palette-list">
            <li class="palette-item active" @click="submitInline">
              <span class="palette-text">
                <span class="palette-label">
                  {{ inlineValue.trim() ? `Confirm "${inlineValue.trim()}"` : 'Type a value...' }}
                </span>
              </span>
              <span class="palette-hint">Enter</span>
            </li>
          </ul>
        </template>
        <template v-else>
          <input
            ref="inputRef"
            v-model="query"
            class="palette-input"
            type="text"
            placeholder="Type a command..."
            @keydown="onKeydown"
          />
          <ul class="palette-list">
            <template v-for="(row, i) in rows" :key="row.c.id">
              <li v-if="row.header" class="palette-group">{{ row.header }}</li>
              <li
                class="palette-item"
                :class="{ active: i === activeIndex }"
                @mouseenter="activeIndex = i"
                @click="runActive"
              >
                <span class="palette-text">
                  <span class="palette-label">{{ row.c.label }}</span>
                  <span v-if="row.c.subtitle" class="palette-subtitle">{{ row.c.subtitle }}</span>
                </span>
                <span v-if="row.c.hint" class="palette-hint">{{ row.c.hint }}</span>
              </li>
            </template>
            <li v-if="filtered.length === 0" class="palette-empty">
              No matching commands
            </li>
          </ul>
          <!-- Raycast-style footer: echoes the highlighted command and the key
               that runs it, so the primary action is always visible. -->
          <div v-if="activeCommand" class="palette-footer">
            <span class="palette-footer-label">{{ activeCommand.label }}</span>
            <span class="palette-footer-action">
              {{ activeCommand.inline ? 'Continue' : 'Run' }}
              <kbd class="palette-kbd">↵</kbd>
            </span>
          </div>
        </template>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.palette-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(4px);
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding-top: 15vh;
  z-index: 10000;
  pointer-events: auto;
}

.palette {
  width: 100%;
  max-width: 520px;
  background: rgba(45, 52, 54, 0.85);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(78, 205, 196, 0.35);
  border-radius: 14px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  overflow: hidden;
  animation: palette-pop 0.18s ease-out;
}

@keyframes palette-pop {
  from {
    transform: translateY(-8px) scale(0.98);
    opacity: 0;
  }
  to {
    transform: translateY(0) scale(1);
    opacity: 1;
  }
}

.palette-input {
  width: 100%;
  box-sizing: border-box;
  padding: 18px 20px;
  border: none;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  background: transparent;
  color: #dfe6e9;
  font-size: 17px;
  outline: none;
}

.palette-input::placeholder {
  color: #636e72;
}

/* Inline-entry header: a breadcrumb chip for the originating command sits to the
   left of the value field, sharing the input's bottom border. */
.palette-inline-bar {
  display: flex;
  align-items: stretch;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.palette-inline-back {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  margin: 10px 0 10px 12px;
  padding: 0 12px;
  border: none;
  border-radius: 8px;
  background: rgba(78, 205, 196, 0.18);
  color: #4ECDC4;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}

.palette-inline-back:hover {
  background: rgba(78, 205, 196, 0.28);
}

.palette-inline-input {
  border-bottom: none;
  flex: 1 1 auto;
  min-width: 0;
}

.palette-list {
  list-style: none;
  margin: 0;
  padding: 6px;
  max-height: 320px;
  overflow-y: auto;
}

/* Sticky section header that rides the top of the scroll area as its group
   scrolls past, grouping commands the way Raycast does. */
.palette-group {
  position: sticky;
  top: 0;
  padding: 8px 14px 4px;
  background: rgba(45, 52, 54, 0.92);
  color: #8d9aa1;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  z-index: 1;
}

.palette-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 11px 14px;
  border-radius: 8px;
  cursor: pointer;
  color: #dfe6e9;
}

.palette-item.active {
  background: rgba(78, 205, 196, 0.18);
}

.palette-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.palette-label {
  font-size: 15px;
}

.palette-subtitle {
  font-size: 12px;
  color: #8d9aa1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.palette-hint {
  font-size: 12px;
  color: #b2bec3;
  white-space: nowrap;
}

.palette-empty {
  padding: 14px;
  text-align: center;
  color: #636e72;
  font-size: 14px;
}

/* Footer action bar pinned below the list, mirroring the highlighted row's
   primary action and the key that fires it. */
.palette-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 9px 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
}

.palette-footer-label {
  font-size: 12px;
  color: #b2bec3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.palette-footer-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex: 0 0 auto;
  font-size: 12px;
  color: #8d9aa1;
  white-space: nowrap;
}

.palette-kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  padding: 1px 5px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.06);
  color: #dfe6e9;
  font-size: 12px;
  line-height: 1.3;
}
</style>
