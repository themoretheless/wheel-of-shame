<script setup lang="ts">
import { useToasts } from '../composables/useToasts'

// Renders the shared toast queue as a bottom-right stack of glass pills. The
// queue lives in useToasts so WS handlers and App can push without prop-
// drilling; this component is the single sink, Teleported to body in App.vue.
const { toasts, dismiss } = useToasts()
</script>

<template>
  <div class="toast-stack" aria-live="polite" role="status">
    <TransitionGroup name="toast">
      <div
        v-for="t in toasts"
        :key="t.id"
        class="toast"
        :class="'toast-' + t.kind"
        :style="t.accent ? { '--toast-accent': t.accent } : undefined"
        @click="dismiss(t.id)"
      >
        <span class="toast-dot" aria-hidden="true"></span>
        <span class="toast-msg">{{ t.message }}</span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toast-stack {
  position: fixed;
  bottom: 20px;
  right: 20px;
  z-index: 9998;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-end;
  pointer-events: none;
}

.toast {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: 10px;
  max-width: 320px;
  padding: 10px 14px;
  border-radius: 10px;
  background: rgba(30, 30, 30, 0.82);
  backdrop-filter: blur(8px);
  border-left: 3px solid var(--toast-accent, #4ECDC4);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  cursor: pointer;
}

.toast-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--toast-accent, #4ECDC4);
  box-shadow: 0 0 8px var(--toast-accent, #4ECDC4);
}

.toast-msg {
  font-size: 13px;
  color: #dfe6e9;
  line-height: 1.3;
}

.toast-success {
  --toast-accent: #4ECDC4;
}

.toast-info {
  --toast-accent: #95a5a6;
}

.toast-info .toast-dot {
  box-shadow: none;
}

/* Slide-and-fade in from the right, collapse out; the move transition closes the
   gap when an earlier toast in the stack is dismissed. */
.toast-enter-active,
.toast-leave-active {
  transition:
    opacity 0.25s ease,
    transform 0.25s cubic-bezier(0.34, 1.2, 0.64, 1);
}

.toast-move {
  transition: transform 0.25s ease;
}

.toast-enter-from {
  opacity: 0;
  transform: translateX(24px);
}

.toast-leave-active {
  position: absolute;
}

.toast-leave-to {
  opacity: 0;
  transform: translateX(24px);
}

@media (prefers-reduced-motion: reduce) {
  .toast-enter-active,
  .toast-leave-active,
  .toast-move {
    transition: opacity 0.2s ease;
  }

  .toast-enter-from,
  .toast-leave-to {
    transform: none;
  }
}

@media (max-width: 700px) {
  .toast-stack {
    /* Sit above the bottom roster sheet on narrow viewports. */
    bottom: calc(50vh + 12px);
    left: 12px;
    right: 12px;
    align-items: stretch;
  }

  .toast {
    max-width: none;
  }
}
</style>
