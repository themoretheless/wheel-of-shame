import { describe, it, expect } from 'vitest'
import { computeAngles, segmentIdAtRotation } from './wheel'

const TAU = Math.PI * 2

describe('computeAngles', () => {
  it('splits a full turn evenly for equal weights', () => {
    const angles = computeAngles([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }])
    expect(angles).toHaveLength(4)
    for (const a of angles) expect(a).toBeCloseTo(TAU / 4)
    expect(angles.reduce((s, a) => s + a, 0)).toBeCloseTo(TAU)
  })

  it('is proportional to weight', () => {
    const angles = computeAngles([{ id: 'a', weight: 3 }, { id: 'b', weight: 1 }])
    expect(angles[0]).toBeCloseTo((3 / 4) * TAU)
    expect(angles[1]).toBeCloseTo((1 / 4) * TAU)
  })
})

describe('segmentIdAtRotation', () => {
  // The latent bug this guards: the renderer's id list was never populated, so
  // the mapping was always fed an empty array and returned null -> no ticks.
  it('returns null for an empty id list', () => {
    expect(segmentIdAtRotation(0, [])).toBeNull()
    expect(segmentIdAtRotation(5.5, [])).toBeNull()
  })

  it('returns the only id regardless of rotation for a single segment', () => {
    const ids = ['solo']
    for (const r of [0, Math.PI, 5, -3, 100]) {
      expect(segmentIdAtRotation(r, ids)).toBe('solo')
    }
  })

  it('maps each quarter turn to the right segment for 4 uniform slices', () => {
    const ids = ['a', 'b', 'c', 'd'] // slice = TAU/4
    expect(segmentIdAtRotation(0, ids)).toBe('a')
    expect(segmentIdAtRotation(TAU / 4 - 0.01, ids)).toBe('a')
    expect(segmentIdAtRotation(TAU / 4, ids)).toBe('b')
    expect(segmentIdAtRotation(TAU / 2, ids)).toBe('c')
    expect(segmentIdAtRotation((3 * TAU) / 4, ids)).toBe('d')
  })

  it('wraps rotations outside [0, TAU)', () => {
    const ids = ['a', 'b', 'c', 'd']
    expect(segmentIdAtRotation(TAU, ids)).toBe('a') // full turn -> back to start
    expect(segmentIdAtRotation(TAU + TAU / 4, ids)).toBe('b')
    expect(segmentIdAtRotation(-TAU / 4, ids)).toBe('d') // negative wraps forward
  })

  it('returns null for an undefined slot', () => {
    const ids = ['a', undefined]
    expect(segmentIdAtRotation(0, ids)).toBe('a')
    expect(segmentIdAtRotation(TAU / 2 + 0.1, ids)).toBeNull()
  })

  it('never goes out of bounds at the upper boundary', () => {
    const ids = ['a', 'b', 'c']
    // A rotation that normalizes to just under TAU must land on the last slot.
    expect(segmentIdAtRotation(TAU - 1e-9, ids)).toBe('c')
  })
})
