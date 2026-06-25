<script setup lang="ts">
import { computed } from 'vue'
import type { Participant } from '../types'

const props = defineProps<{
  active: Participant[]
  removed: Participant[]
}>()

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