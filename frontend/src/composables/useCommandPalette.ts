import { computed, ref } from 'vue'
import type { Command } from '../types/commands'
import type { Participant } from '../types'

// Extracted from App.vue god component. Palette logic now here.
export function useCommandPalette(deps: {
  activeParticipants: any
  spinning: any
  removedParticipants: any
  session: any
  soundMuted: any
  toggleSound: () => void
  handleSpin: () => void
  reset: () => void
  copyLink: () => void
  handleRemove: (id: string) => void
  addName: (name: string) => void
  createSession?: () => void // optional for templates
}) {
  const paletteOpen = ref(false)
  const shortcutsOpen = ref(false) // related but kept separate for now

  const paletteCommands = computed<Command[]>(() => [
    {
      id: 'spin',
      label: 'Spin the wheel',
      hint: 'Spin',
      group: 'Actions',
      disabled: deps.spinning.value || (deps.activeParticipants.value?.length || 0) === 0,
      run: () => {
        deps.handleSpin()
      },
    },
    {
      id: 'add',
      label: 'Add a name',
      hint: 'New participant',
      group: 'Actions',
      disabled: !deps.session.value,
      run: () => {},
      inline: {
        placeholder: 'Name to add...',
        submit: (name) => {
          deps.addName(name)
          return false
        },
      },
    },
    {
      id: 'reset',
      label: 'Reset the wheel',
      hint: 'Restore everyone',
      group: 'Actions',
      disabled: !deps.session.value || (deps.removedParticipants.value?.length || 0) === 0,
      run: () => {
        deps.reset()
      },
    },
    {
      id: 'copy-link',
      label: 'Copy share link',
      hint: 'Share',
      group: 'Actions',
      disabled: !deps.session.value,
      run: () => {
        deps.copyLink()
      },
    },
    {
      id: 'toggle-sound',
      label: deps.soundMuted.value ? 'Unmute spin sound' : 'Mute spin sound',
      hint: deps.soundMuted.value ? 'Unmute' : 'Mute',
      group: 'Actions',
      run: () => {
        deps.toggleSound()
      },
    },
    // templates etc can be added here
  ])

  // Spotlight commands for participants
  const participantCommands = computed(() => {
    const list = deps.activeParticipants.value || []
    return list.map((p: Participant): Command => {
      const odds = Math.round(100 / list.length)
      return {
        id: `remove-${p.id}`,
        label: `Eliminate ${p.name}`,
        subtitle: `${odds}% to be picked next`,
        hint: 'Remove',
        group: 'Eliminate',
        run: () => {
          deps.handleRemove(p.id)
        },
      }
    })
  })

  return {
    paletteOpen,
    shortcutsOpen,
    paletteCommands: computed(() => [
      ...paletteCommands.value,
      ...participantCommands.value,
    ]),
  }
}
