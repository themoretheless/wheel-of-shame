// Deterministic per-name identity color (Linear-style). The same name always
// maps to the same hue, so a participant keeps its color across adds/removes
// and the wheel segment matches the roster token — unlike index-based palettes,
// which reshuffle colors whenever the roster changes.

// FNV-1a style hash over the trimmed, case-folded name, reduced to a hue.
export function hashName(name: string): number {
  const s = name.trim().toLowerCase()
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  // Unsigned, then map into 0..359.
  return (h >>> 0) % 360
}

// CSS/three.js-compatible HSL string. Saturation/lightness are tuned to sit in
// the same pastel range as the legacy COLORS palette so the wheel reads the
// same on the dark backdrop.
const colorCache = new Map<string, string>()
export function identityColor(name: string): string {
  if (colorCache.has(name)) return colorCache.get(name)!
  const c = `hsl(${hashName(name)}, 62%, 66%)`
  colorCache.set(name, c)
  return c
}
