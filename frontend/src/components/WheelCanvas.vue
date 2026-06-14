<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import opentype from 'opentype.js'
import type { Participant } from '../types'
import { identityColor } from '../utils/identity'

const props = defineProps<{
  participants: Participant[]
  spinning: boolean
  winnerId: string | null
  // Participant id of the roster row the cursor is hovering (null when none), so
  // the matching wheel segment lifts and glows in sympathy. Reuses the same
  // pointer-hover ease path as on-canvas hovering.
  peekId?: string | null
}>()

const emit = defineEmits<{
  (e: 'spin-complete', participantId: string): void
  (e: 'spin-click', direction: 'left' | 'right'): void
  (e: 'winner-reveal', data: { id: string; name: string; remaining: number }): void
  (e: 'camera-drifted', drifted: boolean): void
  // Participant id of the segment currently under the pointer during a spin
  // (null once the spin ends), so the roster can flash the matching row in sync.
  (e: 'tick-segment', participantId: string | null): void
}>()

const containerRef = ref<HTMLDivElement | null>(null)

// Spin sound: a rising peg tick (playTick) ramping into a low thunk on landing
// (playThunk). Muting is persisted so the preference survives reloads, and is
// surfaced to the parent through isMuted/toggleMute for the action-dock button.
const MUTE_KEY = 'wheel-muted'
function readMuted(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(MUTE_KEY) === '1'
  } catch {
    return false
  }
}
const isMuted = ref(readMuted())
function toggleMute() {
  isMuted.value = !isMuted.value
  // The whoosh is a continuous bed, so muting mid-spin must silence it directly
  // (the one-shot voices already self-gate on their next call).
  if (isMuted.value) stopWhoosh()
  try {
    localStorage.setItem(MUTE_KEY, isMuted.value ? '1' : '0')
  } catch {
    // Persistence unavailable (private mode / blocked) — keep the in-memory flag.
  }
}

let renderer: THREE.WebGLRenderer | null = null
let composer: EffectComposer | null = null
// Bloom pass held so animateSpin can surge its strength with the wheel's
// energy: bright at launch, easing back to BLOOM_BASE as the spin decelerates.
// Null under reduced motion (the pass is never added to the chain there).
let bloomPass: UnrealBloomPass | null = null
const BLOOM_BASE = 0.55
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let wheelGroup: THREE.Group | null = null
let pointerMesh: THREE.Mesh | null = null
let pegPivot: THREE.Group | null = null // hinge that lets the pointer flap
let pegMeshes: THREE.Mesh[] = []
let donutMeshes: THREE.Mesh[] = [] // per-segment odds-donut arcs around the hub
// Pre-roll countdown ring: a single thin arc tucked just inside the inner rim
// that sweeps from 0 to 2π during the wind-up pre-roll. Built lazily on first
// spin, parked invisible between spins, and disposed on unmount.
let countdownRing: THREE.Mesh | null = null
let countdownRingMat: THREE.MeshBasicMaterial | null = null
let pegSpacing = 0 // angular gap between pegs during the active spin
let prevPegSign = 0 // sign of the nearest-peg offset, to detect crossings
// Squash-and-stretch on the pointer tip. squash is a signed scalar (+contact
// compresses the tip, the spring overshoots negative into a stretch on release);
// squashVel integrates it frame to frame so the rebound is springy, not linear.
let squash = 0
let squashVel = 0
let lastFlapTime = 0 // performance.now() of the previous updateFlapper, for dt
// Active participant ids in segment order, captured at spin start so updateFlapper
// can name the segment currently under the pointer for the roster-row spotlight.
let spinSegmentIds: string[] = []
let lastTickSegment: string | null = null
let audioCtx: AudioContext | null = null
// Doppler whoosh bed: a looping white-noise source through a band-pass filter,
// held while the wheel spins so its cutoff/gain can track the angular velocity
// each frame. Nodes are created on startWhoosh and torn down on stopWhoosh; the
// noise buffer is cached and reused across spins.
let whooshNoiseBuffer: AudioBuffer | null = null
let whooshSource: AudioBufferSourceNode | null = null
let whooshFilter: BiquadFilterNode | null = null
let whooshGain: GainNode | null = null
let pivotGroup: THREE.Group | null = null
let controls: OrbitControls | null = null
let spinBtnLeft: THREE.Mesh | null = null
let spinBtnRight: THREE.Mesh | null = null
let raycaster: THREE.Raycaster | null = null
let spinDirection: 1 | -1 = 1
// Scene lights held at module scope so the winner reveal can dim the room and
// raise a per-winner spotlight, then restore them on dismiss.
let ambientLight: THREE.AmbientLight | null = null
let keyLight: THREE.DirectionalLight | null = null
let spotLight: THREE.PointLight | null = null
// Velocity-reactive streak ring: a thin additive annulus parked at the rim,
// invisible at rest. Its opacity and scale are driven each spin frame from the
// per-frame angular delta so a fast spin smears a bright halo at the wheel's
// edge, fading to nothing as it decelerates. Lives on pivotGroup (not
// wheelGroup) so it stays a fixed ring while the wheel turns behind it.
let streakRing: THREE.Mesh | null = null
let streakRingMat: THREE.MeshBasicMaterial | null = null
const ambientBaseIntensity = 0.7
const keyBaseIntensity = 1.0
let otFont: opentype.Font | null = null
let animFrameId = 0

// Cached reusable objects
const cachedMaterials = new Map<string, THREE.Material>()
let cachedCenterGroup: THREE.Group | null = null
let cachedLineMat: THREE.LineBasicMaterial | null = null

function getCachedMat(color: string, metalness: number, roughness: number): THREE.MeshStandardMaterial {
  const key = `${color}_${metalness}_${roughness}`
  if (!cachedMaterials.has(key)) {
    cachedMaterials.set(key, new THREE.MeshStandardMaterial({ color, metalness, roughness }))
  }
  return cachedMaterials.get(key) as THREE.MeshStandardMaterial
}

function getLineMat(): THREE.LineBasicMaterial {
  if (!cachedLineMat) cachedLineMat = new THREE.LineBasicMaterial({ color: 0xffffff })
  return cachedLineMat
}

// Text labels reuse one shared black material plus one per fill color, instead
// of allocating two MeshBasicMaterials per label on every rebuild.
let cachedTextBlackMat: THREE.MeshBasicMaterial | null = null
const cachedTextColorMats = new Map<string, THREE.MeshBasicMaterial>()

function getTextMats(color: string): [THREE.MeshBasicMaterial, THREE.MeshBasicMaterial] {
  if (!cachedTextBlackMat) {
    cachedTextBlackMat = new THREE.MeshBasicMaterial({ color: '#000000', side: THREE.DoubleSide })
  }
  let colorMat = cachedTextColorMats.get(color)
  if (!colorMat) {
    colorMat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })
    cachedTextColorMats.set(color, colorMat)
  }
  return [cachedTextBlackMat, colorMat]
}

function getCenterGroup(): THREE.Group {
  if (cachedCenterGroup) return cachedCenterGroup.clone(true)

  cachedCenterGroup = new THREE.Group()

  const innerRimGeo = new THREE.TorusGeometry(WHEEL_INNER, 0.04, 12, 64)
  cachedCenterGroup.add(new THREE.Mesh(innerRimGeo, getCachedMat('#bdc3c7', 0.6, 0.25)))

  const hubShape = new THREE.Shape()
  hubShape.absarc(0, 0, WHEEL_INNER - 0.02, 0, Math.PI * 2, false)
  const hubGeo = new THREE.ExtrudeGeometry(hubShape, { depth: WHEEL_DEPTH * 0.6, bevelEnabled: true, bevelThickness: 0.02, bevelSize: 0.02, bevelSegments: 2 })
  const hub = new THREE.Mesh(hubGeo, getCachedMat('#c0c0c0', 0.8, 0.15))
  hub.position.z = -(WHEEL_DEPTH * 0.6) / 2
  cachedCenterGroup.add(hub)

  const pinGeo = new THREE.CylinderGeometry(0.08, 0.08, WHEEL_DEPTH + 0.15, 16)
  const pin = new THREE.Mesh(pinGeo, getCachedMat('#e0e0e0', 0.9, 0.1))
  pin.rotation.x = Math.PI / 2
  cachedCenterGroup.add(pin)

  const rimGeo = new THREE.TorusGeometry(WHEEL_RADIUS + 0.02, 0.045, 12, 80)
  cachedCenterGroup.add(new THREE.Mesh(rimGeo, getCachedMat('#bdc3c7', 0.6, 0.25)))

  // Clones share these geometries/materials — protect them from clearGroup.
  cachedCenterGroup.children.forEach((c) => { c.userData.sharedGeometry = true })

  return cachedCenterGroup.clone(true)
}
let currentRotation = 0
let isSpinAnimating = false
let segmentMeshes: THREE.Mesh[] = []
let dividerLines: (THREE.Line | null)[] = []
let lastAzimuth = 0
let azimuthVelocity = 0
let isPointerDown = false
let flickCooldown = 0
const BASE_CAM_Z = 7.8
let homeCamZ = BASE_CAM_Z
const FLICK_THRESHOLD = 0.06 // radians per frame — trigger spin
// Fraction of the main spin after which animateSpin re-maps the easing through
// a second, slower deceleration so the wheel creeps into the landing peg.
const SLOWMO_START = 0.82
// Snap-home: once the orbit camera drifts off its resting framing we surface a
// reset pill. Tracked with hysteresis so a single threshold-straddling frame
// doesn't flicker the pill on and off.
let cameraDrifted = false
let isResettingView = false
const CAM_DRIFT_ON = 0.6 // distance from home that raises the pill
const CAM_DRIFT_OFF = 0.15 // distance below which it is considered home again

// Magnetic snap: while the camera is idle and only slightly off its head-on
// framing (azimuth 0, polar π/2) it is gently pulled back to that orientation,
// like a Figma viewport detent. Engages only inside SNAP_CAPTURE on both axes
// so deliberate orbits beyond it are left alone (and surface the reset pill
// instead). A dead zone keeps it from fighting micro-offsets and lets the
// render-on-demand loop settle.
const SNAP_TARGET_AZIMUTH = 0
const SNAP_TARGET_POLAR = Math.PI / 2
const SNAP_CAPTURE = 0.28 // radians; orbit further than this is intentional
const SNAP_DEADZONE = 0.004 // radians; below this we consider it settled
const SNAP_PULL = 1.1 // per-frame fraction of the gap (pre-damping)

const WHEEL_RADIUS = 2.2
const WHEEL_INNER = 0.6
const WHEEL_DEPTH = 0.3

// Odds donut: a thin per-segment ring hugging the hub, each arc tinted to the
// participant's identity color so the colors read as a compact legend around
// the center (Stripe-style). Sits just outside the inner rim and just proud of
// the wheel face so it catches the light.
const DONUT_INNER = WHEEL_INNER + 0.06
const DONUT_OUTER = WHEEL_INNER + 0.22
const DONUT_GAP = 0.04 // radians trimmed off each arc end so segments separate

// Pre-roll countdown ring: a thin arc tucked just inside the inner rim that
// sweeps closed over COUNTDOWN_MS before the wind-up launches (Apple-keynote
// "get ready" beat). Skipped under reduced motion.
const COUNTDOWN_INNER = WHEEL_INNER - 0.1
const COUNTDOWN_OUTER = WHEEL_INNER - 0.04
const COUNTDOWN_MS = 700


const textGeoCache = new Map<string, THREE.BufferGeometry>()
const textWidthCache = new Map<string, number>()

// Render-on-demand: skip renderer.render when nothing changed
let needsRender = true
function markDirty() {
  needsRender = true
}

// Accessibility: when the OS requests reduced motion we collapse the long,
// camera-swinging animations (coin drop, multi-spin, settle rock) into short
// near-instant transitions and skip the bloom pass. Read live so toggling the
// OS setting takes effect on the next spin without a reload.
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

// Curved (arc-bent) text geometry depends only on (text, size, depth) — the
// bend radius is constant — so it is cached and shared between rebuilds.
const curvedTextGeoCache = new Map<string, THREE.BufferGeometry>()
const segGeoCache = new Map<number, THREE.ExtrudeGeometry>()
let sharedDividerGeo: THREE.BufferGeometry | null = null

// ShapePath.toShapes assumes consistent contour winding, but Roboto (like
// many Google fonts) ships glyphs with unremoved overlaps: stems and
// crossbars are separate same-winding contours that overlap, and only true
// counters (inside of О etc.) wind the opposite way. One opposite-winding
// contour in a name made toShapes(false) collapse the whole name into a
// single shape with every other letter as a hole, producing black blobs.
// Instead: contours with the dominant winding sign are independent solids;
// opposite-sign contours become holes of the smallest solid containing them.
function pointInPolygon(p: THREE.Vector2, poly: THREE.Vector2[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if ((a.y > p.y) !== (b.y > p.y) && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

function shapePathToShapes(shapePath: THREE.ShapePath): THREE.Shape[] {
  const subPaths = shapePath.subPaths.filter((sp) => sp.curves.length > 0)
  const pts = subPaths.map((sp) => sp.getPoints())
  const areas = pts.map((p) => THREE.ShapeUtils.area(p))
  const n = subPaths.length

  // Dominant winding = winding of the contour with the largest absolute area
  let domSign = 1
  let maxAbs = 0
  for (const a of areas) {
    if (Math.abs(a) > maxAbs) {
      maxAbs = Math.abs(a)
      domSign = Math.sign(a) || 1
    }
  }

  const shapes: THREE.Shape[] = []
  const solidIdx: number[] = [] // subPath index per shape
  for (let i = 0; i < n; i++) {
    if (Math.sign(areas[i]) !== domSign && areas[i] !== 0) continue
    const shape = new THREE.Shape()
    shape.curves = subPaths[i].curves
    solidIdx.push(i)
    shapes.push(shape)
  }
  for (let i = 0; i < n; i++) {
    if (Math.sign(areas[i]) === domSign || areas[i] === 0) continue
    // Attach to the smallest solid that contains this contour
    let best = -1
    let bestArea = Infinity
    for (let s = 0; s < solidIdx.length; s++) {
      const j = solidIdx[s]
      const abs = Math.abs(areas[j])
      if (abs <= Math.abs(areas[i]) || abs >= bestArea) continue
      if (pointInPolygon(pts[i][0], pts[j])) {
        best = s
        bestArea = abs
      }
    }
    if (best !== -1) {
      const hole = new THREE.Path()
      hole.curves = subPaths[i].curves
      shapes[best].holes.push(hole)
    } else {
      // No container found: keep it solid rather than dropping geometry
      const shape = new THREE.Shape()
      shape.curves = subPaths[i].curves
      shapes.push(shape)
      solidIdx.push(i)
    }
  }
  return shapes
}

function getTextGeometry(text: string, size: number, depth: number): THREE.BufferGeometry | null {
  if (!otFont) return null
  const key = `${text}_${size}_${depth}`
  if (textGeoCache.has(key)) return textGeoCache.get(key)!

  // ShapePath handles holes (О, А, Б, etc.). X is mirrored so the text reads
  // correctly after the arc bend reverses its direction.
  const otPath = otFont.getPath(text, 0, 0, size)
  const textW = measureTextWidth(text, size)

  const shapePath = new THREE.ShapePath()

  for (const cmd of otPath.commands) {
    switch (cmd.type) {
      case 'M': shapePath.moveTo(-(cmd.x - textW / 2), -cmd.y); break
      case 'L': shapePath.lineTo(-(cmd.x - textW / 2), -cmd.y); break
      case 'Q': shapePath.quadraticCurveTo(-(cmd.x1 - textW / 2), -cmd.y1, -(cmd.x - textW / 2), -cmd.y); break
      case 'C': shapePath.bezierCurveTo(-(cmd.x1 - textW / 2), -cmd.y1, -(cmd.x2 - textW / 2), -cmd.y2, -(cmd.x - textW / 2), -cmd.y); break
      case 'Z': break
    }
  }

  const shapes = shapePathToShapes(shapePath)
  if (shapes.length === 0) return null

  const geo = new THREE.ExtrudeGeometry(shapes, {
    depth,
    bevelEnabled: true,
    bevelThickness: depth * 0.15,
    bevelSize: depth * 0.12,
    bevelSegments: 1,
  })
  geo.computeBoundingBox()
  const bb = geo.boundingBox!
  geo.translate(-(bb.max.x + bb.min.x) / 2, -(bb.max.y + bb.min.y) / 2, 0)

  textGeoCache.set(key, geo)
  return geo
}

function getCurvedTextGeometry(text: string, size: number, depth: number): THREE.BufferGeometry | null {
  const key = `${text}_${size}_${depth}`
  const cached = curvedTextGeoCache.get(key)
  if (cached) return cached

  const srcGeo = getTextGeometry(text, size, depth)
  if (!srcGeo) return null
  const curvedGeo = srcGeo.clone()

  // Assign material groups using pre-bend normals. Bent-position based
  // classification misclassifies bevels (mid-Z position but cap-facing
  // normal) and leaks segment colour onto letter edges.
  // Reorder triangles so all cap faces come first, then all side faces.
  // This yields exactly two material groups — interleaved groups produce
  // a draw call per run (tens of thousands per frame in the worst case).
  const origNormals = curvedGeo.getAttribute('normal')
  const idx = curvedGeo.getIndex()
  curvedGeo.clearGroups()
  const faceCount = idx ? idx.count / 3 : origNormals.count / 3
  const faceMat = new Uint8Array(faceCount)
  let capFaces = 0
  for (let ti = 0; ti < faceCount; ti++) {
    const i0 = idx ? idx.getX(ti * 3) : ti * 3
    const i1 = idx ? idx.getY(ti * 3) : ti * 3 + 1
    const i2 = idx ? idx.getZ(ti * 3) : ti * 3 + 2
    const nz = (Math.abs(origNormals.getZ(i0))
              + Math.abs(origNormals.getZ(i1))
              + Math.abs(origNormals.getZ(i2))) / 3
    const mat = nz > 0.5 ? 0 : 1
    faceMat[ti] = mat
    if (mat === 0) capFaces++
  }
  if (!idx) {
    // ExtrudeGeometry is non-indexed: physically reorder the vertex data.
    const attrNames = Object.keys(curvedGeo.attributes)
    for (const name of attrNames) {
      const attr = curvedGeo.getAttribute(name) as THREE.BufferAttribute
      const itemSize = attr.itemSize
      const src = attr.array as Float32Array
      const dst = new Float32Array(src.length)
      let cap = 0
      let side = capFaces
      for (let ti = 0; ti < faceCount; ti++) {
        const dstFace = faceMat[ti] === 0 ? cap++ : side++
        const from = ti * 3 * itemSize
        const to = dstFace * 3 * itemSize
        for (let k = 0; k < 3 * itemSize; k++) dst[to + k] = src[from + k]
      }
      curvedGeo.setAttribute(name, new THREE.BufferAttribute(dst, itemSize))
    }
    curvedGeo.addGroup(0, capFaces * 3, 0)
    curvedGeo.addGroup(capFaces * 3, (faceCount - capFaces) * 3, 1)
  } else {
    // Indexed fallback: reorder the index buffer only.
    const srcIdx = idx.array
    const dstIdx = new (srcIdx.constructor as any)(srcIdx.length)
    let cap = 0
    let side = capFaces
    for (let ti = 0; ti < faceCount; ti++) {
      const dstFace = faceMat[ti] === 0 ? cap++ : side++
      dstIdx[dstFace * 3] = srcIdx[ti * 3]
      dstIdx[dstFace * 3 + 1] = srcIdx[ti * 3 + 1]
      dstIdx[dstFace * 3 + 2] = srcIdx[ti * 3 + 2]
    }
    curvedGeo.setIndex(new THREE.BufferAttribute(dstIdx, 1))
    curvedGeo.addGroup(0, capFaces * 3, 0)
    curvedGeo.addGroup(capFaces * 3, (faceCount - capFaces) * 3, 1)
  }

  const arcR = WHEEL_INNER + (WHEEL_RADIUS - WHEEL_INNER) * 0.65
  const pos = curvedGeo.getAttribute('position')
  const r = arcR * 100
  for (let vi = 0; vi < pos.count; vi++) {
    const x = pos.getX(vi)
    const y = pos.getY(vi)
    const angle = x / r
    const radius = r + y
    pos.setX(vi, Math.cos(angle) * radius)
    pos.setY(vi, Math.sin(angle) * radius)
  }
  pos.needsUpdate = true

  curvedTextGeoCache.set(key, curvedGeo)
  return curvedGeo
}

// Segment geometry built at start angle 0 and cached by quantized slice
// angle; the mesh itself is rotated into place. During the shrink animation
// every frame has only two distinct slice angles, so rebuilds become
// cache hits instead of fresh ExtrudeGeometry tessellations.
const SEG_GEO_CACHE_LIMIT = 64

function getSegmentGeometry(segAngle: number): THREE.ExtrudeGeometry {
  const key = Math.round(segAngle * 2048)
  const cached = segGeoCache.get(key)
  if (cached) return cached
  // During the shrink animation every frame produces new angles; evict
  // oldest entries so the cache stays bounded.
  if (segGeoCache.size >= SEG_GEO_CACHE_LIMIT) {
    const oldestKey = segGeoCache.keys().next().value!
    segGeoCache.get(oldestKey)!.dispose()
    segGeoCache.delete(oldestKey)
  }

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
  segGeoCache.set(key, geo)
  return geo
}

function getDividerGeo(): THREE.BufferGeometry {
  if (!sharedDividerGeo) {
    sharedDividerGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(WHEEL_INNER, 0, WHEEL_DEPTH / 2 + 0.01),
      new THREE.Vector3(WHEEL_RADIUS, 0, WHEEL_DEPTH / 2 + 0.01),
    ])
  }
  return sharedDividerGeo
}

// Pegs studded around the rim at each segment boundary; the pointer flaps off
// them as the wheel turns. Geometry/material are shared across all pegs.
let sharedPegGeo: THREE.CylinderGeometry | null = null
let sharedPegMat: THREE.MeshStandardMaterial | null = null

function getPegGeo(): THREE.CylinderGeometry {
  if (!sharedPegGeo) {
    // Cylinder axis is Y by default; we rotate it to point along +Z (toward
    // the viewer) so each peg reads as a little stud on the wheel face.
    sharedPegGeo = new THREE.CylinderGeometry(0.045, 0.055, 0.16, 12)
  }
  return sharedPegGeo
}

function getPegMat(): THREE.MeshStandardMaterial {
  if (!sharedPegMat) {
    sharedPegMat = new THREE.MeshStandardMaterial({ color: '#d0d3d4', metalness: 0.85, roughness: 0.25 })
  }
  return sharedPegMat
}

function measureTextWidth(text: string, size: number): number {
  if (!otFont) return 0
  const key = `${text}_${size}`
  const cached = textWidthCache.get(key)
  if (cached !== undefined) return cached
  const bb = otFont.getPath(text, 0, 0, size).getBoundingBox()
  const w = bb.x2 - bb.x1
  textWidthCache.set(key, w)
  return w
}

function disposeChild(obj: THREE.Object3D) {
  // Geometries and materials from the shared caches outlive the rebuild.
  if (obj.userData.sharedGeometry) {
    obj.children.forEach(disposeChild)
    return
  }
  if (obj instanceof THREE.Mesh) {
    obj.geometry.dispose()
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
    mats.forEach((m) => {
      if (m.map) m.map.dispose()
      m.dispose()
    })
    obj.children.forEach(disposeChild)
  }
  if (obj instanceof THREE.Line) {
    obj.geometry.dispose()
    if (obj.material instanceof THREE.Material) obj.material.dispose()
  }
}

function clearGroup(group: THREE.Group) {
  while (group.children.length > 0) {
    const child = group.children[0]
    group.remove(child)
    disposeChild(child)
  }
}

function resetSegments() {
  for (const seg of segmentMeshes) {
    seg.position.z = -WHEEL_DEPTH / 2
  }
}

// Build wheel with custom per-segment angles. If no angles given, equal slices.
function buildWheelWithAngles(
  active: { id: string; name: string }[],
  angles?: number[], // radian size per segment
) {
  if (!wheelGroup) return
  const group: THREE.Group = wheelGroup
  clearGroup(group)
  segmentMeshes = []
  dividerLines = []
  pegMeshes = []
  donutMeshes = []
  // Old segment meshes are gone; drop any dangling hover reference so the
  // ease loop doesn't touch a disposed mesh.
  hoveredSeg = null
  markDirty()

  if (active.length === 0) {
    const shape = new THREE.Shape()
    shape.absarc(0, 0, WHEEL_RADIUS, 0, Math.PI * 2, false)
    const geo = new THREE.ExtrudeGeometry(shape, { depth: WHEEL_DEPTH, bevelEnabled: false })
    const mat = new THREE.MeshStandardMaterial({ color: '#2d3436' })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.z = -WHEEL_DEPTH / 2
    wheelGroup.add(mesh)
    addWheelCenter()
    return
  }

  const sliceAngle = (Math.PI * 2) / active.length
  let cursor = 0
  // Per-segment arcs for the odds donut, collected as the segments are laid
  // out so the ring reuses the exact same start angles and colors.
  const donutArcs: { start: number; end: number; color: string }[] = []

  // Uniform text sizing based on sliceAngle (not per-segment angles[i]) so
  // size stays stable during shrink animation. Shrink down first, then
  // truncate names that still overflow.
  const arcR = WHEEL_INNER + (WHEEL_RADIUS - WHEEL_INNER) * 0.65
  const textDepth = 4
  const baseTextSize = Math.min(28, Math.max(14, 110 / active.length))
  const maxArcWidth = sliceAngle * 0.85 * arcR * 100
  const displayNames: string[] = active.map((p) =>
    p.name.length > 20 ? p.name.slice(0, 19) + '…' : p.name,
  )
  let textSize = baseTextSize
  if (otFont) {
    let scale = 1
    for (const n of displayNames) {
      const w = measureTextWidth(n, baseTextSize)
      if (w > maxArcWidth) scale = Math.min(scale, maxArcWidth / w)
    }
    textSize = Math.max(10, baseTextSize * scale)
    for (let i = 0; i < displayNames.length; i++) {
      while (displayNames[i].length > 1 && measureTextWidth(displayNames[i], textSize) > maxArcWidth) {
        const base = displayNames[i].replace(/…$/, '')
        displayNames[i] = base.slice(0, -1) + '…'
      }
    }
  }

  active.forEach((p, i) => {
    const segAngle = angles ? angles[i] : sliceAngle
    if (segAngle < 0.005) {
      // Too small to render — skip but keep index
      cursor += segAngle
      segmentMeshes.push(null as any)
      dividerLines.push(null)
      return
    }
    const startAngle = cursor
    cursor += segAngle
    const color = identityColor(p.name)
    donutArcs.push({ start: startAngle, end: startAngle + segAngle, color })

    const mesh = new THREE.Mesh(getSegmentGeometry(segAngle), getCachedMat(color, 0.1, 0.55))
    mesh.position.z = -WHEEL_DEPTH / 2
    mesh.rotation.z = startAngle
    mesh.userData.participantId = p.id
    mesh.userData.segmentIndex = i
    mesh.userData.sharedGeometry = true
    segmentMeshes.push(mesh)
    group.add(mesh)

    // Divider line (shared geometry, rotated into place)
    const line = new THREE.Line(getDividerGeo(), getLineMat())
    line.rotation.z = startAngle
    line.userData.sharedGeometry = true
    group.add(line)
    dividerLines.push(line)

    // Peg studded on the rim at this boundary; the pointer flaps off it.
    const peg = new THREE.Mesh(getPegGeo(), getPegMat())
    peg.rotation.x = Math.PI / 2 // point the cylinder along +Z
    peg.position.set(
      Math.cos(startAngle) * WHEEL_RADIUS,
      Math.sin(startAngle) * WHEEL_RADIUS,
      WHEEL_DEPTH / 2 + 0.05,
    )
    peg.userData.sharedGeometry = true
    group.add(peg)
    pegMeshes.push(peg)

    const name = displayNames[i]
    const curvedGeo = getCurvedTextGeometry(name, textSize, textDepth)
    if (curvedGeo) {
      const textMesh = new THREE.Mesh(curvedGeo, getTextMats(color))
      textMesh.scale.set(1 / 100, 1 / 100, 1 / 100)
      textMesh.position.z = WHEEL_DEPTH + 0.02
      // Parent segment is rotated by startAngle, so only the half-slice
      // offset remains.
      textMesh.rotation.z = segAngle / 2
      textMesh.userData.sharedGeometry = true
      mesh.add(textMesh)
    }
  })

  addOddsDonut(donutArcs)
  addWheelCenter()
  markDirty()
}

// Build the odds donut: one short ring arc per segment, tinted to that
// segment's identity color. Geometry and materials are created fresh per build
// (not from the shared caches), so clearGroup/disposeChild reclaim them on the
// next rebuild without touching the cached segment/text resources.
function addOddsDonut(arcs: { start: number; end: number; color: string }[]) {
  if (!wheelGroup || arcs.length === 0) return
  // A single arc spanning the whole ring would have no visible seam; keep the
  // gap only when there is more than one participant.
  const gap = arcs.length > 1 ? DONUT_GAP : 0
  for (const arc of arcs) {
    const span = arc.end - arc.start - gap
    if (span <= 0.001) continue
    const geo = new THREE.RingGeometry(DONUT_INNER, DONUT_OUTER, 32, 1, arc.start + gap / 2, span)
    const mat = new THREE.MeshStandardMaterial({ color: arc.color, metalness: 0.2, roughness: 0.45 })
    const ring = new THREE.Mesh(geo, mat)
    // Lift just proud of the wheel face so the donut catches the key light.
    ring.position.z = WHEEL_DEPTH / 2 + 0.012
    wheelGroup.add(ring)
    donutMeshes.push(ring)
  }
}

function addWheelCenter() {
  if (!wheelGroup) return
  wheelGroup.add(getCenterGroup())
}

// Set the countdown ring's visible sweep to `frac` (0..1) of a full turn,
// rebuilding its arc geometry each step. Lives in pivotGroup (not wheelGroup) so
// the sweep angle is independent of the wheel's own rotation. Built lazily on
// first use and parked invisible (frac <= 0).
function setCountdownArc(frac: number) {
  if (!pivotGroup) return
  if (!countdownRing) {
    countdownRingMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.85,
    })
    countdownRing = new THREE.Mesh(new THREE.BufferGeometry(), countdownRingMat)
    // Sit just proud of the wheel face, in front of the hub.
    countdownRing.position.z = WHEEL_DEPTH / 2 + 0.02
    countdownRing.visible = false
    pivotGroup.add(countdownRing)
  }
  const f = Math.max(0, Math.min(1, frac))
  if (f <= 0) {
    countdownRing.visible = false
    return
  }
  // Sweep clockwise from the top (12 o'clock) so it reads as a winding-up dial.
  const start = Math.PI / 2
  const span = f * Math.PI * 2
  countdownRing.geometry.dispose()
  countdownRing.geometry = new THREE.RingGeometry(
    COUNTDOWN_INNER,
    COUNTDOWN_OUTER,
    48,
    1,
    start - span,
    span,
  )
  countdownRing.visible = true
  markDirty()
}

function buildWheel() {
  const active = props.participants.filter((p) => !p.removed)
  buildWheelWithAngles(active)
}

// Animate: winner segment shrinks, others expand, then emit result.
//
// Updates the existing segment meshes in place (geometry + rotation) instead
// of tearing down and rebuilding the whole wheel every frame, so the only
// per-frame allocation is the (cache-bounded) wedge geometry for the two
// distinct angles in flight.
function animateSegmentShrink(winnerId: string, callback: () => void) {
  const active = props.participants.filter((p) => !p.removed)
  const winIdx = active.findIndex((p) => p.id === winnerId)
  if (winIdx === -1) { callback(); return }

  const count = active.length
  const baseAngle = (Math.PI * 2) / count
  const duration = 800
  const startTime = performance.now()

  // Pegs and donut arcs sit at the original boundaries; hide them while the
  // segments slide to new angles in place (buildWheel re-creates them after).
  for (const peg of pegMeshes) peg.visible = false
  for (const ring of donutMeshes) ring.visible = false

  // The winner's label fades out. Give it private transparent materials so
  // mutating opacity never touches the shared cached text materials used by
  // every other label. They are disposed when the animation completes.
  const fadeMats: THREE.MeshBasicMaterial[] = []
  const winMesh = segmentMeshes[winIdx]
  if (winMesh) {
    // Undo the lift applied by animateWinnerReveal so the winner shrinks flat.
    winMesh.position.z = -WHEEL_DEPTH / 2
    // Drop the private emissive clone and restore the shared cached material.
    const baseMaterial = winMesh.userData.baseMaterial as THREE.MeshStandardMaterial | undefined
    if (baseMaterial) {
      ;(winMesh.material as THREE.MeshStandardMaterial).dispose()
      winMesh.material = baseMaterial
      delete winMesh.userData.baseMaterial
    }
    for (const child of winMesh.children) {
      if (!(child instanceof THREE.Mesh)) continue
      const orig = Array.isArray(child.material) ? child.material : [child.material]
      const cloned = orig.map((m) => {
        const c = (m as THREE.MeshBasicMaterial).clone()
        c.transparent = true
        return c
      })
      child.material = cloned
      cloned.forEach((c) => fadeMats.push(c))
    }
  }

  function frame(now: number) {
    markDirty()
    const t = Math.min((now - startTime) / duration, 1)
    const eased = 1 - Math.pow(1 - t, 2)

    // Winner shrinks to 0, others grow proportionally.
    const winAngle = baseAngle * (1 - eased)
    const extraPerOther = (baseAngle * eased) / (count - 1 || 1)

    let cursor = 0
    for (let i = 0; i < count; i++) {
      const segAngle = i === winIdx ? winAngle : baseAngle + extraPerOther
      const startAngle = cursor
      cursor += segAngle

      const mesh = segmentMeshes[i]
      const line = dividerLines[i]
      if (!mesh) continue

      if (segAngle < 0.005) {
        mesh.visible = false
        if (line) line.visible = false
        continue
      }

      mesh.visible = true
      mesh.geometry = getSegmentGeometry(segAngle)
      mesh.rotation.z = startAngle
      if (line) {
        line.visible = true
        line.rotation.z = startAngle
      }
      // Text child keeps the half-slice offset within its rotated parent.
      for (const child of mesh.children) {
        if (child instanceof THREE.Mesh) child.rotation.z = segAngle / 2
      }
    }

    fadeMats.forEach((m) => { m.opacity = 1 - eased })

    if (t < 1) {
      requestAnimationFrame(frame)
    } else {
      fadeMats.forEach((m) => m.dispose())
      callback()
    }
  }

  requestAnimationFrame(frame)
}

const MENU_WIDTH = 360 // 320px panel + 20px gap + margin
const PADDING = 40 // extra breathing room in pixels
const CAM_FOV = 38

function fitWheel() {
  if (!camera || !pivotGroup) return

  const vw = window.innerWidth
  const vh = window.innerHeight

  // Available space for wheel
  const availW = vw - MENU_WIDTH - PADDING * 2
  const availH = vh - PADDING * 2

  // World size of wheel (diameter + hinged pointer + margin)
  const wheelWorld = (WHEEL_RADIUS + 0.6) * 2

  // At BASE_CAM_Z, how much world space is visible?
  const vFov = (CAM_FOV * Math.PI) / 180
  const visibleH = 2 * Math.tan(vFov / 2) * BASE_CAM_Z
  const visibleW = visibleH * (vw / vh)

  // Wheel in pixels at base distance
  const wheelPixelsH = (wheelWorld / visibleH) * vh
  const wheelPixelsW = (wheelWorld / visibleW) * vw

  // Scale factor: how much to zoom out if wheel is too big
  const scaleH = availH / wheelPixelsH
  const scaleW = availW / wheelPixelsW
  const scale = Math.min(scaleH, scaleW, 1) // never zoom in past base

  // Adjust camera Z to fit
  camera.position.z = BASE_CAM_Z / scale
  homeCamZ = camera.position.z

  // Shift viewport so wheel appears centered between left edge and menu.
  // setViewOffset shifts what part of the frustum maps to the screen.
  // Positive offsetX shifts the rendered image to the right,
  // making the wheel appear to the left of viewport center.
  camera.setViewOffset(vw, vh, MENU_WIDTH / 2, 0, vw, vh)

  // Wheel and orbit target stay at origin — rotation is around the wheel
  pivotGroup.position.x = 0
  if (controls) {
    controls.target.set(0, 0, 0)
  }
  markDirty()
}

function handleResize() {
  const container = containerRef.value
  if (!container || !renderer || !camera) return
  const w = container.clientWidth
  const h = container.clientHeight
  camera.aspect = w / h
  camera.updateProjectionMatrix()
  // Re-apply pixel ratio: it can change when the window moves to a monitor
  // with a different DPI, otherwise the canvas renders blurry or oversharp.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(w, h)
  if (composer) {
    composer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    composer.setSize(w, h)
  }
  fitWheel()
  markDirty()
}

// Creates an arc button with an arrowhead integrated into the shape.
// arrowEnd: 'start' puts arrow at arcStart side, 'end' at arcEnd side.
// arrowDir: +1 arrow points towards increasing angle, -1 towards decreasing.
function makeArcButtonWithArrow(
  arcStart: number,
  arcEnd: number,
  arrowEnd: 'start' | 'end',
  arrowDir: 1 | -1,
): THREE.Mesh {
  const innerR = WHEEL_RADIUS + 0.2
  const outerR = WHEEL_RADIUS + 0.55
  const midR = (innerR + outerR) / 2
  const arrowTipExtend = 0.12 // how far the tip extends beyond inner/outer
  const arrowBaseWidth = 0.18 // how far back the arrow base cuts into the arc (in radians / midR)
  const segments = 24

  const arrowAngle = arrowEnd === 'end' ? arcEnd : arcStart
  const arrowBaseAngle = arrowAngle - arrowDir * (arrowBaseWidth / midR)
  const tipAngle = arrowAngle + arrowDir * (0.08 / midR)

  const shape = new THREE.Shape()

  if (arrowEnd === 'end') {
    // Outer arc from arcStart to arrow base
    for (let i = 0; i <= segments; i++) {
      const a = arcStart + (arrowBaseAngle - arcStart) * (i / segments)
      const x = Math.cos(a) * outerR
      const y = Math.sin(a) * outerR
      if (i === 0) shape.moveTo(x, y)
      else shape.lineTo(x, y)
    }
    // Arrow: outer corner → tip → inner corner
    shape.lineTo(Math.cos(arrowBaseAngle) * (outerR + arrowTipExtend), Math.sin(arrowBaseAngle) * (outerR + arrowTipExtend))
    shape.lineTo(Math.cos(tipAngle) * midR, Math.sin(tipAngle) * midR)
    shape.lineTo(Math.cos(arrowBaseAngle) * (innerR - arrowTipExtend), Math.sin(arrowBaseAngle) * (innerR - arrowTipExtend))
    shape.lineTo(Math.cos(arrowBaseAngle) * innerR, Math.sin(arrowBaseAngle) * innerR)
    // Inner arc back
    for (let i = segments; i >= 0; i--) {
      const a = arcStart + (arrowBaseAngle - arcStart) * (i / segments)
      shape.lineTo(Math.cos(a) * innerR, Math.sin(a) * innerR)
    }
  } else {
    // Arrow first: tip → outer corner
    shape.moveTo(Math.cos(tipAngle) * midR, Math.sin(tipAngle) * midR)
    shape.lineTo(Math.cos(arrowBaseAngle) * (outerR + arrowTipExtend), Math.sin(arrowBaseAngle) * (outerR + arrowTipExtend))
    shape.lineTo(Math.cos(arrowBaseAngle) * outerR, Math.sin(arrowBaseAngle) * outerR)
    // Outer arc from arrow base to arcEnd
    for (let i = 0; i <= segments; i++) {
      const a = arrowBaseAngle + (arcEnd - arrowBaseAngle) * (i / segments)
      shape.lineTo(Math.cos(a) * outerR, Math.sin(a) * outerR)
    }
    // Inner arc back
    for (let i = segments; i >= 0; i--) {
      const a = arrowBaseAngle + (arcEnd - arrowBaseAngle) * (i / segments)
      shape.lineTo(Math.cos(a) * innerR, Math.sin(a) * innerR)
    }
    // Close through arrow inner corner
    shape.lineTo(Math.cos(arrowBaseAngle) * (innerR - arrowTipExtend), Math.sin(arrowBaseAngle) * (innerR - arrowTipExtend))
  }
  shape.closePath()

  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: 0.18,
    bevelEnabled: true,
    bevelThickness: 0.03,
    bevelSize: 0.03,
    bevelSegments: 2,
  })
  const mat = new THREE.MeshStandardMaterial({
    color: '#FF6B6B',
    metalness: 0.3,
    roughness: 0.4,
    emissive: '#331111',
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.position.z = -0.09
  return mesh
}

function createSpinButtons(): THREE.Group {
  const group = new THREE.Group()
  const gap = 0.3
  const halfArc = 0.65

  // Left button (counter-clockwise): arrow at outer end pointing left,
  // inner end near bottom center
  const leftEnd = Math.PI * 1.5 - gap / 2
  const leftStart = leftEnd - halfArc
  spinBtnLeft = makeArcButtonWithArrow(leftStart, leftEnd, 'start', -1)
  group.add(spinBtnLeft)

  // Right button (clockwise): arrow at outer end pointing right,
  // inner end near bottom center
  const rightStart = Math.PI * 1.5 + gap / 2
  const rightEnd = rightStart + halfArc
  spinBtnRight = makeArcButtonWithArrow(rightStart, rightEnd, 'end', 1)
  group.add(spinBtnRight)

  return group
}

const clickMouse = new THREE.Vector2()

function onCanvasClick(e: MouseEvent) {
  if (!renderer || !camera || isSpinAnimating) return
  if (props.spinning || props.participants.filter(p => !p.removed).length === 0) return

  const rect = renderer.domElement.getBoundingClientRect()
  clickMouse.set(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  )

  if (!raycaster) raycaster = new THREE.Raycaster()
  raycaster.setFromCamera(clickMouse, camera)

  if (spinBtnLeft) {
    const hits = raycaster.intersectObject(spinBtnLeft, false)
    if (hits.length > 0) {
      spinDirection = -1
      emit('spin-click', 'left')
      return
    }
  }
  if (spinBtnRight) {
    const hits = raycaster.intersectObject(spinBtnRight, false)
    if (hits.length > 0) {
      spinDirection = 1
      emit('spin-click', 'right')
      return
    }
  }
}

function initScene() {
  const container = containerRef.value
  if (!container) return

  const w = container.clientWidth
  const h = container.clientHeight

  scene = new THREE.Scene()

  camera = new THREE.PerspectiveCamera(38, w / h, 0.1, 100)
  camera.position.set(0, 0, 7.8)
  camera.lookAt(0, 0, 0)

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
  renderer.setSize(w, h)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setClearColor(0x1e1e1e, 1)
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.2
  container.appendChild(renderer.domElement)

  // Studio image-based lighting: bake a RoomEnvironment into a PMREM so the
  // metallic hub/pins/pegs pick up soft, realistic reflections.
  const pmrem = new THREE.PMREMGenerator(renderer)
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  pmrem.dispose()

  // Cinematic bloom: render through an EffectComposer so bright highlights
  // (notably the lifted winner segment) bleed a soft glow. OutputPass applies
  // tone mapping + sRGB at the end of the chain.
  composer = new EffectComposer(renderer)
  composer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  composer.setSize(w, h)
  composer.addPass(new RenderPass(scene, camera))
  // Skip the bloom pass under reduced motion: the glow exists to sell the
  // animated winner lift, and dropping it keeps the static frame calmer.
  if (!prefersReducedMotion()) {
    bloomPass = new UnrealBloomPass(new THREE.Vector2(w, h), BLOOM_BASE, 0.5, 0.85)
    composer.addPass(bloomPass)
  }
  composer.addPass(new OutputPass())

  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.enablePan = false
  controls.minDistance = 4
  controls.maxDistance = 14
  controls.minPolarAngle = 0.3
  controls.maxPolarAngle = Math.PI - 0.3
  controls.addEventListener('change', markDirty)

  ambientLight = new THREE.AmbientLight(0xffffff, ambientBaseIntensity)
  scene.add(ambientLight)
  keyLight = new THREE.DirectionalLight(0xffffff, keyBaseIntensity)
  keyLight.position.set(2, 4, 8)
  scene.add(keyLight)
  const fill = new THREE.DirectionalLight(0x8899cc, 0.35)
  fill.position.set(-3, -2, 6)
  scene.add(fill)

  // Specular highlight light for metallic text
  const specLight = new THREE.PointLight(0xffffff, 3, 20)
  specLight.position.set(0, 2, 6)
  scene.add(specLight)

  // Per-winner spotlight: parked dark in front of the wheel, tinted to the
  // winner's identity color and ramped up while the room dims on reveal.
  spotLight = new THREE.PointLight(0xffffff, 0, 30)
  spotLight.position.set(0, 0, 5)
  scene.add(spotLight)

  // Pivot group — holds wheel + pointer, shifted so center aligns
  // between left edge and the right-side menu panel
  pivotGroup = new THREE.Group()
  scene.add(pivotGroup)

  wheelGroup = new THREE.Group()
  pivotGroup.add(wheelGroup)

  // Velocity streak ring: a thin annulus hugging the rim, additive-blended so it
  // reads as a glowing smear under the bloom pass when a fast spin lights it up.
  // Parked transparent and invisible; the spin loop raises its opacity/scale.
  // Skipped under reduced motion, where the bloom surge and slow-mo are all off.
  if (!prefersReducedMotion()) {
    const streakGeo = new THREE.RingGeometry(WHEEL_RADIUS - 0.04, WHEEL_RADIUS + 0.2, 96)
    streakRingMat = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
    })
    streakRing = new THREE.Mesh(streakGeo, streakRingMat)
    streakRing.position.z = WHEEL_DEPTH / 2 + 0.03
    streakRing.visible = false
    pivotGroup.add(streakRing)
  }

  // Pointer is a flapper hinged above the rim. Its geometry hangs down from a
  // pivot at the local origin so rotating pegPivot.rotation.z swings the tip
  // sideways, letting it bounce off the pegs as the wheel turns.
  const pShape = new THREE.Shape()
  pShape.moveTo(0, -0.5) // tip, reaches the rim where the pegs are
  pShape.lineTo(-0.14, -0.02)
  pShape.lineTo(-0.1, 0.08)
  pShape.lineTo(0.1, 0.08)
  pShape.lineTo(0.14, -0.02)
  pShape.lineTo(0, -0.5)
  const pGeo = new THREE.ExtrudeGeometry(pShape, { depth: 0.15, bevelEnabled: false })
  const pMat = new THREE.MeshStandardMaterial({ color: '#e74c3c', metalness: 0.25, roughness: 0.4 })
  pointerMesh = new THREE.Mesh(pGeo, pMat)
  pointerMesh.position.z = 0.3

  pegPivot = new THREE.Group()
  pegPivot.position.set(0, WHEEL_RADIUS + 0.5, 0)
  pegPivot.add(pointerMesh)
  pivotGroup.add(pegPivot)

  // 3D spin buttons (left / right)
  const spinBtns = createSpinButtons()
  pivotGroup.add(spinBtns)

  renderer.domElement.addEventListener('click', onCanvasClick)
  renderer.domElement.addEventListener('mousemove', onCanvasMouseMove)
  renderer.domElement.addEventListener('pointerdown', () => { isPointerDown = true })
  renderer.domElement.addEventListener('pointerup', () => { isPointerDown = false })
  renderer.domElement.style.cursor = 'default'

  // Fit wheel to available space and center
  fitWheel()

  // Load font for 3D text
  opentype.load('/Roboto-Bold.ttf', (_err: any, font: any) => {
    if (font) {
      otFont = font
      textGeoCache.clear()
      curvedTextGeoCache.clear()
      textWidthCache.clear()
      buildWheel()
    }
  })

  buildWheel()
  animateCoinDrop()
  startRenderLoop()

  window.addEventListener('resize', handleResize)
}

function animateCoinDrop() {
  if (!camera || !controls || !pointerMesh || !wheelGroup) return

  // Reduced motion: skip the tumbling drop and the swooping camera; place the
  // wheel and camera directly at their resting framing.
  if (prefersReducedMotion()) {
    wheelGroup.position.set(0, 0, 0)
    wheelGroup.rotation.set(0, 0, 0)
    camera.position.set(0, 0, camera.position.z)
    camera.lookAt(0, 0, 0)
    controls.update()
    controls.enabled = true
    pointerMesh.visible = true
    markDirty()
    return
  }

  controls.enabled = false
  pointerMesh.visible = false

  // Randomize drop parameters
  const rng = () => Math.random()
  const wheelStartY = 14 + rng() * 5
  const wheelStartX = (rng() - 0.5) * 8
  const wheelEndY = 0
  const wheelEndX = 0

  // Random initial tilt axis — not always edge-on the same way
  const initRotX = (Math.PI / 3) + rng() * (Math.PI / 3)
  const initRotZ = (rng() - 0.5) * Math.PI * 0.5
  const flipX = Math.PI * (3 + rng() * 4) * (rng() > 0.5 ? 1 : -1)
  const flipZ = Math.PI * (1 + rng() * 2) * (rng() > 0.5 ? 1 : -1)

  // Random bounces (2-4 bounces, decaying height)
  const bounceCount = 2 + Math.floor(rng() * 3)
  const bounces: { start: number; end: number; height: number; shiftX: number }[] = []
  let bStart = 0.55 + rng() * 0.1
  for (let i = 0; i < bounceCount; i++) {
    const bLen = (0.12 + rng() * 0.06) * Math.pow(0.55, i)
    const bHeight = (0.12 + rng() * 0.08) * Math.pow(0.4, i)
    const bShiftX = (rng() - 0.5) * 0.3 * Math.pow(0.5, i)
    bounces.push({ start: bStart, end: bStart + bLen, height: bHeight, shiftX: bShiftX })
    bStart += bLen
  }

  wheelGroup.position.set(wheelStartX, wheelStartY, 0)
  wheelGroup.rotation.set(initRotX, 0, initRotZ)

  // Random camera start position
  const camAngle = (rng() - 0.5) * Math.PI * 0.8
  const camHeight = 6 + rng() * 6
  const camDist = 10 + rng() * 5
  const camStart = new THREE.Vector3(
    Math.sin(camAngle) * camDist,
    camHeight,
    Math.cos(camAngle) * camDist,
  )
  const camEnd = new THREE.Vector3(0, 0, camera.position.z)
  camera.position.copy(camStart)
  camera.lookAt(0, wheelStartY * 0.5, 0)

  const duration = 2200 + rng() * 600
  const startTime = performance.now()

  function frame(now: number) {
    markDirty()
    const elapsed = now - startTime
    const t = Math.min(elapsed / duration, 1)
    const eased = 1 - Math.pow(1 - t, 3)

    // Base drop (accelerating fall to ground)
    const fallEnd = bounces.length > 0 ? bounces[0].start : 0.7
    let dropY: number
    let bounceX = 0
    if (t < fallEnd) {
      const ft = t / fallEnd
      dropY = ft * ft
    } else {
      dropY = 1.0
      // Apply bounces
      for (const b of bounces) {
        if (t >= b.start && t < b.end) {
          const bt = (t - b.start) / (b.end - b.start)
          dropY -= b.height * Math.sin(bt * Math.PI)
          bounceX += b.shiftX * Math.sin(bt * Math.PI)
          break
        }
      }
    }

    if (wheelGroup) {
      wheelGroup.position.x = wheelStartX + (wheelEndX - wheelStartX) * eased + bounceX
      wheelGroup.position.y = wheelStartY + (wheelEndY - wheelStartY) * dropY

      // Tumble rotation decaying to 0
      const tumbleFade = t * (1 - t) * 4
      wheelGroup.rotation.x = initRotX * (1 - eased) + flipX * tumbleFade * 0.15
      wheelGroup.rotation.z = initRotZ * (1 - eased) + flipZ * tumbleFade * 0.15
    }

    if (camera) {
      const camT = eased
      camera.position.lerpVectors(camStart, camEnd, camT)
      const lookY = wheelGroup ? wheelGroup.position.y * (1 - eased) * 0.5 : 0
      camera.lookAt(0, lookY, 0)
    }

    if (t < 1) {
      requestAnimationFrame(frame)
    } else {
      if (wheelGroup) {
        wheelGroup.position.set(0, 0, 0)
        wheelGroup.rotation.set(0, 0, 0)
      }
      if (camera) {
        camera.position.copy(camEnd)
        camera.lookAt(0, 0, 0)
      }
      if (controls) {
        controls.update()
        controls.enabled = true
      }
      if (pointerMesh) pointerMesh.visible = true
    }
  }

  requestAnimationFrame(frame)
}

function startRenderLoop() {
  function loop() {
    if (!renderer || !scene || !camera) return
    // controls.update() returns true while damping is still moving
    if (controls && controls.update()) markDirty()

    // Track angular velocity for flick-to-spin
    if (controls && !isSpinAnimating && !props.spinning && flickCooldown <= 0) {
      const azimuth = controls.getAzimuthalAngle()
      azimuthVelocity = azimuth - lastAzimuth
      lastAzimuth = azimuth

      // Detect fast flick on pointer release
      if (Math.abs(azimuthVelocity) > FLICK_THRESHOLD && !isPointerDown) {
        spinDirection = azimuthVelocity > 0 ? 1 : -1
        emit('spin-click', spinDirection > 0 ? 'right' : 'left')
        azimuthVelocity = 0
        flickCooldown = 120 // ~2 seconds cooldown at 60fps
      }
    } else {
      if (flickCooldown > 0) flickCooldown--
      if (controls) lastAzimuth = controls.getAzimuthalAngle()
    }

    // Surface the reset pill once the user orbits the camera away from its
    // resting framing. Skipped while a spin/reveal drives the camera itself or
    // while resetView is animating it back, so the pill only reflects manual
    // drift. Hysteresis (CAM_DRIFT_ON/OFF) keeps it from flickering.
    if (!isSpinAnimating && !props.spinning && !isResettingView && controls && controls.enabled) {
      const dx = camera.position.x
      const dy = camera.position.y
      const dz = camera.position.z - homeCamZ
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (!cameraDrifted && dist > CAM_DRIFT_ON) {
        cameraDrifted = true
        emit('camera-drifted', true)
      } else if (cameraDrifted && dist < CAM_DRIFT_OFF) {
        cameraDrifted = false
        emit('camera-drifted', false)
      }
    }

    // Magnetic snap-to-framing: nudge an idle, slightly-off camera back toward
    // the head-on orientation. Off-limits while the pointer is down, the pill is
    // up (deliberate orbit), an animation drives the camera, or reduced motion
    // is requested. The pull only fires inside SNAP_CAPTURE on both axes so it
    // complements the reset pill instead of fighting larger drifts.
    if (
      controls &&
      controls.enabled &&
      !isPointerDown &&
      !isSpinAnimating &&
      !props.spinning &&
      !isResettingView &&
      !cameraDrifted &&
      !prefersReducedMotion()
    ) {
      const azGap = SNAP_TARGET_AZIMUTH - controls.getAzimuthalAngle()
      const poGap = SNAP_TARGET_POLAR - controls.getPolarAngle()
      const captured =
        Math.abs(azGap) < SNAP_CAPTURE && Math.abs(poGap) < SNAP_CAPTURE
      const settling =
        Math.abs(azGap) > SNAP_DEADZONE || Math.abs(poGap) > SNAP_DEADZONE
      if (captured && settling) {
        // Strengthen the pull as the camera nears home (a soft detent), then
        // hand off through rotateLeft/Up which apply the impulse via the
        // controls' own damping on the next update().
        const closeness =
          1 - Math.max(Math.abs(azGap), Math.abs(poGap)) / SNAP_CAPTURE
        const strength = SNAP_PULL * (0.5 + 0.5 * closeness)
        controls.rotateLeft(-azGap * strength)
        controls.rotateUp(-poGap * strength)
        lastAzimuth = controls.getAzimuthalAngle()
        markDirty()
      }
    }

    if (needsRender) {
      needsRender = false
      if (composer) composer.render()
      else renderer.render(scene, camera)
    }
    animFrameId = requestAnimationFrame(loop)
  }
  loop()
}

let pendingWinnerId: string | null = null
let pendingOnDismiss: (() => void) | null = null

function animateWinnerReveal(
  winnerId: string,
  winnerName: string,
  remaining: number,
  onDismiss: () => void,
) {
  const seg = segmentMeshes.find((m) => m?.userData?.participantId === winnerId)
  if (!seg) { onDismiss(); return }

  // Give the winner a private emissive material (cloned so the shared cached
  // segment material stays untouched) and ramp it up so the bloom pass catches
  // the lifted slice. The clone is restored to the shared material on shrink.
  const baseMat = seg.material as THREE.MeshStandardMaterial
  if (!seg.userData.baseMaterial) {
    const glowMat = baseMat.clone()
    glowMat.emissive = new THREE.Color(baseMat.color)
    glowMat.emissiveIntensity = 0
    seg.userData.baseMaterial = baseMat
    seg.material = glowMat
  }
  const glow = seg.material as THREE.MeshStandardMaterial

  // Spotlight reveal: tint a front PointLight to the winner's identity color
  // and dim the ambient/key lights so the lifted slice reads like it is under
  // a keynote spotlight. Skipped under reduced motion (the lift itself is
  // already collapsed and the bloom pass is off).
  const spotlightReveal = !prefersReducedMotion() && spotLight !== null
  if (spotlightReveal && spotLight) {
    spotLight.color.set(identityColor(winnerName))
  }

  const startZ = -WHEEL_DEPTH / 2
  const duration = 500
  const startTime = performance.now()

  function frame(now: number) {
    markDirty()
    const t = Math.min((now - startTime) / duration, 1)
    const eased = 1 - Math.pow(1 - t, 3) * Math.cos(t * Math.PI * 2)
    seg!.position.z = startZ + 0.4 * eased
    glow.emissiveIntensity = 0.9 * Math.min(t, 1)

    if (spotlightReveal) {
      const lt = Math.min(t, 1)
      if (ambientLight) ambientLight.intensity = ambientBaseIntensity * (1 - 0.55 * lt)
      if (keyLight) keyLight.intensity = keyBaseIntensity * (1 - 0.45 * lt)
      if (spotLight) spotLight.intensity = 4 * lt
    }

    if (t < 1) {
      requestAnimationFrame(frame)
    } else {
      // Segment is raised — show Vue modal
      pendingWinnerId = winnerId
      pendingOnDismiss = onDismiss
      emit('winner-reveal', { id: winnerId, name: winnerName, remaining })
    }
  }

  requestAnimationFrame(frame)
}

// Ease the dimmed room back to full and fade the winner spotlight out.
function restoreLights() {
  // Snap bloom back to its resting strength in case a spin was cut short before
  // the surge eased itself down.
  if (bloomPass) bloomPass.strength = BLOOM_BASE
  if (!spotLight || spotLight.intensity <= 0.001) {
    if (ambientLight) ambientLight.intensity = ambientBaseIntensity
    if (keyLight) keyLight.intensity = keyBaseIntensity
    return
  }
  const duration = 400
  const startTime = performance.now()
  const startAmbient = ambientLight?.intensity ?? ambientBaseIntensity
  const startKey = keyLight?.intensity ?? keyBaseIntensity
  const startSpot = spotLight.intensity
  function frame(now: number) {
    markDirty()
    const t = Math.min((now - startTime) / duration, 1)
    if (ambientLight) ambientLight.intensity = startAmbient + (ambientBaseIntensity - startAmbient) * t
    if (keyLight) keyLight.intensity = startKey + (keyBaseIntensity - startKey) * t
    if (spotLight) spotLight.intensity = startSpot * (1 - t)
    if (t < 1) {
      requestAnimationFrame(frame)
    } else if (spotLight) {
      spotLight.intensity = 0
    }
  }
  requestAnimationFrame(frame)
}

// Called from parent to dismiss the winner and start shrink
function dismissWinner() {
  const winnerId = pendingWinnerId
  const onDismiss = pendingOnDismiss
  pendingWinnerId = null
  pendingOnDismiss = null

  restoreLights()

  if (winnerId && onDismiss) {
    animateSegmentShrink(winnerId, onDismiss)
  }
}

// Snap the orbit camera back to its resting framing at (0, 0, homeCamZ),
// reusing animateSpin's ease-out lerp. Disables controls for the duration so
// damping doesn't fight the tween, then re-arms drift tracking from rest.
function resetView() {
  if (!camera || isSpinAnimating || props.spinning || isResettingView) return
  isResettingView = true
  if (controls) controls.enabled = false
  // Clearing the drifted flag up front lets startRenderLoop re-detect drift
  // immediately if the user grabs the camera again mid-reset.
  if (cameraDrifted) {
    cameraDrifted = false
    emit('camera-drifted', false)
  }
  const camFrom = camera.position.clone()
  const camHome = new THREE.Vector3(0, 0, homeCamZ)
  const target = controls?.target ?? new THREE.Vector3(0, 0, 0)
  const duration = prefersReducedMotion() ? 200 : 600
  const startTime = performance.now()
  function frame(now: number) {
    markDirty()
    const t = Math.min((now - startTime) / duration, 1)
    const eased = 1 - Math.pow(1 - t, 2)
    if (camera) {
      camera.position.lerpVectors(camFrom, camHome, eased)
      camera.lookAt(target)
    }
    if (t < 1) {
      requestAnimationFrame(frame)
    } else {
      if (camera) {
        camera.position.copy(camHome)
        camera.lookAt(target)
      }
      if (controls) {
        controls.update()
        controls.enabled = true
        lastAzimuth = controls.getAzimuthalAngle()
      }
      isResettingView = false
    }
  }
  requestAnimationFrame(frame)
}

defineExpose({ dismissWinner, resetView, isMuted, toggleMute })

// Tactile companion to the peg tick / landing thunk: a short haptic buzz on
// devices that support the Vibration API. Gated behind the same isMuted flag and
// reduced-motion check as the audio voices, so the mute button and the OS motion
// preference silence it together. No-op where navigator.vibrate is unavailable
// (most desktops), so it only ever adds feel on capable handhelds.
function buzz(pattern: number | number[]) {
  if (isMuted.value || prefersReducedMotion()) return
  try {
    navigator.vibrate?.(pattern)
  } catch {
    // Vibration unavailable, silently skip.
  }
}

// Short percussive click synthesised on each peg strike. Created lazily on the
// first tick — the spin is click-initiated, so the audio context is allowed to
// start. Volume rises toward the finale for tension.
function playTick(volume: number) {
  if (isMuted.value) return
  try {
    if (!audioCtx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      audioCtx = new Ctor()
    }
    const ctx = audioCtx
    if (ctx.state === 'suspended') ctx.resume()
    const now = ctx.currentTime
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'triangle'
    osc.frequency.setValueAtTime(1100 + Math.random() * 300, now)
    osc.frequency.exponentialRampToValueAtTime(520, now + 0.03)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume), now + 0.004)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.05)
    osc.connect(gain).connect(ctx.destination)
    osc.start(now)
    osc.stop(now + 0.06)
  } catch {
    // Audio unavailable — silently skip.
  }
}

// Low detuned "thunk" played once when the wheel lands, closing the rising
// peg-tick sequence with a heavier settle. Two slightly detuned oscillators
// beat against each other for a thicker body than the single-osc tick.
function playThunk() {
  if (isMuted.value) return
  try {
    if (!audioCtx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      audioCtx = new Ctor()
    }
    const ctx = audioCtx
    if (ctx.state === 'suspended') ctx.resume()
    const now = ctx.currentTime
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.22, now + 0.008)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.32)
    gain.connect(ctx.destination)
    for (const detune of [0, 7]) {
      const osc = ctx.createOscillator()
      osc.type = 'sine'
      osc.frequency.setValueAtTime(190 + detune, now)
      osc.frequency.exponentialRampToValueAtTime(70 + detune, now + 0.18)
      osc.connect(gain)
      osc.start(now)
      osc.stop(now + 0.34)
    }
  } catch {
    // Audio unavailable — silently skip.
  }
}

// Rising sine that plays once across the pre-roll countdown sweep: a single
// oscillator glides up about an octave while a soft swell fades in, building
// anticipation before the wheel launches. Duration matches COUNTDOWN_MS.
function playCountdown() {
  if (isMuted.value) return
  try {
    if (!audioCtx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      audioCtx = new Ctor()
    }
    const ctx = audioCtx
    if (ctx.state === 'suspended') ctx.resume()
    const now = ctx.currentTime
    const dur = COUNTDOWN_MS / 1000
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(330, now)
    osc.frequency.exponentialRampToValueAtTime(660, now + dur)
    gain.gain.setValueAtTime(0.0001, now)
    gain.gain.exponentialRampToValueAtTime(0.12, now + dur * 0.85)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + dur)
    osc.connect(gain).connect(ctx.destination)
    osc.start(now)
    osc.stop(now + dur + 0.02)
  } catch {
    // Audio unavailable — silently skip.
  }
}

// Start the spinning-air whoosh bed: a looping white-noise BufferSource fed
// through a band-pass BiquadFilter, parked at silent gain until updateWhoosh
// raises it from the live spin velocity. Gated on isMuted like the other voices.
// The 1s noise buffer is synthesised once and reused across spins. No-op if a
// bed is already running.
function startWhoosh() {
  if (isMuted.value || whooshSource) return
  try {
    if (!audioCtx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      audioCtx = new Ctor()
    }
    const ctx = audioCtx
    if (ctx.state === 'suspended') ctx.resume()
    if (!whooshNoiseBuffer) {
      const len = Math.floor(ctx.sampleRate)
      whooshNoiseBuffer = ctx.createBuffer(1, len, ctx.sampleRate)
      const data = whooshNoiseBuffer.getChannelData(0)
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    }
    const now = ctx.currentTime
    const source = ctx.createBufferSource()
    source.buffer = whooshNoiseBuffer
    source.loop = true
    const filter = ctx.createBiquadFilter()
    filter.type = 'bandpass'
    filter.frequency.setValueAtTime(400, now)
    filter.Q.setValueAtTime(0.7, now)
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, now)
    source.connect(filter).connect(gain).connect(ctx.destination)
    source.start(now)
    whooshSource = source
    whooshFilter = filter
    whooshGain = gain
  } catch {
    // Audio unavailable: silently skip.
  }
}

// Track the whoosh bed to the wheel's angular speed: faster spin pushes the
// band-pass cutoff up (the Doppler-ish rise) and opens the gain, both easing to
// near-silence as the wheel decelerates. `speed` is rad/frame; `intensity`
// (0..1) is the spin progress used to fade the bed out toward the landing so it
// doesn't fight the slow-mo crawl and thunk.
function updateWhoosh(speed: number, intensity: number) {
  if (!audioCtx || !whooshFilter || !whooshGain) return
  const now = audioCtx.currentTime
  // Map rad/frame to a 0..1 drive; ~0.4 rad/frame at peak spin reads as full.
  const drive = Math.min(1, Math.abs(speed) / 0.4)
  const fade = Math.max(0, 1 - intensity)
  const targetFreq = 300 + 1500 * drive
  const targetGain = 0.0001 + 0.13 * drive * fade
  // Short time-constant ramps so per-frame updates glide instead of zipper.
  whooshFilter.frequency.setTargetAtTime(targetFreq, now, 0.04)
  whooshGain.gain.setTargetAtTime(targetGain, now, 0.05)
}

// Fade and tear down the whoosh bed once the wheel lands. The source is stopped
// just after the fade so the tail rings out instead of clicking off.
function stopWhoosh() {
  if (!audioCtx || !whooshSource || !whooshGain) {
    whooshSource = null
    whooshFilter = null
    whooshGain = null
    return
  }
  const ctx = audioCtx
  const now = ctx.currentTime
  const source = whooshSource
  try {
    whooshGain.gain.setTargetAtTime(0.0001, now, 0.08)
    source.stop(now + 0.4)
  } catch {
    // Source may already be stopped: ignore.
  }
  whooshSource = null
  whooshFilter = null
  whooshGain = null
}

// Swing the pointer off the nearest peg and tick when a peg crosses the tip.
// `intensity` (0..1) grows toward the finale, scaling the kick and volume.
function updateFlapper(intensity: number) {
  if (!pegPivot || pegSpacing <= 0) return

  // Offset of the nearest peg from the top pointer, in (-spacing/2, spacing/2].
  const q = (Math.PI / 2 - currentRotation) / pegSpacing
  const m = (q - Math.round(q)) * pegSpacing
  const dir = spinDirection
  const contact = Math.min(0.16, pegSpacing * 0.45)
  const maxDeflect = 0.28 + 0.22 * intensity

  // Deflect while the incoming peg is under the tip; snap back once it passes.
  let deflect = 0
  if (m * dir > 0 && Math.abs(m) < contact) {
    deflect = (1 - Math.abs(m) / contact) * maxDeflect
  }
  pegPivot.rotation.z = -dir * deflect

  // Tactile squash-and-stretch: the same contact factor that bends the tip also
  // compresses it (scale.y down / scale.x up), and a critically-damped-ish spring
  // lets it overshoot into a brief stretch as the peg releases. Skipped under
  // reduced motion, where the tip holds its rest scale.
  if (pointerMesh) {
    if (prefersReducedMotion()) {
      if (squash !== 0 || squashVel !== 0) {
        squash = 0
        squashVel = 0
        pointerMesh.scale.set(1, 1, 1)
      }
    } else {
      const now = performance.now()
      // Clamp dt so a backgrounded tab resuming doesn't explode the spring.
      const dt = lastFlapTime > 0 ? Math.min((now - lastFlapTime) / 1000, 0.05) : 0.016
      lastFlapTime = now
      // Drive toward the live contact factor; the spring's overshoot supplies the
      // stretch, so the target itself is just the squash side.
      const contactFactor = maxDeflect > 0 ? deflect / maxDeflect : 0
      const stiffness = 220
      const damping = 18
      squashVel += (stiffness * (contactFactor - squash) - damping * squashVel) * dt
      squash += squashVel * dt
      // Positive squash shortens the tip and fattens it; negative (overshoot)
      // stretches it. amount keeps the visual deflection modest.
      const amount = 0.32 * intensity
      pointerMesh.scale.y = 1 - amount * squash
      pointerMesh.scale.x = 1 + amount * 0.7 * squash
    }
  }

  // Tick only on a crossing of the tip itself (m through 0), not on the
  // half-way handover between pegs (m near ±spacing/2).
  const sign = m >= 0 ? 1 : -1
  if (prevPegSign !== 0 && sign !== prevPegSign && Math.abs(m) < pegSpacing * 0.3) {
    playTick(0.04 + 0.16 * intensity)
    // A faint per-peg tap that firms up toward the finale (intensity rises as the
    // wheel slows), so a handheld feels the ticks alongside the click.
    buzz(Math.round(4 + 8 * intensity))
  }
  prevPegSign = sign

  // Name the segment under the top pointer so the parent can flash the matching
  // roster row in sync. The local angle at the pointer is (π/2 - currentRotation);
  // segment i occupies [i·spacing, (i+1)·spacing), so flooring gives its index.
  // Emit only on change to keep this to one event per crossing, not per frame.
  if (spinSegmentIds.length > 0) {
    const count = spinSegmentIds.length
    const norm = ((Math.PI / 2 - currentRotation) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2)
    const idx = Math.min(count - 1, Math.floor(norm / pegSpacing))
    const id = spinSegmentIds[idx]
    if (id !== lastTickSegment) {
      lastTickSegment = id
      emit('tick-segment', id)
    }
  }
}

// Restore the pointer tip to its rest scale and clear the squash spring, so the
// next spin starts from a neutral shape regardless of where the last one stopped.
function resetSquash() {
  squash = 0
  squashVel = 0
  lastFlapTime = 0
  if (pointerMesh) pointerMesh.scale.set(1, 1, 1)
}

// Moderate "tip-over": after the wheel lands it rocks slightly past the final
// peg and settles back, selling the last bit of momentum.
function animateSettle(target: number, onDone: () => void) {
  const dir = spinDirection
  const amp = pegSpacing > 0 ? Math.min(0.1, pegSpacing * 0.18) : 0.08
  const duration = 420
  const startTime = performance.now()
  function frame(now: number) {
    markDirty()
    const t = Math.min((now - startTime) / duration, 1)
    const decay = Math.pow(1 - t, 2)
    const offset = dir * amp * decay * Math.sin(t * Math.PI * 3)
    currentRotation = target + offset
    if (wheelGroup) wheelGroup.rotation.z = currentRotation
    updateFlapper(1)
    if (t < 1) {
      requestAnimationFrame(frame)
    } else {
      currentRotation = target
      if (wheelGroup) wheelGroup.rotation.z = target
      if (pegPivot) pegPivot.rotation.z = 0
      resetSquash()
      onDone()
    }
  }
  requestAnimationFrame(frame)
}

function animateSpin() {
  const active = props.participants.filter((p) => !p.removed)
  if (active.length === 0 || !props.winnerId || !camera) return

  const winnerIndex = active.findIndex((p) => p.id === props.winnerId)
  if (winnerIndex === -1) return

  const sliceAngle = (Math.PI * 2) / active.length
  // Random point within the winner segment (not always center)
  const randomOffset = (Math.random() * 0.7 + 0.15) * sliceAngle // 15%-85% of segment
  const segPoint = winnerIndex * sliceAngle + randomOffset
  const targetAngle = Math.PI / 2 - segPoint

  // Normalize target relative to current rotation
  let delta = targetAngle - (currentRotation % (Math.PI * 2))
  // Ensure delta goes in the spin direction
  if (spinDirection > 0) {
    while (delta <= 0) delta += Math.PI * 2
  } else {
    while (delta >= 0) delta -= Math.PI * 2
  }
  // Reduced motion: a single rotation into the winner over a short window,
  // with no anticipation wind-up and no multi-revolution blur.
  const reducedMotion = prefersReducedMotion()
  const fullSpins = reducedMotion
    ? 0
    : Math.PI * 2 * (5 + Math.floor(Math.random() * 3)) * spinDirection
  const totalRotation = fullSpins + delta
  const duration = reducedMotion ? 600 : 4000
  // Anticipation wind-up: a brief reverse rotation that loads the spin before
  // it launches forward. The wheel still lands at startRot + totalRotation, so
  // the main phase travels (totalRotation - windUpAngle) from the wound point.
  const windUpDuration = reducedMotion ? 0 : 250
  const windUpAngle = reducedMotion ? 0 : -spinDirection * 0.12
  // Set when the spin proper begins; deferred past the pre-roll countdown so the
  // wind-up/main phases measure elapsed time from the launch, not the pre-roll.
  let startTime = performance.now()
  const startRot = currentRotation
  const mainStartRot = startRot + windUpAngle
  // Last rotation seen by the whoosh bed, to derive a per-frame angular speed.
  let prevWhooshRot = startRot

  isSpinAnimating = true
  setHoveredBtn(null)
  clearSegmentHover()
  resetSegments()
  pegSpacing = sliceAngle
  prevPegSign = 0
  resetSquash()
  // Segment-order ids for the roster-row spotlight; reset the change tracker so
  // the first crossing emits even if it lands on the same id as a prior spin.
  spinSegmentIds = active.map((p) => p.id)
  lastTickSegment = null
  if (controls) controls.enabled = false

  const camFrom = camera.position.clone()
  const camHome = new THREE.Vector3(0, 0, homeCamZ)
  const camReturnDuration = reducedMotion ? 300 : 800
  // Last-two showdown: with only two slices left, the slow-mo crawl earns a
  // tighter push and a slight face tilt for a more cinematic finish. The deeper
  // dolly target is clamped so it never frames closer than ~5.2 world units even
  // on viewports where homeCamZ is already small.
  const isShowdown = active.length === 2 && !reducedMotion
  const showdownPushZ = Math.max(5.2, homeCamZ - 1.6)

  function frame(now: number) {
    markDirty()
    const elapsed = now - startTime

    if (elapsed < windUpDuration) {
      // Ease-in reverse load; hold the camera at its drop framing so the
      // camera return reads as starting only once the wheel snaps forward.
      const wt = elapsed / windUpDuration
      const wEase = wt * wt
      currentRotation = startRot + windUpAngle * wEase
      if (wheelGroup) wheelGroup.rotation.z = currentRotation
      updateFlapper(0)
      if (camera) {
        camera.position.copy(camFrom)
        camera.lookAt(controls?.target ?? new THREE.Vector3(0, 0, 0))
      }
      requestAnimationFrame(frame)
      return
    }

    const spinElapsed = elapsed - windUpDuration
    const t = Math.min(spinElapsed / duration, 1)

    // Final-phase slow-mo: up to SLOWMO_START the cubic ease-out runs as usual;
    // past it the tail is re-mapped through a stretched-sine deceleration so the
    // wheel visibly creeps into the landing peg (Magic Move easing). The branch
    // is continuous in value at the join and still lands exactly at 1, so the
    // wheel stops on the same target. Skipped under reduced motion, where the
    // whole spin is already collapsed to a short single rotation.
    let eased: number
    let slowmoU = 0 // 0..1 progress through the slow-mo window, 0 outside it
    if (reducedMotion || t < SLOWMO_START) {
      eased = 1 - Math.pow(1 - t, 3)
    } else {
      const e0 = 1 - Math.pow(1 - SLOWMO_START, 3)
      slowmoU = (t - SLOWMO_START) / (1 - SLOWMO_START)
      eased = e0 + (1 - e0) * Math.sin(slowmoU * (Math.PI / 2))
    }

    currentRotation = mainStartRot + (totalRotation - windUpAngle) * eased
    if (wheelGroup) {
      wheelGroup.rotation.z = currentRotation
    }
    updateFlapper(t)

    // Spin-energy bloom surge: glow runs hot (~1.1) while the wheel is fast and
    // eases back to BLOOM_BASE as it decelerates, fully settled by SLOWMO_START
    // so the slow-mo crawl and winner reveal read clean. bloomPass is null under
    // reduced motion, so this is implicitly skipped there.
    if (bloomPass) {
      const surge = Math.max(0, 1 - t / SLOWMO_START)
      bloomPass.strength = BLOOM_BASE + 0.55 * surge
    }

    // Doppler whoosh bed: drive its band-pass cutoff and gain from the per-frame
    // angular speed, fading out by SLOWMO_START so the slow-mo crawl reads quiet.
    // updateWhoosh no-ops when the bed isn't running (reduced motion / muted).
    const whooshSpeed = currentRotation - prevWhooshRot
    prevWhooshRot = currentRotation
    updateWhoosh(whooshSpeed, t / SLOWMO_START)

    // Velocity streak ring: map the per-frame angular delta to a 0..1 intensity
    // (saturating around STREAK_REF rad/frame), gate it on the same surge curve
    // as the bloom so it's already dark by SLOWMO_START, then drive the rim
    // annulus's opacity and a slight outward bulge from it. Parked invisible at
    // v~0 so it never shows at rest. streakRing is null under reduced motion.
    if (streakRing && streakRingMat) {
      const STREAK_REF = 0.5
      const surge = Math.max(0, 1 - t / SLOWMO_START)
      const v = Math.min(1, Math.abs(whooshSpeed) / STREAK_REF) * surge
      if (v > 0.001) {
        streakRing.visible = true
        streakRingMat.opacity = 0.5 * v
        const s = 1 + 0.12 * v
        streakRing.scale.set(s, s, 1)
      } else if (streakRing.visible) {
        streakRing.visible = false
        streakRingMat.opacity = 0
      }
    }

    if (camera && spinElapsed < camReturnDuration) {
      const ct = Math.min(spinElapsed / camReturnDuration, 1)
      const ce = 1 - Math.pow(1 - ct, 2)
      camera.position.lerpVectors(camFrom, camHome, ce)
      camera.lookAt(controls?.target ?? new THREE.Vector3(0, 0, 0))
    } else if (camera && slowmoU > 0) {
      // Subtle push-in during the slow-mo crawl: ease the camera toward
      // camHome*0.94 and back to home across the window (sine bump peaks at the
      // midpoint, returns to exactly camHome at t=1 so post-spin framing holds).
      // In the last-two showdown the dolly reaches the tighter showdownPushZ
      // target instead, and the wheel face tilts forward a touch; both ride the
      // same sine bump so they return cleanly to rest at the landing.
      const push = Math.sin(slowmoU * Math.PI)
      if (isShowdown) {
        camera.position.set(camHome.x, camHome.y, camHome.z + (showdownPushZ - camHome.z) * push)
        if (wheelGroup) wheelGroup.rotation.x = -0.07 * push
      } else {
        camera.position.set(camHome.x, camHome.y, camHome.z * (1 - 0.06 * push))
      }
      camera.lookAt(controls?.target ?? new THREE.Vector3(0, 0, 0))
    } else if (camera && spinElapsed >= camReturnDuration && spinElapsed < camReturnDuration + 16) {
      camera.position.copy(camHome)
      camera.lookAt(controls?.target ?? new THREE.Vector3(0, 0, 0))
    }

    if (t < 1) {
      requestAnimationFrame(frame)
    } else {
      const landed = () => {
        isSpinAnimating = false
        azimuthVelocity = 0
        flickCooldown = 120
        // Wheel is at rest: stop the roster-row spotlight before the winner
        // reveal takes over.
        spinSegmentIds = []
        if (lastTickSegment !== null) {
          lastTickSegment = null
          emit('tick-segment', null)
        }
        // Clear any residual showdown face tilt so the wheel rests flat.
        if (wheelGroup) wheelGroup.rotation.x = 0
        // Park the velocity streak ring fully dark at rest in case the last
        // frame carried residual speed.
        if (streakRing && streakRingMat) {
          streakRing.visible = false
          streakRingMat.opacity = 0
        }
        if (controls) {
          controls.update()
          controls.enabled = true
          lastAzimuth = controls.getAzimuthalAngle()
        }

        const winner = active.find((p) => p.id === props.winnerId)
        const remaining = active.length - 1

        animateWinnerReveal(
          props.winnerId!,
          winner?.name ?? '???',
          remaining,
          () => {
            emit('spin-complete', props.winnerId!)
          },
        )
      }

      // Release the whoosh bed as the wheel reaches its landing peg, then the
      // heavy settle thunk fires both when it snaps (reduced motion) and when
      // the rock-over begins.
      stopWhoosh()
      playThunk()
      // A heavier double-tap landing buzz to match the thunk, sealing the spin
      // with a tactile beat on capable devices.
      buzz([0, 30, 20, 40])

      if (reducedMotion) {
        // Snap to the final angle and reveal, no rock-over-the-last-peg.
        currentRotation = startRot + totalRotation
        if (wheelGroup) wheelGroup.rotation.z = currentRotation
        if (pegPivot) pegPivot.rotation.z = 0
        resetSquash()
        landed()
      } else {
        // Land, then rock over the last peg before revealing the winner.
        animateSettle(startRot + totalRotation, landed)
      }
    }
  }

  // Launch the spin proper: rebase startTime to now so the wind-up/main phases
  // measure from here, and kick off the frame loop. The whoosh bed rides the
  // full spin, so it starts here; reduced motion stays silent (no air rush on a
  // single short rotation).
  function launch() {
    startTime = performance.now()
    if (!reducedMotion) startWhoosh()
    requestAnimationFrame(frame)
  }

  // Pre-roll countdown: a ~700ms ring sweep around the hub with a rising tone,
  // building a "get ready" beat before the wheel launches. Skipped under reduced
  // motion, where the spin starts immediately.
  if (reducedMotion) {
    launch()
    return
  }

  playCountdown()
  const preRollStart = performance.now()
  function preRoll(now: number) {
    markDirty()
    const p = Math.min((now - preRollStart) / COUNTDOWN_MS, 1)
    // Ease-out so the ring slows as it closes, handing off to the wind-up.
    setCountdownArc(1 - Math.pow(1 - p, 2))
    if (p < 1) {
      requestAnimationFrame(preRoll)
    } else {
      setCountdownArc(0)
      launch()
    }
  }
  requestAnimationFrame(preRoll)
}

watch(
  () => props.spinning,
  (val) => {
    if (val) {
      animateSpin()
    }
  },
)

// Hover effect on spin buttons
const hoverMouse = new THREE.Vector2()
let hoveredBtn: THREE.Mesh | null = null

function setHoveredBtn(btn: THREE.Mesh | null) {
  if (btn === hoveredBtn) return
  if (hoveredBtn) {
    (hoveredBtn.material as THREE.MeshStandardMaterial).emissive.set('#331111')
  }
  if (btn) {
    (btn.material as THREE.MeshStandardMaterial).emissive.set('#662222')
  }
  hoveredBtn = btn
  if (renderer) renderer.domElement.style.cursor = btn ? 'pointer' : 'default'
  markDirty()
}

// Metallic segment hover lift: the slice under the cursor eases up in Z and
// gains a faint emissive glow, reusing animateWinnerReveal's clone-and-bump
// pattern so the shared cached segment material stays untouched. Only one
// segment is lifted at a time; the previous one eases back down.
const SEG_HOVER_LIFT = 0.08
let hoveredSeg: THREE.Mesh | null = null
let segHoverAnimating = false

function liftMaterial(seg: THREE.Mesh): THREE.MeshStandardMaterial {
  // Clone once into a private emissive material; restore-on-leave is handled by
  // settling position only — the clone is cheap to keep and reused on re-hover.
  if (!seg.userData.hoverBaseMaterial) {
    const base = seg.material as THREE.MeshStandardMaterial
    const glow = base.clone()
    glow.emissive = new THREE.Color(base.color)
    glow.emissiveIntensity = 0
    seg.userData.hoverBaseMaterial = base
    seg.material = glow
  }
  return seg.material as THREE.MeshStandardMaterial
}

function setHoveredSegment(seg: THREE.Mesh | null) {
  if (seg === hoveredSeg) return
  hoveredSeg = seg
  if (!segHoverAnimating) {
    segHoverAnimating = true
    requestAnimationFrame(segHoverFrame)
  }
}

// Synchronously drop any lifted segment back to rest (used when a spin starts,
// where resetSegments force-snaps Z and the eased clones must not linger).
function clearSegmentHover() {
  hoveredSeg = null
  const baseZ = -WHEEL_DEPTH / 2
  for (const seg of segmentMeshes) {
    if (!seg || seg.userData.hoverBaseMaterial === undefined) continue
    if (seg.userData.baseMaterial) continue // owned by the winner reveal
    ;(seg.material as THREE.MeshStandardMaterial).dispose()
    seg.material = seg.userData.hoverBaseMaterial as THREE.MeshStandardMaterial
    delete seg.userData.hoverBaseMaterial
    seg.position.z = baseZ
  }
  markDirty()
}

// Eases every lifted segment toward its target (raised + glowing when hovered,
// flat + dark otherwise) and stops once they have all settled. A segment that
// reaches its lifted target is held in place (loop pauses, no idle re-renders);
// a segment that returns to rest drops its private clone. Skips the winner
// segment, which animateWinnerReveal owns via userData.baseMaterial.
const SEG_HOVER_GLOW = 0.45

function segHoverFrame() {
  let moving = false
  const baseZ = -WHEEL_DEPTH / 2
  for (const seg of segmentMeshes) {
    if (!seg) continue
    if (seg.userData.baseMaterial) continue // owned by the winner reveal
    const lifted = seg.userData.hoverBaseMaterial !== undefined
    const isHovered = seg === hoveredSeg && !isSpinAnimating && !props.spinning
    if (!lifted) {
      if (!isHovered) continue
      liftMaterial(seg)
    }
    const targetZ = isHovered ? baseZ + SEG_HOVER_LIFT : baseZ
    const targetGlow = isHovered ? SEG_HOVER_GLOW : 0
    const glow = seg.material as THREE.MeshStandardMaterial
    seg.position.z += (targetZ - seg.position.z) * 0.2
    glow.emissiveIntensity += (targetGlow - glow.emissiveIntensity) * 0.2
    const atTarget =
      Math.abs(targetZ - seg.position.z) < 0.001 &&
      Math.abs(targetGlow - glow.emissiveIntensity) < 0.005
    if (!atTarget) {
      moving = true
      continue
    }
    if (isHovered) {
      // Settled at the lifted target: snap exactly and stop animating this one.
      seg.position.z = targetZ
      glow.emissiveIntensity = targetGlow
    } else {
      // Returned to rest: drop the private clone and restore the shared material.
      seg.position.z = baseZ
      glow.dispose()
      seg.material = seg.userData.hoverBaseMaterial as THREE.MeshStandardMaterial
      delete seg.userData.hoverBaseMaterial
    }
  }
  markDirty()
  if (moving) {
    requestAnimationFrame(segHoverFrame)
  } else {
    segHoverAnimating = false
  }
}

function onCanvasMouseMove(e: MouseEvent) {
  if (!renderer || !camera) return
  if (props.spinning || isSpinAnimating) {
    setHoveredBtn(null)
    setHoveredSegment(null)
    return
  }
  const rect = renderer.domElement.getBoundingClientRect()
  hoverMouse.set(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  )
  if (!raycaster) raycaster = new THREE.Raycaster()
  raycaster.setFromCamera(hoverMouse, camera)

  let hit: THREE.Mesh | null = null
  for (const btn of [spinBtnLeft, spinBtnRight]) {
    if (!btn) continue
    if (raycaster.intersectObject(btn, false).length > 0) {
      hit = btn
      break
    }
  }
  setHoveredBtn(hit)

  // A button takes priority over the segment beneath it. Otherwise lift the
  // nearest segment the ray hits.
  let segHit: THREE.Mesh | null = null
  if (!hit) {
    const segs = segmentMeshes.filter((m): m is THREE.Mesh => m !== null)
    const segHits = raycaster.intersectObjects(segs, false)
    if (segHits.length > 0) segHit = segHits[0].object as THREE.Mesh
  }
  setHoveredSegment(segHit)
}

// Roster hover peek: when a NameList row is hovered, lift the matching wheel
// segment through the same eased hover path the on-canvas pointer uses. Skipped
// during a spin/reveal (segHoverFrame already gates the lift on those), and a
// real canvas mousemove will override this the moment the cursor enters the
// scene. A missing/removed id (or null) just clears any peek lift.
watch(
  () => props.peekId,
  (id) => {
    if (props.spinning || isSpinAnimating) return
    const seg = id
      ? segmentMeshes.find((m) => m?.userData?.participantId === id) ?? null
      : null
    setHoveredSegment(seg)
  },
)

watch(
  () => props.participants.filter((p) => !p.removed).map((p) => p.id + ':' + p.name).join('|'),
  () => {
    nextTick(() => buildWheel())
  },
)

onMounted(() => {
  initScene()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(animFrameId)
  window.removeEventListener('resize', handleResize)
  textGeoCache.forEach((g) => g.dispose())
  textGeoCache.clear()
  curvedTextGeoCache.forEach((g) => g.dispose())
  curvedTextGeoCache.clear()
  segGeoCache.forEach((g) => g.dispose())
  segGeoCache.clear()
  cachedMaterials.forEach((m) => m.dispose())
  cachedMaterials.clear()
  cachedTextColorMats.forEach((m) => m.dispose())
  cachedTextColorMats.clear()
  if (cachedTextBlackMat) cachedTextBlackMat.dispose()
  if (cachedLineMat) cachedLineMat.dispose()
  if (sharedDividerGeo) sharedDividerGeo.dispose()
  if (sharedPegGeo) sharedPegGeo.dispose()
  if (sharedPegMat) sharedPegMat.dispose()
  if (countdownRing) countdownRing.geometry.dispose()
  if (countdownRingMat) countdownRingMat.dispose()
  if (streakRing) streakRing.geometry.dispose()
  if (streakRingMat) streakRingMat.dispose()
  whooshSource = null
  whooshFilter = null
  whooshGain = null
  whooshNoiseBuffer = null
  if (audioCtx) audioCtx.close().catch(() => {})
  if (controls) controls.dispose()
  if (scene && scene.environment) {
    scene.environment.dispose()
    scene.environment = null
  }
  if (bloomPass) {
    bloomPass.dispose()
    bloomPass = null
  }
  if (composer) composer.dispose()
  if (renderer) {
    renderer.domElement.remove()
    renderer.dispose()
  }
})
</script>

<template>
  <div class="wheel-bg" ref="containerRef"></div>
</template>

<style scoped>
.wheel-bg {
  position: fixed;
  inset: 0;
  z-index: 0;
}
</style>
