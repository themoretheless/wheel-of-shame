<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, nextTick } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import opentype from 'opentype.js'
import type { Participant } from '../types'

const props = defineProps<{
  participants: Participant[]
  spinning: boolean
  winnerId: string | null
}>()

const emit = defineEmits<{
  (e: 'spin-complete', participantId: string): void
  (e: 'spin-click', direction: 'left' | 'right'): void
  (e: 'winner-reveal', data: { id: string; name: string; remaining: number }): void
}>()

const containerRef = ref<HTMLDivElement | null>(null)

const COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
  '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
  '#BB8FCE', '#85C1E9', '#F0B27A', '#82E0AA',
  '#F1948A', '#AED6F1', '#D7BDE2', '#A3E4D7',
]

let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let wheelGroup: THREE.Group | null = null
let pointerMesh: THREE.Mesh | null = null
let pivotGroup: THREE.Group | null = null
let controls: OrbitControls | null = null
let spinBtnLeft: THREE.Mesh | null = null
let spinBtnRight: THREE.Mesh | null = null
let raycaster: THREE.Raycaster | null = null
let spinDirection: 1 | -1 = 1
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
let lastAzimuth = 0
let azimuthVelocity = 0
let isPointerDown = false
let flickCooldown = 0
const BASE_CAM_Z = 7.8
let homeCamZ = BASE_CAM_Z
const FLICK_THRESHOLD = 0.06 // radians per frame — trigger spin

const WHEEL_RADIUS = 2.2
const WHEEL_INNER = 0.6
const WHEEL_DEPTH = 0.3


const textGeoCache = new Map<string, THREE.BufferGeometry>()
const textWidthCache = new Map<string, number>()

// Render-on-demand: skip renderer.render when nothing changed
let needsRender = true
function markDirty() {
  needsRender = true
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
  alphas?: number[], // opacity per segment (0..1)
) {
  if (!wheelGroup) return
  const group: THREE.Group = wheelGroup
  clearGroup(group)
  segmentMeshes = []
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
      return
    }
    const startAngle = cursor
    cursor += segAngle
    const color = COLORS[i % COLORS.length]
    const alpha = alphas ? alphas[i] : 1

    const mat = alpha < 1
      ? new THREE.MeshStandardMaterial({ color, metalness: 0.1, roughness: 0.55, transparent: true, opacity: alpha })
      : getCachedMat(color, 0.1, 0.55)
    const mesh = new THREE.Mesh(getSegmentGeometry(segAngle), mat)
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

    const name = displayNames[i]
    const curvedGeo = getCurvedTextGeometry(name, textSize, textDepth)
    if (curvedGeo) {
      const blackMat = new THREE.MeshBasicMaterial({ color: '#000000', side: THREE.DoubleSide })
      const segColorMat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })
      const textMesh = new THREE.Mesh(curvedGeo, [blackMat, segColorMat])
      textMesh.scale.set(1 / 100, 1 / 100, 1 / 100)
      textMesh.position.z = WHEEL_DEPTH + 0.02
      // Parent segment is rotated by startAngle, so only the half-slice
      // offset remains.
      textMesh.rotation.z = segAngle / 2
      textMesh.userData.sharedGeometry = true
      mesh.add(textMesh)
    }
  })

  addWheelCenter()
  markDirty()
}

function addWheelCenter() {
  if (!wheelGroup) return
  wheelGroup.add(getCenterGroup())
}

function buildWheel() {
  const active = props.participants.filter((p) => !p.removed)
  buildWheelWithAngles(active)
}

// Animate: winner segment shrinks, others expand, then emit result
function animateSegmentShrink(winnerId: string, callback: () => void) {
  const active = props.participants.filter((p) => !p.removed)
  const winIdx = active.findIndex((p) => p.id === winnerId)
  if (winIdx === -1) { callback(); return }

  const count = active.length
  const baseAngle = (Math.PI * 2) / count
  const duration = 800
  const startTime = performance.now()

  function frame(now: number) {
    markDirty()
    const t = Math.min((now - startTime) / duration, 1)
    const eased = 1 - Math.pow(1 - t, 2)

    // Winner shrinks to 0, others grow proportionally
    const winAngle = baseAngle * (1 - eased)
    const extraPerOther = (baseAngle * eased) / (count - 1 || 1)
    const angles = active.map((_, i) =>
      i === winIdx ? winAngle : baseAngle + extraPerOther,
    )
    const savedRotation = wheelGroup ? wheelGroup.rotation.z : 0
    buildWheelWithAngles(active, angles)
    if (wheelGroup) wheelGroup.rotation.z = savedRotation

    // Fade out winner's label
    const winMesh = segmentMeshes[winIdx]
    if (winMesh) {
      winMesh.children.forEach((child) => {
        if (child instanceof THREE.Mesh && child.material instanceof THREE.MeshBasicMaterial) {
          child.material.opacity = 1 - eased
        }
      })
    }

    if (t < 1) {
      requestAnimationFrame(frame)
    } else {
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

  // World size of wheel (diameter + pointer + margin)
  const wheelWorld = (WHEEL_RADIUS + 0.3) * 2

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
  renderer.setSize(w, h)
  fitWheel()
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


  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.dampingFactor = 0.08
  controls.enablePan = false
  controls.minDistance = 4
  controls.maxDistance = 14
  controls.minPolarAngle = 0.3
  controls.maxPolarAngle = Math.PI - 0.3
  controls.addEventListener('change', markDirty)

  scene.add(new THREE.AmbientLight(0xffffff, 0.7))
  const key = new THREE.DirectionalLight(0xffffff, 1.0)
  key.position.set(2, 4, 8)
  scene.add(key)
  const fill = new THREE.DirectionalLight(0x8899cc, 0.35)
  fill.position.set(-3, -2, 6)
  scene.add(fill)

  // Specular highlight light for metallic text
  const specLight = new THREE.PointLight(0xffffff, 3, 20)
  specLight.position.set(0, 2, 6)
  scene.add(specLight)

  // Pivot group — holds wheel + pointer, shifted so center aligns
  // between left edge and the right-side menu panel
  pivotGroup = new THREE.Group()
  scene.add(pivotGroup)

  wheelGroup = new THREE.Group()
  pivotGroup.add(wheelGroup)

  const pShape = new THREE.Shape()
  pShape.moveTo(0, -0.05)
  pShape.lineTo(-0.18, 0.4)
  pShape.lineTo(0.18, 0.4)
  pShape.lineTo(0, -0.05)
  const pGeo = new THREE.ExtrudeGeometry(pShape, { depth: 0.15, bevelEnabled: false })
  const pMat = new THREE.MeshStandardMaterial({ color: '#e74c3c', metalness: 0.25, roughness: 0.4 })
  pointerMesh = new THREE.Mesh(pGeo, pMat)
  pointerMesh.position.set(0, WHEEL_RADIUS + 0.15, 0.3)
  pivotGroup.add(pointerMesh)

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

    if (needsRender) {
      needsRender = false
      renderer.render(scene, camera)
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

  const startZ = -WHEEL_DEPTH / 2
  const duration = 500
  const startTime = performance.now()

  function frame(now: number) {
    markDirty()
    const t = Math.min((now - startTime) / duration, 1)
    const eased = 1 - Math.pow(1 - t, 3) * Math.cos(t * Math.PI * 2)
    seg!.position.z = startZ + 0.4 * eased

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

// Called from parent to dismiss the winner and start shrink
function dismissWinner() {
  const winnerId = pendingWinnerId
  const onDismiss = pendingOnDismiss
  pendingWinnerId = null
  pendingOnDismiss = null

  if (winnerId && onDismiss) {
    animateSegmentShrink(winnerId, onDismiss)
  }
}

defineExpose({ dismissWinner })

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
  const fullSpins = Math.PI * 2 * (5 + Math.floor(Math.random() * 3)) * spinDirection
  const totalRotation = fullSpins + delta
  const duration = 4000
  const startTime = performance.now()
  const startRot = currentRotation

  isSpinAnimating = true
  setHoveredBtn(null)
  resetSegments()
  if (controls) controls.enabled = false

  const camFrom = camera.position.clone()
  const camHome = new THREE.Vector3(0, 0, homeCamZ)
  const camReturnDuration = 800

  function frame(now: number) {
    markDirty()
    const elapsed = now - startTime
    const t = Math.min(elapsed / duration, 1)
    const eased = 1 - Math.pow(1 - t, 3)

    currentRotation = startRot + totalRotation * eased
    if (wheelGroup) {
      wheelGroup.rotation.z = currentRotation
    }

    if (camera && elapsed < camReturnDuration) {
      const ct = Math.min(elapsed / camReturnDuration, 1)
      const ce = 1 - Math.pow(1 - ct, 2)
      camera.position.lerpVectors(camFrom, camHome, ce)
      camera.lookAt(controls?.target ?? new THREE.Vector3(0, 0, 0))
    } else if (camera && elapsed >= camReturnDuration && elapsed < camReturnDuration + 16) {
      camera.position.copy(camHome)
      camera.lookAt(controls?.target ?? new THREE.Vector3(0, 0, 0))
    }

    if (t < 1) {
      requestAnimationFrame(frame)
    } else {
      isSpinAnimating = false
      azimuthVelocity = 0
      flickCooldown = 120
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
  }

  requestAnimationFrame(frame)
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

function onCanvasMouseMove(e: MouseEvent) {
  if (!renderer || !camera) return
  if (props.spinning || isSpinAnimating) {
    setHoveredBtn(null)
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
}

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
  if (sharedDividerGeo) sharedDividerGeo.dispose()
  if (controls) controls.dispose()
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
