/**
 * Web Worker for heavy wheel math.
 * Offloads simulateSpins, computeAngles (large N), and export prep.
 * Keeps main thread responsive (especially during live preview drags or large rosters).
 */

import { computeAngles, simulateSpins, weightedPickIndex } from '../utils/wheel'

export type WorkerRequest =
  | { id: number; type: 'computeAngles'; segments: Array<{ id: string; weight?: number }> }
  | { id: number; type: 'simulate'; segments: Array<{ id: string; weight?: number }>; count: number }
  | { id: number; type: 'weightedPick'; segments: Array<{ id: string; weight?: number }> }

export type WorkerResponse =
  | { id: number; type: 'computeAngles'; result: number[] }
  | { id: number; type: 'simulate'; result: string[] }
  | { id: number; type: 'weightedPick'; result: number }

const ctx: Worker = self as any

ctx.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data
  try {
    switch (msg.type) {
      case 'computeAngles': {
        const angles = computeAngles(msg.segments)
        ctx.postMessage({ id: msg.id, type: 'computeAngles', result: angles })
        break
      }
      case 'simulate': {
        const picks = simulateSpins(msg.segments, msg.count)
        ctx.postMessage({ id: msg.id, type: 'simulate', result: picks })
        break
      }
      case 'weightedPick': {
        const idx = weightedPickIndex(msg.segments)
        ctx.postMessage({ id: msg.id, type: 'weightedPick', result: idx })
        break
      }
      default:
        throw new Error('Unknown worker request type')
    }
  } catch (err: any) {
    ctx.postMessage({ id: msg.id, error: err?.message || String(err) })
  }
}
