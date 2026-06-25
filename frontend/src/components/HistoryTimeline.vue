<script setup lang="ts">
import { ref, computed, watch } from 'vue'
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

watch(() => props.actions, () => {
  selectedIndex.value = -1
})
</script>

<template>
  <div class="history-timeline glass-panel" @mouseleave="onActionHover(null)">
    <h4>History (scrub to preview)</h4>
    <div class="timeline-list" @mousedown="onScrubStart" @mouseup="onScrubEnd">
      <div
        v-for="(action, index) in visibleActions"
        :key="action.id"
        class="timeline-item"
        :class="{ selected: index === selectedIndex }"
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
    <div class="hint">Cmd-Z for undo • hover for preview</div>
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