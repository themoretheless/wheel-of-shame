import { ref } from 'vue'
import type { Session, SpinResult } from '../types'
import * as api from '../api/client'
import { useWebSocket } from './useWebSocket'
import { useToasts } from './useToasts'
import { identityColor } from '../utils/identity'
import { useHistory } from './useHistory'
import { useRosterStore } from '../stores/roster'

const { push: pushToast, update: updateToast, dismiss: dismissToast } = useToasts()

const session = ref<Session | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const lastSpinResult = ref<SpinResult | null>(null)

// History is now pure event log (roster is owner)
const history = useHistory('')
function setHistorySession(id: string) {
  // Minimal patch for composable internal (no full refactor); typed access
  ;(history as unknown as { _sessionId?: string })._sessionId = id
}

// --- Pinned recents (frecency-lite) ---
//
// Every session successfully loaded or created is remembered in localStorage as
// {id, title, lastUsed}, deduped by id and capped, so a returning visitor can
// hop back to a recent room without keeping its link around. The list is sorted
// most-recent-first and surfaced through `recentSessions` for the App.vue
// switcher chip. Storage failures (private mode, quota) are swallowed: recents
// are a convenience, never load-bearing.
export interface RecentSession {
  id: string
  title: string
  lastUsed: number
}

const RECENTS_KEY = 'wheel-recent-sessions'
const RECENTS_CAP = 8

const recentSessions = ref<RecentSession[]>(readRecents())

function readRecents(): RecentSession[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter(
        (r): r is RecentSession =>
          r != null &&
          typeof r.id === 'string' &&
          typeof r.title === 'string' &&
          typeof r.lastUsed === 'number',
      )
      .sort((a, b) => b.lastUsed - a.lastUsed)
      .slice(0, RECENTS_CAP)
  } catch {
    return []
  }
}

function rememberSession(s: Session) {
  const next: RecentSession[] = [
    { id: s.id, title: s.title, lastUsed: Date.now() },
    ...recentSessions.value.filter((r) => r.id !== s.id),
  ].slice(0, RECENTS_CAP)
  recentSessions.value = next
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
  } catch {
    // Persisting recents is best-effort; ignore storage failures.
  }
}

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
// Handle to the sticky "reconnecting…" toast, raised on the first drop and
// resolved (or dropped) once the socket comes back or we give up. Null when no
// outage is being surfaced, which also gates the "Reconnected" success toast so
// the very first connect on load never reports a reconnection.
let reconnectToastId: number | null = null

// Raise the sticky reconnect pill on the first drop of an outage; later attempts
// reuse the same toast so a long outage doesn't stack a new pill each backoff.
function showReconnectingToast() {
  if (reconnectToastId !== null) return
  reconnectToastId = pushToast('Connection lost, reconnecting…', 'warn', undefined, true)
}

// Flip the sticky reconnect pill to a timed success toast once the socket is
// back. No-op if no outage was being surfaced (e.g. the initial connect).
function resolveReconnectToast() {
  if (reconnectToastId === null) return
  updateToast(reconnectToastId, { message: 'Reconnected', kind: 'success', sticky: false })
  reconnectToastId = null
}

// Tear the sticky reconnect pill down without a success note, e.g. when the
// session is abandoned or the server is gone for good.
function clearReconnectToast() {
  if (reconnectToastId === null) return
  dismissToast(reconnectToastId)
  reconnectToastId = null
}

function cancelReconnect() {
  reconnectGen++
  reconnectAttempt = 0
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  // An intentional reconnect (load/create/teardown) ends any outage we were
  // surfacing, so retire the sticky pill rather than leaving it stuck.
  clearReconnectToast()
}

function scheduleReconnect() {
  if (!session.value || reconnectTimer) return
  // Surface the outage on the very first scheduled retry; reused for the rest.
  showReconnectingToast()
  const gen = reconnectGen
  const backoff = Math.min(
    RECONNECT_BASE_MS * 2 ** reconnectAttempt,
    RECONNECT_CAP_MS,
  )
  const delay = backoff + Math.random() * RECONNECT_JITTER_MS
  reconnectAttempt++
  if (import.meta.env.DEV) console.log(
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
    const r = useRosterStore()
    r.setSessionId(data.session.id)
    r.setParticipants(data.participants)
    error.value = null
    // Don't reset the backoff here: the REST re-fetch succeeding doesn't mean
    // the WebSocket will. Reset only once the socket actually opens (onOpen
    // below), so a server that serves HTTP but drops the WS handshake still
    // escalates the delay instead of looping at the base interval.
    if (import.meta.env.DEV) console.log('[ws] session state re-synced, reopening websocket')
    ws.connect(id)
  } catch (e: any) {
    if (gen !== reconnectGen) return
    if (e?.status === 404) {
      if (import.meta.env.DEV) console.log('[ws] session no longer exists on server, giving up')
      cancelReconnect()
      session.value = null
      useRosterStore().setParticipants([])
      error.value =
        'Session no longer exists (the server may have restarted). Please create a new session.'
      return
    }
    // Server unreachable or transient error: keep backing off.
    scheduleReconnect()
  }
}

ws.onOpen(() => {
  // A real open is the only success signal that clears the backoff, so the
  // next unexpected drop starts the delay sequence over from the base.
  reconnectAttempt = 0
  // If an outage was being surfaced, flip its sticky pill to a "Reconnected"
  // note; on the initial connect there is no pill, so this is a no-op.
  resolveReconnectToast()
})

ws.onUnexpectedClose(() => {
  scheduleReconnect()
})

ws.onMessage((event: any) => {
  switch (event.type) {
    case 'participant_added': {
      const roster = useRosterStore()
      const current = roster.participants || []
      if (!current.some((p: any) => p.id === event.participant.id)) {
        roster.setParticipants([...current, event.participant])
        pushToast(
          `${event.participant.name} joined`,
          'info',
          identityColor(event.participant.name),
        )
      }
      break
    }
    case 'participants_added': {
      const roster = useRosterStore()
      const current = roster.participants || []
      const toAdd = event.participants.filter((p: any) => !current.some((ep: any) => ep.id === p.id))
      if (toAdd.length > 0) {
        roster.setParticipants([...current, ...toAdd])
        pushToast(`${toAdd.length} name(s) added`, 'info')
      }
      break
    }
    case 'participant_deleted': {
      const roster = useRosterStore()
      const current = (roster.participants || []).filter((p: any) => p.id !== event.participant_id)
      roster.setParticipants(current)
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
      // Note a remote spin's outcome; the local winner reveal modal already
      // covers our own spins (those set suppressWsSpin above).
      pushToast(
        `${event.picked.name} was picked`,
        'spin',
        identityColor(event.picked.name),
      )
      break
    }
    case 'session_reset': {
      useRosterStore().setParticipants(event.participants || [])
      lastSpinResult.value = null
      pushToast('Session reset', 'info')
      break
    }
    case 'segment_updated': {
      const roster = useRosterStore()
      const current = roster.participants || []
      const idx = current.findIndex((p: any) => p.id === event.participant.id)
      if (idx !== -1) {
        current[idx] = { ...current[idx], ...event.participant }
        roster.setParticipants(current)
      }
      break
    }
    case 'action_logged': {
      // optional: could push to a local history if exposed
      break
    }
    case 'snapshot_restored': {
      useRosterStore().setParticipants(event.participants || [])
      lastSpinResult.value = null
      pushToast('State restored from history', 'info')
      break
    }
  }
})

export function useSession() {
  const roster = useRosterStore()

  // useSession no longer owns the roster list (fundamental change point 1).
  // Roster data lives exclusively in rosterStore.

  async function create(title: string) {
    loading.value = true
    error.value = null
    try {
      cancelReconnect()
      session.value = await api.createSession(title)
      roster.setSessionId(session.value.id)
      roster.setParticipants([])
      setHistorySession(session.value.id)
      history.loadActions?.().then(() => {
        if (history.actions?.value?.length) {
          roster.replayEvents(history.actions.value)
        }
      })
      rememberSession(session.value)
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
      roster.setSessionId(data.session.id)
      roster.setParticipants(data.participants)
      setHistorySession(data.session.id)
      history.loadActions?.().then(() => {
        if (history.actions?.value?.length) {
          roster.replayEvents(history.actions.value)
        }
      })
      rememberSession(data.session)
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
    await roster.addName(name).catch((e: any) => { error.value = e.message })
  }

  async function addNames(names: string[]) {
    if (!session.value) return
    error.value = null
    await roster.addNames(names).catch((e: any) => { error.value = e.message })
  }

  async function removeName(participantId: string) {
    if (!session.value) return
    error.value = null
    await roster.removeName(participantId).catch((e: any) => { error.value = e.message })
  }

  async function doSpin(): Promise<SpinResult | null> {
    if (!session.value) return null
    error.value = null
    suppressWsSpin = true

    // Note: rules now primarily handled in rosterStore + engine
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
    roster.applySpinResult(result)
  }

  async function reset() {
    if (!session.value) return
    error.value = null
    await roster.resetRoster().catch((e: any) => { error.value = e.message })
    lastSpinResult.value = null
  }

  return {
    session,
    loading,
    error,
    lastSpinResult,
    remoteSpinResult,
    recentSessions,
    wsConnected: ws.connected,
    history,
    create,
    load,
    addName,
    addNames,
    removeName,
    doSpin,
    applySpinResult,
    reset,
    setHistorySession,
  }
}
