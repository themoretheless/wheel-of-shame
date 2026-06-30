import { ref } from 'vue'
import { filterPreventRepeat } from '../utils/wheel'

export function usePreventRepeat() {
  const preventRepeat = ref(true)
  const lastPickedId = ref<string | null>(null)

  function applyPreventFilter(candidates: any[]) {
    if (preventRepeat.value && lastPickedId.value) {
      return filterPreventRepeat(candidates, lastPickedId.value)
    }
    return candidates
  }

  function setLastPicked(id: string) {
    lastPickedId.value = id
  }

  return {
    preventRepeat,
    lastPickedId,
    applyPreventFilter,
    setLastPicked,
  }
}
