/**
 * Example Editor-like and Example Recorder-like data from the example layout, built with the real core (`defineSchema`, `defineRegistry`,
 * `previewImport`). The demo page and the tests share it. Times are local, on Monday 19 October 2026.
 */
import { defineRegistry } from "@app-patterns/commands";
import {
  commandsAdapter, defineSchema, emptyState, exportFile, previewImport,
  type ChangeEntry, type ImportWho, type ExportFile, type ImportPreview, type SettingDef, type SettingsState,
} from "@app-patterns/settings";
import type { RowHint, Slot } from "../src/types.ts";

const at = (day: number, h: number, m: number, s = 0): number => new Date(2026, 9, day, h, m, s).getTime();
export const NOW = at(19, 10, 55);
const opt = (...labels: string[]): { value: string; label: string }[] => labels.map((l) => ({ value: l.toLowerCase().replace(/[^a-z0-9]+/g, "-"), label: l }));
const nums = (values: number[], unit: string): { value: number; label: string }[] => values.map((v) => ({ value: v, label: `${v} ${unit}` }));

/* ---------------------------------------------------------------- Example Editor */

const WF_SETTINGS: SettingDef[] = [
  { key: "integration.browserLinks", label: "Open files from browser links", section: "general", group: "Opening", type: "toggle", default: true, help: "Links to local Markdown files in a browser open in Example Editor instead of downloading." },
  { key: "app.launchAtLogin", label: "Launch at login", section: "general", group: "Opening", type: "toggle", default: false, help: "Opens Example Editor when you log in to this Mac." },
  { key: "getStarted.showExample", label: "Show the example on the start screen", section: "general", group: "Opening", type: "toggle", default: false, help: "The example workspace on the start screen." },
  { key: "updates.auto", label: "Check for updates automatically", section: "general", group: "Updates", type: "toggle", default: true, help: "Checks once a day and when Example Editor opens." },
  { key: "updates.channel", label: "Update channel", section: "general", group: "Updates", type: "choice", default: "stable", options: opt("Stable", "Preview"), help: "Stable gets tested releases. Preview gets alpha builds first." },

  { key: "appearance.theme", label: "Appearance", section: "appearance", group: "Theme", type: "choice", default: "light", options: opt("Light", "Dark"), help: "Light is the default. Dark changes the editor, side panels and this window." },
  { key: "appearance.uiSize", label: "Interface text size", section: "appearance", group: "Text", type: "choice", default: "medium", options: opt("Small", "Medium", "Large"), help: "Font size of menus, side panels and this window. The prose size is set in Editor." },
  { key: "actionBar.visible", label: "Show the action bar", section: "appearance", group: "Action bar", type: "toggle", default: true, help: "The row of buttons above the editor." },

  { key: "agent.model", label: "Model", section: "assistant", group: "Model", type: "choice", default: "sonnet-5-5", options: [{ value: "sonnet-5-5", label: "Claude Sonnet 5.5" }, { value: "opus-5-5", label: "Claude Opus 5.5" }], help: "The model the Example Editor assistant uses for new conversations." },
  { key: "agent.thinkingLevel", label: "Default reasoning level", section: "assistant", group: "Model", type: "choice", default: "medium", options: opt("Low", "Medium", "High"), help: "How long the assistant thinks before answering." },
  { key: "permissions.proseEdits", label: "Propose prose edits", section: "assistant", group: "Agent permissions", type: "toggle", default: true, help: "The assistant may propose edits to your text. You accept or reject each one." },
  { key: "permissions.createFiles", label: "Create files", section: "assistant", group: "Agent permissions", type: "toggle", default: true, help: "The assistant may create new files in the Workspace." },
  { key: "permissions.renameFiles", label: "Rename and move files", section: "assistant", group: "Agent permissions", type: "toggle", default: false, help: "The assistant may rename and move files in the Workspace." },
  { key: "permissions.readWorkspace", label: "Search and read the Workspace", section: "assistant", group: "Agent permissions", type: "toggle", default: true, help: "The assistant may search and read every file in the Workspace." },

  { key: "editor.typewriter", label: "Typewriter mode", section: "editor", group: "Writing", type: "toggle", default: false, help: "Keeps the line you are typing at one height on screen." },
  { key: "editor.fixedLine", label: "Fixed line position", section: "editor", group: "Writing", type: "choice", default: "middle", options: opt("Upper", "Middle", "Lower"), help: "Where the typing line stays in Typewriter mode." },
  { key: "editor.viewMode", label: "View mode", section: "editor", group: "Writing", type: "choice", default: "editor-and-preview", options: opt("Editor", "Preview", "Editor and preview"), help: "What a newly opened document shows." },
  { key: "editor.proseSize", label: "Prose size", section: "editor", group: "Text", type: "choice", default: 16, options: nums([14, 16, 18, 20, 22], "pt"), help: "Font size of body text in the editor and the Reading Room." },
  { key: "editor.lineWidth", label: "Line width", section: "editor", group: "Text", type: "choice", default: "medium", options: opt("Narrow", "Medium", "Wide"), help: "Maximum width of a line of prose." },
  { key: "editor.spellcheck", label: "Spellcheck", section: "editor", group: "Text", type: "toggle", default: true, help: "Underlines misspelt words while you type." },
  { key: "editor.focusMode", label: "Reading focus", section: "editor", group: "Reading focus", type: "choice", default: "off", options: opt("Off", "Paragraph", "Sentence"), help: "Dims everything except the paragraph or sentence you are in." },
  { key: "editor.leadStyle", label: "Anchored lead-in style", section: "editor", group: "Reading focus", type: "choice", default: "bold", options: opt("Bold", "Italic"), help: "How the opening words of each paragraph are marked in Reading focus." },
  { key: "editor.rulerOpacity", label: "Ruler opacity", section: "editor", group: "Reading focus", type: "number", default: 40, min: 0, max: 100, unit: "%", help: "How strongly the reading ruler shows." },

  { key: "readingRoom.side", label: "Reading Room side", section: "readingroom", group: "Layout", type: "choice", default: "right", options: opt("Left", "Right"), help: "Which side of the editor the Reading Room opens on." },

  { key: "readAloud.voiceURI", label: "Voice", section: "readaloud", group: "Voice", type: "choice", default: "serena", options: [{ value: "system", label: "System voice" }, { value: "serena", label: "Serena (English, UK)" }], help: "The voice used to read documents aloud." },
  { key: "readAloud.rate", label: "Default speed", section: "readaloud", group: "Voice", type: "number", default: 1, min: 0.5, max: 3, unit: "×", help: "Speed at which read aloud starts. You can change it while listening." },
  { key: "readAloud.skipPrefix", label: "Skip lines starting with", section: "readaloud", group: "Voice", type: "text", default: "%%", help: "Lines that begin with this text are not read aloud." },
  { key: "readAloud.highlight", label: "Highlight the sentence being read", section: "readaloud", group: "Highlight", type: "toggle", default: true, help: "Marks the sentence being read in the editor." },
  { key: "readAloud.highlightStrength", label: "Highlight strength", section: "readaloud", group: "Highlight", type: "choice", default: "medium", options: opt("Light", "Medium", "Strong"), help: "How strong the read-aloud highlight is." },
  { key: "readAloud.paragraphPause", label: "Pause between paragraphs", section: "readaloud", group: "Playback", type: "number", default: 250, min: 0, max: 2000, unit: "ms", help: "Silence between two paragraphs." },
  { key: "readAloud.cacheFolder", label: "Audio cache folder", section: "readaloud", group: "Playback", type: "path", default: "~/Library/Caches/Example Editor/audio", help: "Where generated speech is kept so it plays at once next time." },
  { key: "shortcut.readAloud", label: "Start or stop read aloud", section: "readaloud", group: "Playback", type: "chord", default: "⌘⌥R", help: "The keyboard shortcut. All shortcuts are also in Shortcuts." },
  { key: "accounts.speech", label: "Speech service key", section: "readaloud", group: "Playback", type: "secret", default: null, help: "Key for the online voices. Saved in Keychain, never in the settings file." },

  { key: "sounds.typing.enabled", label: "Typing sounds", section: "sounds", group: "Typing sounds", type: "toggle", default: true, help: "Plays a key sound as you type." },
  { key: "sounds.typing.scheme", label: "Typing sound scheme", section: "sounds", group: "Typing sounds", type: "choice", default: "typewriter", options: opt("Typewriter", "Soft keys"), help: "Which key sounds play." },
  { key: "sounds.typing.volume", label: "Typing sound volume", section: "sounds", group: "Typing sounds", type: "number", default: 60, min: 0, max: 100, unit: "%", help: "Volume of key sounds." },
  { key: "sounds.ambient.enabled", label: "Ambient sound", section: "sounds", group: "Ambient sound", type: "toggle", default: false, help: "Plays a background loop while you write." },
  { key: "sounds.ambient.loop", label: "Ambient loop", section: "sounds", group: "Ambient sound", type: "choice", default: "rain", options: opt("White noise", "Rain"), help: "Which loop plays." },

  {
    key: "workspace.folder", label: "Workspace folder", section: "library", group: "Workspace", type: "path", default: "~/Documents/Writing", help: "The folder Example Editor opens as the Library.",
    canApply: (v) => (v === "~/Dropbox/Writing" ? "~/Dropbox/Writing is not on this Mac." : null),
  },
  { key: "workspace.watchExternalChanges", label: "Watch for external changes", section: "library", group: "Workspace", type: "toggle", default: true, help: "Reloads files changed by other apps." },
  { key: "diary.folder", label: "Diary folder", section: "diary", group: "Diary", type: "path", default: "~/Documents/Writing/Diary", help: "The folder that holds diary entries." },
  { key: "snapshots.frequency", label: "Checkpoint on close", section: "saving", group: "Checkpoints", type: "choice", default: "every-close", options: [{ value: "every-close", label: "Every close" }, { value: "off", label: "Off" }], help: "Saves a checkpoint of each document when you close it, so you can go back to it." },
  { key: "snapshots.retention", label: "Keep history for", section: "saving", group: "Checkpoints", type: "choice", default: 30, options: nums([14, 30, 90], "days"), help: "How long checkpoints are kept." },
];

export const wfSchema = defineSchema({
  app: "editorexample",
  sections: [
    { id: "assistant", label: "Assistant", icon: "bot" },
    { id: "editor", label: "Editor", icon: "type" },
    { id: "readingroom", label: "Reading Room", icon: "book-open" },
    { id: "readaloud", label: "Read aloud", icon: "audio-lines" },
    { id: "sounds", label: "Sounds", icon: "volume-2" },
    { id: "library", label: "Library", icon: "library" },
    { id: "diary", label: "Diary", icon: "notebook-pen" },
    { id: "saving", label: "Saving & history", icon: "history" },
  ],
  settings: WF_SETTINGS,
});

type Group = "Writing" | "Navigation" | "Read aloud";
const cmd = (id: string, group: Group, label: string, key: string, icon: string) => ({ id, group, label, key, icon });
/** Insert link and Open quickly use ⌘L and ⌘O: the mockup's ⌘K and ⌘P are reserved for every app by the command registry. */
export const wfRegistry = defineRegistry<Group>([
  cmd("typewriter-mode", "Writing", "Typewriter mode", "⌘T", "type"),
  cmd("reading-focus", "Writing", "Reading focus", "⌘⌃F", "scan-eye"),
  cmd("insert-link", "Writing", "Insert link", "⌘L", "link"),
  cmd("open-quickly", "Navigation", "Open quickly", "⌘O", "search"),
  cmd("go-to-heading", "Navigation", "Go to heading", "⌘⇧G", "hash"),
  cmd("next-document", "Navigation", "Next document", "⌘⌥]", "arrow-right"),
  cmd("read-aloud", "Read aloud", "Start or stop read aloud", "⌘⌥R", "audio-lines"),
  cmd("skip-sentence", "Read aloud", "Skip sentence", "⌘⌥→", "skip-forward"),
]);
export const wfAdapter = commandsAdapter(wfRegistry);
export const FRAME_COMMANDS = new Set(["settings", "cheat", "export-settings", "import-settings"]);

export const wfMenus = [{ label: "Format", groups: ["Writing"] }, { label: "View", groups: ["Navigation"] }];
export const wfCommandHelp: Record<string, string> = { "insert-link": "Turns the selected text into a link." };

export const wfHints: Record<string, RowHint> = {
  "appearance.theme": { control: "segmented" },
  "appearance.uiSize": { summary: "Font size of menus and side panels." },
  "permissions.proseEdits": { summary: "Always staged as suggestions." },
  "editor.fixedLine": { control: "segmented", disabled: "Turn on Typewriter mode to set this." },
  "editor.proseSize": { summary: "Font size of body text.", example: "20" },
  "editor.focusMode": { example: "sentence" },
  "editor.leadStyle": { summary: "Bold or italic font for the opening words." },
  "readAloud.rate": { step: 0.25 },
  "readAloud.highlightStrength": { control: "segmented", disabled: "Turn on the highlight to choose a strength." },
  "sounds.ambient.loop": { control: "segmented", disabled: "Turn on Ambient sound to choose a loop." },
  "snapshots.frequency": { example: "every-close" },
};

const E = (id: string, o: Omit<ChangeEntry, "id">): ChangeEntry => ({ id, ...o });
const you = { kind: "you" } as const;
const agent = (name: string) => ({ kind: "agent", name }) as const;

export const WF_CHANGES: ChangeEntry[] = [
  E("e1", { at: at(19, 10, 38), key: "snapshots.frequency", from: "every-close", to: "off", who: agent("Claude Code") }),
  E("e2", { at: at(19, 9, 12), key: "editor.proseSize", from: 16, to: 18, who: you }),
  E("e3", { at: at(18, 16, 20), key: "readAloud.rate", from: 1, to: 1.25, who: you }),
  E("e4", { at: at(18, 11, 5), key: "editor.focusMode", from: "off", to: "paragraph", who: agent("Example Editor assistant") }),
  E("e5", { at: at(15, 14, 2), key: "snapshots.frequency", from: "off", to: "every-close", who: { kind: "reset", of: "e8" } }),
  E("e6", { at: at(10, 12, 30), key: "readAloud.highlight", from: true, to: false, who: you }),
  E("e7", { at: at(12, 9, 0), key: "snapshots.retention", from: 14, to: 30, who: { kind: "app-update", version: "0.31.0" } }),
  E("e8", { at: at(12, 17, 45), key: "snapshots.frequency", from: "every-close", to: "off", who: you }),
  E("e9", { at: at(7, 8, 15), commandId: "go-to-heading", from: "⌘⇧G", to: "⌘⇧O", who: you }),
];

export const wfState = (): SettingsState => ({
  ...emptyState("editorexample"),
  settings: { "editor.proseSize": 18, "editor.focusMode": "paragraph", "readAloud.rate": 1.25, "readAloud.highlight": false, "snapshots.frequency": "off" },
  keys: { "go-to-heading": "⌘⇧O" },
  changes: WF_CHANGES.map((e) => ({ ...e })),
});

export const IMPORT_FILE = "Example Editor Settings 2026-10-17.json";
export const IMPORT_BATCH = "imp1";
const imp: ImportWho = {
  kind: "import", file: IMPORT_FILE, exportedFrom: "Example Mac", exportedAt: "2026-10-17T18:04:00", appVersion: "0.31.2",
  skipped: [{ key: "workspace.folder", reason: "~/Dropbox/Writing is not on this Mac." }],
};
const I = (id: string, o: Omit<ChangeEntry, "id" | "at" | "who" | "batch">): ChangeEntry => E(id, { ...o, at: at(19, 10, 52), who: imp, batch: IMPORT_BATCH });
export const IMPORT_ENTRIES: ChangeEntry[] = [
  I("i1", { key: "editor.proseSize", from: 18, to: 20 }),
  I("i2", { key: "editor.lineWidth", from: "medium", to: "wide" }),
  I("i3", { key: "sounds.typing.enabled", from: true, to: false }),
  I("i4", { key: "snapshots.retention", from: 30, to: 90 }),
  I("i5", { key: "agent.thinkingLevel", from: "medium", to: "high" }),
  I("i6", { commandId: "typewriter-mode", from: "⌘T", to: "⌘⌃T" }),
];

/** The state right after the import in the mockup's frame 15. */
export const wfStateAfterImport = (): SettingsState => {
  const s = wfState();
  return {
    ...s,
    settings: { ...s.settings, "editor.proseSize": 20, "editor.lineWidth": "wide", "sounds.typing.enabled": false, "snapshots.retention": 90, "agent.thinkingLevel": "high" },
    keys: { ...s.keys, "typewriter-mode": "⌘⌃T" },
    changes: [...IMPORT_ENTRIES.map((e) => ({ ...e })), ...s.changes],
  };
};

/** The file the import preview in frame 14 reads, written by the real exporter's format. */
export function wfImportFile(): ExportFile {
  const s = wfState();
  const base = exportFile(s, { appVersion: "0.31.2", hostName: "Example Mac", now: at(17, 18, 4), schema: wfSchema, commands: wfAdapter });
  const settings: ExportFile["settings"] = {
    "editor.proseSize": 20, "editor.lineWidth": "wide", "sounds.typing.enabled": false, "snapshots.retention": 90, "agent.thinkingLevel": "high",
    "workspace.folder": "~/Dropbox/Writing",
  };
  // Eleven more that already match this Mac.
  const same = WF_SETTINGS.filter((d) => d.type !== "secret" && !(d.key in settings) && d.type !== "chord").slice(0, 11);
  for (const d of same) settings[d.key] = (s.settings[d.key] ?? d.default) as string | number | boolean;
  return { ...base, exportedAt: "2026-10-17T18:04:00", settings, keys: { "typewriter-mode": "⌘⌃T" } };
}

export function wfImportPreview(): ImportPreview {
  return previewImport(wfState(), wfImportFile(), { schema: wfSchema, commands: wfAdapter });
}

/* ---------------------------------------------------------------- Example Recorder */

const TW_SETTINGS: SettingDef[] = [
  { key: "clock.amber", label: "Amber warning", section: "presenting", group: "Clock", type: "number", default: 5, min: 1, max: 30, unit: "min", help: "Minutes remaining when the presenter clock turns amber." },
  { key: "clock.darkAmber", label: "Dark-amber warning", section: "presenting", group: "Clock", type: "number", default: 2, min: 1, max: 30, unit: "min", help: "Minutes remaining when the presenter clock turns dark amber." },
  { key: "presenting.statusWhere", label: "Show where I am in the status bar", section: "presenting", group: "Clock", type: "toggle", default: true, help: "Shows the slide number and section in the status bar." },
  { key: "presenting.name", label: "Presenter name", section: "presenting", group: "Presenter identity and deck defaults", type: "text", default: "Dominik Lukeš", help: "Shown on title slides and handouts." },
  { key: "presenting.backupFolder", label: "Backup folder", section: "presenting", group: "Presenter identity and deck defaults", type: "path", default: "~/Talks/Backups", help: "Where presentation backups are saved." },
  { key: "publishing.project", label: "Pages project", section: "publishing", group: "Cloudflare Pages", type: "text", default: "talks-dl", help: "The Cloudflare Pages project talks are published to." },
  { key: "publishing.domain", label: "Custom domain", section: "publishing", group: "Cloudflare Pages", type: "text", default: "talks.dlnet.com", help: "Optional domain for published talks." },
  { key: "publishing.shortUrls", label: "Short URLs", section: "publishing", group: "Cloudflare Pages", type: "toggle", default: false, help: "Share short links instead of links with the talk name." },
  { key: "recording.endpoint", label: "Endpoint", section: "recording", group: "Recording storage", type: "text", default: "https://r2.example.com", help: "S3-compatible storage for recordings." },
  { key: "recording.bucket", label: "Bucket", section: "recording", group: "Recording storage", type: "text", default: "talk-recordings", help: "Bucket name." },
  { key: "accounts.recording", label: "Access keys", section: "recording", group: "Recording storage", type: "secret", default: null, help: "Saved in Keychain." },
  { key: "recording.autoDiscard", label: "Auto-discard under", section: "recording", group: "Recording storage", type: "number", default: 20, min: 0, max: 120, unit: "s", help: "Recordings shorter than this are dropped as accidental starts." },
];

export const twSchema = defineSchema({
  app: "recorderexample",
  sections: [
    { id: "presenting", label: "Presenting", icon: "presentation" },
    { id: "publishing", label: "Publishing", icon: "send" },
    { id: "recording", label: "Recording", icon: "mic" },
  ],
  settings: TW_SETTINGS,
});
export const twRegistry = defineRegistry<"Present">([{ id: "start-show", group: "Present", label: "Start the show", key: "⌘⇧R", icon: "play" }]);
export const twState = (): SettingsState => ({
  ...emptyState("recorderexample"),
  settings: { "clock.darkAmber": 1, "publishing.shortUrls": true },
  changes: [
    E("t1", { at: at(16, 13, 10), key: "clock.darkAmber", from: 2, to: 1, who: you }),
    E("t2", { at: at(13, 15, 30), key: "publishing.shortUrls", from: false, to: true, who: agent("Claude Code") }),
    E("t3", { at: at(5, 9, 0), key: "clock.amber", from: 3, to: 5, who: { kind: "app-update", version: "0.40.0" } }),
  ],
});
export const twHints: Record<string, RowHint> = {
  "clock.amber": { summary: "Minutes remaining when the clock turns amber." },
  "clock.darkAmber": { summary: "Minutes remaining when the clock turns dark amber." },
};

/* ---------------------------------------------------------------- slots */

export const wfSlots = (speech: "connected" | "problem" = "connected"): Slot[] => [
  { id: "accounts.anthropic", label: "Anthropic", kind: "account", status: "connected", detail: "Signed in · plan subscription", group: "Model provider", icon: "bot" },
  {
    id: "accounts.readwise", label: "Readwise", status: "missing", group: "Services", icon: "book-marked",
    usedBy: [{ area: "Library", what: "Import highlights" }, { area: "Reading Room", what: "Show highlights" }],
    history: [{ text: "Key removed", who: "you", at: "Tue 6 Oct" }],
  },
  { id: "accounts.speech", label: "Speech service", status: speech, group: "Services", icon: "audio-lines", ...(speech === "problem" ? { detail: "Key rejected by the service." } : { detail: "Key saved" }) },
];
