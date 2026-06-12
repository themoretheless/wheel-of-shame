// Minimal type declarations for opentype.js v1.3.4, covering only the API
// surface used in this project (load, Font.getPath, Path commands).
declare module 'opentype.js' {
  namespace opentype {
    interface BoundingBox {
      x1: number
      y1: number
      x2: number
      y2: number
    }

    type PathCommand =
      | { type: 'M'; x: number; y: number }
      | { type: 'L'; x: number; y: number }
      | { type: 'Q'; x1: number; y1: number; x: number; y: number }
      | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
      | { type: 'Z' }

    interface Path {
      commands: PathCommand[]
      getBoundingBox(): BoundingBox
    }

    interface Font {
      getPath(text: string, x: number, y: number, fontSize: number): Path
    }

    function load(
      url: string,
      callback: (err: Error | null, font?: Font) => void,
    ): void
  }

  export = opentype
}
