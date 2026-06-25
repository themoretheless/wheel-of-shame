import { exportWheelSVG, captureSpinGIF } from '../utils/export'

// Extracted export logic from App god component.
export function useExports(deps: {
  session: any
  activeParticipants: any
  removedParticipants: any
  analytics: any
  wheelRef: any
  pushToast: (msg: string, kind?: any) => void
}) {
  async function exportWheel() {
    if (!deps.session.value) return
    const svg = await exportWheelSVG(deps.activeParticipants.value, deps.session.value.title)
    const blob = new Blob([svg], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${deps.session.value.title}-wheel.svg`
    a.click()
    URL.revokeObjectURL(url)
    deps.pushToast('Wheel SVG exported', 'success')
  }

  async function exportSpin() {
    const canvas = deps.wheelRef.value?.captureCanvas?.()
    if (canvas) {
      const blob = await captureSpinGIF(canvas, 1500)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'spin.webm'
      a.click()
      URL.revokeObjectURL(url)
      deps.pushToast('Spin capture exported', 'success')
    } else {
      deps.pushToast('Could not capture spin', 'info')
    }
  }

  async function exportPDF() {
    // Mock PDF report
    const content = `Wheel Report: ${deps.session.value?.title}\nRemoved: ${deps.removedParticipants.value.length}\nAnalytics: ${deps.analytics.value}\nWeights: ${deps.activeParticipants.value.map((p: any) => `${p.name}:${p.weight||1}`).join(', ')}`
    const blob = new Blob([content], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'report.txt'
    a.click()
    URL.revokeObjectURL(url)
    deps.pushToast('Report exported (mock PDF)', 'success')
  }

  return {
    exportWheel,
    exportSpin,
    exportPDF,
  }
}
