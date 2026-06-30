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
  pinned?: boolean
  weight?: number
  visual?: SegmentVisual
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

export interface SegmentVisual {
  color_override?: string
  icon?: string
}

export interface Action {
  id: string
  session_id: string
  kind: ActionKind
  timestamp: string
  actor?: string
}

export type ActionKind =
  | { type: 'Add'; payload: { name: string } }
  | { type: 'Remove'; payload: { id: string } }
  | { type: 'Spin'; payload: { picked_id: string } }
  | { type: 'Reset' }
  | { type: 'UpdateWeight'; payload: { id: string; weight: number } }
  | { type: 'UpdateVisual'; payload: { id: string; visual: SegmentVisual } }
  | { type: 'Reorder'; payload: { from: number; to: number } }
  | { type: 'SnapshotRestored'; payload: { snapshot_id: string } }
  | { type: 'Comment'; payload: { participant_id: string; text: string } }

export interface Snapshot {
  id: string
  session_id: string
  action_id: string
  participants: Participant[]
}

export interface SpinResult {
  picked: Participant
  remaining: number
}

export interface SessionData {
  session: Session
  participants: Participant[]
}
