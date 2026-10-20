/** A schema with every setting type, a small command set, and a deterministic clock, shared by the tests. */
import { expect } from "bun:test";
import type { Actor } from "./changes.ts";
import type { CommandsAdapter, Rejected } from "./keys.ts";
import { loadState } from "./load.ts";
import { defineSchema, type Schema, type SettingDef } from "./schema.ts";
import { emptyState, type OpContext, type SettingsState } from "./state.ts";

export const SETTINGS: SettingDef[] = [
  { key: "appearance.theme", label: "Appearance", section: "appearance", type: "choice", default: "light", options: [{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }] },
  { key: "editor.proseSize", label: "Prose size", section: "editor", group: "Text", type: "number", default: 16, min: 10, max: 32, unit: "pt", help: "Font size of the prose" },
  { key: "editor.focusMode", label: "Reading focus", section: "editor", type: "toggle", default: false },
  { key: "readAloud.skipPrefix", label: "Skip lines starting with", section: "readAloud", type: "text", default: "%%", validate: (v) => (String(v).length > 10 ? "At most 10 characters" : null) },
  {
    key: "library.folder", label: "Workspace folder", section: "library", type: "path", default: "~/Documents/Writing",
    canApply: (v, env) => (env.pathExists && !env.pathExists(String(v)) ? "Not on this Mac" : null),
  },
  { key: "shortcuts.globalHotkey", label: "Show the app from anywhere", section: "shortcuts", type: "chord", default: "" },
  { key: "accounts.speech", label: "Speech service key", section: "accounts", type: "secret", default: null, help: "Saved in Keychain" },
];

export const schema = defineSchema({
  app: "editorexample",
  sections: [
    { id: "editor", label: "Editor", icon: "pen-line" },
    { id: "readAloud", label: "Read aloud", icon: "volume-2" },
    { id: "library", label: "Library", icon: "library" },
  ],
  settings: SETTINGS,
});

/** Non-secret settings, each with a valid value other than its default. */
export const CHANGED_VALUES: Record<string, string | number | boolean> = {
  "appearance.theme": "dark",
  "editor.proseSize": 18,
  "editor.focusMode": true,
  "readAloud.skipPrefix": "//",
  "library.folder": "~/Dropbox/Writing",
  "shortcuts.globalHotkey": "⌥⌘Space",
};

const DEFAULT_CHORDS: Record<string, string> = { "insert-link": "⌘K", rename: "⌘R", pin: "⌘D", "go-to-heading": "⇧⌘G" };
const RESERVED = new Set(["⌘Q", "⌘,"]);

/**
 * Stands in for `@app-patterns/commands`' `resolveBindings`: unknown ids and reserved chords are rejected; on a collision the overriding
 * commands lose to a command on its default, and otherwise all but the first override lose; repeated until the set is clean.
 */
export const commands: CommandsAdapter = {
  isCommand: (id) => Object.hasOwn(DEFAULT_CHORDS, id),
  defaultChord: (id) => DEFAULT_CHORDS[id] ?? "",
  resolve: (overrides) => {
    const rejected: Rejected[] = [];
    const accepted = new Map<string, string>();
    for (const [id, chord] of Object.entries(overrides)) {
      if (!Object.hasOwn(DEFAULT_CHORDS, id)) rejected.push({ commandId: id, chord, reason: `There is no command "${id}"` });
      else if (RESERVED.has(chord)) rejected.push({ commandId: id, chord, reason: `${chord} is reserved` });
      else accepted.set(id, chord);
    }
    for (;;) {
      const bindings: Record<string, string> = { ...DEFAULT_CHORDS, ...Object.fromEntries(accepted) };
      const byChord = new Map<string, string[]>();
      for (const [id, chord] of Object.entries(bindings)) if (chord) byChord.set(chord, [...(byChord.get(chord) ?? []), id]);
      const lose: string[] = [];
      for (const [chord, ids] of byChord) {
        if (ids.length < 2) continue;
        const over = ids.filter((id) => accepted.has(id));
        const losers = over.length < ids.length ? over : over.slice(1);
        for (const id of losers) {
          lose.push(id);
          rejected.push({ commandId: id, chord, reason: `${chord} is taken by ${ids.find((x) => x !== id)}` });
        }
      }
      if (lose.length === 0) return { bindings, rejected };
      for (const id of lose) accepted.delete(id);
    }
  },
};

/** Fails the test unless the operation succeeded, and checks that what it wrote survives loadState unchanged. */
export function must<R extends { ok: boolean }>(r: R, withSchema: Schema = schema): Extract<R, { ok: true }> {
  if (!r.ok) throw new Error(`${(r as { code?: string }).code}: ${(r as { error?: string }).error}`);
  const st = (r as unknown as { state: SettingsState }).state;
  const back = loadState(JSON.parse(JSON.stringify(st)), { schema: withSchema, commands, appVersion: "0.31.0", now: () => 0, newId: () => "rt" });
  expect(back.problem).toBeUndefined();
  expect(back.entries).toEqual([]);
  expect(back.dropped).toEqual([]);
  expect(back.state).toEqual(st);
  return r as Extract<R, { ok: true }>;
}

export function makeCtx(who: Actor = { kind: "you" }, start = 1_000, prefix = "id"): OpContext & { appVersion: string } {
  let t = start;
  let n = 0;
  return { schema, who, commands, now: () => t++, newId: () => `${prefix}${++n}`, appVersion: "0.31.0" };
}

export const fresh = (): SettingsState => emptyState("editorexample");
