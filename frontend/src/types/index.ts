export interface Session {
  id: string
  title: string
  created_at: string
}

export interface Participant {
  id: string
  session_id: string
  name: string
  removed: boolean
  removed_at?: string
  spin_order?: number
  pinned: boolean
  weight: number
  // Client-only transient flags for optimistic add (Linear-style). `pending`
  // marks a temp row awaiting server confirmation; `error` marks one whose
  // POST failed and is about to be removed. Never sent by or to the server.
  pending?: boolean
  error?: boolean
}

export interface ParticipantDraft {
  name: string
  pinned?: boolean
  weight?: number
}

export interface SpinResult {
  picked: Participant
  remaining: number
}

export interface SessionData {
  session: Session
  participants: Participant[]
}
