// Command-palette contract. Lives in types/ rather than in CommandPalette.vue so
// useCommandPalette (a composable) doesn't import upward from a component SFC.

// An inline value-entry mode: when present, activating the command swaps the
// command list for a single text field (Raycast-style) instead of running
// immediately. submit() receives the typed value; returning false keeps the
// field open for another entry, anything else closes the palette.
export interface CommandInline {
  placeholder: string
  submit: (value: string) => void | boolean
}

export interface Command {
  id: string
  label: string
  hint?: string
  // A secondary line under the label (e.g. a participant's win odds).
  subtitle?: string
  // A section label (e.g. 'Actions' / 'Eliminate'); commands sharing one get a
  // sticky group header above the first row of that group.
  group?: string
  // Returning false keeps the palette open (e.g. an inline name entry that
  // wants another value); anything else closes it.
  run: () => void | boolean
  // When set, the command opens an inline input instead of running on Enter.
  inline?: CommandInline
  disabled?: boolean
}
