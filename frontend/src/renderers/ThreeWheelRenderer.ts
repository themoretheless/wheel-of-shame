/**
 * ThreeWheelRenderer
 * Full Three.js renderer extracted from the old WheelCanvas god object.
 * Canvas is now a thin host. All scene, meshes, animation, audio, controls here.
 */
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import type { PreparedSegment } from '../types/wheel'
import type { WheelRenderer } from './WheelRenderer'
import { segmentIdAtRotation } from '../utils/wheel'

const WHEEL_RADIUS = 2.2
const WHEEL_INNER = 0.6
const WHEEL_DEPTH = 0.3
const DONUT_INNER = WHEEL_INNER + 0.06
const DONUT_OUTER = WHEEL_INNER + 0.22
const DONUT_GAP = 0.04
const BASE_CAM_Z = 7.8
const SLOWMO_START = 0.82

export class ThreeWheelRenderer implements WheelRenderer {
  private container: HTMLDivElement
  private onTick: (id: string | null) => void
  private _onDrift: (drifted: boolean) => void
  private _onWinner: (data: any) => void
  private onSpinComplete?: (id: string) => void
  private onSpinClick?: (dir: 'left' | 'right') => void

  // Core three
  private renderer: THREE.WebGLRenderer | null = null
  private scene: THREE.Scene | null = null
  private camera: THREE.PerspectiveCamera | null = null
  private wheelGroup: THREE.Group | null = null
  private controls: OrbitControls | null = null
  private composer: EffectComposer | null = null
  private bloomPass: UnrealBloomPass | null = null

  private segmentMeshes: THREE.Mesh[] = []
  private pegMeshes: any[] = []
  private donutMeshes: any[] = []
  private dividerLines: any[] = []
  private _hoveredSeg: any = null
  private previewOverrides: any = {}

  private needsRender = true
  private animFrameId = 0

  // Spin state
  private currentRotation = 0
  private isSpinAnimating = false
  private spinDirection = 1
  private _pegSpacing = 0
  private lastTickSegment: string | null = null
  private spinSegmentIds: string[] = []

  // Interaction / camera
  private _isPointerDown = false
  private _cameraDrifted = false
  private homeCamZ = BASE_CAM_Z

  // Audio (lightweight)
  private audioCtx: AudioContext | null = null
  private masterGain: GainNode | null = null
  private audioResume: (() => void) | null = null
  private isMuted = false
  private muteKey = 'wheel-muted'

  // Caches
  private cachedMaterials = new Map<string, THREE.Material>()
  private segGeoCache = new Map<number, THREE.ExtrudeGeometry>()
  private sharedDividerGeo: THREE.BufferGeometry | null = null
  private sharedPegGeo: THREE.CylinderGeometry | null = null
  private sharedPegMat: THREE.MeshStandardMaterial | null = null

  private getCachedMat(color: string, metalness: number, roughness: number, emissiveIntensity = 0): THREE.Material {
    const key = `${color}_${metalness}_${roughness}_${emissiveIntensity.toFixed(2)}`
    if (!this.cachedMaterials.has(key)) {
      const mat = new THREE.MeshStandardMaterial({ color, metalness, roughness })
      if (emissiveIntensity > 0) {
        mat.emissive = new THREE.Color(color)
        mat.emissiveIntensity = emissiveIntensity
      }
      this.cachedMaterials.set(key, mat)
    }
    return this.cachedMaterials.get(key)!
  }

  private getSegmentGeometry(segAngle: number): THREE.ExtrudeGeometry {
    const key = Math.round(segAngle * 2048)
    if (this.segGeoCache.has(key)) return this.segGeoCache.get(key)!
    const shape = new THREE.Shape()
    shape.absarc(0, 0, WHEEL_RADIUS, 0, segAngle, false)
    shape.absarc(0, 0, WHEEL_INNER, segAngle, 0, true)
    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: WHEEL_DEPTH,
      bevelEnabled: true,
      bevelThickness: 0.015,
      bevelSize: 0.015,
      bevelSegments: 1,
    })
    this.segGeoCache.set(key, geo)
    return geo
  }

  private getDividerGeo(): THREE.BufferGeometry {
    if (!this.sharedDividerGeo) {
      this.sharedDividerGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(WHEEL_INNER, 0, WHEEL_DEPTH / 2 + 0.01),
        new THREE.Vector3(WHEEL_RADIUS, 0, WHEEL_DEPTH / 2 + 0.01),
      ])
    }
    return this.sharedDividerGeo
  }

  private getPegGeo(): THREE.CylinderGeometry {
    if (!this.sharedPegGeo) {
      this.sharedPegGeo = new THREE.CylinderGeometry(0.045, 0.055, 0.16, 12)
    }
    return this.sharedPegGeo
  }

  private getPegMat(): THREE.MeshStandardMaterial {
    if (!this.sharedPegMat) {
      this.sharedPegMat = new THREE.MeshStandardMaterial({ color: '#d0d3d4', metalness: 0.85, roughness: 0.25 })
    }
    return this.sharedPegMat
  }

  private clearGroup(group: THREE.Group) {
    while (group.children.length > 0) {
      const child = group.children[0]
      group.remove(child)
      if ((child as any).geometry && !(child as any).userData?.sharedGeometry) {
        ;(child as any).geometry.dispose()
      }
      const m = (child as any).material
      if (m && !(child as any).userData?.sharedMaterial) {
        if (Array.isArray(m)) m.forEach((mm: any) => mm.dispose && mm.dispose())
        else if (m.dispose) m.dispose()
      }
    }
  }

  private markDirty() { this.needsRender = true }

  private addWheelCenter() {
    if (!this.wheelGroup) return
    const innerRim = new THREE.Mesh(
      new THREE.TorusGeometry(WHEEL_INNER, 0.04, 12, 64),
      this.getCachedMat('#bdc3c7', 0.6, 0.25)
    )
    this.wheelGroup.add(innerRim)
  }

  constructor(
    container: HTMLDivElement,
    callbacks: {
      onTick?: (id: string | null) => void
      onDrift?: (drifted: boolean) => void
      onWinner?: (data: any) => void
      onSpinComplete?: (id: string) => void
      onSpinClick?: (dir: 'left' | 'right') => void
    }
  ) {
    this.container = container
    this.onTick = callbacks.onTick || (() => {})
    this._onDrift = callbacks.onDrift || (() => {})
    this._onWinner = callbacks.onWinner || (() => {})
    this.onSpinComplete = callbacks.onSpinComplete
    this.onSpinClick = callbacks.onSpinClick

    this.initScene()
    this.initAudio()
    this.build([]) // initial placeholder wheel until prepared segments arrive
    this.startRenderLoop()

    // Basic interactions
    const el = this.renderer!.domElement
    el.addEventListener('click', this.onCanvasClick.bind(this))
    el.addEventListener('mousemove', this.onCanvasMouseMove.bind(this))
    el.addEventListener('pointerdown', () => { this._isPointerDown = true })
    el.addEventListener('pointerup', () => { this._isPointerDown = false })

    window.addEventListener('resize', this.onResize.bind(this))

    // seed mute
    try {
      this.isMuted = localStorage.getItem(this.muteKey) === '1'
    } catch {}
    // touch unused for build (future use in pointer/hover/font)
    void this._pegSpacing; void this._isPointerDown; void this._cameraDrifted; void this._setMuted; void this._hoveredSeg; void this._onWinner; void this._onDrift
  }

  private initScene() {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.renderer.setSize(this.container.clientWidth, this.container.clientHeight)
    this.renderer.setClearColor(0x1e1e1e, 1)
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.2
    this.container.appendChild(this.renderer.domElement)

    this.scene = new THREE.Scene()

    this.camera = new THREE.PerspectiveCamera(
      38,
      this.container.clientWidth / this.container.clientHeight,
      0.1,
      100
    )
    this.camera.position.set(0, 0, BASE_CAM_Z)
    this.camera.lookAt(0, 0, 0)

    this.wheelGroup = new THREE.Group()
    this.scene.add(this.wheelGroup)

    // Lighting + env
    const pmrem = new THREE.PMREMGenerator(this.renderer)
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    pmrem.dispose()

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.65))
    const key = new THREE.DirectionalLight(0xffffff, 1.0)
    key.position.set(2, 4, 8)
    this.scene.add(key)

    // Composer + bloom
    this.composer = new EffectComposer(this.renderer)
    this.composer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    this.composer.setSize(this.container.clientWidth, this.container.clientHeight)
    this.composer.addPass(new RenderPass(this.scene, this.camera))
    if (!this.prefersReducedMotion()) {
      this.bloomPass = new UnrealBloomPass(new THREE.Vector2(this.container.clientWidth, this.container.clientHeight), 0.6, 0.5, 0.85)
      this.composer.addPass(this.bloomPass)
    }
    this.composer.addPass(new OutputPass())

    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.enableDamping = true
    this.controls.dampingFactor = 0.08
    this.controls.enablePan = false
    this.controls.minDistance = 4
    this.controls.maxDistance = 14
    this.controls.minPolarAngle = 0.3
    this.controls.maxPolarAngle = Math.PI - 0.3
    this.controls.addEventListener('change', () => this.markDirty())

    // initial fit
    this.fitWheel()
  }

  private prefersReducedMotion(): boolean {
    return typeof window !== 'undefined' &&
      window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
  }

  private initAudio() {
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
      this.audioCtx = ctx
      // Master bus: ticks/thunk -> masterGain -> compressor -> destination, so
      // overlapping ticks have headroom and never clip.
      this.masterGain = ctx.createGain()
      this.masterGain.gain.value = 0.9
      const comp = ctx.createDynamicsCompressor()
      this.masterGain.connect(comp)
      comp.connect(ctx.destination)
      // Browsers start the context suspended until a user gesture; resume on the
      // first pointer/key so early ticks aren't silently dropped.
      const resume = () => {
        if (this.audioCtx && this.audioCtx.state === 'suspended') this.audioCtx.resume().catch(() => {})
        if (this.audioResume) {
          window.removeEventListener('pointerdown', this.audioResume)
          window.removeEventListener('keydown', this.audioResume)
          this.audioResume = null
        }
      }
      this.audioResume = resume
      window.addEventListener('pointerdown', resume)
      window.addEventListener('keydown', resume)
    } catch {}
  }

  private _setMuted(m: boolean) {
    this.isMuted = m
  }

  // Rising-pitch tick: pitch climbs with spin progress (a drumroll into the
  // landing) and the gain swells on the final slow-mo stretch. progress is the
  // eased spin t in [0,1]; boost lifts the volume for the last dramatic ticks.
  private playTick(progress = 0, boost = false) {
    if (this.isMuted || !this.audioCtx || !this.masterGain) return
    try {
      const ctx = this.audioCtx
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'square'
      const clamped = progress < 0 ? 0 : progress > 1 ? 1 : progress
      o.frequency.value = 660 + clamped * 540 // 660Hz -> 1200Hz across the spin
      const peak = boost ? 0.05 : 0.03
      const now = ctx.currentTime
      // Short percussive envelope (attack + exponential decay on the audio clock)
      // instead of a hard setTimeout cutoff, which clicked at each tick end.
      g.gain.setValueAtTime(0.0001, now)
      g.gain.exponentialRampToValueAtTime(peak, now + 0.005)
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.05)
      o.connect(g)
      g.connect(this.masterGain)
      o.start(now)
      o.stop(now + 0.06)
    } catch {}
  }

  private playThunk() {
    if (this.isMuted || !this.audioCtx || !this.masterGain) return
    try {
      const ctx = this.audioCtx
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'sine'
      o.frequency.value = 140
      const now = ctx.currentTime
      g.gain.setValueAtTime(0.0001, now)
      g.gain.exponentialRampToValueAtTime(0.3, now + 0.01)
      g.gain.exponentialRampToValueAtTime(0.0001, now + 0.18)
      o.connect(g)
      g.connect(this.masterGain)
      o.start(now)
      o.stop(now + 0.2)
    } catch {}
  }

  // Haptic pulse, gated by the same mute flag as audio. navigator.vibrate is a
  // no-op on desktop / unsupported, so this is safe to call unconditionally.
  private vibrate(pattern: number | number[]) {
    if (this.isMuted) return
    try {
      if (typeof navigator !== 'undefined' && (navigator as any).vibrate) (navigator as any).vibrate(pattern)
    } catch {}
  }

  // Pick black or white ink for legibility over a fill via relative luminance.
  private contrastInk(color: string): string {
    try {
      const col = new THREE.Color(color)
      const lum = 0.2126 * col.r + 0.7152 * col.g + 0.0722 * col.b
      return lum > 0.55 ? '#000000' : '#ffffff'
    } catch { return '#000000' }
  }

  private onResize() {
    if (!this.renderer || !this.camera) return
    const w = this.container.clientWidth
    const h = this.container.clientHeight
    this.camera.aspect = w / h
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(w, h)
    if (this.composer) this.composer.setSize(w, h)
    this.markDirty()
  }

  private fitWheel() {
    // simple centering
    if (this.wheelGroup) this.wheelGroup.position.set(0, 0, 0)
  }

  build(segments: PreparedSegment[]): void {
    if (!this.wheelGroup || !this.scene) return
    const group = this.wheelGroup
    this.clearGroup(group)
    this.segmentMeshes = []
    this.dividerLines = []
    this.pegMeshes = []
    this.donutMeshes = []
    this._hoveredSeg = null
    this.markDirty()

    if (!segments.length) {
      // placeholder dark wheel
      const shape = new THREE.Shape()
      shape.absarc(0, 0, WHEEL_RADIUS, 0, Math.PI * 2, false)
      shape.absarc(0, 0, WHEEL_INNER, Math.PI * 2, 0, true)
      const geo = new THREE.ExtrudeGeometry(shape, { depth: WHEEL_DEPTH, bevelEnabled: false })
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: '#2d3436' }))
      mesh.position.z = -WHEEL_DEPTH / 2
      group.add(mesh)
      this.addWheelCenter()
      return
    }

    let cursor = 0
    const donutArcs: { start: number; end: number; color: string }[] = []

    segments.forEach((p) => {
      const segAngle = p.angle || (Math.PI * 2 / segments.length)
      const startAngle = cursor
      cursor += segAngle
      const color = p.color || '#4ECDC4'
      const w = p.weight || 1
      const emissive = w > 1 ? Math.min(0.55, (w - 1) * 0.22) : 0
      const mesh = new THREE.Mesh(
        this.getSegmentGeometry(segAngle),
        this.getCachedMat(color, 0.12, 0.55, emissive)
      )
      mesh.position.z = -WHEEL_DEPTH / 2
      mesh.rotation.z = startAngle
      mesh.userData.participantId = p.id
      group.add(mesh)
      this.segmentMeshes.push(mesh)

      donutArcs.push({ start: startAngle, end: startAngle + segAngle, color })

      // prevent ring (red)
      if (p.isLast && p.isPrevented) {
        const ring = new THREE.Mesh(
          new THREE.RingGeometry(WHEEL_RADIUS - 0.01, WHEEL_RADIUS + 0.11, 64, 1, startAngle, segAngle),
          new THREE.MeshBasicMaterial({ color: 0xff3b30, transparent: true, opacity: 0.85, side: THREE.DoubleSide })
        )
        ring.position.z = 0.12
        ring.rotation.z = startAngle
        group.add(ring)
      }

      // divider
      const line = new THREE.Line(this.getDividerGeo(), new THREE.LineBasicMaterial({ color: 0xffffff }))
      line.rotation.z = startAngle
      line.userData.sharedGeometry = true
      group.add(line)
      this.dividerLines.push(line)

      // peg
      const peg = new THREE.Mesh(this.getPegGeo(), this.getPegMat())
      peg.rotation.x = Math.PI / 2
      peg.position.set(
        Math.cos(startAngle) * WHEEL_RADIUS,
        Math.sin(startAngle) * WHEEL_RADIUS,
        WHEEL_DEPTH / 2 + 0.05
      )
      peg.userData.sharedGeometry = true
      group.add(peg)
      this.pegMeshes.push(peg)

      // simple label (plane text fallback; curved would require more port)
      if (p.name) {
        const label = this.makeSimpleLabel(p.name, color)
        if (label) {
          label.position.z = WHEEL_DEPTH + 0.05
          label.rotation.z = startAngle + segAngle * 0.5
          mesh.add(label)
        }
      }
    })

    this.addOddsDonut(donutArcs)
    this.addWheelCenter()
    this.markDirty()
  }

  private makeSimpleLabel(name: string, color: string): THREE.Object3D | null {
    // lightweight label using canvas texture (avoids full opentype curved port complexity here)
    try {
      // Render at devicePixelRatio (capped at 2, matching the renderer) so labels
      // stay crisp on retina instead of the old fixed 256x64 blur.
      const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2)
      const baseW = 256
      const baseH = 64
      const c = document.createElement('canvas')
      c.width = baseW * dpr
      c.height = baseH * dpr
      const ctx = c.getContext('2d')!
      ctx.scale(dpr, dpr)
      ctx.font = 'bold 28px Roboto, sans-serif'
      const text = name.length > 18 ? name.slice(0, 17) + '…' : name
      // Contrast-aware ink: dark text over light segment fills, light over dark,
      // so names stay legible across the whole hashed identity palette. A thin
      // opposite-color halo decouples legibility from the fill and bloom wash.
      const ink = this.contrastInk(color)
      ctx.lineWidth = 3
      ctx.lineJoin = 'round'
      ctx.strokeStyle = ink === '#000000' ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.85)'
      ctx.strokeText(text, 8, 40)
      ctx.fillStyle = ink
      ctx.fillText(text, 8, 40)
      const tex = new THREE.CanvasTexture(c)
      if (this.renderer) tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy()
      const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide })
      const plane = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.32), mat)
      return plane
    } catch { return null }
  }

  private addOddsDonut(arcs: { start: number; end: number; color: string }[]) {
    if (!this.wheelGroup || !arcs.length) return
    const gap = arcs.length > 1 ? DONUT_GAP : 0
    for (const a of arcs) {
      const span = a.end - a.start - gap
      if (span <= 0.001) continue
      const geo = new THREE.RingGeometry(DONUT_INNER, DONUT_OUTER, 32, 1, a.start + gap / 2, span)
      const mat = new THREE.MeshStandardMaterial({
        color: a.color,
        emissive: new THREE.Color(a.color),
        emissiveIntensity: 0,
        metalness: 0.2,
        roughness: 0.45,
      })
      const ring = new THREE.Mesh(geo, mat)
      ring.position.z = WHEEL_DEPTH / 2 + 0.012
      this.wheelGroup.add(ring)
      this.donutMeshes.push(ring)
    }
  }

  updateInPlace(segments: PreparedSegment[]): void {
    if (!this.wheelGroup || !this.segmentMeshes.length) return
    const overrides = this.previewOverrides || {}
    let cursor = 0
    const slice = (Math.PI * 2) / Math.max(1, segments.length)
    segments.forEach((p, i) => {
      const mesh = this.segmentMeshes[i]
      if (!mesh) return
      const segAngle = p.angle || slice
      const start = cursor
      cursor += segAngle
      const color = p.color || '#4ECDC4'
      const w = (overrides[p.id]?.weight ?? p.weight ?? 1)
      const emissive = w > 1 ? Math.min(0.55, (w - 1) * 0.22) : 0
      const mat = mesh.material as any
      if (mat && mat.color) {
        mat.color.set(color)
        if (emissive > 0) {
          mat.emissive = new THREE.Color(color)
          mat.emissiveIntensity = emissive
        } else {
          mat.emissiveIntensity = 0
        }
      }
      mesh.rotation.z = start
    })
    this.markDirty()
  }

  setHighlight(id: string | null) {
    // simple lift for hover/focus
    this.segmentMeshes.forEach((m) => {
      const mid = m.userData?.participantId
      const lift = mid === id ? 0.18 : 0
      m.position.z = -WHEEL_DEPTH / 2 + lift
    })
    this._hoveredSeg = id ? this.segmentMeshes.find((m) => m.userData?.participantId === id) : null
    this.markDirty()
  }

  playSpin(winnerId: string, onComplete: () => void) {
    if (!this.wheelGroup || !this.segmentMeshes.length || !this.camera) {
      onComplete()
      return
    }
    const activeCount = this.segmentMeshes.length
    if (activeCount === 0) { onComplete(); return }

    const slice = (Math.PI * 2) / activeCount
    const idx = this.segmentMeshes.findIndex((m) => m.userData?.participantId === winnerId)
    if (idx < 0) { onComplete(); return }

    const randomOffset = (Math.random() * 0.6 + 0.2) * slice
    const segPoint = idx * slice + randomOffset
    const target = Math.PI / 2 - segPoint

    let delta = target - (this.currentRotation % (Math.PI * 2))
    const dir = this.spinDirection || 1
    while (dir > 0 ? delta <= 0 : delta >= 0) {
      delta += dir * Math.PI * 2
    }

    const reduced = this.prefersReducedMotion()
    // Scale the spin's energy to the roster size: a tiny wheel shouldn't spin as
    // long or as many turns as a crowded one. Bounded so it stays snappy at both
    // extremes (~3.0s/5 turns for a handful of names, ~3.7s/8 turns for ~30+).
    const sizeFactor = Math.min(1.5, Math.max(0.7, Math.sqrt(activeCount / 8)))
    const turns = 3 + Math.round(sizeFactor * 2) + Math.floor(Math.random() * 2)
    const full = reduced ? 0 : (Math.PI * 2 * turns * dir)
    const total = full + delta
    const dur = reduced ? 520 : Math.round(2600 + 700 * sizeFactor)
    const windDur = reduced ? 0 : 180
    const wind = reduced ? 0 : -dir * 0.1
    const startRot = this.currentRotation
    const mainStart = startRot + wind
    const startT = performance.now()

    this.isSpinAnimating = true
    if (this.controls) this.controls.enabled = false

    // Map wheel-order -> participant id so the per-frame segment-cross logic can
    // fire onTick/playTick. This list was previously never populated, so the
    // spin played no ticks at all; lastTickSegment resets so the first cross
    // after launch always fires a tick.
    this.spinSegmentIds = this.segmentMeshes.map((m) => m.userData?.participantId)
    this.lastTickSegment = null

    // Anticipation: compress the wheel a hair so the launch reads as a released
    // spring. The frame loop eases scale back to 1.0 over the first frames.
    if (!reduced && this.wheelGroup) this.wheelGroup.scale.set(0.97, 0.97, 1)

    const frame = (now: number) => {
      this.markDirty()
      const t = Math.min((now - startT) / dur, 1)
      let eased = reduced ? t : 1 - Math.pow(1 - t, 3)
      if (!reduced && t > SLOWMO_START) {
        const u = (t - SLOWMO_START) / (1 - SLOWMO_START)
        eased = (1 - Math.pow(1 - SLOWMO_START, 3)) + (1 - (1 - Math.pow(1 - SLOWMO_START, 3))) * Math.sin(u * Math.PI / 2)
      }
      this.currentRotation = mainStart + (total - wind) * eased
      if (this.wheelGroup) this.wheelGroup.rotation.z = this.currentRotation

      // Release the anticipation squash back to rest over the first ~12%.
      if (!reduced && this.wheelGroup) {
        const rel = Math.min(t / 0.12, 1)
        const s = 0.97 + 0.03 * rel
        this.wheelGroup.scale.set(s, s, 1)
      }

      // Bloom glows hottest mid-spin and cools into the slow-mo tail, so the
      // wheel reads as energized then settling onto the winner.
      if (!reduced && this.bloomPass) {
        const heat = Math.sin(Math.min(t / SLOWMO_START, 1) * Math.PI)
        this.bloomPass.strength = 0.6 + 0.5 * heat
      }

      // tick on segment cross (pure mapping, unit-tested in utils/wheel.test.ts)
      const id = segmentIdAtRotation(this.currentRotation, this.spinSegmentIds)
      if (id && id !== this.lastTickSegment) {
        this.lastTickSegment = id
        this.onTick(id)
        this.playTick(t, t > SLOWMO_START)
        this.vibrate(8) // felt drumroll on mobile; no-op on desktop
      }

      if (t < 1) {
        requestAnimationFrame(frame)
      } else {
        // Hitstop: a sub-100ms freeze a hair past the resting angle converts the
        // smooth coast into a felt "landed" hit, then we settle onto target.
        // Skipped under reduced motion (resolve immediately).
        const settle = () => {
          this.currentRotation = target
          if (this.wheelGroup) {
            this.wheelGroup.rotation.z = target
            this.wheelGroup.scale.set(1, 1, 1)
          }
          this.isSpinAnimating = false
          if (this.controls) this.controls.enabled = true
          if (this.bloomPass) this.bloomPass.strength = 0.6 // back to resting glow
          this.playThunk()
          this.vibrate([30, 40, 18]) // landing impact in the palm
          this.onTick(null)
          onComplete()
          if (this.onSpinComplete) this.onSpinComplete(winnerId)
          this.markDirty()
        }
        if (reduced) { settle(); return }
        const overshoot = dir * (0.5 * Math.PI / 180) // ~0.5deg past rest
        this.currentRotation = target + overshoot
        if (this.wheelGroup) this.wheelGroup.rotation.z = target + overshoot
        this.markDirty()
        setTimeout(settle, 70)
      }
    }
    // wind up stub
    setTimeout(() => requestAnimationFrame(frame), windDur)
  }

  // expose for App / parent
  resetView() {
    if (!this.camera || !this.controls) return
    this.camera.position.set(0, 0, this.homeCamZ)
    this.camera.lookAt(0, 0, 0)
    this.controls.update()
    this.currentRotation = 0
    if (this.wheelGroup) {
      this.wheelGroup.rotation.z = 0
      this.wheelGroup.scale.set(1, 1, 1)
    }
    this.markDirty()
  }

  captureCanvas(): HTMLCanvasElement | null {
    return this.renderer ? this.renderer.domElement : null
  }

  dismissWinner() {
    // caller will clear winner; just reset highlight state
    this.setHighlight(null)
    this.markDirty()
  }

  // allow parent to drive mute
  toggleMute() {
    this.isMuted = !this.isMuted
    try { localStorage.setItem(this.muteKey, this.isMuted ? '1' : '0') } catch {}
  }

  private onCanvasClick(_e: MouseEvent) {
    // simple: emit spin click if needed (App maps to spin)
    // For now just a no-op or future left/right
    if (this.onSpinClick) {
      // heuristic: left or right side of screen
      const dir = (_e.clientX > (window.innerWidth / 2)) ? 'right' : 'left'
      this.onSpinClick(dir)
    }
  }

  private onCanvasMouseMove(_e: MouseEvent) {
    if (!this.renderer || !this.camera || this.isSpinAnimating) return
    // very light hover lift (raycast simplified)
    // full raycast port would be long; we rely on peekId prop via setHighlight from parent
  }

  private startRenderLoop() {
    const loop = () => {
      this.animFrameId = requestAnimationFrame(loop)
      if (this.controls) this.controls.update()
      if (this.needsRender && this.renderer && this.scene && this.camera) {
        if (this.composer) this.composer.render()
        else this.renderer.render(this.scene, this.camera)
        this.needsRender = false
      }
    }
    loop()
  }

  dispose() {
    cancelAnimationFrame(this.animFrameId)
    if (this.audioResume) {
      window.removeEventListener('pointerdown', this.audioResume)
      window.removeEventListener('keydown', this.audioResume)
      this.audioResume = null
    }
    if (this.audioCtx) { this.audioCtx.close().catch(() => {}) }
    if (this.controls) this.controls.dispose()
    if (this.renderer) {
      this.renderer.domElement.remove()
      this.renderer.dispose()
    }
    this.cachedMaterials.forEach(m => (m as any).dispose && (m as any).dispose())
    this.cachedMaterials.clear()
    this.segGeoCache.forEach(g => g.dispose())
    this.segGeoCache.clear()
    if (this.sharedDividerGeo) this.sharedDividerGeo.dispose()
    if (this.sharedPegGeo) this.sharedPegGeo.dispose()
    if (this.sharedPegMat) this.sharedPegMat.dispose()
  }
}

export default ThreeWheelRenderer