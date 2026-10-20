import type { UpdatesProps } from "@app-patterns/updates-react";
/** Props and callbacks of the Settings window. Everything the window knows arrives as props; everything it does leaves through `actions`. */
import type { MenuDecl, RebindCheck } from "@app-patterns/commands";
import type { ChangeFilter, ImportPreview, Schema, SettingsState, SettingValue } from "@app-patterns/settings";

/** What an action returns. An `OpResult` from the core fits as it is; the host may also return `{ ok: true }`. */
/** `batch` on a success is the id of the batch the operation wrote (an `OpResult` carries it); `importApply` should return it so the window can open the import. */
export type Outcome = { ok: true; batch?: string } | { ok: false; error: string };
export type MaybeAsync<T> = T | Promise<T>;

/** The part of a `@app-patterns/commands` registry the window reads (any `defineRegistry` result fits). */
export interface SettingsRegistry {
  readonly defs: readonly {
    id: string;
    group: string;
    label: string;
    key: string;
    icon: string;
    fixed?: true;
    hidden?: true;
    noMenu?: true;
  }[];
  byId(id: string): { id: string; group: string; label: string; key: string } | undefined;
  resolveBindings(overrides?: Record<string, string>): { bindings: Record<string, string> };
  commandForChord(bindings: Record<string, string>, chord: string): string | null;
  checkRebind(bindings: Record<string, string>, id: string, chord: string): RebindCheck;
  rebindMessage(check: RebindCheck, chord: string): string;
}

export type SlotStatus = "connected" | "missing" | "problem";

/** One key or sign-in in Accounts and keys. For a key, `id` is the key of the `secret` setting it belongs to. The value is never passed in. */
export interface Slot {
  id: string;
  label: string;
  status: SlotStatus;
  /** The status line after the icon ("Signed in · plan subscription", "Key rejected by the service."). A default is written from `status`. */
  detail?: string;
  /** The last four characters of a saved key, when the host chooses to show them. */
  last4?: string;
  /** Card heading ("Model provider", "Services"). Slots with the same group share a card; the default is "Services". */
  group?: string;
  /** lucide icon name. */
  icon?: string;
  /** `account` is a sign-in (Sign out), not a key. */
  kind?: "key" | "account";
  /** Settings or commands that use it, for the inspector ("Library: Import highlights"). */
  usedBy?: { area: string; what: string }[];
  /** Newest first, for the inspector. */
  history?: { text: string; who: "you" | "agent" | "app-update" | "import"; whoName?: string; at: string }[];
}

/** What the host implements. Each takes plain values and returns once it is done; the window shows `error` when `ok` is false. */
export interface SettingsActions {
  set(key: string, value: SettingValue): MaybeAsync<Outcome>;
  rebind(commandId: string, chord: string): MaybeAsync<Outcome>;
  rebindMany(pairs: { commandId: string; chord: string }[]): MaybeAsync<Outcome>;
  reset(target: string | { commandId: string }): MaybeAsync<Outcome>;
  resetSection(sectionId: string): MaybeAsync<Outcome>;
  resetAll(): MaybeAsync<Outcome>;
  resetEntry(entryId: string): MaybeAsync<Outcome>;
  undoBatch(batchId: string): MaybeAsync<Outcome>;
  /** Opens the native save panel, writes the file. `ok: true` with nothing else when the user cancelled is also fine. */
  exportSettings(): MaybeAsync<Outcome>;
  /** Opens the native open panel, reads the file and returns its name and `previewImport` result; null when cancelled. */
  importPick(): MaybeAsync<{ fileName: string; preview: ImportPreview } | null>;
  /** Applies the preview as one batch (`applyImport`). */
  importApply(preview: ImportPreview, fileName: string): MaybeAsync<Outcome>;
  setSecret(slotId: string, value: string): MaybeAsync<Outcome>;
  removeSecret(slotId: string): MaybeAsync<Outcome>;
  /** Optional: sign out of an `account` slot. */
  signOut?(slotId: string): MaybeAsync<Outcome>;
  /** Optional: the native folder or file picker for `path` rows. Resolves to the chosen path, or null when cancelled. */
  choosePath?(key: string): MaybeAsync<string | null>;
  /** Optional: runs the host's update check. */
  checkForUpdates?(): MaybeAsync<void>;
}

/** What the schema cannot say about a row. All optional, by setting key. */
export interface RowHint {
  /** Draw a `choice` as a segmented control. */
  control?: "segmented";
  /** The short line under the label. The long description in the inspector is the schema's `help`. */
  summary?: string;
  /** Why the row cannot be changed now; the row is dimmed and shows this. */
  disabled?: string;
  /** A `path` row whose folder is not on this Mac. */
  missing?: boolean;
  /** Step of a `number` row (default 1). */
  step?: number;
  /** The value shown in the agent command example, when the default guess is not the one to show. Give the plain value (`sentence`, not `"sentence"`); the window quotes it for the shell. */
  example?: string;
}

export interface AppInfo {
  name: string;
  version: string;
  build?: string;
  /** lucide icon name for the About card. */
  icon?: string;
  /** The agent command-line name; defaults to the schema's app id. */
  cli?: string;
}

export interface UpdateStatus {
  /** "Example Editor is up to date" / "Version 0.32.0 is available". */
  text: string;
  tone?: "ok" | "info" | "problem";
  detail?: string;
}

export interface CustomPage {
  id: string;
  label: string;
  /** lucide icon name. */
  icon: string;
  /** "all" puts it under All apps; "app" under the app's name (default). */
  placement?: "all" | "app";
  render(): import("react").ReactNode;
}

export type SheetState =
  | { kind: "reset-all" }
  | { kind: "reset-section"; section: string }
  | { kind: "import"; fileName: string; preview: ImportPreview }
  | { kind: "refused"; fileName: string; preview: ImportPreview };

/** The window's own state. `initial` lets a host (or the demo) open it in any state. */
export interface UiState {
  section: string;
  query: string;
  /** The setting selected for the inspector. */
  selKey: string | null;
  /** On Changes: an entry id, or an import batch id. */
  selChange: string | null;
  /** On Shortcuts and Accounts: the selected command or slot. */
  selItem: string | null;
  filter: ChangeFilter;
  changeText: string;
  shortcutText: string;
  capturing: string | null;
  conflict: { commandId: string; chord: string } | null;
  addingKey: string | null;
  /** Typed text that was not accepted, by setting key. */
  drafts: Record<string, string>;
  sheet: SheetState | null;
  notice: string | null;
  /** The search field starts focused. */
  focusSearch: boolean;
}

export interface SettingsWindowProps {
  schema: Schema;
  state: SettingsState;
  registry: SettingsRegistry;
  appInfo: AppInfo;
  actions: SettingsActions;
  slots?: Slot[];
  customPages?: CustomPage[];
  rowHints?: Record<string, RowHint>;
  /** Menus the app declares, so the Shortcuts inspector can say where a command sits. */
  menus?: MenuDecl<string>[];
  update?: UpdateStatus | UpdatesProps;
  /** Changes newer than this (ms) are new: the badge, the agent highlight. Default: now, so nothing is new. */
  changesSeenAt?: number;
  /**
   * Called with the current time when Changes opens (also when the window starts on it), and again when the user leaves Changes or
   * the window unmounts while on it, so the host can store the time as `changesSeenAt`. The window keeps the "new" highlight for
   * the rest of the current visit itself, whatever `changesSeenAt` becomes meanwhile.
   */
  onChangesSeen?(at: number): void;
  /** For "Today" and "just now"; defaults to `Date.now()`. */
  now?: number;
  /** Names for other apps' ids, for the wrong-file sheet. */
  appNames?: Record<string, string>;
  /** What each command does, for the Shortcuts inspector (command id to one sentence). */
  commandHelp?: Record<string, string>;
  /** Which registry commands the Shortcuts page lists (default: every command that is not `hidden`). */
  showCommand?(def: SettingsRegistry["defs"][number]): boolean;
  /**
   * Show the agent commands for a shortcut in its inspector (default false, hidden). When true: `<cli> settings rebind <command> <chord>`
   * and `<cli> settings reset-shortcut <command>`. The CLI does not have these two verbs yet, so leave this off until it does.
   */
  agentCommandsForShortcuts?: boolean;
  /** Copies text; defaults to `navigator.clipboard`. */
  onCopy?(text: string): void;
  initial?: Partial<UiState>;
  className?: string;
}
