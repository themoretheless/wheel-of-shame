<script setup lang="ts">
import { useToasts } from '../composables/useToasts'
import type { Toast } from '../composables/useToasts'

// Renders the shared toast queue as a bottom-right stack of glass pills. The
// queue lives in useToasts so WS handlers and App can push without prop-
// drilling; this component is the single sink, Teleported to body in App.vue.
const { toasts, dismiss } = useToasts()

// Take a toast's reverse action (e.g. "Undo"), then dismiss the toast. Stops
// propagation so the click doesn't also hit the container's dismiss handler.
function runAction(t: Toast) {
  t.action?.run()
  dismiss(t.id)
}
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
        <button
          v-if="t.action"
          type="button"
          class="toast-action"
          @click.stop="runAction(t)"
        >
          {{ t.action.label }}
        </button>
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

/* Reverse-action button (e.g. "Undo"), pushed to the toast's trailing edge and
   tinted with the same accent as the dot so it reads as the toast's own affordance. */
.toast-action {
  flex: 0 0 auto;
  margin-left: auto;
  padding: 4px 10px;
  border: 1px solid var(--toast-accent, #4ECDC4);
  border-radius: 7px;
  background: transparent;
  color: var(--toast-accent, #4ECDC4);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition:
    background 0.15s ease,
    color 0.15s ease;
}

.toast-action:hover {
  background: var(--toast-accent, #4ECDC4);
  color: #1a1a1a;
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

/* Connection-trouble accent: an amber pill for the sticky "reconnecting…" state,
   flipped to a success toast once the socket is back. */
.toast-warn {
  --toast-accent: #f1c40f;
}

/* A reconnecting toast pulses its dot so a persistent pill reads as live work in
   progress rather than a stuck notification. */
.toast-warn .toast-dot {
  animation: toast-dot-pulse 1.1s ease-in-out infinite;
}

@keyframes toast-dot-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}

@media (prefers-reduced-motion: reduce) {
  .toast-warn .toast-dot {
    animation: none;
  }
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
