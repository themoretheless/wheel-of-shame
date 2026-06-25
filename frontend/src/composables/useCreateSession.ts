import { ref } from 'vue'

// Extracted create session logic from App god component.
export function useCreateSession(deps: {
  create: (title: string) => Promise<void>
  addName: (name: string) => Promise<void>
  startVoiceAdd: () => void
  ui: any
}) {
  const titleInput = ref('')
  const templateSelect = ref('')
  const showTemplateGallery = ref(false)

  const SEED_TEMPLATES = [
    { id: 'retro', title: 'Sprint Retro', names: ['Alice', 'Bob', 'Carol', 'Dave'], weights: [1,1,1,1] },
    { id: 'critique', title: 'Design Critique', names: ['Lead', 'Dev1', 'Dev2'], weights: [2,1,1] }
  ]

  async function createSession() {
    const title = titleInput.value.trim()
    if (!title) return
    const tmpl = SEED_TEMPLATES.find(t => t.id === templateSelect.value)
    await deps.create(tmpl ? tmpl.title : title)
    if (tmpl) {
      for (const name of tmpl.names) {
        await deps.addName(name)
      }
    }
    titleInput.value = ''
    templateSelect.value = ''
  }

  function applyTemplate(t: any) {
    templateSelect.value = t.id
    createSession()
    deps.ui.showTemplateGallery = false
  }

  return {
    titleInput,
    templateSelect,
    showTemplateGallery,
    SEED_TEMPLATES,
    createSession,
    applyTemplate,
    startVoiceAdd: deps.startVoiceAdd,
  }
}
