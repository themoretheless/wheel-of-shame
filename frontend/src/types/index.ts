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
}

export interface SpinResult {
  picked: Participant
  remaining: number
}

export interface SessionData {
  session: Session
  participants: Participant[]
}
