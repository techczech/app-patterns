# `@app-patterns/commands`

One command registry per desktop app. The palette, the cheat sheet, the shortcuts page, the key handler and the app menu all read it, so a command is added in one place. Pure TypeScript: no Electron or React dependency (Electron appears only as the local structural type `MenuItem`, which is assignable to `MenuItemConstructorOptions`).

## Interface

- `defineRegistry(defs, options?)` returns a registry with `bindingsOf(overrides)` / `resolveBindings(overrides)` (overrides that are reserved, bare, invalid, platform-prohibited or collide are dropped and reported in `rejected`; never throws), `commandForChord`, `checkRebind` (`ok` / `same` / `fixed` / `reserved` / `bare` / `taken` / `platform` / `invalid`), `rebindMessage`, `paletteList(ctx, query?)` and `cheatSheet(bindings)`. It throws on a duplicate id, a bad or colliding default chord, a default on a reserved chord, or `noMenu` without `noMenuReason`.
- Scopes: `CommandDef.scope?: string` (absent = global). Duplicate default chords are an error only within one scope; a chord in a named scope shadows the same global chord while that scope is active, and only named-scope commands may use a bare (unmodified) key as a user override (`checkRebind` says `bare` for a global command). Reserved chords stay reserved in every scope. `commandForChord(bindings, chord, scope?)` and `dispatchKey(..., { ..., scope })` take the active scope; without one only global commands match. `toAccelerator` now returns a string for an unmodified key ("Delete", "F5", "Down", "R"), null only for an empty chord.
- `CommandDef<G, Ctx>`: `id`, `group`, `label`, `key`, `icon`, flags `fixed`, `typing`, `hidden`, `noMenu`, optional `available?(ctx)` (null = available, string = reason shown).
- Chords: `canonChord`, `isValidChord` (spelling), `chordRestriction` (platform refusal), `isTypingSafe`, `chordFromEvent`, `toAccelerator`. `RESERVED_ESTATE` and `RESERVED_SYSTEM` protect chord meanings. With the opt-in below, only an estate chord's declared holder may return to it.
- `dispatchKey(registry, keyEvent, bindings, { inField, onControl, overlay })` returns the command id to run, or null.
- The registry always includes the frame commands `settings` (⌘,), `cheat` (⌘/), `export-settings` and `import-settings`; an app may relabel them. With `rebindableEstateDefaults`, saved overrides may move or unbind Settings and the cheat sheet. Command ids match `/^[a-z][a-z0-9.-]*$/`. `buildMenuTemplate({ appName, registry, menus, bindings, run, appItems, ctx })` builds the fixed-frame menu: App, Edit, View, declared app menus, Window, Help. Items are disabled when `available(ctx)` returns a reason (`ctx` is required, `undefined` for a void context; a throwing `available` disables the item; rebuild when the context changes). Each menu label may be declared once. Accelerators are shown with `registerAccelerator: false`, because the renderer handles keys. `validateMenuCoverage(registry, menus)` returns the ids of commands that land in no menu.

## Rebinding estate defaults (MediaWell)

MediaWell enables the corrected contract when creating its single registry:

```ts
const registry = defineRegistry(commandDefs, { rebindableEstateDefaults: true });
const { bindings, rejected } = registry.resolveBindings(savedOverrides);
```

Keep the estate default in each definition's `key`: palette `⌘⇧P`, switcher `⌘⇧K`, contextual actions `⌘K`, inspector `⌘P`, find `⌘F`, search `⌘⇧F`, Settings `⌘,`, cheat sheet `⌘/` and rebind `⌘⇧,`. This declaration assigns the default chord's meaning to that command; command ids and labels are app-defined. Settings and cheat sheet declarations are supplied by the framework. Do not put saved choices into definitions or modify the registry's frozen copies.

With this option, these nine holders are rebindable even when the input says `fixed: true`. Their returned definitions omit `fixed`, so Settings can offer rebinding. Valid saved overrides survive resolution, loading, migration and import through `commandsAdapter(registry)`. A holder may return to its own reserved default. Moving or removing its binding leaves that default reserved in every scope; another command cannot take it. A second declaration claiming the same estate default is refused, including across scopes. Custom chords still undergo collision, typing and platform checks. Explicitly fixed commands on other chords remain fixed, and their chords remain reserved.

The default overlay set retains estate holders after rebinding; an explicit `overlayIds` still takes precedence. Feed the resolved bindings to dispatch, the cheat sheet and menu generation, and rebuild menus after rebinding. Callers that omit this option keep their existing fixed-binding behaviour.

Every registry rejects full four-modifier hyper bindings (reserved for Raycast) and plain `⌃←`, `⌃→`, `⌃↑`, `⌃↓` (Mission Control and Spaces). `checkRebind` returns `platform` with a specific `reason`; `rebindMessage` supplies the same words. Invalid saved overrides are reported and fall back to a free default. Definitions are refused even for fixed commands. Settings rebind/import and CLI commands use this validation through the same adapter. `⌘⌃` structural arrows and `⌘⌃⇧` subtree arrows remain available; the check does not prohibit every Control+arrow combination. Chord spelling and accelerator conversion remain independent of binding permission.

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
