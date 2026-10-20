# `@app-patterns/commands`

One command registry per desktop app. The palette, the cheat sheet, the shortcuts page, the key handler and the app menu all read it, so a command is added in one place. Pure TypeScript: no Electron or React dependency (Electron appears only as the local structural type `MenuItem`, which is assignable to `MenuItemConstructorOptions`).

## Interface

- `defineRegistry(defs, options?)` returns a registry with `bindingsOf(overrides)` / `resolveBindings(overrides)` (overrides that are reserved, bare, invalid or collide are dropped and reported in `rejected`; never throws), `commandForChord`, `checkRebind` (`ok` / `same` / `fixed` / `reserved` / `bare` / `taken` / `invalid`), `rebindMessage`, `paletteList(ctx, query?)` and `cheatSheet(bindings)`. It throws on a duplicate id, a bad or colliding default chord, a default on a reserved chord, or `noMenu` without `noMenuReason`.
- Scopes: `CommandDef.scope?: string` (absent = global). Duplicate default chords are an error only within one scope; a chord in a named scope shadows the same global chord while that scope is active, and only named-scope commands may use a bare (unmodified) key as a user override (`checkRebind` says `bare` for a global command). Reserved chords stay reserved in every scope. `commandForChord(bindings, chord, scope?)` and `dispatchKey(..., { ..., scope })` take the active scope; without one only global commands match. `toAccelerator` now returns a string for an unmodified key ("Delete", "F5", "Down", "R"), null only for an empty chord.
- `CommandDef<G, Ctx>`: `id`, `group`, `label`, `key`, `icon`, flags `fixed`, `typing`, `hidden`, `noMenu`, optional `available?(ctx)` (null = available, string = reason shown).
- Chords: `canonChord`, `isValidChord`, `isTypingSafe`, `chordFromEvent`, `toAccelerator`. `RESERVED_ESTATE` and `RESERVED_SYSTEM` are chords no app command may be rebound to.
- `dispatchKey(registry, keyEvent, bindings, { inField, onControl, overlay })` returns the command id to run, or null.
- The registry always includes the frame commands `settings` (⌘,), `cheat` (⌘/), `export-settings` and `import-settings`; an app may relabel them, not remove or rekey them. Command ids match `/^[a-z][a-z0-9.-]*$/`. `buildMenuTemplate({ appName, registry, menus, bindings, run, appItems, ctx })` builds the fixed-frame menu: App, Edit, declared app menus, View, Window, Help. Items are disabled when `available(ctx)` returns a reason (`ctx` is required, `undefined` for a void context; a throwing `available` disables the item; rebuild when the context changes). Each menu label may be declared once. Accelerators are shown with `registerAccelerator: false`, because the renderer handles keys. `validateMenuCoverage(registry, menus)` returns the ids of commands that land in no menu.

## Example

```ts
import { buildMenuTemplate, defineRegistry, dispatchKey } from "@app-patterns/commands";

const registry = defineRegistry<"Find" | "App", { selected: boolean }>([
  { id: "palette", group: "Find", label: "Command palette", key: "⌘⇧P", icon: "command", fixed: true, typing: true },
  { id: "rename", group: "Find", label: "Rename", key: "⌘R", icon: "pencil", available: (c) => (c.selected ? null : "select an item first") },
  { id: "settings", group: "App", label: "Settings", key: "⌘,", icon: "settings", fixed: true, typing: true },
]);
const bindings = registry.bindingsOf({ rename: "⌘⌥R" });
const template = buildMenuTemplate({ appName: "Demo", registry, menus: [{ label: "Go", groups: ["Find"] }], bindings, ctx: { selected: true }, run: (id) => console.log(id) });
```

Run `bun run check` in this package (typecheck, tests, build).
