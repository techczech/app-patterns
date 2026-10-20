/**
 * The bridge from a `@app-patterns/commands` registry to the `CommandsAdapter` the core takes. This package does not depend on
 * `@app-patterns/commands`; `RegistryLike` is the part of its `Registry` the bridge reads, so any registry from `defineRegistry` fits.
 * The registry's rejection codes (`taken`, `reserved` ...) become the registry's own words through `checkRebind` + `rebindMessage`.
 */
import type { CommandsAdapter, Rejected } from "./keys.ts";

export interface RegistryLike<Check = unknown> {
  byId(id: string): { key: string } | undefined;
  resolveBindings(overrides?: Record<string, string>): {
    bindings: Record<string, string>;
    rejected: readonly { commandId: string; chord: string; reason: string }[];
  };
  checkRebind(bindings: Record<string, string>, id: string, chord: string): Check;
  rebindMessage(check: Check, chord: string): string;
}

const FALLBACK: Record<string, string> = {
  unknown: "There is no such command",
  fixed: "This shortcut is the same in all the apps, so it cannot be changed",
  invalid: "That is not a key combination this app can use",
  reserved: "That shortcut is kept for the system or all the apps",
  bare: "A key alone is for typing; add ⌘, ⌥ or ⌃",
  taken: "That shortcut is already used by another command",
};

/** A `CommandsAdapter` over a command registry. */
export function commandsAdapter<Check>(registry: RegistryLike<Check>): CommandsAdapter {
  const reasonOf = (bindings: Record<string, string>, r: { commandId: string; chord: string; reason: string }): string => {
    if (r.reason === "unknown") return `There is no command "${r.commandId}"`;
    if (r.reason !== "fixed" && r.reason !== "invalid") {
      // Ask again against the resolved set so a "taken" or "reserved" names who holds the chord.
      const message = registry.rebindMessage(registry.checkRebind(bindings, r.commandId, r.chord), r.chord);
      if (message) return message;
    }
    return FALLBACK[r.reason] ?? "Conflicts with another shortcut";
  };
  return {
    isCommand: (id) => registry.byId(id) !== undefined,
    defaultChord: (id) => registry.byId(id)?.key ?? "",
    resolve: (overrides) => {
      const r = registry.resolveBindings({ ...overrides });
      const rejected: Rejected[] = r.rejected.map((x) => ({ commandId: x.commandId, chord: x.chord, reason: reasonOf(r.bindings, x) }));
      return { bindings: { ...r.bindings }, rejected };
    },
  };
}
