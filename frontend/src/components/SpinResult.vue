<script setup lang="ts">
defineProps<{
  name: string
  remaining: number
}>()

const emit = defineEmits<{
  (e: 'close'): void
}>()
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')">
    <div class="result-card">
      <div class="emoji">🎯</div>
      <h2>{{ name }}</h2>
      <p class="remaining">{{ remaining }} remaining</p>
      <button @click="emit('close')" class="btn-close">Continue</button>
    </div>
  </div>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  justify-content: center;
  align-items: center;
  z-index: 9999;
  backdrop-filter: blur(4px);
  pointer-events: auto;
}

.result-card {
  background: #2d3436;
  border: 2px solid #4ECDC4;
  border-radius: 8px;
  padding: 40px 60px;
  text-align: center;
  animation: pop 0.3s ease-out;
}

@keyframes pop {
  from {
    transform: scale(0.5);
    opacity: 0;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}

.emoji {
  font-size: 48px;
  margin-bottom: 12px;
}

h2 {
  font-size: 32px;
  color: #FF6B6B;
  margin: 0 0 8px;
}

.remaining {
  color: #636e72;
  font-size: 14px;
  margin: 0 0 24px;
}

.btn-close {
  padding: 12px 32px;
  border: none;
  border-radius: 8px;
  background: #4ECDC4;
  color: #2d3436;
  font-weight: bold;
  font-size: 16px;
  cursor: pointer;
}

.btn-close:hover {
  background: #45b7aa;
}
</style>
