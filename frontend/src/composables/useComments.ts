import { ref, watch, type Ref } from 'vue'

export function useComments(sessionId: string | Ref<string> = 'global') {
  const getKey = () => typeof sessionId === 'string' ? sessionId : sessionId.value
  const STORAGE_KEY_BASE = 'wheel-comments-'
  const comments = ref<Record<string, string[]>>({})

  function loadFor(key: string) {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_BASE + key)
      comments.value = saved ? JSON.parse(saved) : {}
    } catch { comments.value = {} }
  }

  loadFor(getKey())

  // If passed a ref, react to session switch (reloads comments map from ls)
  if (typeof sessionId !== 'string') {
    watch(sessionId, (k) => { loadFor(k || 'global') }, { immediate: false })
  }

  function addComment(id: string, text: string) {
    if (!text.trim()) return
    if (!comments.value[id]) comments.value[id] = []
    comments.value[id].push(text.trim())
  }

  function getComments(id: string): string[] {
    return comments.value[id] || []
  }

  // Persist on change (keyed at write time)
  watch(comments, (val) => {
    try { localStorage.setItem(STORAGE_KEY_BASE + getKey(), JSON.stringify(val)) } catch {}
  }, { deep: true })

  return {
    comments,
    addComment,
    getComments
  }
}