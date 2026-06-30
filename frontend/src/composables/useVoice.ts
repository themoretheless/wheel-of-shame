import { useToasts } from './useToasts'

const { push: pushToast } = useToasts()

export function useVoice(addName: (name: string) => void, handleSpin: () => void) {
  function getSpeechRecognition() {
    const w = window as any
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition
    if (!SR) return null
    const rec: any = new SR()
    // SpeechRecognition.lang takes a single BCP-47 tag; a comma list is invalid
    // and makes browsers silently fall back to the page locale, breaking RU
    // recognition. Pick one (RU, the primary user language).
    rec.lang = 'ru-RU'
    rec.continuous = false
    rec.interimResults = false
    return rec
  }

  function startVoiceAdd() {
    const recognition = getSpeechRecognition()
    if (!recognition) {
      pushToast('Voice not supported', 'info')
      return
    }
    recognition.onresult = (event: any) => {
      const name = event.results[0][0].transcript.trim()
      if (name) addName(name)
    }
    recognition.onerror = () => pushToast('Voice error', 'info')
    recognition.start()
    pushToast('Listening for name...', 'info')
  }

  function voiceSpin() {
    const recognition = getSpeechRecognition()
    if (!recognition) {
      pushToast('Voice not supported', 'info')
      return
    }
    recognition.onresult = (event: any) => {
      const cmd = event.results[0][0].transcript.trim().toLowerCase()
      if (cmd.includes('spin') || cmd.includes('крутить') || cmd.includes('крути')) {
        handleSpin()
      }
    }
    recognition.onerror = () => pushToast('Voice error', 'info')
    recognition.start()
    pushToast('Say "spin" or "крутить"...', 'info')
  }

  return {
    startVoiceAdd,
    voiceSpin,
  }
}
