<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'

export interface Command {
  id: string
  label: string
  hint?: string
  // Returning false keeps the palette open (e.g. an inline name entry that
  // wants another value); anything else closes it.
  run: () => void | boolean
  disabled?: boolean
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

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  const list = props.commands.filter((c) => !c.disabled)
  if (!q) return list
  return list.filter(
    (c) =>
      c.label.toLowerCase().includes(q) ||
      (c.hint ? c.hint.toLowerCase().includes(q) : false),
  )
})

// Reset to a clean state and focus the input each time the palette opens.
watch(
  () => props.open,
  (open) => {
    if (open) {
      query.value = ''
      activeIndex.value = 0
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
  const keepOpen = cmd.run()
  if (keepOpen !== false) emit('close')
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
        <input
          ref="inputRef"
          v-model="query"
          class="palette-input"
          type="text"
          placeholder="Type a command..."
          @keydown="onKeydown"
        />
        <ul class="palette-list">
          <li
            v-for="(cmd, i) in filtered"
            :key="cmd.id"
            class="palette-item"
            :class="{ active: i === activeIndex }"
            @mouseenter="activeIndex = i"
            @click="runActive"
          >
            <span class="palette-label">{{ cmd.label }}</span>
            <span v-if="cmd.hint" class="palette-hint">{{ cmd.hint }}</span>
          </li>
          <li v-if="filtered.length === 0" class="palette-empty">
            No matching commands
          </li>
        </ul>
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

.palette-list {
  list-style: none;
  margin: 0;
  padding: 6px;
  max-height: 320px;
  overflow-y: auto;
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

.palette-label {
  font-size: 15px;
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
</style>
