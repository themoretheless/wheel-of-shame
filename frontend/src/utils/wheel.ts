// Pure wheel math utilities (no Vue / three deps).
// Used for angle computation, simulation, and testing.
// Grounded in existing logic from WheelCanvas and export.ts.

export type WeightedSegment = { id: string; weight: number };

/**
 * Normalize weights (default 1) and compute proportional radian angles.
 * Matches the logic previously duplicated in WheelCanvas buildWheel + exportWheelSVG.
 */
export function computeAngles(segments: Array<{ id: string; weight?: number }>): number[] {
  const weights = segments.map(s => Math.max(0.1, s.weight ?? 1));
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  return weights.map(w => (w / total) * (Math.PI * 2));
}

/**
 * Weighted random pick index (for simulation / tests).
 * Returns index into the input array.
 */
export function weightedPickIndex<T extends { weight?: number }>(items: T[], rng: () => number = Math.random): number {
  const weights = items.map(i => Math.max(0.1, i.weight ?? 1));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return Math.floor(rng() * items.length);

  let r = rng() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

/**
 * Simple simulation helper: returns sequence of picked ids for N spins.
 * Useful for property tests and "AI suggest" previews.
 */
export function simulateSpins<T extends { id: string; weight?: number }>(
  items: T[],
  count: number,
  rng: () => number = Math.random
): string[] {
  const active = [...items];
  const picked: string[] = [];
  for (let i = 0; i < count && active.length > 0; i++) {
    const idx = weightedPickIndex(active, rng);
    const [chosen] = active.splice(idx, 1);
    picked.push(chosen.id);
  }
  return picked;
}

/**
 * Basic rule example: prevent immediate repeat (last picked).
 */
export function filterPreventRepeat<T extends { id: string }>(
  active: T[],
  lastPickedId: string | null
): T[] {
  if (!lastPickedId) return active;
  return active.filter(p => p.id !== lastPickedId);
}

/**
 * Which segment id sits under the fixed top pointer for a given wheel rotation,
 * assuming uniform slices (the spin tick-cross approximation used by the
 * renderer). `ids` is in wheel order (segment 0 starts at angle 0). Returns null
 * for an empty list or an undefined slot.
 *
 * This is the pure core of the per-frame tick logic in
 * ThreeWheelRenderer.playSpin, extracted so the mapping is unit-tested: the id
 * list there was previously never populated, so `ids[crossed]` was always
 * undefined and the spin played no ticks at all.
 */
export function segmentIdAtRotation(
  rotation: number,
  ids: Array<string | undefined>
): string | null {
  const n = ids.length;
  if (n === 0) return null;
  const twoPi = Math.PI * 2;
  const slice = twoPi / n;
  const rotNorm = ((rotation % twoPi) + twoPi) % twoPi;
  let crossed = Math.floor(rotNorm / slice);
  if (crossed >= n) crossed = n - 1;
  if (crossed < 0) crossed = 0;
  return ids[crossed] ?? null;
}

export default {
  computeAngles,
  weightedPickIndex,
  simulateSpins,
  filterPreventRepeat,
  segmentIdAtRotation,
};