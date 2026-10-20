/**
 * Which command a key press runs, given what has focus. The one rule every command shares: inside a text field a command runs only when
 * the registry marks it `typing` and its chord has a modifier (or is a function key); everything else is left to the field. Pure, so it is tested without a DOM.
 */
import { chordFromEvent, isTypingSafe, type KeyLike } from "./chords.ts";
import type { Bindings, Registry } from "./registry.ts";

export interface KeyContext {
  /** Focus is in an input, textarea, select or editable element. */
  inField: boolean;
  /** Focus is on a button or menu item, which would use Return for itself. */
  onControl: boolean;
  /** An overlay (palette, jump list, cheat sheet ...) is open: only the registry's `overlayIds` commands run. */
  overlay: boolean;
  /** The active scope (a mode or surface that owns bare keys); its commands shadow global ones on the same chord. Absent: global only. */
  scope?: string;
}

export function dispatchKey<G extends string, Ctx>(registry: Registry<G, Ctx>, e: KeyLike, bindings: Bindings, ctx: KeyContext): string | null {
  const chord = chordFromEvent(e);
  if (!chord) return null;
  const id = registry.commandForChord(bindings, chord, ctx.scope);
  if (!id) return null;
  if (ctx.inField && (!registry.runsWhileTyping(id) || !isTypingSafe(chord))) return null; // a bare key in a text field is typing, whatever the command's flag
  if (ctx.overlay && !registry.overlayIds.has(id)) return null;
  // A bare Return belongs to a focused button.
  if (ctx.onControl && chord === "↵") return null;
  return id;
}
