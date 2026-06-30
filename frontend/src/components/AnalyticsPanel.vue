<script setup lang="ts">
import { computed } from 'vue'
import type { Participant } from '../types'
import { computeAngles } from '../utils/wheel'
import { identityColor } from '../utils/identity'

const props = defineProps<{
  active: Participant[]
  removed: Participant[]
}>()

// Live pick-probability per active name from the shared weighted-angle math,
// sorted favorites-first, so the panel shows real odds instead of only a mock
// bias string. Capped so a huge roster doesn't overflow the panel.
const liveOdds = computed(() => {
  const active = props.active
  if (!active.length) return []
  const angles = computeAngles(active.map((p) => ({ id: p.id, weight: p.weight })))
  const total = angles.reduce((a, b) => a + b, 0) || Math.PI * 2
  return active
    .map((p, i) => ({ id: p.id, name: p.name, pct: ((angles[i] || 0) / total) * 100 }))
    .sort((a, b) => b.pct - a.pct)
    .slice(0, 8)
})

const stats = computed(() => {
  const total = props.removed.length + props.active.length
  const removedCount = props.removed.length
  const avgSpins = removedCount > 0 ? (removedCount / total).toFixed(2) : '0'
  const nameCounts: Record<string, number> = {}
  props.removed.forEach(p => {
    nameCounts[p.name] = (nameCounts[p.name] || 0) + 1
  })
  const topRemoved = Object.entries(nameCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, count]) => ({ name, count }))
  return {
    total,
    removed: removedCount,
    avgSpins,
    topRemoved
  }
})

const biasEffect = computed(() => {
  // Simple mock: if weights differ, show bias note
  const hasBias = props.active.some((p: any) => (p.weight ?? 1) !== 1)
  return hasBias ? 'Bias active - spins not uniform' : 'No bias (uniform)'
})

const maxCount = computed(() => {
  return Math.max(...stats.value.topRemoved.map(t => t.count), 1)
})
</script>

<template>
  <div class="analytics-panel glass-panel">
    <h4>Analytics</h4>
    <div>Total: {{ stats.total }} | Removed: {{ stats.removed }} | Avg: {{ stats.avgSpins }}</div>
    <div class="bias">{{ biasEffect }}</div>

    <!-- Live pick odds for the active roster (weighted), favorites first. -->
    <div v-if="liveOdds.length" class="odds-section">
      <div class="odds-title">Live odds</div>
      <div v-for="o in liveOdds" :key="o.id" class="odds-row">
        <span class="oname" :title="o.name">{{ o.name }}</span>
        <div class="obar-track">
          <div class="obar" :style="{ width: o.pct + '%', background: identityColor(o.name) }"></div>
        </div>
        <span class="opct">{{ o.pct.toFixed(0) }}%</span>
      </div>
    </div>

    <div v-for="t in stats.topRemoved" :key="t.name" class="bar-row">
      <span class="name">{{ t.name }}</span>
      <div class="bar" :style="{ width: (t.count / maxCount * 100) + '%' }"></div>
      <span class="count">{{ t.count }}</span>
    </div>
    <div class="hint">Based on current session (extend with history for full)</div>
  </div>
</template>

<style scoped>
.glass-panel {
  position: absolute;
  left: 12px;
  top: 120px;
  width: 220px;
  background: rgba(30, 30, 30, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  padding: 10px;
  font-size: 11px;
  color: #dfe6e9;
  z-index: 30;
}
.bias {
  color: #4ECDC4;
  font-weight: bold;
}
.odds-section {
  margin: 6px 0;
  padding: 6px 0;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.odds-title {
  font-size: 9px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #8d9aa1;
  margin-bottom: 4px;
}
.odds-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 2px 0;
  font-size: 10px;
}
.oname {
  width: 56px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.obar-track {
  flex: 1;
  height: 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.06);
  overflow: hidden;
}
.obar {
  height: 100%;
  border-radius: 3px;
  transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}
.opct {
  width: 24px;
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.hint {
  font-size: 9px;
  opacity: 0.6;
  margin-top: 4px;
}
.bar-row {
  display: flex;
  align-items: center;
  margin: 2px 0;
  font-size: 10px;
}
.name {
  width: 60px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bar {
  height: 8px;
  background: #4ECDC4;
  margin: 0 4px;
  transition: width 0.2s;
}
.count {
  width: 20px;
}
</style>