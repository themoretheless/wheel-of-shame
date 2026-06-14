import { ref, computed } from 'vue'
import type { Session, Participant, SpinResult } from '../types'
import * as api from '../api/client'
import { useWebSocket } from './useWebSocket'

const session = ref<Session | null>(null)
const participants = ref<Participant[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const lastSpinResult = ref<SpinResult | null>(null)

// Remote spin events (from other clients)
const remoteSpinResult = ref<SpinResult | null>(null)
let suppressWsSpin = false

const ws = useWebSocket()

// --- WebSocket auto-reconnect with exponential backoff ---
//
// On an unexpected close we retry indefinitely: wait (0.5s doubling up to a
// 10s cap, plus jitter), then re-fetch the session over REST so any events
// missed during the outage are recovered, then re-open the WebSocket.
//
// Sessions are in-memory server-side, so after a backend restart the REST
// re-fetch returns 404. In that case we stop retrying, clear the session and
// surface the error state (the create screen with an explanatory message)
// instead of hanging or looping forever.
const RECONNECT_BASE_MS = 500
const RECONNECT_CAP_MS = 10_000
const RECONNECT_JITTER_MS = 250
let reconnectAttempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
// Bumped whenever a new connection is established intentionally (load/create)
// or the session is torn down, invalidating any in-flight reconnect loop.
let reconnectGen = 0

function cancelReconnect() {
  reconnectGen++
  reconnectAttempt = 0
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function scheduleReconnect() {
  if (!session.value || reconnectTimer) return
  const gen = reconnectGen
  const backoff = Math.min(
    RECONNECT_BASE_MS * 2 ** reconnectAttempt,
    RECONNECT_CAP_MS,
  )
  const delay = backoff + Math.random() * RECONNECT_JITTER_MS
  reconnectAttempt++
  console.log(
    `[ws] connection lost, reconnect attempt ${reconnectAttempt} in ${Math.round(delay)}ms`,
  )
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    void attemptReconnect(gen)
  }, delay)
}

async function attemptReconnect(gen: number) {
  if (gen !== reconnectGen || !session.value) return
  const id = session.value.id
  try {
    // Re-fetch state first so events missed during the outage are not lost.
    const data = await api.getSession(id)
    if (gen !== reconnectGen) return
    session.value = data.session
    participants.value = data.participants
    error.value = null
    reconnectAttempt = 0
    console.log('[ws] session state re-synced, reopening websocket')
    ws.connect(id)
  } catch (e: any) {
    if (gen !== reconnectGen) return
    if (e?.status === 404) {
      console.log('[ws] session no longer exists on server, giving up')
      cancelReconnect()
      session.value = null
      participants.value = []
      error.value =
        'Session no longer exists (the server may have restarted). Please create a new session.'
      return
    }
    // Server unreachable or transient error: keep backing off.
    scheduleReconnect()
  }
}

ws.onUnexpectedClose(() => {
  scheduleReconnect()
})

ws.onMessage((event: any) => {
  switch (event.type) {
    case 'participant_added': {
      const exists = participants.value.some((p) => p.id === event.participant.id)
      if (!exists) {
        participants.value.push(event.participant)
      }
      break
    }
    case 'participants_added': {
      for (const p of event.participants) {
        const exists = participants.value.some((ep) => ep.id === p.id)
        if (!exists) {
          participants.value.push(p)
        }
      }
      break
    }
    case 'participant_deleted': {
      participants.value = participants.value.filter(
        (p) => p.id !== event.participant_id,
      )
      break
    }
    case 'spin_result': {
      if (suppressWsSpin) {
        // Own spin — don't update state, animation handles it
        suppressWsSpin = false
        break
      }
      // Surface the result so App.vue can drive the wheel animation to this
      // winner. Don't mark the picked participant removed yet: it must stay in
      // activeParticipants until the spin lands, or the wheel would jump to the
      // post-removal state. App.vue applies the removal on animation complete
      // via applySpinResult().
      remoteSpinResult.value = {
        picked: event.picked,
        remaining: event.remaining,
      }
      break
    }
    case 'session_reset': {
      participants.value = event.participants
      lastSpinResult.value = null
      break
    }
  }
})

export function useSession() {
  const activeParticipants = computed(() =>
    participants.value.filter((p) => !p.removed),
  )

  const removedParticipants = computed(() =>
    participants.value
      .filter((p) => p.removed)
      .sort((a, b) => (a.spin_order ?? 0) - (b.spin_order ?? 0)),
  )

  async function create(title: string) {
    loading.value = true
    error.value = null
    try {
      cancelReconnect()
      session.value = await api.createSession(title)
      participants.value = []
      window.location.hash = `#/${session.value.id}`
      ws.connect(session.value.id)
    } catch (e: any) {
      error.value = e.message
    } finally {
      loading.value = false
    }
  }

  async function load(id: string) {
    loading.value = true
    error.value = null
    try {
      cancelReconnect()
      const data = await api.getSession(id)
      session.value = data.session
      participants.value = data.participants
      ws.connect(id)
    } catch (e: any) {
      error.value = e.message
      session.value = null
    } finally {
      loading.value = false
    }
  }

  async function addName(name: string) {
    if (!session.value) return
    error.value = null
    // Optimistic add (Linear-style): show a pending chip immediately, then
    // reconcile its id once the server confirms. A unique temp id keeps the
    // list/wheel :key stable and lets us find the row again on resolve.
    const tempId = `temp-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const temp: Participant = {
      id: tempId,
      session_id: session.value.id,
      name,
      removed: false,
      pending: true,
    }
    participants.value.push(temp)
    try {
      const p = await api.addParticipant(session.value.id, name)
      const tempIdx = participants.value.findIndex((ep) => ep.id === tempId)
      // The WS broadcast may have already delivered the real participant.
      const exists = participants.value.some((ep) => ep.id === p.id)
      if (tempIdx !== -1) {
        if (exists) {
          // Real one arrived via WS; drop the temp placeholder.
          participants.value.splice(tempIdx, 1)
        } else {
          // Reconcile in place so the row settles without a remount.
          participants.value[tempIdx] = p
        }
      } else if (!exists) {
        participants.value.push(p)
      }
    } catch (e: any) {
      error.value = e.message
      // Flag the temp row so the UI can shake it, then remove it shortly after.
      const tempIdx = participants.value.findIndex((ep) => ep.id === tempId)
      if (tempIdx !== -1) {
        participants.value[tempIdx] = { ...temp, pending: false, error: true }
        setTimeout(() => {
          participants.value = participants.value.filter((ep) => ep.id !== tempId)
        }, 600)
      }
    }
  }

  async function addNames(names: string[]) {
    if (!session.value) return
    error.value = null
    try {
      const newParticipants = await api.addParticipantsBatch(
        session.value.id,
        names,
      )
      for (const p of newParticipants) {
        const exists = participants.value.some((ep) => ep.id === p.id)
        if (!exists) {
          participants.value.push(p)
        }
      }
    } catch (e: any) {
      error.value = e.message
    }
  }

  async function removeName(participantId: string) {
    if (!session.value) return
    error.value = null
    try {
      await api.deleteParticipant(session.value.id, participantId)
      participants.value = participants.value.filter(
        (p) => p.id !== participantId,
      )
    } catch (e: any) {
      error.value = e.message
    }
  }

  async function doSpin(): Promise<SpinResult | null> {
    if (!session.value) return null
    error.value = null
    suppressWsSpin = true
    try {
      const result = await api.spin(session.value.id)
      lastSpinResult.value = result
      return result
    } catch (e: any) {
      error.value = e.message
      return null
    }
  }

  function applySpinResult(result: SpinResult) {
    const idx = participants.value.findIndex((p) => p.id === result.picked.id)
    if (idx !== -1) {
      participants.value[idx] = result.picked
    }
  }

  async function reset() {
    if (!session.value) return
    error.value = null
    try {
      await api.resetSession(session.value.id)
      participants.value.forEach((p) => {
        p.removed = false
        p.removed_at = undefined
        p.spin_order = undefined
      })
      lastSpinResult.value = null
    } catch (e: any) {
      error.value = e.message
    }
  }

  return {
    session,
    participants,
    activeParticipants,
    removedParticipants,
    loading,
    error,
    lastSpinResult,
    remoteSpinResult,
    wsConnected: ws.connected,
    create,
    load,
    addName,
    addNames,
    removeName,
    doSpin,
    applySpinResult,
    reset,
  }
}
