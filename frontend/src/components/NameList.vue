<script setup lang="ts">
import { ref } from 'vue'
import type { Participant } from '../types'

defineProps<{
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
      <ul v-if="active.length > 0">
        <li v-for="p in active" :key="p.id" class="participant-item">
          <span>{{ p.name }}</span>
          <button @click="emit('remove', p.id)" class="btn btn-remove" title="Remove">
            &times;
          </button>
        </li>
      </ul>
      <p v-else class="empty">No participants yet</p>
    </div>

    <div v-if="removed.length > 0" class="participants removed-list">
      <h3>Picked ({{ removed.length }})</h3>
      <ol>
        <li v-for="p in removed" :key="p.id" class="participant-item picked">
          <span>#{{ p.spin_order }} — {{ p.name }}</span>
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

ol {
  list-style: none;
}

.participant-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 12px;
  border-radius: 6px;
  margin-bottom: 4px;
  background: rgba(255, 255, 255, 0.05);
}

.participant-item.picked {
  opacity: 0.6;
  text-decoration: line-through;
}

.empty {
  color: #636e72;
  font-style: italic;
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
