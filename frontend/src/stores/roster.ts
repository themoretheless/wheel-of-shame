import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import type { Participant, ParticipantDraft, SpinResult } from '../types'
import type { PreparedSegment } from '../types/wheel'
import { usePreventRepeat } from '../composables/usePreventRepeat'
import { usePreview } from '../composables/usePreview' // temporary bridge - will remove
import { WheelEngine, type WheelSegment } from '../engine/wheelEngine'
import { useWheelWorker } from '../composables/useWheelWorker'
import { identityColor } from '../utils/identity'
import * as api from '../api/client'

// This store owns the "live roster" + preview + rules.
// Fundamental change: central place instead of scattered refs + mutations in App.

export const useRosterStore = defineStore('roster', () => {
  const currentSessionId = ref<string | null>(null)
  const participants = ref<Participant[]>([])

  // Temporary bridges (will be removed in full event sourcing)
  const prevent = usePreventRepeat()
  const preview = usePreview({ value: null } as any, { value: null } as any)

  const engine = ref<WheelEngine>(new WheelEngine([]))
  const workerApi = useWheelWorker()

  // Event source: every change records Action (for replay in history)
  const eventLog = ref<any[]>([])

  function recordEvent(kind: any, payload: any = {}) {
    if (!currentSessionId.value) return
    const action = {
      id: 'evt-' + Date.now() + Math.random().toString(36).slice(2),
      session_id: currentSessionId.value,
      kind: { type: kind, payload },
      timestamp: new Date().toISOString(),
    }
    eventLog.value.push(action)
    // In full, this would go to useHistory.recordAction
  }

  // Replay for event sourcing: roster state = fold over history events
  function replayEvents(actions: any[]) {
    // full event sourcing: roster state = pure fold over history events
    participants.value = []
    for (const a of actions) {
      const kind = a.kind || a
      if (kind.type === 'Add' && kind.payload?.name) {
        participants.value.push({ id: 'replay-' + (a.id || Date.now()), session_id: currentSessionId.value || '', name: kind.payload.name, removed: false } as any)
      } else if (kind.type === 'Remove' && kind.payload?.id) {
        const idx = participants.value.findIndex((p: any) => p.id === kind.payload.id)
        if (idx !== -1) participants.value[idx].removed = true
      } else if (kind.type === 'UpdateWeight' && kind.payload) {
        const p = participants.value.find((pp: any) => pp.id === kind.payload.id)
        if (p) p.weight = kind.payload.weight
      } else if (kind.type === 'Spin' && kind.payload?.picked_id) {
        const p = participants.value.find((pp: any) => pp.id === kind.payload.picked_id)
        if (p) p.removed = true
      }
      // add more kinds as needed
    }
    syncEngine()
  }

  // Sync engine whenever participants change
  function syncEngine() {
    const segs: WheelSegment[] = participants.value
      .filter(p => !p.removed)
      .map(p => ({
        id: p.id,
        name: p.name,
        weight: p.weight ?? 1,
        visual: p.visual
      }))
    engine.value.setSegments(segs)
    engine.value.setPreventRepeat(prevent.preventRepeat.value)
    engine.value.setLastPicked(prevent.lastPickedId.value)
  }

  const activeParticipants = computed(() =>
    participants.value.filter((p) => !p.removed)
  )

  const removedParticipants = computed(() =>
    participants.value
      .filter((p) => p.removed)
      .sort((a, b) => (a.spin_order ?? 0) - (b.spin_order ?? 0))
  )

  function setSessionId(id: string | null) {
    currentSessionId.value = id
  }

  function setParticipants(newParts: Participant[]) {
    participants.value = newParts.map(p => ({ ...p }))
    syncEngine()
  }

  function add(participant: Participant) {
    participants.value.push({ ...participant })
    syncEngine()
  }

  function addMany(parts: Participant[]) {
    participants.value.push(...parts.map(p => ({ ...p })))
    syncEngine()
  }

  function remove(id: string) {
    const idx = participants.value.findIndex(p => p.id === id)
    if (idx !== -1) {
      participants.value[idx] = { ...participants.value[idx], removed: true, removed_at: new Date().toISOString() }
      syncEngine()
    }
  }

  // The key mutation that was in App.vue - now goes through store
  async function reorder(from: number, to: number) {
    const active = activeParticipants.value
    if (from < 0 || to < 0 || from >= active.length || to >= active.length) return

    const list = [...active]
    const [moved] = list.splice(from, 1)
    list.splice(to, 0, moved)

    // Simple approach: rebuild active in new order + append removed
    const removed = participants.value.filter(p => p.removed)
    const newParticipants: Participant[] = [...list, ...removed]

    participants.value = newParticipants.map(p => ({ ...p }))
    syncEngine()
  }

  async function updateWeight(id: string, weight: number) {
    preview.clearPreviewOverrides()
    const p = participants.value.find(pp => pp.id === id)
    if (p) p.weight = weight
    syncEngine()

    // Record side effect is still done in caller for now (history)
    try {
      // In future the store would know the session id
    } catch (e) {
      console.warn('update weight api failed', e)
    }
  }

  function previewWeight(id: string, weight: number) {
    preview.setPreviewOverride(id, { weight })
    syncEngine()
  }

  function clearPreviews() {
    preview.clearPreviewOverrides()
    syncEngine()
  }

  const previewOverrides = computed(() => preview.previewOverrides.value)

  function setLastPicked(id: string) {
    prevent.setLastPicked(id)
    syncEngine()
  }

  // === Roster operations - rosterStore is now the owner (point 1+2 of redesign) ===

  async function addName(name: string) {
    const sid = currentSessionId.value
    if (!sid) return
    // Optimistic
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const temp: Participant = {
      id: tempId,
      session_id: sid,
      name,
      removed: false,
      pinned: false,
      weight: 1,
      pending: true,
    }
    participants.value.push(temp)
    syncEngine()

    try {
      const p = await api.addParticipant(sid, name)
      const tempIdx = participants.value.findIndex((ep) => ep.id === tempId)
      const exists = participants.value.some((ep) => ep.id === p.id)
      if (tempIdx !== -1) {
        if (exists) {
          participants.value.splice(tempIdx, 1)
        } else {
          participants.value[tempIdx] = p
        }
      } else if (!exists) {
        participants.value.push(p)
      }
      syncEngine()
      recordEvent('Add', { name })
    } catch (e: any) {
      const tempIdx = participants.value.findIndex((ep) => ep.id === tempId)
      if (tempIdx !== -1) {
        participants.value[tempIdx] = { ...temp, pending: false, error: true }
        setTimeout(() => {
          participants.value = participants.value.filter((ep) => ep.id !== tempId)
          syncEngine()
        }, 600)
      }
    }
  }

  async function addNames(names: string[]) {
    const sid = currentSessionId.value
    if (!sid) return
    try {
      const newParticipants = await api.addParticipantsBatch(sid, names)
      for (const p of newParticipants) {
        const exists = participants.value.some((ep) => ep.id === p.id)
        if (!exists) participants.value.push(p)
      }
      syncEngine()
    } catch (e: any) {
      console.error('addNames failed', e)
    }
  }

  async function addDrafts(drafts: ParticipantDraft[]) {
    const sid = currentSessionId.value
    if (!sid || drafts.length === 0) return
    try {
      const newParticipants = await api.addParticipantsBatch(sid, drafts.map((draft) => draft.name))
      for (const p of newParticipants) {
        const exists = participants.value.some((ep) => ep.id === p.id)
        if (!exists) participants.value.push(p)
      }
      syncEngine()

      for (let index = 0; index < newParticipants.length; index++) {
        const draft = drafts[index]
        if (!draft) continue
        const patch: { pinned?: boolean; weight?: number } = {}
        if (draft.pinned) patch.pinned = true
        if (draft.weight && draft.weight !== 1) patch.weight = draft.weight
        if (Object.keys(patch).length > 0) {
          await updateParticipant(newParticipants[index].id, patch)
        }
      }
    } catch (e: any) {
      console.error('addDrafts failed', e)
      throw e
    }
  }

  async function updateParticipant(
    participantId: string,
    patch: { name?: string; pinned?: boolean; weight?: number },
  ) {
    const sid = currentSessionId.value
    if (!sid) return
    const idx = participants.value.findIndex((p) => p.id === participantId)
    const previous = idx === -1 ? null : { ...participants.value[idx] }
    if (idx !== -1) {
      participants.value[idx] = { ...participants.value[idx], ...patch }
      syncEngine()
    }

    try {
      const participant = await api.updateParticipant(sid, participantId, patch)
      const nextIdx = participants.value.findIndex((p) => p.id === participant.id)
      if (nextIdx !== -1) {
        participants.value[nextIdx] = participant
      } else {
        participants.value.push(participant)
      }
      syncEngine()
      if (patch.name) recordEvent('Rename', { id: participantId, name: patch.name })
      if (patch.pinned !== undefined) recordEvent('Pin', { id: participantId, pinned: patch.pinned })
      if (patch.weight !== undefined) recordEvent('UpdateWeight', { id: participantId, weight: patch.weight })
    } catch (e: any) {
      if (idx !== -1 && previous) {
        participants.value[idx] = previous
        syncEngine()
      }
      console.error('update participant failed', e)
      throw e
    }
  }

  async function removeName(participantId: string) {
    const sid = currentSessionId.value
    if (!sid) return
    try {
      await api.deleteParticipant(sid, participantId)
      participants.value = participants.value.filter((p) => p.id !== participantId)
      syncEngine()
    } catch (e: any) {
      console.error('remove failed', e)
    }
  }

  async function applySpinResult(result: SpinResult) {
    const idx = participants.value.findIndex((p) => p.id === result.picked.id)
    if (idx !== -1) {
      participants.value[idx] = result.picked
      setLastPicked(result.picked.id)
      syncEngine()
    }
  }

  async function resetRoster() {
    const sid = currentSessionId.value
    if (!sid) return
    try {
      await api.resetSession(sid)
      participants.value.forEach((p) => {
        p.removed = false
        p.removed_at = undefined
        p.spin_order = undefined
      })
      syncEngine()
    } catch (e: any) {
      console.error('reset failed', e)
    }
  }

  // Prepared segments - now default via worker for heavy computeAngles (point from redesign)
  const preparedSegments = ref<PreparedSegment[]>([])

  async function refreshPreparedSegments() {
    syncEngine()
    const active = activeParticipants.value
    if (!active.length) {
      preparedSegments.value = []
      return
    }
    try {
      const angles = await workerApi.computeAnglesAsync(active.map(p => ({ id: p.id, weight: p.weight })))
      preparedSegments.value = active.map((p, i) => ({
        id: p.id,
        name: p.name,
        weight: p.weight ?? 1,
        angle: angles[i] || (Math.PI * 2 / active.length),
        color: identityColor(p.name),
        isLast: preventRepeat.value && lastPickedId.value === p.id,  // note: lastPicked from prevent
        isPrevented: preventRepeat.value && lastPickedId.value === p.id,
      }))
    } catch {
      // fallback sync
      const base = engine.value.getPreparedSegments()
      preparedSegments.value = base.map(seg => ({
        ...seg,
        color: identityColor(active.find((p: any) => p.id === seg.id)?.name || seg.name || '')
      }))
    }
  }

  // trigger refresh when relevant
  watch([() => activeParticipants.value.length, () => JSON.stringify(activeParticipants.value.map(p => p.weight || 1)) ], () => {
    refreshPreparedSegments()
  }, { immediate: true })

  // Async heavy ops via worker (from-scratch perf requirement)
  async function simulateHeavy(count: number) {
    const segs = activeParticipants.value.map(p => ({ id: p.id, weight: p.weight }))
    return workerApi.simulateAsync(segs, count)
  }

  async function computeAnglesHeavy(segments: Array<{ id: string; weight?: number }>) {
    return workerApi.computeAnglesAsync(segments)
  }

  const preventRepeat = computed(() => prevent.preventRepeat.value)
  const lastPickedId = computed(() => prevent.lastPickedId.value)

  function togglePreventRepeat() {
    prevent.preventRepeat.value = !prevent.preventRepeat.value
    syncEngine()
  }

  function applyPreventFilter(candidates: Participant[]) {
    return prevent.applyPreventFilter(candidates)
  }

  return {
    participants,
    activeParticipants,
    removedParticipants,
    previewOverrides,

    setParticipants,
    add,
    addMany,
    remove,
    reorder,
    updateWeight,
    previewWeight,
    clearPreviews,

    setLastPicked,
    preventRepeat,
    lastPickedId,
    togglePreventRepeat,
    applyPreventFilter,

    engine,
    preparedSegments,
    simulateHeavy,

    // New ownership API
    setSessionId,
    addName,
    addNames,
    addDrafts,
    updateParticipant,
    removeName,
    applySpinResult,
    resetRoster,
    computeAnglesHeavy,
    eventLog,
    recordEvent,
    replayEvents,
  }
})
