import { defineStore } from 'pinia'
import { ref, watch } from 'vue'

export const useUiStore = defineStore('ui', () => {
  // Editor mode (advanced weights/history)
  const editorEnabled = ref(false)
  const EDITOR_KEY = 'wheel-editor'

  function readEditorFlag(): boolean {
    try { return localStorage.getItem(EDITOR_KEY) === '1' } catch { return false }
  }
  editorEnabled.value = readEditorFlag()

  function toggleEditor() {
    editorEnabled.value = !editorEnabled.value
    try { localStorage.setItem(EDITOR_KEY, editorEnabled.value ? '1' : '0') } catch {}
  }

  function enableEditor() {
    if (!editorEnabled.value) {
      editorEnabled.value = true
      try { localStorage.setItem(EDITOR_KEY, '1') } catch {}
    }
  }

  // Collapsible right panels
  const PANEL_KEY = 'wheel-panel-collapsed'
  function readPanelCollapsed() {
    try {
      const raw = localStorage.getItem(PANEL_KEY)
      if (raw) {
        const parsed = JSON.parse(raw)
        return {
          inspector: !!parsed.inspector,
          history: !!parsed.history,
          analytics: !!parsed.analytics
        }
      }
    } catch {}
    return { inspector: false, history: false, analytics: false }
  }
  const panelCollapsed = ref(readPanelCollapsed())

  watch(panelCollapsed, (val) => {
    try { localStorage.setItem(PANEL_KEY, JSON.stringify(val)) } catch {}
  }, { deep: true })

  function togglePanel(name: 'inspector' | 'history' | 'analytics') {
    panelCollapsed.value[name] = !panelCollapsed.value[name]
  }

  // Theming
  const currentTheme = ref('default')
  const themeColor = ref('#4ECDC4')

  function toggleTheme() {
    currentTheme.value = currentTheme.value === 'default' ? 'high-contrast' : 'default'
    if (typeof document !== 'undefined') {
      // Set a data attribute rather than overwriting className, which would wipe
      // any other classes on <html> (reduced-motion helpers, future skins).
      document.documentElement.dataset.theme = currentTheme.value
    }
  }
  function updateThemeColor(color: string) {
    themeColor.value = color
    if (typeof document !== 'undefined') {
      document.documentElement.style.setProperty('--theme-accent', color)
    }
  }

  // Local UI state that used to live in App.vue. (paletteOpen / shortcutsOpen /
  // showTemplateGallery were declared here but the app binds the cmdPalette and
  // createSession owners instead, so they were dead; removed.)
  const recentsOpen = ref(false)

  const cameraDrifted = ref(false)

  // Spin and recap state live in useSpin (the spin flow's single source of
  // truth). The ui store used to declare spinning/winnerId/recapOpen/recapQueued
  // too, but nothing ever wrote them, so binding the wheel to the ui-store refs
  // silently broke local-spin animation; removed to kill the dead-state landmine.

  // Live spin/hover state
  const tickingId = ref<string | null>(null)
  const hoverPeekId = ref<string | null>(null)
  const focusedId = ref<string | null>(null)

  // Simple presence mock (can be replaced by WS later)
  const presence = ref<Record<string, string>>({})

  // SEED templates extracted from App god
  const SEED_TEMPLATES = [
    { id: 'retro', title: 'Sprint Retro', names: ['Alice', 'Bob', 'Carol', 'Dave'], weights: [1,1,1,1] },
    { id: 'critique', title: 'Design Critique', names: ['Lead', 'Dev1', 'Dev2'], weights: [2,1,1] }
  ]

  function setCameraDrifted(drifted: boolean) {
    cameraDrifted.value = drifted
  }
  function setTickingId(id: string | null) {
    tickingId.value = id
  }
  function setHoverPeekId(id: string | null) {
    hoverPeekId.value = id
    if (id) focusedId.value = null
  }
  function setFocusedId(id: string | null) {
    focusedId.value = id
  }

  function toggleRecents() {
    recentsOpen.value = !recentsOpen.value
  }
  function closeRecents() {
    recentsOpen.value = false
  }

  return {
    // Editor
    editorEnabled,
    toggleEditor,
    enableEditor,

    // Panels
    panelCollapsed,
    togglePanel,

    // Theme
    currentTheme,
    themeColor,
    toggleTheme,
    updateThemeColor,

    // Modals / overlays
    recentsOpen,
    cameraDrifted,
    setCameraDrifted,

    // Live interaction
    tickingId,
    hoverPeekId,
    focusedId,
    presence,
    setTickingId,
    setHoverPeekId,
    setFocusedId,

    // Actions
    toggleRecents,
    closeRecents,

    SEED_TEMPLATES,
  }
})
