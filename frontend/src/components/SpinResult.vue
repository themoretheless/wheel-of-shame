<script setup lang="ts">
defineProps<{
  name: string
  remaining: number
  color: string
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()
</script>

<template>
  <div class="lower-third-wrap" @click.self="emit('close')">
    <div class="lower-third" :style="{ '--accent': color }">
      <div class="accent-bar"></div>
      <div class="info">
        <span class="eyebrow">Winner</span>
        <h2>{{ name }}</h2>
        <p class="remaining">{{ remaining }} remaining</p>
      </div>
      <button @click="emit('close')" class="btn-close">Continue</button>
    </div>
  </div>
</template>

<style scoped>
.lower-third-wrap {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: flex-end;
  justify-content: center;
  padding: 0 0 8vh;
  pointer-events: auto;
}

.lower-third {
  display: flex;
  align-items: center;
  gap: 20px;
  background: rgba(30, 30, 30, 0.82);
  border-radius: 12px;
  padding: 20px 28px 20px 0;
  min-width: 360px;
  max-width: min(90vw, 640px);
  backdrop-filter: blur(8px);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.45);
  overflow: hidden;
  animation: slide-up 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

.accent-bar {
  flex: 0 0 6px;
  align-self: stretch;
  background: var(--accent);
  box-shadow: 0 0 16px var(--accent);
}

.info {
  flex: 1 1 auto;
  min-width: 0;
}

.eyebrow {
  display: block;
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--accent);
  font-weight: 700;
  margin-bottom: 2px;
}

@keyframes slide-up {
  from {
    transform: translateY(24px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

h2 {
  font-size: 30px;
  color: #f5f6fa;
  margin: 0;
  line-height: 1.1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.remaining {
  color: #95a5a6;
  font-size: 13px;
  margin: 4px 0 0;
}

.btn-close {
  flex: 0 0 auto;
  padding: 12px 28px;
  border: none;
  border-radius: 8px;
  background: var(--accent);
  color: #1e1e1e;
  font-weight: bold;
  font-size: 15px;
  cursor: pointer;
}

.btn-close:hover {
  filter: brightness(1.08);
}
</style>
