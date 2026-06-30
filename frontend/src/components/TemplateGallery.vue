<script setup lang="ts">
import { ref } from 'vue'

const emit = defineEmits<{
  (e: 'apply', template: any): void
  (e: 'close'): void
}>()

const SEED_TEMPLATES = [
  { id: 'retro', title: 'Sprint Retro', names: ['Alice', 'Bob', 'Carol', 'Dave'], weights: [1,1,1,1] },
  { id: 'critique', title: 'Design Critique', names: ['Lead', 'Dev1', 'Dev2'], weights: [2,1,1] },
  { id: 'hiring', title: 'Hiring Screen', names: ['Candidate', 'Interviewer1', 'Interviewer2'], weights: [1,1.5,1.5] },
]

const customTemplates = ref<any[]>(JSON.parse(localStorage.getItem('custom-templates') || '[]'))

function apply(t: any) {
  emit('apply', t)
  emit('close')
}

function saveCustom() {
  // For demo, add current as custom (would need current state)
  const newT = { id: 'custom-' + Date.now(), title: 'My Custom', names: [], weights: [] }
  customTemplates.value.push(newT)
  localStorage.setItem('custom-templates', JSON.stringify(customTemplates.value))
  alert('Custom saved (demo)')
}
</script>

<template>
  <div class="modal" @click.self="emit('close')">
    <div class="content glass-panel">
      <h3>Templates</h3>
      <div v-for="t in SEED_TEMPLATES" :key="t.id" class="template" @click="apply(t)">
        {{ t.title }}
      </div>
      <h4>Custom</h4>
      <div v-for="t in customTemplates" :key="t.id" class="template" @click="apply(t)">
        {{ t.title }}
      </div>
      <button @click="saveCustom">Save Current as Custom</button>
      <button @click="emit('close')">Close</button>
    </div>
  </div>
</template>

<style scoped>
.modal { position: fixed; top:0; left:0; right:0; bottom:0; background: rgba(0,0,0,0.5); z-index: 100; display: flex; align-items: center; justify-content: center; }
.content { padding: 20px; max-width: 300px; }
.template { padding: 8px; cursor: pointer; border-bottom: 1px solid #444; }
.template:hover { background: #333; }
</style>