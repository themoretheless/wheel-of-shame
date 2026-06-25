/**
 * Renderer abstraction for the wheel.
 * Allows swapping the underlying implementation:
 *  - Three.js (current)
 *  - 2D Canvas fallback (lightweight)
 *  - WebGPU (future)
 *
 * The goal (from scratch design): WheelCanvas / roster only talk to this interface.
 * Prepared segments are the contract.
 */

import type { PreparedSegment } from '../components/WheelCanvas.vue'

export interface WheelRenderer {
  /** Full (re)build. Expensive - use sparingly. */
  build(segments: PreparedSegment[]): void

  /**
   * Fast in-place update. Preferred for weight drags, last/prevent highlights.
   * Only touch transform + material properties.
   */
  updateInPlace(segments: PreparedSegment[]): void

  /** Play the spin animation to a winner. */
  playSpin(winnerId: string, onComplete: () => void): void

  /** Set hover / focus highlight on a segment. */
  setHighlight(id: string | null): void

  /** Cleanup resources. */
  dispose(): void
}

// Current concrete implementation lives inside WheelCanvas (Three.js).
// In a full redesign, the scene code would be moved here as WheelThreeRenderer.
export type { PreparedSegment }