<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Participant } from '../types'
import { identityColor } from '../utils/identity'
import { buildPodium, buildRecapSummary, PODIUM_COLORS } from '../utils/recap'

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
  // Result of the one-tap trophy-image export, so the parent can raise the same
  // toast it uses for the text copy. true on a successful clipboard write.
  (e: 'copy-image', ok: boolean): void
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

// One-tap trophy image: the same podium shown in the reel, redrawn onto a hidden
// canvas and copied to the clipboard as a PNG so the host can paste a picture of
// the night, not just text. Reuses identityColor + initialOf + the podium tiers.
const trophyCanvas = ref<HTMLCanvasElement | null>(null)

// Only offer the image button where an async clipboard image write is plausible;
// browsers without ClipboardItem (or the canvas/blob path) keep the text copy.
const canCopyImage =
  typeof window !== 'undefined' &&
  typeof window.ClipboardItem !== 'undefined' &&
  typeof navigator !== 'undefined' &&
  !!navigator.clipboard

// Round-rect path helper (older Safari lacks ctx.roundRect), so the card and its
// chips share one rounded-corner routine.
function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rad = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + rad, y)
  ctx.arcTo(x + w, y, x + w, y + h, rad)
  ctx.arcTo(x + w, y + h, x, y + h, rad)
  ctx.arcTo(x, y + h, x, y, rad)
  ctx.arcTo(x, y, x + w, y, rad)
  ctx.closePath()
}

// Paint the trophy card: title, the crowned survivor, then the gold/silver/bronze
// podium of the first three off the wheel. Drawn at 2x for crisp export. Returns
// false if the 2D context is unavailable.
function drawTrophy(canvas: HTMLCanvasElement): boolean {
  const scale = 2
  const w = 440
  const accent = survivorColor.value
  const podium = buildPodium(props.picked)
  // Fixed top block + one row per podium entry, so a short run stays compact.
  const h = 150 + podium.length * 56 + (podium.length > 0 ? 46 : 0)

  canvas.width = w * scale
  canvas.height = h * scale
  const ctx = canvas.getContext('2d')
  if (!ctx) return false
  ctx.scale(scale, scale)

  // Card backdrop with the survivor accent as a left rail, echoing the modal.
  ctx.fillStyle = '#1e1e1e'
  roundRect(ctx, 0, 0, w, h, 18)
  ctx.fill()
  ctx.fillStyle = accent
  roundRect(ctx, 0, 0, 6, h, 3)
  ctx.fill()

  const padX = 28
  ctx.textBaseline = 'alphabetic'

  // Eyebrow + headline.
  ctx.fillStyle = accent
  ctx.font = '700 12px system-ui, sans-serif'
  ctx.fillText('CURTAIN CALL', padX, 38)

  ctx.fillStyle = '#f5f6fa'
  ctx.font = '700 26px system-ui, sans-serif'
  const headline = props.survivor ? `${props.survivor.name} survives` : "That's a wrap"
  ctx.fillText(clampText(ctx, headline, w - padX * 2), padX, 70)

  ctx.fillStyle = '#95a5a6'
  ctx.font = '400 13px system-ui, sans-serif'
  const sub = props.title.trim() || 'Wheel of Shame'
  ctx.fillText(clampText(ctx, sub, w - padX * 2), padX, 92)

  // Podium rows: medal chip, identity token, name. Mirrors the modal reel.
  let y = 124
  if (podium.length > 0) {
    ctx.fillStyle = '#7f8c8d'
    ctx.font = '700 11px system-ui, sans-serif'
    ctx.fillText('FIRST OFF THE WHEEL', padX, y)
    y += 20
  }
  for (const row of podium) {
    const rowH = 44
    const medal = PODIUM_COLORS[row.tier]
    ctx.fillStyle = 'rgba(255, 255, 255, 0.05)'
    roundRect(ctx, padX, y, w - padX * 2, rowH, 8)
    ctx.fill()
    // Medal rail.
    ctx.fillStyle = medal
    roundRect(ctx, padX, y, 4, rowH, 2)
    ctx.fill()

    // Rank.
    ctx.fillStyle = medal
    ctx.font = '700 13px system-ui, sans-serif'
    ctx.fillText(`#${row.rank}`, padX + 16, y + 28)

    // Identity token.
    const tokenX = padX + 52
    const tokenR = 13
    ctx.fillStyle = identityColor(row.name)
    ctx.beginPath()
    ctx.arc(tokenX + tokenR, y + rowH / 2, tokenR, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#2d3436'
    ctx.font = '700 13px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(initialOf(row.name), tokenX + tokenR, y + rowH / 2 + 5)
    ctx.textAlign = 'left'

    // Name.
    ctx.fillStyle = '#dfe6e9'
    ctx.font = '600 15px system-ui, sans-serif'
    ctx.fillText(clampText(ctx, row.name, w - tokenX - tokenR * 2 - padX - 12), tokenX + tokenR * 2 + 12, y + rowH / 2 + 5)

    y += rowH + 12
  }

  return true
}

// Trim text to fit a pixel width, appending an ellipsis. Keeps long names from
// running off the card.
function clampText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (ctx.measureText(text).width <= maxW) return text
  let t = text
  while (t.length > 1 && ctx.measureText(t + '…').width > maxW) {
    t = t.slice(0, -1)
  }
  return t + '…'
}

const copyingImage = ref(false)

// Render the card and copy it to the clipboard as a PNG, then report the result
// up so App.vue raises the toast (single source of toasts, like copySummary).
async function copyImage() {
  if (copyingImage.value) return
  const canvas = trophyCanvas.value
  if (!canvas || !drawTrophy(canvas)) {
    emit('copy-image', false)
    return
  }
  copyingImage.value = true
  try {
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/png'),
    )
    if (!blob) {
      emit('copy-image', false)
      return
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    emit('copy-image', true)
  } catch {
    emit('copy-image', false)
  } finally {
    copyingImage.value = false
  }
}
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
        <button
          v-if="canCopyImage"
          @click="copyImage"
          class="btn-copy"
          :disabled="copyingImage"
          title="Copy a trophy card image"
        >
          {{ copyingImage ? 'Copying…' : 'Copy image' }}
        </button>
        <button @click="copySummary" class="btn-copy" title="Copy run summary">
          Copy text
        </button>
        <button @click="emit('close')" class="btn-close">Done</button>
      </div>
    </div>

    <!-- Off-screen render target for the exported trophy card; never shown, only
         drawn to and read back as a PNG blob on Copy image. -->
    <canvas ref="trophyCanvas" class="trophy-canvas" aria-hidden="true"></canvas>
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
  flex-wrap: wrap;
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

/* Secondary, ghost-styled so the primary Done keeps the accent fill. Two of
   these (image + text) sit beside Done, so they run a touch tighter to fit. */
.btn-copy {
  flex: none;
  padding: 12px 18px;
  border: 1px solid color-mix(in srgb, var(--accent) 45%, transparent);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
  color: #dfe6e9;
  font-weight: bold;
  font-size: 14px;
  cursor: pointer;
}

.btn-copy:hover {
  background: rgba(255, 255, 255, 0.12);
  border-color: var(--accent);
}

.btn-copy:disabled {
  opacity: 0.6;
  cursor: default;
}

/* Hidden export canvas: kept in the layout but visually removed and pulled out
   of the tab order. Not display:none so the 2D context still rasterizes. */
.trophy-canvas {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
  pointer-events: none;
  left: -9999px;
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
