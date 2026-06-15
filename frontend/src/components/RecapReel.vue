<script setup lang="ts">
import { computed } from 'vue'
import type { Participant } from '../types'
import { identityColor } from '../utils/identity'
import { buildRecapSummary } from '../utils/recap'

// Curtain-call recap: once the wheel is down to its last name, replay the full
// run of the night as a stacked reel. Each picked row is read straight from
// removedParticipants (already sorted by spin_order) and gets a per-row accent
// sweep tinted to its identity color, the same flourish SpinResult.vue lands on.
const props = defineProps<{
  // Session title, used as the heading of the copyable run summary.
  title: string
  // Everyone eliminated over the session, in spin order (earliest first).
  picked: Participant[]
  // The lone name left on the wheel — the one who survived to the end.
  survivor: Participant | null
}>()

const emit = defineEmits<{
  (e: 'close'): void
  // Hands the assembled plain-text run summary to the parent, which owns the
  // clipboard write and result toast (mirroring App.vue's copyLink flow).
  (e: 'copy', summary: string): void
}>()

// Assemble the shareable run summary on demand and hand it up for copying.
function copySummary() {
  emit('copy', buildRecapSummary(props.title, props.picked, props.survivor))
}

function initialOf(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase()
}

const survivorColor = computed(() =>
  props.survivor ? identityColor(props.survivor.name) : '#4ECDC4',
)
</script>

<template>
  <div class="recap-wrap" @click.self="emit('close')">
    <div class="recap" :style="{ '--accent': survivorColor }">
      <header class="recap-head">
        <span class="eyebrow">Curtain call</span>
        <h2 v-if="survivor">{{ survivor.name }} survives</h2>
        <h2 v-else>That's a wrap</h2>
        <p class="recap-sub">{{ picked.length }} off the wheel, in order</p>
      </header>

      <ol class="reel">
        <li
          v-for="(p, i) in picked"
          :key="p.id"
          class="reel-row"
          :style="{
            '--row-accent': identityColor(p.name),
            '--row-delay': i * 0.06 + 's',
          }"
        >
          <span class="reel-rank">#{{ p.spin_order ?? i + 1 }}</span>
          <span class="reel-token" :style="{ background: identityColor(p.name) }">{{
            initialOf(p.name)
          }}</span>
          <span class="reel-name">{{ p.name }}</span>
        </li>
      </ol>

      <div class="recap-actions">
        <button @click="copySummary" class="btn-copy" title="Copy run summary">
          Copy summary
        </button>
        <button @click="emit('close')" class="btn-close">Done</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.recap-wrap {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6vh 16px;
  pointer-events: auto;
}

.recap {
  position: relative;
  display: flex;
  flex-direction: column;
  width: min(92vw, 420px);
  max-height: 88vh;
  background: rgba(30, 30, 30, 0.9);
  border-radius: 16px;
  padding: 24px;
  backdrop-filter: blur(10px);
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  box-sizing: border-box;
  /* Same pop-and-settle the winner lower-third lands on, scaled up a touch. */
  animation: recap-pop 0.52s cubic-bezier(0.34, 1.56, 0.64, 1) both;
}

.recap-head {
  margin-bottom: 16px;
}

.eyebrow {
  display: block;
  font-size: 11px;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--accent);
  font-weight: 700;
  margin-bottom: 4px;
}

h2 {
  margin: 0;
  font-size: 26px;
  line-height: 1.1;
  color: #f5f6fa;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recap-sub {
  margin: 4px 0 0;
  font-size: 13px;
  color: #95a5a6;
}

.reel {
  list-style: none;
  margin: 0 0 18px;
  padding: 0;
  overflow-y: auto;
  /* Hold the long-roster case to a scroll without blowing past the card. */
  min-height: 0;
}

.reel-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 8px;
  margin-bottom: 4px;
  background: rgba(255, 255, 255, 0.05);
  box-shadow: inset 3px 0 0 var(--row-accent);
  overflow: hidden;
}

/* Per-row accent sweep tinted to the eliminated name's identity color, sliding
   across once on entry, staggered by --row-delay. Mirrors SpinResult.vue's
   accent-sweep flourish. */
.reel-row::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
  background: linear-gradient(
    105deg,
    transparent 35%,
    color-mix(in srgb, var(--row-accent) 40%, transparent) 50%,
    transparent 65%
  );
  transform: translateX(-120%);
  animation: reel-sweep 0.7s ease-out var(--row-delay, 0s) both;
}

.reel-rank {
  flex: none;
  min-width: 26px;
  font-size: 12px;
  font-weight: bold;
  font-variant-numeric: tabular-nums;
  color: #95a5a6;
}

.reel-token {
  flex: none;
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: bold;
  color: #2d3436;
}

.reel-name {
  flex: 1 1 auto;
  min-width: 0;
  color: #dfe6e9;
  font-size: 15px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recap-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}

.btn-close {
  flex: none;
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

/* Secondary, ghost-styled so the primary Done keeps the accent fill. */
.btn-copy {
  flex: none;
  padding: 12px 22px;
  border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
  color: #dfe6e9;
  font-weight: bold;
  font-size: 15px;
  cursor: pointer;
}

.btn-copy:hover {
  background: rgba(255, 255, 255, 0.12);
  border-color: var(--accent);
}

@keyframes recap-pop {
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

@keyframes reel-sweep {
  to {
    transform: translateX(120%);
  }
}

@media (prefers-reduced-motion: reduce) {
  .recap {
    animation: fade-in 0.2s ease both;
  }

  .reel-row::after {
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
</style>
