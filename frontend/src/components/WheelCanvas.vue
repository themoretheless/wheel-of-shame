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

  return cachedCenterGroup.clone(true)
}
let currentRotation = 0
let isSpinAnimating = false
let segmentMeshes: THREE.Mesh[] = []
let lastAzimuth = 0
let azimuthVelocity = 0
let isPointerDown = false
let flickCooldown = 0
let homeCamZ = BASE_CAM_Z
const FLICK_THRESHOLD = 0.06 // radians per frame — trigger spin

const WHEEL_RADIUS = 2.2
const WHEEL_INNER = 0.6
const WHEEL_DEPTH = 0.3


const textGeoCache = new Map<string, THREE.BufferGeometry>()

function getTextGeometry(text: string, size: number, depth: number): THREE.BufferGeometry | null {
  if (!otFont) return null
  const key = `${text}_${size}_${depth}`
  if (textGeoCache.has(key)) return textGeoCache.get(key)!

  // Use ShapePath — automatically handles holes (О, А, Б, etc.)
  // Opentype Y is inverted vs Three.js — negate X to mirror so text reads correctly
  // after being bent along the arc (which reverses reading direction)
  const otPath = otFont.getPath(text, 0, 0, size)

  // Get text width for centering after X-flip
  const otBB = otFont.getPath(text, 0, 0, size).getBoundingBox()
  const textW = otBB.x2 - otBB.x1

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

  const shapes = shapePath.toShapes(false)
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

function isLightColor(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return (r * 299 + g * 587 + b * 114) / 1000 > 150
}

function disposeChild(obj: THREE.Object3D) {
  if (obj instanceof THREE.Mesh) {
    obj.geometry.dispose()
    const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
    mats.forEach((m) => {
      if (m.map) m.map.dispose()
      m.dispose()
    })
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
  segmentBumps = []
}

const POINTER_BUMP = 0.15
const BUMP_LERP_SPEED = 0.12 // 0..1, higher = snappier
let segmentBumps: number[] = [] // current Z offset per segment

function updatePointerHighlight() {
  if (segmentMeshes.length === 0) return
  const count = segmentMeshes.length

  // Ensure bumps array matches segment count
  if (segmentBumps.length !== count) {
    segmentBumps = new Array(count).fill(0)
  }

  const sliceAngle = (Math.PI * 2) / count

  let angle = currentRotation % (Math.PI * 2)
  if (angle < 0) angle += Math.PI * 2

  // Pointer is at PI/2. For each segment, calculate angular distance to pointer.
  for (let i = 0; i < count; i++) {
    const segCenter = i * sliceAngle + sliceAngle / 2
    // Angular distance between segment center (rotated) and pointer
    let dist = ((segCenter + angle - Math.PI / 2) % (Math.PI * 2))
    if (dist < 0) dist += Math.PI * 2
    if (dist > Math.PI) dist = Math.PI * 2 - dist
    // Normalize: 0 = directly at pointer, 1 = opposite side
    const proximity = 1 - dist / Math.PI
    // Only bump segments that are close (within ~1.5 segments)
    const threshold = sliceAngle * 1.5
    const target = dist < threshold
      ? POINTER_BUMP * Math.pow(1 - dist / threshold, 1.5)
      : 0
    // Lerp towards target for smooth transitions
    segmentBumps[i] += (target - segmentBumps[i]) * BUMP_LERP_SPEED
    // Clamp tiny values to zero
    if (Math.abs(segmentBumps[i]) < 0.001) segmentBumps[i] = 0
    segmentMeshes[i].position.z = -WHEEL_DEPTH / 2 + segmentBumps[i]
  }
}

// Build wheel with custom per-segment angles. If no angles given, equal slices.
function buildWheelWithAngles(
  active: { id: string; name: string }[],
  angles?: number[], // radian size per segment
  alphas?: number[], // opacity per segment (0..1)
) {
  if (!wheelGroup) return
  clearGroup(wheelGroup)
  segmentMeshes = []

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

    const shape = new THREE.Shape()
    shape.absarc(0, 0, WHEEL_RADIUS, startAngle, startAngle + segAngle, false)
    shape.absarc(0, 0, WHEEL_INNER, startAngle + segAngle, startAngle, true)

    const geo = new THREE.ExtrudeGeometry(shape, {
      depth: WHEEL_DEPTH,
      bevelEnabled: true,
      bevelThickness: 0.015,
      bevelSize: 0.015,
      bevelSegments: 1,
    })
    const mat = alpha < 1
      ? new THREE.MeshStandardMaterial({ color, metalness: 0.1, roughness: 0.55, transparent: true, opacity: alpha })
      : getCachedMat(color, 0.1, 0.55)
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.z = -WHEEL_DEPTH / 2
    mesh.userData.participantId = p.id
    mesh.userData.segmentIndex = i
    segmentMeshes.push(mesh)
    wheelGroup.add(mesh)

    // Divider line
    const pts = [
      new THREE.Vector3(
        Math.cos(startAngle) * WHEEL_INNER,
        Math.sin(startAngle) * WHEEL_INNER,
        WHEEL_DEPTH / 2 + 0.01,
      ),
      new THREE.Vector3(
        Math.cos(startAngle) * WHEEL_RADIUS,
        Math.sin(startAngle) * WHEEL_RADIUS,
        WHEEL_DEPTH / 2 + 0.01,
      ),
    ]
    const lineGeo = new THREE.BufferGeometry().setFromPoints(pts)
    wheelGroup.add(new THREE.Line(lineGeo, getLineMat()))

    // 3D extruded text bent along the arc
    const midAngle = startAngle + segAngle / 2
    const arcR = WHEEL_INNER + (WHEEL_RADIUS - WHEEL_INNER) * 0.65
    const name = p.name.length > 12 ? p.name.slice(0, 11) + '…' : p.name
    const light = isLightColor(color)

    const textSize = Math.min(28, Math.max(14, 110 / active.length))
    const textDepth = 4
    const srcGeo = getTextGeometry(name, textSize, textDepth)
    if (srcGeo) {
      // Clone and bend vertices along the arc
      const curvedGeo = srcGeo.clone()
      const pos = curvedGeo.getAttribute('position')
      const r = arcR * 100 // work in font units (scale 1/100)

      for (let vi = 0; vi < pos.count; vi++) {
        const x = pos.getX(vi) // along text width → angle on arc
        const y = pos.getY(vi) // text height → radial offset
        const z = pos.getZ(vi) // extrude depth → Z towards camera

        const angle = x / r
        const radius = r + y
        pos.setX(vi, Math.cos(angle) * radius)
        pos.setY(vi, Math.sin(angle) * radius)
        pos.setZ(vi, z)
      }
      pos.needsUpdate = true
      // Recompute normals: front faces should point +Z (towards camera)
      // After bending, computeVertexNormals gives wrong results, so set manually
      const normals = curvedGeo.getAttribute('normal')
      for (let vi = 0; vi < normals.count; vi++) {
        const z = pos.getZ(vi)
        if (z > textDepth * 0.5) {
          // Front face — point towards camera
          normals.setXYZ(vi, 0, 0, 1)
        } else if (z < 0.5) {
          // Back face
          normals.setXYZ(vi, 0, 0, -1)
        } else {
          // Side faces — point outward from arc center
          const x = pos.getX(vi)
          const y = pos.getY(vi)
          const len = Math.sqrt(x * x + y * y) || 1
          normals.setXYZ(vi, x / len, y / len, 0)
        }
      }
      normals.needsUpdate = true

      const scale = 1 / 100
      // Color faces by normal direction: front/back (Z-facing) = black, sides = segment color
      const blackMat = new THREE.MeshBasicMaterial({ color: '#000000', side: THREE.DoubleSide })
      const segColorMat = new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide })

      // Split into 2 groups by checking face normals
      const norms = curvedGeo.getAttribute('normal')
      const idx = curvedGeo.getIndex()
      if (idx) {
        // Clear existing groups
        curvedGeo.clearGroups()

        for (let fi = 0; fi < idx.count; fi += 3) {
          const i0 = idx.getX(fi)
          const nz = Math.abs(norms.getZ(i0))
          // If normal mostly faces Z → front/back face → black (0)
          // Otherwise → side face → segment color (1)
          const matIdx = nz > 0.5 ? 0 : 1
          curvedGeo.addGroup(fi, 3, matIdx)
        }
      }

      const textMesh = new THREE.Mesh(curvedGeo, [blackMat, segColorMat])
      textMesh.scale.set(scale, scale, scale)
      textMesh.position.z = WHEEL_DEPTH + 0.02
      textMesh.rotation.z = midAngle
      mesh.add(textMesh)
    }
  })

  addWheelCenter()
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
const BASE_CAM_Z = 7.8
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

function onCanvasClick(e: MouseEvent) {
  if (!renderer || !camera || isSpinAnimating) return
  if (props.spinning || props.participants.filter(p => !p.removed).length === 0) return

  const rect = renderer.domElement.getBoundingClientRect()
  const mouse = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  )

  if (!raycaster) raycaster = new THREE.Raycaster()
  raycaster.setFromCamera(mouse, camera)

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
    if (controls) controls.update()

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

    renderer.render(scene, camera)
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

function getWinnerFromAngle(active: { id: string }[]): string {
  // Pointer is at top (PI/2). Find which segment is there.
  const sliceAngle = (Math.PI * 2) / active.length
  // Normalize rotation to 0..2PI
  let angle = currentRotation % (Math.PI * 2)
  if (angle < 0) angle += Math.PI * 2
  // Pointer at PI/2: segment index = floor((PI/2 - angle) / sliceAngle) mod count
  let pointerAngle = (Math.PI / 2 - angle) % (Math.PI * 2)
  if (pointerAngle < 0) pointerAngle += Math.PI * 2
  const idx = Math.floor(pointerAngle / sliceAngle) % active.length
  return active[idx].id
}

function animateSpin() {
  const active = props.participants.filter((p) => !p.removed)
  if (active.length === 0 || !props.winnerId) return

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
  resetSegments()
  if (controls) controls.enabled = false

  const camFrom = camera.position.clone()
  const camHome = new THREE.Vector3(0, 0, homeCamZ)
  const camReturnDuration = 800

  function frame(now: number) {
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
function onCanvasMouseMove(e: MouseEvent) {
  if (!renderer || !camera) return
  const rect = renderer.domElement.getBoundingClientRect()
  const mouse = new THREE.Vector2(
    ((e.clientX - rect.left) / rect.width) * 2 - 1,
    -((e.clientY - rect.top) / rect.height) * 2 + 1,
  )
  if (!raycaster) raycaster = new THREE.Raycaster()
  raycaster.setFromCamera(mouse, camera)

  let hovering = false
  for (const btn of [spinBtnLeft, spinBtnRight]) {
    if (!btn) continue
    const mat = btn.material as THREE.MeshStandardMaterial
    const hits = raycaster.intersectObject(btn, false)
    if (hits.length > 0 && !props.spinning) {
      mat.emissive.set('#662222')
      hovering = true
    } else {
      mat.emissive.set('#331111')
    }
  }
  renderer.domElement.style.cursor = hovering ? 'pointer' : 'default'
}

watch(
  () => [props.participants, props.participants.filter((p) => !p.removed).length],
  () => {
    nextTick(() => buildWheel())
  },
  { deep: true },
)

onMounted(() => {
  initScene()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(animFrameId)
  window.removeEventListener('resize', handleResize)
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
