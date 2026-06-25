import { ref, computed } from 'vue'
import type { Session } from '../types'

export interface RecentSession {
  id: string
  title: string
  lastUsed: number
}

const RECENTS_KEY = 'wheel-recent-sessions'
const RECENTS_CAP = 8

export function useRecents() {
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
      // ignore
    }
  }

  const otherRecents = computed(() =>
    recentSessions.value.filter((r) => r.id !== /* current id would be passed */ ''), // placeholder, better to filter outside
  )

  return {
    recentSessions,
    rememberSession,
    otherRecents,
    readRecents,
  }
}
