// No Vue runtime needed - pure functions extracted from god App.vue
import type { UseHistory } from './useHistory'

// Extracted from App.vue god component to kill the hotkey monolith.
export function useHotkeys(deps: {
  activeParticipants: any // computed or ref
  spinning: any
  winnerData: any
  recapOpen: any
  paletteOpen: any
  shortcutsOpen: any
  recentsOpen: any
  focusedId: any
  hoverPeekId: any
  handleSpin: () => void
  dismissWinner: () => void
  cycleFocus: (dir: 1 | -1) => void
  nameListRef: any
  history: UseHistory | null
  isEditor: any
}) {
  function isEditableTarget(target: EventTarget | null): boolean {
    const el = target as HTMLElement | null
    if (!el) return false
    const tag = el.tagName
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable
  }

  function cycleFocusImpl(dir: 1 | -1) {
    const list = deps.activeParticipants.value || deps.activeParticipants || []
    if (list.length === 0) {
      deps.focusedId.value = null
      return
    }
    deps.hoverPeekId.value = null
    const current = list.findIndex((p: any) => p.id === deps.focusedId.value)
    let next: number
    if (current === -1) {
      next = dir === 1 ? 0 : list.length - 1
    } else {
      next = (current + dir + list.length) % list.length
    }
    deps.focusedId.value = list[next].id
  }

  function onGlobalKeydown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      deps.paletteOpen.value = !deps.paletteOpen.value
      return
    }
    if (deps.paletteOpen.value) return

    if (deps.recentsOpen.value && e.key === 'Escape') {
      e.preventDefault()
      deps.recentsOpen.value = false
      return
    }

    if (deps.shortcutsOpen.value) {
      if (e.key === 'Escape') {
        e.preventDefault()
        deps.shortcutsOpen.value = false
      }
      return
    }

    if (e.key === '?' && !isEditableTarget(e.target)) {
      e.preventDefault()
      deps.shortcutsOpen.value = true
    } else if (
      (e.key === '/' || e.key === 'n') &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !isEditableTarget(e.target)
    ) {
      e.preventDefault()
      deps.nameListRef.value?.focusInput()
    } else if (
      e.key === 'Tab' &&
      !e.metaKey &&
      !e.ctrlKey &&
      !e.altKey &&
      !isEditableTarget(e.target) &&
      !deps.winnerData.value &&
      !deps.recapOpen.value &&
      !deps.spinning.value &&
      (deps.activeParticipants.value || []).length > 0
    ) {
      e.preventDefault()
      cycleFocusImpl(e.shiftKey ? -1 : 1)
    } else if (e.code === 'Space' && !isEditableTarget(e.target)) {
      e.preventDefault()
      if (!deps.winnerData.value && !deps.recapOpen.value) deps.handleSpin()
    } else if (e.key === 'Escape' && deps.recapOpen.value) {
      e.preventDefault()
      deps.recapOpen.value = false
    } else if (e.key === 'Escape' && deps.winnerData.value) {
      e.preventDefault()
      deps.dismissWinner()
    } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !isEditableTarget(e.target)) {
      e.preventDefault()
      if (e.shiftKey) {
        // redo
      } else if (deps.history?.undo) {
        deps.history.undo()
      }
    }
  }

  // Provide the functions for direct use if needed
  return {
    onGlobalKeydown,
    isEditableTarget,
    cycleFocus: cycleFocusImpl,
  }
}
