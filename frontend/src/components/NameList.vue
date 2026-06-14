<script setup lang="ts">
import { ref } from 'vue'
import type { Participant } from '../types'
import { identityColor } from '../utils/identity'

// First visible character, upper-cased, for the round identity token.
function initialOf(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase()
}

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
      <!-- Physical eject: when a name leaves the active list (picked by a spin
           or removed by hand) the row slides out and blurs away while the rows
           below slide up to fill the gap, instead of vanishing instantly. -->
      <TransitionGroup v-if="active.length > 0" tag="ul" name="eject">
        <li
          v-for="p in active"
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
          >
            &times;
          </button>
        </li>
      </TransitionGroup>
      <p v-else class="empty">No participants yet</p>
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

/* Positioning context so an ejecting row (position: absolute during its leave
   transition) is measured against the list, not the page. */
ul {
  position: relative;
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

.name-cell {
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
