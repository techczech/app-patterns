/** The sixteen frames of the example layout, as the props and starting view that reproduce each one. */
import { exportFile, previewImport, emptyState, type ImportPreview, type SettingsState } from "@app-patterns/settings";
import type { UiState } from "../src/types.ts";
import {
  IMPORT_BATCH, NOW, twSchema, twState, twRegistry, wfAdapter, wfImportPreview, wfSchema, wfState, wfStateAfterImport,
} from "./fixture.ts";

export type AppId = "editorexample" | "recorderexample";
export interface Frame {
  key: string;
  name: string;
  app: AppId;
  /** Which panel the host draws over or beside the window. */
  host?: "app-menu" | "save-panel";
  state?: () => SettingsState;
  /** Clock and "seen" time for this frame, as minutes after midnight on 19 Oct. */
  now?: number;
  seenAt?: number;
  speech?: "connected" | "problem";
  initial?: Partial<UiState>;
}

const min = (h: number, m: number, s = 0): number => new Date(2026, 9, 19, h, m, s).getTime();
const AFTER = min(10, 40);

function twFile(): ImportPreview {
  const tw = twState();
  const file = exportFile(tw, { appVersion: "0.41.0", hostName: "Example Mac", now: new Date(2026, 9, 12, 9, 0).getTime(), schema: twSchema, commands: wfAdapter });
  return previewImport(wfState(), file, { schema: wfSchema, commands: wfAdapter });
}

export const FRAMES: Frame[] = [
  { key: "1", name: "Window, default", app: "editorexample", initial: { focusSearch: true } },
  { key: "2", name: "Search: font", app: "editorexample", initial: { query: "font", selKey: "editor.proseSize" } },
  { key: "3", name: "Search: no results", app: "editorexample", initial: { query: "dictionary" } },
  { key: "4", name: "Every row type", app: "editorexample", initial: { section: "readaloud", selKey: "readAloud.rate", drafts: { "readAloud.paragraphPause": "-5" } } },
  { key: "5", name: "Agent just changed a row", app: "editorexample", now: min(10, 39), seenAt: min(10, 30), initial: { section: "saving", selKey: "snapshots.frequency" } },
  { key: "6", name: "Changes", app: "editorexample", initial: { section: "changes", selChange: "e1" } },
  { key: "7", name: "Shortcuts", app: "editorexample", initial: { section: "shortcuts", selItem: "insert-link", capturing: "insert-link", conflict: { commandId: "reading-focus", chord: "⌘T" } } },
  { key: "8", name: "Accounts and keys", app: "editorexample", speech: "problem", initial: { section: "accounts", selItem: "accounts.readwise", addingKey: "accounts.readwise" } },
  { key: "9", name: "About and Reset all", app: "editorexample", initial: { section: "about", sheet: { kind: "reset-all" } } },
  { key: "0", name: "Same window: Example Recorder", app: "recorderexample", state: twState, initial: { section: "presenting", selKey: "clock.darkAmber" } },
  { key: "q", name: "App menu: Settings… ⌘,", app: "editorexample", host: "app-menu" },
  { key: "w", name: "Changes: empty", app: "editorexample", state: () => emptyState("editorexample"), initial: { section: "changes" } },
  { key: "e", name: "Export: save dialog", app: "editorexample", host: "save-panel", initial: { section: "general" } },
  { key: "r", name: "Import: preview", app: "editorexample", initial: { section: "general", sheet: { kind: "import", fileName: "Example Editor Settings 2026-10-17.json", preview: wfImportPreview() } } },
  { key: "t", name: "After import: Changes", app: "editorexample", state: wfStateAfterImport, seenAt: AFTER, initial: { section: "changes", selChange: IMPORT_BATCH } },
  { key: "y", name: "Import: wrong file", app: "editorexample", initial: { section: "general", sheet: { kind: "refused", fileName: "Example Recorder Settings 2026-10-12.json", preview: twFile() } } },
];

export const frameState = (f: Frame): SettingsState => (f.state ?? (f.app === "recorderexample" ? twState : wfState))();
export const frameNow = (f: Frame): number => f.now ?? NOW;
export { twRegistry };
