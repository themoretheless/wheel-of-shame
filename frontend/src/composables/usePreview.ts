import { ref, onBeforeUnmount } from 'vue'
import * as api from '../api/client'

export interface PreviewOverride {
  weight?: number
  visual?: any
}

export function usePreview(session: any, history: any) {
  const previewOverrides = ref<Record<string, PreviewOverride>>({})
  let previewThrottle: number | null = null

  function setPreviewOverride(id: string, override: PreviewOverride) {
    if (previewThrottle) cancelAnimationFrame(previewThrottle)
    previewThrottle = requestAnimationFrame(() => {
      previewOverrides.value = { ...previewOverrides.value, [id]: override }
    })
  }

  function clearPreviewOverrides() {
    if (previewThrottle) cancelAnimationFrame(previewThrottle)
    previewOverrides.value = {}
  }

  onBeforeUnmount(() => {
    if (previewThrottle) cancelAnimationFrame(previewThrottle)
  })

  async function setPreviewOverrideFromHistory(actionId: string) {
    if (!session.value) return
    try {
      const snap = await api.getSnapshot(session.value.id, actionId)
      if (snap && snap.participants) {
        clearPreviewOverrides()
        for (const p of snap.participants) {
          if (p.weight !== undefined) {
            setPreviewOverride(p.id, { weight: p.weight })
          }
        }
      }
    } catch {
      const h = history as { actions?: { value?: Array<{ id: string }> } } | undefined
      const len = h?.actions?.value?.length || 0
      if (len > 0) {
        const first = (h!.actions!.value as Array<{ id: string }>)[0]
        setPreviewOverride(first.id, { weight: 0.5 })
      }
    }
  }

  return {
    previewOverrides,
    setPreviewOverride,
    clearPreviewOverrides,
    setPreviewOverrideFromHistory,
  }
}
