<script setup lang="ts">
import { ref } from 'vue'
import type { Participant } from '../types'
import { identityColor } from '../utils/identity'

const props = defineProps<{
  selected: Participant | null
}>()

const emit = defineEmits<{
  (e: 'update-weight', id: string, weight: number): void
  (e: 'preview-weight', id: string, weight: number): void
  (e: 'update-visual', id: string, visual: any): void
  (e: 'add-comment', id: string, text: string): void
}>()

const commentText = ref('')

function onWeightInput(v: Event) {
  const val = parseFloat((v.target as HTMLInputElement).value)
  if (props.selected && !isNaN(val)) {
    // Live preview during drag (no commit yet)
    emit('preview-weight', props.selected.id, Math.max(0.1, Math.min(10, val)))
  }
}

function commitWeight(v: Event) {
  if (props.selected) {
    const val = parseFloat((v.target as HTMLInputElement).value)
    if (!isNaN(val)) {
      emit('update-weight', props.selected.id, Math.max(0.1, Math.min(10, val)))
    }
  }
}

function adjustWeight(delta: number) {
  if (props.selected) {
    const current = props.selected.weight ?? 1
    const next = Math.max(0.1, Math.min(10, current + delta))
    emit('update-weight', props.selected.id, next)
  }
}

function submitComment() {
  if (props.selected && commentText.value.trim()) {
    emit('add-comment', props.selected.id, commentText.value)
    commentText.value = ''
  }
}
</script>

<template>
  <div v-if="selected" class="inspector glass-panel">
    <div class="inspector-header">
      <span class="name">{{ selected.name }}</span>
      <span class="hint">{{ ((selected.weight ?? 1)).toFixed(1) }}x</span>
    </div>

    <label class="label">Bias / Weight (0.1–10)</label>
    <div class="weight-row">
      <input
        type="range"
        min="0.1"
        max="10"
        step="0.1"
        :value="selected.weight ?? 1"
        @input="onWeightInput"
        @change="commitWeight"
        @keyup.enter="commitWeight"
        @pointerup="commitWeight"
      />
      <button @click="adjustWeight(-0.5)" class="btn-small" title="Decrease bias">−</button>
      <button @click="adjustWeight(0.5)" class="btn-small" title="Increase bias">+</button>
    </div>

    <!-- v1 minimal: color/icon future -->
    <div class="inspector-footer">
      <button @click="emit('update-visual', selected.id, { color_override: identityColor(selected.name) })" class="btn-small">
        Reset color
      </button>
      <span class="kbd-hint">Tab to focus • Enter commit</span>
    </div>

    <!-- Mini comments (top-100 poured) -->
    <div class="comment-section">
      <input v-model="commentText" @keyup.enter="submitComment" placeholder="Add comment..." class="comment-input" />
      <button @click="submitComment" class="btn-small">Add</button>
    </div>
  </div>
</template>

<style scoped>
.glass-panel {
  position: absolute;
  right: 12px;
  bottom: 80px;
  width: 260px;
  background: rgba(30, 30, 30, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  padding: 12px 14px;
  font-size: 12px;
  color: #dfe6e9;
  backdrop-filter: blur(8px);
  z-index: 30;
  box-shadow: 0 4px 20px rgba(0,0,0,0.4);
}
.inspector-header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 8px;
  font-weight: 600;
}
.label {
  display: block;
  font-size: 10px;
  opacity: 0.7;
  margin-bottom: 4px;
}
.weight-row {
  display: flex;
  align-items: center;
  gap: 6px;
}
input[type="range"] {
  flex: 1;
}
.btn-small {
  font-size: 10px;
  padding: 2px 6px;
}
.inspector-footer {
  margin-top: 8px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 10px;
  opacity: 0.6;
}
.comment-section {
  margin-top: 8px;
  display: flex;
  gap: 4px;
}
.comment-input {
  flex: 1;
  font-size: 10px;
  padding: 2px 4px;
  background: #222;
  border: 1px solid #444;
  color: #ddd;
}
</style>
