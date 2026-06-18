import { ref, computed, type ComputedRef } from 'vue'
import type { Action } from '../types'
import * as api from '../api/client'
import { useToasts } from './useToasts'
import { identityColor } from '../utils/identity'

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

export function useHistory(sessionId: string, participantsRef: any): UseHistory {
  const actions = ref<Action[]>([])
  const canUndo = computed(() => actions.value.length > 0)

  async function loadActions() {
    if (!sessionId) return
    try {
      const list = await api.listActions(sessionId)
      actions.value = list as Action[]
    } catch {
      actions.value = []
    }
  }

  function recordAction(action: Action) {
    actions.value.push(action)
    // keep bounded
    if (actions.value.length > 50) actions.value.shift()
  }

  async function undo() {
    if (!canUndo.value || !sessionId) return
    const last = actions.value[actions.value.length - 1]
    const prevParticipants = participantsRef.value ? [...participantsRef.value] : []

    try {
      const snap = await api.getSnapshot(sessionId, last.id)
      if (snap && snap.participants) {
        participantsRef.value = snap.participants.map((p: any) => ({ ...p }))
        // Server will have logged SnapshotRestored via /restore or we can call it
        await api.restoreFromSnapshot(sessionId, snap.participants).catch(() => {})
        recordAction({
          id: 'local-undo-' + Date.now(),
          session_id: sessionId,
          kind: { type: 'SnapshotRestored', payload: { snapshot_id: snap.id } } as any,
          timestamp: new Date().toISOString(),
          actor: undefined,
        } as Action)

        const lastKind = last.kind as any
        pushToast('Undo: prior state restored', 'info', identityColor(lastKind?.payload?.picked_id || lastKind?.picked_id || ''))
      } else {
        actions.value.pop()
        pushToast('Undid last action', 'info')
      }
    } catch (e) {
      if (prevParticipants.length) participantsRef.value = prevParticipants
      console.warn('undo failed', e)
    }
  }

  async function restoreTo(actionId: string) {
    if (!sessionId) return
    try {
      const snap = await api.getSnapshot(sessionId, actionId)
      if (snap && snap.participants) {
        participantsRef.value = snap.participants.map((p: any) => ({ ...p }))
        await api.restoreFromSnapshot(sessionId, snap.participants).catch(() => {})
        pushToast('Restored to point in history', 'info')
      }
    } catch (e) {
      console.warn('restoreTo failed', e)
    }
  }

  async function preview(actionId: string | null) {
    if (!sessionId) return
    if (!actionId) {
      // clear preview? but for now, no op, parent handles
      return
    }
    try {
      const snap = await api.getSnapshot(sessionId, actionId)
      if (snap && snap.participants) {
        // For preview, set temporary, but since no temp state, for demo use same
        // In full, would use preview mode
        participantsRef.value = snap.participants.map((p: any) => ({ ...p, _preview: true }))
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
