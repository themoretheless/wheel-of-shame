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
  position: relative;
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
  /* Pop-and-settle: an overshoot past 1 then a magnetic snap back to rest. */
  animation: pop-settle 0.52s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}

/* One-shot gradient sweep tinted to the winner's identity color, sliding
   across the card once as it lands. Lives above the content but ignores
   pointer events so the Continue button stays clickable. */
.lower-third::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(
    105deg,
    transparent 35%,
    color-mix(in srgb, var(--accent) 45%, transparent) 50%,
    transparent 65%
  );
  transform: translateX(-120%);
  animation: accent-sweep 0.7s ease-out 0.18s both;
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

@keyframes pop-settle {
  0% {
    transform: translateY(28px) scale(0.94);
    opacity: 0;
  }
  60% {
    opacity: 1;
  }
  100% {
    transform: translateY(0) scale(1);
    opacity: 1;
  }
}

@keyframes accent-sweep {
  to {
    transform: translateX(120%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .lower-third {
    animation: fade-in 0.2s ease both;
  }

  .lower-third::after {
    display: none;
  }

  @keyframes fade-in {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
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
