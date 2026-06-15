<script setup lang="ts">
// A keyboard cheat-sheet, toggled with '?'. The rows mirror the handlers wired
// in App.vue's onGlobalKeydown so the sheet stays in sync with what the keys
// actually do; there is no separate source of truth to drift from.
interface Shortcut {
  keys: string[]
  label: string
}

defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()

const shortcuts: Shortcut[] = [
  { keys: ['Space'], label: 'Spin the wheel' },
  { keys: ['Tab'], label: 'Spotlight the next name on the wheel' },
  { keys: ['/'], label: 'Jump to the name field' },
  { keys: ['⌘', 'K'], label: 'Open command palette' },
  { keys: ['Esc'], label: 'Dismiss winner / close overlays' },
  { keys: ['?'], label: 'Toggle this cheat sheet' },
]
</script>

<template>
  <Teleport to="body">
    <div v-if="open" class="sheet-overlay" @click.self="emit('close')">
      <div class="sheet" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">
        <div class="sheet-head">
          <span class="sheet-title">Keyboard shortcuts</span>
          <button class="sheet-close" @click="emit('close')" aria-label="Close">
            <kbd class="sheet-kbd">Esc</kbd>
          </button>
        </div>
        <ul class="sheet-list">
          <li v-for="s in shortcuts" :key="s.label" class="sheet-row">
            <span class="sheet-label">{{ s.label }}</span>
            <span class="sheet-keys">
              <kbd v-for="k in s.keys" :key="k" class="sheet-kbd">{{ k }}</kbd>
            </span>
          </li>
        </ul>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.sheet-overlay {
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

.sheet {
  width: 100%;
  max-width: 420px;
  background: rgba(45, 52, 54, 0.85);
  backdrop-filter: blur(16px);
  border: 1px solid rgba(78, 205, 196, 0.35);
  border-radius: 14px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  overflow: hidden;
  animation: sheet-pop 0.18s ease-out;
}

@keyframes sheet-pop {
  from {
    transform: translateY(-8px) scale(0.98);
    opacity: 0;
  }
  to {
    transform: translateY(0) scale(1);
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .sheet {
    animation: none;
  }
}

.sheet-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.sheet-title {
  color: #dfe6e9;
  font-size: 15px;
  font-weight: 600;
}

.sheet-close {
  display: inline-flex;
  align-items: center;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
}

.sheet-list {
  list-style: none;
  margin: 0;
  padding: 8px;
}

.sheet-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 11px 10px;
  border-radius: 8px;
}

.sheet-row:hover {
  background: rgba(255, 255, 255, 0.04);
}

.sheet-label {
  color: #dfe6e9;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sheet-keys {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
}

.sheet-kbd {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  padding: 2px 7px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.06);
  color: #dfe6e9;
  font-size: 12px;
  line-height: 1.4;
}
</style>
