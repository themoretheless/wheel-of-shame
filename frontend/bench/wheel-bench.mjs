// Benchmark of the geometry work done by WheelCanvas.vue during the
// segment-shrink animation (full wheel rebuild on every rAF frame).
//
// "before" replicates the current code path: per frame, per segment —
// new ExtrudeGeometry, text geometry clone, material-group reassignment,
// per-vertex arc bend.
//
// "after" replicates the optimized path: curved text geometry cached by
// (text, size); segment ExtrudeGeometry cached by quantized angle (during
// the shrink there are only 2 unique angles per frame).
//
// Run: node bench/wheel-bench.mjs

import * as THREE from 'three'
import { readFileSync } from 'node:fs'
import opentype from 'opentype.js'

const font = opentype.parse(readFileSync(new URL('../public/Roboto-Bold.ttf', import.meta.url)).buffer)

const WHEEL_RADIUS = 2.2
const WHEEL_INNER = 0.6
const WHEEL_DEPTH = 0.3
const arcR = WHEEL_INNER + (WHEEL_RADIUS - WHEEL_INNER) * 0.65

const NAMES = [
  'Алексей', 'Мария', 'Дмитрий', 'Екатерина', 'Сергей', 'Анна',
  'Николай', 'Ольга', 'Владимир', 'Татьяна', 'Андрей', 'Светлана',
]

// --- flat (un-bent) text geometry, cached in both variants (matches textGeoCache) ---
const flatCache = new Map()
function getFlatTextGeometry(text, size, depth) {
  const key = `${text}_${size}_${depth}`
  if (flatCache.has(key)) return flatCache.get(key)
  const otPath = font.getPath(text, 0, 0, size)
  const bb = otPath.getBoundingBox()
  const textW = bb.x2 - bb.x1
  const shapePath = new THREE.ShapePath()
  for (const cmd of otPath.commands) {
    switch (cmd.type) {
      case 'M': shapePath.moveTo(-(cmd.x - textW / 2), -cmd.y); break
      case 'L': shapePath.lineTo(-(cmd.x - textW / 2), -cmd.y); break
      case 'Q': shapePath.quadraticCurveTo(-(cmd.x1 - textW / 2), -cmd.y1, -(cmd.x - textW / 2), -cmd.y); break
      case 'C': shapePath.bezierCurveTo(-(cmd.x1 - textW / 2), -cmd.y1, -(cmd.x2 - textW / 2), -cmd.y2, -(cmd.x - textW / 2), -cmd.y); break
    }
  }
  const shapes = shapePath.toShapes(false)
  const geo = new THREE.ExtrudeGeometry(shapes, {
    depth, bevelEnabled: true, bevelThickness: depth * 0.15, bevelSize: depth * 0.12, bevelSegments: 1,
  })
  geo.computeBoundingBox()
  const b = geo.boundingBox
  geo.translate(-(b.max.x + b.min.x) / 2, -(b.max.y + b.min.y) / 2, 0)
  flatCache.set(key, geo)
  return geo
}

function bendAndGroup(srcGeo) {
  const curvedGeo = srcGeo.clone()
  const origNormals = curvedGeo.getAttribute('normal')
  const idx = curvedGeo.getIndex()
  curvedGeo.clearGroups()
  const faceCount = idx ? idx.count / 3 : origNormals.count / 3
  for (let ti = 0; ti < faceCount; ti++) {
    const i0 = idx ? idx.getX(ti * 3) : ti * 3
    const i1 = idx ? idx.getY(ti * 3) : ti * 3 + 1
    const i2 = idx ? idx.getZ(ti * 3) : ti * 3 + 2
    const nz = (Math.abs(origNormals.getZ(i0)) + Math.abs(origNormals.getZ(i1)) + Math.abs(origNormals.getZ(i2))) / 3
    curvedGeo.addGroup(ti * 3, 3, nz > 0.5 ? 0 : 1)
  }
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
  return curvedGeo
}

function makeSegmentGeometry(startAngle, segAngle) {
  const shape = new THREE.Shape()
  shape.absarc(0, 0, WHEEL_RADIUS, startAngle, startAngle + segAngle, false)
  shape.absarc(0, 0, WHEEL_INNER, startAngle + segAngle, startAngle, true)
  return new THREE.ExtrudeGeometry(shape, {
    depth: WHEEL_DEPTH, bevelEnabled: true, bevelThickness: 0.015, bevelSize: 0.015, bevelSegments: 1,
  })
}

function shrinkAngles(count, winIdx, eased) {
  const baseAngle = (Math.PI * 2) / count
  const winAngle = baseAngle * (1 - eased)
  const extra = (baseAngle * eased) / (count - 1 || 1)
  return Array.from({ length: count }, (_, i) => (i === winIdx ? winAngle : baseAngle + extra))
}

const textSize = Math.min(28, Math.max(14, 110 / NAMES.length))

// ---------------- BEFORE: current code path ----------------
function frameBefore(angles) {
  const created = []
  let cursor = 0
  for (let i = 0; i < angles.length; i++) {
    const segAngle = angles[i]
    if (segAngle < 0.005) { cursor += segAngle; continue }
    const startAngle = cursor
    cursor += segAngle
    const segGeo = makeSegmentGeometry(startAngle, segAngle)
    created.push(segGeo)
    // divider line
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(Math.cos(startAngle) * WHEEL_INNER, Math.sin(startAngle) * WHEEL_INNER, 0),
      new THREE.Vector3(Math.cos(startAngle) * WHEEL_RADIUS, Math.sin(startAngle) * WHEEL_RADIUS, 0),
    ])
    created.push(lineGeo)
    // text: clone + groups + bend EVERY frame
    const src = getFlatTextGeometry(NAMES[i], textSize, 4)
    created.push(bendAndGroup(src))
  }
  created.forEach((g) => g.dispose())
}

// ---------------- AFTER: cached curved text + segment geo cache ----------------
const curvedCache = new Map()
function getCurvedText(text, size) {
  const key = `${text}_${size}`
  if (curvedCache.has(key)) return curvedCache.get(key)
  const geo = bendAndGroup(getFlatTextGeometry(text, size, 4))
  curvedCache.set(key, geo)
  return geo
}

const segGeoCache = new Map()
function getSegmentGeometry(segAngle) {
  const key = Math.round(segAngle * 2048) // quantized
  if (segGeoCache.has(key)) return segGeoCache.get(key)
  const geo = makeSegmentGeometry(0, segAngle) // built at angle 0, mesh gets rotated
  segGeoCache.set(key, geo)
  return geo
}

const dividerGeo = new THREE.BufferGeometry().setFromPoints([
  new THREE.Vector3(WHEEL_INNER, 0, 0),
  new THREE.Vector3(WHEEL_RADIUS, 0, 0),
]) // shared, mesh rotated per divider

function frameAfter(angles) {
  let cursor = 0
  for (let i = 0; i < angles.length; i++) {
    const segAngle = angles[i]
    if (segAngle < 0.005) { cursor += segAngle; continue }
    cursor += segAngle
    getSegmentGeometry(segAngle) // shared geometry, mesh.rotation.z = startAngle
    getCurvedText(NAMES[i], textSize) // shared geometry
    // divider: shared dividerGeo, rotated — no per-frame work
  }
}

// ---------------- run ----------------
const FRAMES = 48 // ~800ms shrink at 60fps
const WIN_IDX = 4

function runShrink(frameFn) {
  for (let f = 0; f < FRAMES; f++) {
    const t = (f + 1) / FRAMES
    const eased = 1 - Math.pow(1 - t, 2)
    frameFn(shrinkAngles(NAMES.length, WIN_IDX, eased))
  }
}

function bench(label, frameFn, runs) {
  runShrink(frameFn) // warmup (also fills caches in "after")
  const times = []
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now()
    runShrink(frameFn)
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  const median = times[Math.floor(times.length / 2)]
  const perFrame = median / FRAMES
  console.log(`${label}: median ${median.toFixed(1)} ms per ${FRAMES}-frame shrink (${perFrame.toFixed(2)} ms/frame), min ${times[0].toFixed(1)} ms, max ${times[times.length - 1].toFixed(1)} ms`)
  return perFrame
}

console.log(`Participants: ${NAMES.length}, frames: ${FRAMES}\n`)
const before = bench('BEFORE (current)', frameBefore, 15)
const after = bench('AFTER  (cached) ', frameAfter, 15)
console.log(`\nSpeedup: ${(before / after).toFixed(1)}x, frame budget at 60fps is 16.7 ms`)
