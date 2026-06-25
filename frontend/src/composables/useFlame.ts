import { ref, onMounted, onBeforeUnmount, type Ref } from 'vue'

// Extracted flame header effect (was inline in App). Capped rAF, flare support.
export interface UseFlame {
  flameCanvas: Ref<HTMLCanvasElement | null>
  flare: (ms?: number) => void
}

export function useFlame(): UseFlame {
  const flameCanvas = ref<HTMLCanvasElement | null>(null)
  let flameAnimId = 0
  let flameCleanup: (() => void) | null = null
  let flareUntil = 0
  const FLARE_MS = 900

  interface Particle {
    x: number; y: number; vx: number; vy: number; life: number; maxLife: number; size: number
    drift?: boolean; flare?: number
  }

  const edgePointsCache = new Map<string, [number, number][]>()
  const EDGE_POINTS_CACHE_LIMIT = 12

  function getTextEdgePoints(w: number, h: number): [number, number][] {
    const key = `${w}x${h}`
    const cached = edgePointsCache.get(key)
    if (cached) return cached
    const points = computeTextEdgePoints(w, h)
    if (edgePointsCache.size >= EDGE_POINTS_CACHE_LIMIT) {
      edgePointsCache.delete(edgePointsCache.keys().next().value!)
    }
    edgePointsCache.set(key, points)
    return points
  }

  function computeTextEdgePoints(w: number, h: number): [number, number][] {
    if (w < 1 || h < 1) return []
    const off = document.createElement('canvas')
    off.width = w; off.height = h
    const octx = off.getContext('2d')!
    octx.clearRect(0, 0, w, h)
    octx.font = 'bold 42px Inter, system-ui, sans-serif'
    octx.textAlign = 'center'; octx.textBaseline = 'middle'
    octx.fillStyle = '#fff'
    octx.fillText('Wheel of Shame', w / 2, h / 2)
    const imgData = octx.getImageData(0, 0, w, h)
    const pixels = imgData.data
    const points: [number, number][] = []
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const idx = (y * w + x) * 4
        const a = pixels[idx + 3]
        if (a < 80) continue
        const top = pixels[((y - 1) * w + x) * 4 + 3]
        const bot = pixels[((y + 1) * w + x) * 4 + 3]
        const lft = pixels[(y * w + x - 1) * 4 + 3]
        const rgt = pixels[(y * w + x + 1) * 4 + 3]
        if (top < 80 || bot < 80 || lft < 80 || rgt < 80) points.push([x, y])
      }
    }
    return points
  }

  function init() {
    const canvasEl = flameCanvas.value
    if (!canvasEl) return
    const canvas: HTMLCanvasElement = canvasEl
    const ctx = canvas.getContext('2d')!
    const particles: Particle[] = []
    let edgePoints: [number, number][] = []
    const EMBER_DRIFT = 280
    let headerH = 0
    let sizeRetry: number | undefined

    function resize() {
      const header = canvas.parentElement
      if (!header) return
      headerH = header.clientHeight
      canvas.width = header.clientWidth
      canvas.height = headerH + EMBER_DRIFT
      canvas.style.height = `${canvas.height}px`
      if (canvas.width < 1 || headerH < 1) {
        sizeRetry = requestAnimationFrame(resize)
        return
      }
      sizeRetry = undefined
      edgePoints = getTextEdgePoints(canvas.width, headerH)
    }
    resize()

    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    const onResize = () => {
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(resize, 150)
    }
    window.addEventListener('resize', onResize)
    flameCleanup = () => {
      window.removeEventListener('resize', onResize)
      clearTimeout(resizeTimer)
      if (sizeRetry !== undefined) cancelAnimationFrame(sizeRetry)
    }

    const reducedMotion = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const spawnPerFrame = reducedMotion ? 1 : 4

    function flareStrength(): number {
      if (reducedMotion) return 0
      const remain = flareUntil - performance.now()
      if (remain <= 0) return 0
      return Math.min(1, remain / FLARE_MS)
    }

    function spawn() {
      if (edgePoints.length === 0) return
      const flare = flareStrength()
      const count = Math.round(spawnPerFrame * (1 + flare * 1.5))
      for (let i = 0; i < count; i++) {
        const pt = edgePoints[Math.floor(Math.random() * edgePoints.length)]
        const drifter = !reducedMotion && Math.random() < 0.02
        particles.push({
          x: pt[0], y: pt[1],
          vx: (Math.random() - 0.5) * 0.6,
          vy: drifter ? 0.3 + Math.random() * 0.5 : -(0.8 + Math.random() * 1.8),
          life: 0,
          maxLife: drifter ? 160 + Math.random() * 80 : 20 + Math.random() * 30,
          size: (4 + Math.random() * 10) * (1 + flare * 0.6),
          drift: drifter, flare,
        })
      }
    }

    const FLAME_TARGET_FPS = 60
    const FLAME_FRAME_MS = 1000 / FLAME_TARGET_FPS
    let lastFlameTime = 0
    function loop(now = performance.now()) {
      if (now - lastFlameTime < FLAME_FRAME_MS) {
        flameAnimId = requestAnimationFrame(loop)
        return
      }
      lastFlameTime = now
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      spawn()
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i]
        p.life++
        p.x += p.vx + (Math.random() - 0.5) * 0.4
        p.y += p.vy
        if (p.drift) {
          p.vy = Math.min(p.vy + 0.012, 1.0)
          p.size *= 0.995
        } else {
          p.vy *= 0.97
          p.size *= 0.98
        }
        p.vx += (Math.random() - 0.5) * 0.1
        if (p.life >= p.maxLife || p.size < 0.5) {
          particles.splice(i, 1)
          continue
        }
        const t = p.life / p.maxLife
        const alpha = t < 0.15 ? t / 0.15 : 1 - ((t - 0.15) / 0.85)
        let r: number, g: number, b: number
        if (t < 0.2) { r=255; g=255-t*400; b=50*(1-t*5) }
        else if (t < 0.5) { const st=(t-0.2)/0.3; r=255; g=155*(1-st); b=0 }
        else if (t < 0.8) { const st=(t-0.5)/0.3; r=255-st*120; g=0; b=0 }
        else { const st=(t-0.8)/0.2; r=135-st*80; g=st*20; b=st*20 }
        const f = p.flare ?? 0
        if (f > 0) { g += (255-g)*0.6*f; b += (200-b)*0.6*f }
        ctx.save()
        ctx.globalAlpha = Math.min(1, alpha * (0.8 + 0.25 * f))
        ctx.translate(p.x, p.y)
        const s = p.size
        ctx.beginPath()
        ctx.moveTo(0, -s * 1.2)
        ctx.bezierCurveTo(s*0.5, -s*0.4, s*0.4, s*0.3, 0, s*0.5)
        ctx.bezierCurveTo(-s*0.4, s*0.3, -s*0.5, -s*0.4, 0, -s*1.2)
        ctx.closePath()
        const grad = ctx.createRadialGradient(0, -s*0.3, 0, 0, -s*0.3, s)
        grad.addColorStop(0, `rgba(${r},${g},${b},1)`)
        grad.addColorStop(0.5, `rgba(${r},${g},${b},0.4)`)
        grad.addColorStop(1, `rgba(${r},${g},${b},0)`)
        ctx.fillStyle = grad
        ctx.fill()
        ctx.restore()
      }
      flameAnimId = requestAnimationFrame(loop)
    }
    flameAnimId = requestAnimationFrame(loop)
  }

  onMounted(() => { init() })
  onBeforeUnmount(() => {
    cancelAnimationFrame(flameAnimId)
    flameCleanup?.()
  })

  function flare(ms = FLARE_MS) {
    flareUntil = performance.now() + ms
  }

  return { flameCanvas, flare }
}
