// The renderer's data contract. A participant's wheel segment, fully resolved
// (angle, color, prevent-repeat flags) so a WheelRenderer needs no roster or Vue
// dependency. Lives in types/ (not in a Vue SFC) so the renderer layer can be
// unit-tested and a 2D/headless renderer can implement the same interface
// without importing upward into components.
export interface PreparedSegment {
  id: string
  name?: string
  weight: number
  angle: number
  color: string
  isLast?: boolean
  isPrevented?: boolean
}
