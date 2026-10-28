# `@app-patterns/commands`

One command registry per desktop app. The palette, the cheat sheet, the shortcuts page, the key handler and the app menu all read it, so a command is added in one place. Pure TypeScript: no Electron or React dependency (Electron appears only as the local structural type `MenuItem`, which is assignable to `MenuItemConstructorOptions`).

## Interface

- `defineRegistry(defs, options?)` returns a registry with `bindingsOf(overrides)` / `resolveBindings(overrides)` (overrides that are reserved, bare, invalid, platform-prohibited or collide are dropped and reported in `rejected`; never throws), `commandForChord`, `checkRebind` (`ok` / `same` / `fixed` / `reserved` / `bare` / `taken` / `platform` / `invalid`), `rebindMessage`, `paletteList(ctx, query?)` and `cheatSheet(bindings)`. It throws on a duplicate id, a bad or colliding default chord, a default on a reserved chord, or `noMenu` without `noMenuReason`.
- Scopes: `CommandDef.scope?: string` (absent = global). Duplicate default chords are an error only within one scope; a chord in a named scope shadows the same global chord while that scope is active, and only named-scope commands may use a bare (unmodified) key as a user override (`checkRebind` says `bare` for a global command). Reserved chords stay reserved in every scope. `commandForChord(bindings, chord, scope?)` and `dispatchKey(..., { ..., scope })` take the active scope; without one only global commands match. `toAccelerator` now returns a string for an unmodified key ("Delete", "F5", "Down", "R"), null only for an empty chord.
- `CommandDef<G, Ctx>`: `id`, `group`, `label`, `key`, `icon`, flags `fixed`, `typing`, `hidden`, `noMenu`, optional `available?(ctx)` (null = available, string = reason shown).
- Chords: `canonChord`, `isValidChord` (spelling), `chordRestriction` (platform refusal), `isTypingSafe`, `chordFromEvent`, `toAccelerator`. `RESERVED_ESTATE` and `RESERVED_SYSTEM` protect chord meanings. With the opt-in below, only an estate chord's declared holder may return to it.
- `dispatchKey(registry, keyEvent, bindings, { inField, onControl, overlay })` returns the command id to run, or null.
- The registry always includes the frame commands `settings` (⌘,), `cheat` (⌘/), `export-settings` and `import-settings`; an app may relabel them. With `rebindableEstateDefaults`, saved overrides may move or unbind Settings and the cheat sheet. Command ids match `/^[a-z][a-z0-9.-]*$/`. `buildMenuTemplate({ appName, registry, menus, bindings, run, appItems, ctx })` builds the fixed-frame menu: App, Edit, View, declared app menus, Window, Help. Items are disabled when `available(ctx)` returns a reason (`ctx` is required, `undefined` for a void context; a throwing `available` disables the item; rebuild when the context changes). Each menu label may be declared once. Templates set `registerAccelerator: false` because the renderer handles keys, but macOS still installs native key equivalents; apply the [keyboard safety pattern](#keyboard-safety-and-text-entry) before passing a template to Electron. `validateMenuCoverage(registry, menus)` returns the ids of commands that land in no menu.

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

## Keyboard safety and text entry

A shortcut is permission to run a command in a particular context. A modifier alone does not establish that permission. Keep ordinary typing, text editing and focused-control activation with the surface that owns them. ReportScout's search-field defect demonstrated why this must cover both the renderer listener and the native menu.

### Responsibilities of the app listener

`dispatchKey` is a pure matcher. The caller supplies `inField`, `onControl`, `overlay` and the active `scope`; it does not inspect the DOM or consume the event. Before calling it:

- Return when `event.defaultPrevented` or `event.isComposing` is true. Let the editor finish handling the key first; use its composition state or legacy IME fallback where its event path requires one.
- Determine text-entry ownership from the event's composed path and the editor's focus API where needed. Cover inputs (including search), textareas, selects, inherited editable descendants, `contenteditable=""`, `contenteditable="true"` and `contenteditable="plaintext-only"`. `isContentEditable` handles effective HTML editability, including a `contenteditable="false"` boundary; a selector for only `[contenteditable="true"]` does not. Inspect real element nodes in `composedPath()` when shadow DOM retargets `event.target`. A closed shadow root or custom canvas editor needs an explicit host/editor integration; DOM inspection alone cannot see its internal focus.
- Identify buttons, links and other interactive controls separately. Leave their Return and Space activation, and their owned navigation/Delete keys, to the control. `onControl` currently suppresses only bare Return; callers must protect Space and other widget keys themselves. ReportScout separately excludes its Space-to-open command on controls.
- Reject AltGr text-entry events (`getModifierState('AltGraph')` where supported) before interpreting Control+Alt as a command. Preserve platform Option-based character entry as well. The matcher uses physical `code` and exact modifier flags; it cannot distinguish an AltGr character from an app chord by those flags alone. Never replace exact matching with `metaKey || ctrlKey`, which collapses distinct chords.

In a field, the helper requires **both** `typing: true` and `isTypingSafe(chord)`. Bare letters, navigation, Return, Space, Delete/Backspace and Shift-only chords therefore stay with the field even if the command says `typing: true`. Function keys count as typing-safe, as do Command, Control or Option chords; this classification is only a first filter. The app must preserve native editing chords such as select all, copy/paste, undo/redo, word/line/document movement and their Shift selection variants. On macOS this includes Option+arrows, Command+arrows and their Shift extensions. Mark only deliberate app-wide actions as `typing`; let the editor own its other modified keys.

Choose a named scope only while its surface owns the gesture. Named-scope bindings shadow global bindings in that scope, but the helper does not infer the scope from focus. Apply availability before executing, and call `preventDefault()` only after accepting a command. An overlay also limits dispatch to the registry's `overlayIds`. Here “global” means app-wide dispatch, not an operating-system `globalShortcut` registration.

### Native menu safety on macOS

**`registerAccelerator: false` does not make macOS menu accelerators display-only.** Electron's native menu can handle a key that the renderer leaves unconsumed. A field guard alone cannot stop a bare menu key equivalent from firing Star, Topics or Open while somebody types.

Before every native menu build, recursively remove the `accelerator` and its `registerAccelerator` property from items whose effective chord lacks Command, Control or Option. This includes Shift-only keys, Return, Escape, Space, Delete, arrows and function keys. Retain the command's menu item, label, enabled state and click action. Keep its binding in the registry, palette and cheat sheet; the renderer can still dispatch it outside fields in its declared scope. Do not suppress ordinary text events merely to shield the menu.

ReportScout provides a small app-local reference: `src/menu-keys.mjs` (`withoutBareKeys` and `menuWithoutBareKeys`), passed to the shared Settings host in `src/main.mjs`. It transforms every rebuilt template, so rebinding a scoped command to a bare key cannot reintroduce the native accelerator. This is an integration pattern, **not an exported capability of commands 0.4.2**. No package upgrade is needed to apply it locally. Modified native accelerators still need a deliberate policy for text entry, availability and overlays; stripping bare keys does not prove those paths safe.

### Bindings and discoverability

Resolve saved overrides once and pass the resulting effective bindings to dispatch, the palette's shortcut display, the cheat sheet, Settings and menu generation. Rebuild the native menu when bindings or availability change. Assert parity after rebinding and unbinding, including rejection/fallback cases. The intentional macOS exception is that a bare binding remains discoverable in the palette and cheat sheet while its native menu item carries no accelerator. Preserve standard Edit roles.

### Regression verification

Drive the app's real keyboard event path with an isolated fixture and assert resulting state, not just a command id. Type letters that coincide with actions, spaces and Return in search in each relevant view; check the exact text, focus, dialogs, selection and persisted report marks. Check native editing and selection without clipboard mutation, bare navigation/Delete and Shift-only keys in fields, custom editors, composition, already-consumed events, extra modifiers and AltGr on supported layouts. Then prove bare shortcuts work outside fields and declared app-wide chords work inside them. Check control activation, overlay/scope boundaries and effective bindings after rebinding.

Also inspect the **built application menu** for forbidden bare accelerators, including nested menus and user overrides. Hidden Electron `sendInputEvent` and Playwright keys exercise the renderer but do not establish that AppKit's native menu dispatch ran. Report that native limitation separately; a structural native-menu assertion complements the hidden event-path check. Prove a regression check can fail by removing its guard in a disposable fixture, then restore it.

ReportScout's repeatable reference is `scripts/check-typing-and-archive.mjs`: run against source and the installed executable with `--report-scout-check`, isolated data and `--use-mock-keychain`; it verifies typing leaves report marks unchanged, bare S/G work outside search, declared chords work inside search, and windows remain hidden. Its existing search check does **not** cover the full editor/IME/AltGr matrix above. Its caller currently uses a limited editable selector, and commands 0.4.2 does not handle DOM ownership, consumed events, composition or AltGr itself. Adopt these responsibilities where the consuming app has those surfaces; do not claim fleet-wide coverage from the reference.
