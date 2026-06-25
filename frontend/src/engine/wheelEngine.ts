/**
 * Pure WheelEngine - the domain core.
 * No Vue, no DOM, no Three, no network.
 * Single place for:
 *  - angle computation
 *  - weighted picking with rules
 *  - simulation
 *  - bias / prevent logic
 *
 * This is what I would put at the center from day one.
 */

import { computeAngles, weightedPickIndex, simulateSpins, filterPreventRepeat } from '../utils/wheel'
import type { Participant } from '../types'

export interface WheelSegment {
  id: string
  name: string
  weight: number
  visual?: Participant['visual']
}

export interface SpinResult {
  picked: WheelSegment
  remaining: WheelSegment[]
}

export class WheelEngine {
  private segments: WheelSegment[] = []
  private lastPickedId: string | null = null
  private preventRepeat = true
  private biasMap: Record<string, number> = {} // id -> extra bias multiplier

  constructor(initial?: WheelSegment[]) {
    if (initial) this.setSegments(initial)
  }

  setSegments(segs: WheelSegment[]) {
    this.segments = segs.map(s => ({
      id: s.id,
      name: s.name,
      weight: Math.max(0.1, s.weight ?? 1),
      visual: s.visual
    }))
  }

  getSegments(): WheelSegment[] {
    return [...this.segments]
  }

  setPreventRepeat(enabled: boolean) {
    this.preventRepeat = enabled
  }

  getPreventRepeat(): boolean {
    return this.preventRepeat
  }

  setLastPicked(id: string | null) {
    this.lastPickedId = id
  }

  getLastPicked(): string | null {
    return this.lastPickedId
  }

  // Apply bias (e.g. from AI suggestion or history)
  setBias(id: string, multiplier: number) {
    if (multiplier <= 0) {
      delete this.biasMap[id]
    } else {
      this.biasMap[id] = multiplier
    }
  }

  clearBiases() {
    this.biasMap = {}
  }

  // Get effective weight after prevent + bias
  private getEffectiveSegments(): WheelSegment[] {
    let candidates = this.segments

    if (this.preventRepeat && this.lastPickedId) {
      candidates = filterPreventRepeat(candidates, this.lastPickedId) as WheelSegment[]
    }

    return candidates.map(seg => {
      const bias = this.biasMap[seg.id] || 1
      return {
        ...seg,
        weight: seg.weight * bias
      }
    })
  }

  computeAngles(): number[] {
    return computeAngles(this.segments)
  }

  /**
   * Returns ready-to-render segments with precomputed angle + visual flags.
   * This is what WheelCanvas should receive (per "from scratch" perf design).
   */
  getPreparedSegments(): Array<{
    id: string
    name: string
    weight: number
    angle: number
    color: string
    isLast: boolean
    isPrevented: boolean
  }> {
    const angles = computeAngles(this.segments)
    const last = this.lastPickedId
    const prevent = this.preventRepeat

    return this.segments.map((seg, i) => {
      const w = seg.weight
      // color from visual or identity (simple fallback here; real uses identityColor)
      const color = (seg.visual as any)?.color_override || '#4ECDC4'

      return {
        id: seg.id,
        name: seg.name,
        weight: w,
        angle: angles[i] || (Math.PI * 2 / this.segments.length),
        color,
        isLast: prevent && last === seg.id,
        isPrevented: prevent && last === seg.id,
      }
    })
  }

  // Main pick with rules applied
  pick(): SpinResult | null {
    const effective = this.getEffectiveSegments()
    if (effective.length === 0) return null

    const idx = weightedPickIndex(effective)
    const picked = { ...effective[idx] }

    const remaining = this.segments.filter(s => s.id !== picked.id)

    // Update internal state
    this.lastPickedId = picked.id

    return {
      picked,
      remaining: remaining.map(r => ({ ...r }))
    }
  }

  // Pure simulation (used by AI suggest etc)
  simulate(count: number): string[] {
    return simulateSpins(this.segments, count)
  }

  // Suggest weight for a participant (e.g. least recently picked)
  suggestLeastRecentBias(factor = 2.5): { id: string; weight: number } | null {
    if (this.segments.length === 0) return null

    const picks = this.simulate(20)
    const counts: Record<string, number> = {}
    picks.forEach(id => { counts[id] = (counts[id] || 0) + 1 })

    let target = this.segments[0].id
    let min = Infinity
    this.segments.forEach(p => {
      const c = counts[p.id] || 0
      if (c < min) {
        min = c
        target = p.id
      }
    })

    return { id: target, weight: factor }
  }

  // Equalize all to 1x
  equalize(): WheelSegment[] {
    return this.segments.map(s => ({ ...s, weight: 1 }))
  }

  // Reorder helper (returns new array)
  reorder(from: number, to: number): WheelSegment[] {
    const list = [...this.segments]
    const [moved] = list.splice(from, 1)
    list.splice(to, 0, moved)
    this.segments = list
    return [...list]
  }
}

// Convenience factory
export function createWheelEngine(participants: Array<{id: string, name: string, weight?: number, visual?: any}>) {
  const segs: WheelSegment[] = participants.map(p => ({
    id: p.id,
    name: p.name,
    weight: p.weight ?? 1,
    visual: p.visual
  }))
  return new WheelEngine(segs)
}
