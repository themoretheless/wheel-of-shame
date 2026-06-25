import { ref } from 'vue'
import type { SpinResult } from '../types'

// Extracted spin coordination from App.vue god component.
// Handles local/remote spin pending, winner reveal, recap queuing.
export function useSpin(deps: {
  activeParticipants: any
  removedParticipants: any
  applySpinResult: (result: SpinResult) => void
  roster: any // for prevent etc if needed
}) {
  const spinning = ref(false)
  const winnerId = ref<string | null>(null)
  const pendingSpinResult = ref<SpinResult | null>(null)
  let isLocalSpin = false
  const recapQueued = ref(false)
  const recapOpen = ref(false)
  const winnerData = ref<{ id: string; name: string; remaining: number } | null>(null)

  function handleSpinStart() {
    if (spinning.value || (deps.activeParticipants.value?.length || 0) === 0) return
    isLocalSpin = true
    // prevent filter advisory
    return true // indicate can proceed
  }

  function onSpinComplete(_participantId: string) {
    if (pendingSpinResult.value) {
      deps.applySpinResult(pendingSpinResult.value)
      pendingSpinResult.value = null
    }
    spinning.value = false
    winnerId.value = null
    isLocalSpin = false
    // remoteSpinResult cleared outside
    if ((deps.activeParticipants.value?.length || 0) <= 1 && (deps.removedParticipants.value?.length || 0) > 0) {
      recapQueued.value = true
    }
  }

  function onWinnerReveal(data: { id: string; name: string; remaining: number }) {
    winnerData.value = data
  }

  function dismissWinner() {
    winnerData.value = null
    if (recapQueued.value) {
      recapQueued.value = false
      recapOpen.value = true
    }
  }

  function setPendingSpin(result: SpinResult) {
    pendingSpinResult.value = result
    winnerId.value = result.picked.id
    spinning.value = true
  }

  function setRemoteSpin(result: SpinResult) {
    if (isLocalSpin) {
      // ignore own
      return
    }
    if (spinning.value) {
      deps.applySpinResult(result)
      return
    }
    pendingSpinResult.value = result
    winnerId.value = result.picked.id
    spinning.value = true
  }

  return {
    spinning,
    winnerId,
    pendingSpinResult,
    recapQueued,
    recapOpen,
    winnerData,
    isLocalSpin: () => isLocalSpin,
    handleSpinStart,
    onSpinComplete,
    onWinnerReveal,
    dismissWinner,
    setPendingSpin,
    setRemoteSpin,
    setIsLocalSpin: (v: boolean) => { isLocalSpin = v },
  }
}
