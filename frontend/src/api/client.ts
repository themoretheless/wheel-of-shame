import type { Session, SessionData, SpinResult, Participant } from '../types'

const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:8080'

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {}
  if (options?.body) {
    headers['Content-Type'] = 'application/json'
  }
  const res = await fetch(`${BASE_URL}${path}`, {
    headers,
    ...options,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || `HTTP ${res.status}`)
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T
  const text = await res.text()
  if (!text) return undefined as T
  return JSON.parse(text)
}

export function createSession(title: string): Promise<Session> {
  return request('/api/v1/sessions', {
    method: 'POST',
    body: JSON.stringify({ title }),
  })
}

export function getSession(id: string): Promise<SessionData> {
  return request(`/api/v1/sessions/${id}`)
}

export function addParticipant(sessionId: string, name: string): Promise<Participant> {
  return request(`/api/v1/sessions/${sessionId}/participants`, {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

export function addParticipantsBatch(sessionId: string, names: string[]): Promise<Participant[]> {
  return request(`/api/v1/sessions/${sessionId}/participants/batch`, {
    method: 'POST',
    body: JSON.stringify({ names }),
  })
}

export function deleteParticipant(sessionId: string, participantId: string): Promise<void> {
  return request(`/api/v1/sessions/${sessionId}/participants/${participantId}`, {
    method: 'DELETE',
  })
}

export function spin(sessionId: string): Promise<SpinResult> {
  return request(`/api/v1/sessions/${sessionId}/spin`, {
    method: 'POST',
  })
}

export function resetSession(sessionId: string): Promise<void> {
  return request(`/api/v1/sessions/${sessionId}/reset`, {
    method: 'POST',
  })
}
