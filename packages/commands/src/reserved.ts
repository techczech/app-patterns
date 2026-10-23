import type { Chord } from "./chords.ts";

/** Chords every app in the estate keeps for the same job (the shared keymap). Chord to what it does. */
export const RESERVED_ESTATE: Readonly<Record<Chord, string>> = {
  "⌘⇧P": "Command palette",
  "⌘⇧K": "Jump to",
  "⌘K": "Actions on the selection",
  "⌘P": "Show or hide the side pane",
  "⌘F": "Find",
  "⌘⇧F": "Search everything",
  "⌘,": "Settings",
  "⌘/": "Keyboard cheat sheet",
  "⌘⇧,": "Change the shortcut",
};

/** Chords the system and text editing use; nothing may take them. Chord to what it does. */
export const RESERVED_SYSTEM: Readonly<Record<Chord, string>> = {
  "⌘Q": "Quit",
  "⌘W": "Close the window",
  "⌘H": "Hide the app",
  "⌘M": "Minimise",
  "⌘C": "Copy",
  "⌘X": "Cut",
  "⌘V": "Paste",
  "⌘A": "Select all",
  "⌘Z": "Undo",
  "⌘⇧Z": "Redo",
};
