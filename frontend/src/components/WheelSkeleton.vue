<script setup lang="ts">
// Placeholder shown while the WheelCanvas chunk (three.js + scene setup) is
// still loading. It occupies the same fixed full-bleed z-index:0 slot as
// WheelCanvas's .wheel-bg so the eventual swap reads as the wheel resolving
// in place rather than a layout jump. A faint ring outlines where the wheel
// will land while a conic highlight sweeps around it.
</script>

<template>
  <div class="wheel-skeleton" aria-hidden="true">
    <div class="ring-wrap">
      <svg class="ring" viewBox="0 0 100 100">
        <circle class="ring-track" cx="50" cy="50" r="40" />
        <circle class="ring-hub" cx="50" cy="50" r="9" />
      </svg>
      <div class="sweep"></div>
    </div>
  </div>
</template>

<style scoped>
/* Match WheelCanvas's .wheel-bg: fixed, full-bleed, behind the overlay. */
.wheel-skeleton {
  position: fixed;
  inset: 0;
  z-index: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.ring-wrap {
  position: relative;
  width: min(58vmin, 460px);
  height: min(58vmin, 460px);
}

.ring {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}

.ring-track {
  fill: none;
  stroke: rgba(255, 255, 255, 0.08);
  stroke-width: 2.5;
}

.ring-hub {
  fill: rgba(255, 255, 255, 0.05);
}

/* A conic highlight masked into a ring band, rotating to trace the rim like a
   shimmer. The teal accent matches the app's active-roster highlight. */
.sweep {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: conic-gradient(
    from 0deg,
    transparent 0deg,
    rgba(78, 205, 196, 0.55) 40deg,
    transparent 80deg
  );
  -webkit-mask: radial-gradient(
    circle at center,
    transparent 36%,
    #000 38%,
    #000 42%,
    transparent 44%
  );
  mask: radial-gradient(
    circle at center,
    transparent 36%,
    #000 38%,
    #000 42%,
    transparent 44%
  );
  animation: wheelSweep 1.6s linear infinite;
}

@keyframes wheelSweep {
  to {
    transform: rotate(360deg);
  }
}

/* No motion: drop the sweep to a static dim ring band so the placeholder still
   reads but nothing spins. */
@media (prefers-reduced-motion: reduce) {
  .sweep {
    animation: none;
    background: rgba(78, 205, 196, 0.18);
  }
}
</style>
