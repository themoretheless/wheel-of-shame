import { ref, computed, type ComputedRef } from 'vue'
import type { Action } from '../types'
import * as api from '../api/client'
import { useRosterStore } from '../stores/roster'
import { useToasts } from './useToasts'

const { push: pushToast } = useToasts()

export interface UseHistory {
  actions: ReturnType<typeof ref<Action[]>>
  canUndo: ComputedRef<boolean>
  loadActions: () => Promise<void>
  undo: () => Promise<void>
  restoreTo: (actionId: string) => Promise<void>
  preview: (actionId: string | null) => Promise<void>
  recordAction: (action: Action) => void
}

// Pure event sourcing foundation (point 3 of redesign).
// History is now primarily an event log. State derivation (roster) happens
// by applying events in rosterStore / engine. The old participantsRef mutation
// is removed.
export function useHistory(sessionId: string): UseHistory {
  const actions = ref<Action[]>([])
  const canUndo = computed(() => actions.value.length > 0)

  async function loadActions() {
    if (!sessionId) return
    try {
      actions.value = await api.listActions(sessionId)
    } catch {
      actions.value = []
    }
  }

  function recordAction(action: Action) {
    actions.value.push(action)
    if (actions.value.length > 50) actions.value.shift()
  }

  async function undo() {
    if (!canUndo.value || !sessionId) return
    // In full event sourcing, we would replay all previous events.
    // For now, we still use snapshot for practicality.
    const last = actions.value[actions.value.length - 1]
    try {
      const snap = await api.getSnapshot(sessionId, last.id)
      if (snap && snap.participants) {
        // Delegate restore to rosterStore (single owner)
        // In a full implementation roster would apply a "Restore" event.
        const roster = useRosterStore()
        roster.setParticipants(snap.participants.map((p) => ({ ...p })))
        recordAction({
          id: 'local-undo-' + Date.now(),
          session_id: sessionId,
          kind: { type: 'SnapshotRestored', payload: { snapshot_id: snap.id } },
          timestamp: new Date().toISOString(),
        } as Action)
        pushToast('Undo: prior state restored', 'info')
      } else {
        actions.value.pop()
        pushToast('Undid last action', 'info')
      }
    } catch (e) {
      console.warn('undo failed', e)
    }
  }

  async function restoreTo(actionId: string) {
    if (!sessionId) return
    try {
      const snap = await api.getSnapshot(sessionId, actionId)
      if (snap && snap.participants) {
        const roster = useRosterStore()
        roster.setParticipants(snap.participants.map((p) => ({ ...p })))
        await api.restoreFromSnapshot(sessionId, snap.participants).catch(() => {})
        pushToast('Restored to point in history', 'info')
      }
    } catch (e) {
      console.warn('restoreTo failed', e)
    }
  }

  async function preview(actionId: string | null) {
    if (!sessionId) return
    if (!actionId) return
    try {
      const snap = await api.getSnapshot(sessionId, actionId)
      if (snap && snap.participants) {
        const roster = useRosterStore()
        roster.setParticipants(snap.participants.map((p: any) => ({ ...p, _preview: true })))
      }
    } catch (e) {
      console.warn('preview failed', e)
    }
  }

  return {
    actions,
    canUndo,
    loadActions,
    undo,
    restoreTo,
    preview,
    recordAction,
  }
}
