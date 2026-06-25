<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import type { Action } from '../types'

const props = defineProps<{
  actions: Action[]
  sessionId: string
}>()

const emit = defineEmits<{
  (e: 'restore', actionId: string): void
  (e: 'preview', actionId: string | null): void
}>()

const selectedIndex = ref(-1)
const isScrubbing = ref(false)
const listRef = ref<HTMLElement | null>(null)

const visibleActions = computed(() => props.actions.slice().reverse()) // newest first for display

function selectAction(index: number) {
  selectedIndex.value = index
  const action = visibleActions.value[index]
  if (action) {
    emit('preview', action.id)
  }
}

function commitRestore() {
  if (selectedIndex.value >= 0) {
    const action = visibleActions.value[selectedIndex.value]
    if (action) {
      emit('restore', action.id)
    }
  }
  isScrubbing.value = false
  emit('preview', null)
}

function onScrubStart() {
  isScrubbing.value = true
}

function onScrubEnd() {
  if (isScrubbing.value) {
    commitRestore()
  }
}

function formatAction(action: Action) {
  const kind = action.kind as { type?: string; payload?: any }
  const type = kind.type || 'unknown'
  const payload = kind.payload || {}
  let label = type
  if (type === 'Spin') label = `Spin: ${payload.picked_id?.slice(0,8) || ''}`
  else if (type === 'UpdateWeight') label = `Weight ${payload.id?.slice(0,8)} = ${payload.weight}`
  else if (type === 'UpdateVisual') label = `Visual for ${payload.id?.slice(0,8)}`
  else if (type === 'Add') label = `Add ${payload.name}`
  else if (type === 'Remove') label = `Remove ${payload.id?.slice(0,8)}`
  return `${new Date(action.timestamp).toLocaleTimeString()} - ${label}`
}

// Live preview on hover/scrub
function onActionHover(actionId: string | null) {
  emit('preview', actionId)
}

// Keep the keyboard-selected row in view as j/k walk a long history.
function scrollSelectedIntoView() {
  nextTick(() => {
    const el = listRef.value?.querySelector<HTMLElement>(
      `[data-idx="${selectedIndex.value}"]`,
    )
    el?.scrollIntoView({ block: 'nearest' })
  })
}

// j/k (or arrows) rove the history, each step ghost-previewing that snapshot via
// the same preview emit hover uses; Enter commits the restore, Escape clears the
// preview. stopPropagation keeps these keys from reaching the global hotkeys.
function onListKeydown(e: KeyboardEvent) {
  const len = visibleActions.value.length
  if (!len) return
  if (e.key === 'j' || e.key === 'ArrowDown') {
    e.preventDefault()
    e.stopPropagation()
    const next = selectedIndex.value < 0 ? 0 : Math.min(selectedIndex.value + 1, len - 1)
    selectAction(next)
    scrollSelectedIntoView()
  } else if (e.key === 'k' || e.key === 'ArrowUp') {
    e.preventDefault()
    e.stopPropagation()
    const next = selectedIndex.value < 0 ? 0 : Math.max(selectedIndex.value - 1, 0)
    selectAction(next)
    scrollSelectedIntoView()
  } else if (e.key === 'Enter') {
    e.preventDefault()
    e.stopPropagation()
    commitRestore()
  } else if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    selectedIndex.value = -1
    emit('preview', null)
  }
}

watch(() => props.actions, () => {
  selectedIndex.value = -1
})
</script>

<template>
  <div class="history-timeline glass-panel" @mouseleave="onActionHover(null)">
    <h4>History (scrub to preview)</h4>
    <div
      ref="listRef"
      class="timeline-list"
      tabindex="0"
      role="listbox"
      aria-label="History snapshots, j/k to scrub, Enter to restore"
      @mousedown="onScrubStart"
      @mouseup="onScrubEnd"
      @keydown="onListKeydown"
    >
      <div
        v-for="(action, index) in visibleActions"
        :key="action.id"
        class="timeline-item"
        :class="{ selected: index === selectedIndex }"
        :data-idx="index"
        role="option"
        :aria-selected="index === selectedIndex"
        @click="selectAction(index)"
        @mouseenter="onActionHover(action.id)"
      >
        {{ formatAction(action) }}
      </div>
    </div>
    <div v-if="selectedIndex >= 0" class="controls">
      <button @click="commitRestore" class="btn">Restore</button>
      <button @click="() => { selectedIndex = -1; onActionHover(null) }" class="btn">Cancel</button>
    </div>
    <div class="hint">Cmd-Z undo • hover or <kbd>j</kbd>/<kbd>k</kbd> preview • <kbd>Enter</kbd> restore</div>
  </div>
</template>

<style scoped>
.glass-panel {
  position: absolute;
  left: 12px;
  bottom: 80px;
  width: 280px;
  background: rgba(30, 30, 30, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  padding: 12px;
  font-size: 11px;
  color: #dfe6e9;
  z-index: 30;
  max-height: 200px;
  overflow: auto;
}
.timeline-list {
  max-height: 140px;
  overflow-y: auto;
}
.timeline-item {
  padding: 4px 6px;
  cursor: pointer;
  border-radius: 4px;
}
.timeline-item:hover {
  background: rgba(255,255,255,0.1);
}
.timeline-item.selected {
  background: rgba(78, 205, 196, 0.2);
  border-left: 2px solid #4ECDC4;
}
.controls {
  margin-top: 8px;
  display: flex;
  gap: 6px;
}
.hint {
  font-size: 9px;
  opacity: 0.6;
  margin-top: 4px;
}
</style>