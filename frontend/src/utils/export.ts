import type { Participant } from '../types'
import { computeAngles } from './wheel'

export async function exportWheelSVG(participants: Participant[], title: string): Promise<string> {
  // Simple SVG generator using shared pure math
  const active = participants.filter(p => !p.removed)
  const angles = computeAngles(active)
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">`
  svg += `<circle cx="200" cy="200" r="180" fill="#1e1e1e" stroke="#4ECDC4" stroke-width="4"/>`
  let cursor = -Math.PI / 2
  active.forEach((p, i) => {
    const angle = angles[i] || (Math.PI * 2 / active.length)
    const end = cursor + angle
    const x1 = 200 + 170 * Math.cos(cursor)
    const y1 = 200 + 170 * Math.sin(cursor)
    const x2 = 200 + 170 * Math.cos(end)
    const y2 = 200 + 170 * Math.sin(end)
    const large = angle > Math.PI ? 1 : 0
    const color = p.visual?.color_override || '#4ECDC4'
    svg += `<path d="M200,200 L${x1},${y1} A170,170 0 ${large} 1 ${x2},${y2} Z" fill="${color}" stroke="#fff" stroke-width="1"/>`
    cursor = end
  })
  svg += `<text x="200" y="200" text-anchor="middle" fill="#fff" font-size="16">${title}</text>`
  svg += `</svg>`
  return svg
}

export async function captureSpinGIF(canvas: HTMLCanvasElement, durationMs = 2000): Promise<Blob> {
  const stream = canvas.captureStream(30)
  const recorder = new MediaRecorder(stream)
  const chunks: Blob[] = []
  recorder.ondataavailable = e => chunks.push(e.data)
  recorder.start()
  await new Promise(r => setTimeout(r, durationMs))
  recorder.stop()
  return new Promise(resolve => {
    recorder.onstop = () => {
      // Release camera-like stream tracks to avoid leaking
      stream.getTracks().forEach(t => t.stop())
      resolve(new Blob(chunks, { type: 'video/webm' }))
    }
  })
}
