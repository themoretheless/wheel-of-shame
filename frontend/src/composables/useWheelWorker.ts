/**
 * Composable wrapper around the wheel-math Web Worker.
 * Provides async versions of heavy functions.
 * Falls back to synchronous utils if worker is unavailable (e.g. SSR or old browsers).
 */

import { ref, onBeforeUnmount } from 'vue'
import type { WorkerResponse } from '../workers/wheel-math.worker'
import { computeAngles, simulateSpins } from '../utils/wheel'

// @ts-ignore - Vite ?worker
import WheelMathWorker from '../workers/wheel-math.worker.ts?worker'

let worker: Worker | null = null
let nextId = 1
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()

function ensureWorker() {
  if (worker) return worker
  try {
    worker = new WheelMathWorker() as Worker

    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const msg = e.data
      const p = pending.get(msg.id)
      if (p) {
        pending.delete(msg.id)
        if ('error' in msg) p.reject(new Error(String((msg as any).error)))
        else p.resolve(msg.result)
      }
    }

    worker.onerror = (e) => {
      console.warn('[wheel-worker] error, falling back to sync', e)
      worker = null
      // Settle any in-flight requests instead of leaving their awaiters hung on a
      // dead worker; each caller has a sync fallback in its catch.
      for (const [, p] of pending) p.reject(new Error('wheel worker crashed'))
      pending.clear()
    }
  } catch (e) {
    console.warn('[wheel-worker] unavailable, using sync fallback', e)
    worker = null
  }
  return worker
}

function post<T>(req: any): Promise<T> {
  return new Promise((resolve, reject) => {
    const id = nextId++
    const w = ensureWorker()
    if (!w) {
      // sync fallback
      try {
        if (req.type === 'computeAngles') {
          resolve(computeAngles(req.segments) as any)
        } else if (req.type === 'simulate') {
          resolve(simulateSpins(req.segments, req.count) as any)
        } else {
          reject(new Error('Unsupported sync fallback'))
        }
      } catch (err: any) { reject(err) }
      return
    }
    pending.set(id, { resolve, reject })
    w.postMessage({ ...req, id })
  })
}

export function useWheelWorker() {
  const busy = ref(false)

  async function computeAnglesAsync(segments: Array<{ id: string; weight?: number }>): Promise<number[]> {
    busy.value = true
    try {
      return await post<number[]>({ type: 'computeAngles', segments })
    } finally {
      busy.value = false
    }
  }

  async function simulateAsync(segments: Array<{ id: string; weight?: number }>, count: number): Promise<string[]> {
    busy.value = true
    try {
      return await post<string[]>({ type: 'simulate', segments, count })
    } finally {
      busy.value = false
    }
  }

  onBeforeUnmount(() => {
    // We keep the worker singleton alive for the app lifetime.
    // If you want to terminate: worker?.terminate(); worker = null
  })

  return {
    busy,
    computeAnglesAsync,
    simulateAsync,
    // Future: weightedPickAsync, prepareExportData etc.
  }
}
