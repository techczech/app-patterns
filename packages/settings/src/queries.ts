/**
 * Read-only views over the state for the window's frames and the CLI: one setting's history, the Changes filters and their counts, an
 * import batch, new entries since a time, and search.
 */
import { actorOf, type ActorKind, type ChangeEntry, type ImportWho, type SkippedItem, type Who } from "./changes.ts";
import type { Section, SettingDef } from "./schema.ts";
import type { SettingsState, Target } from "./state.ts";

const matches = (e: ChangeEntry, t: string | Target): boolean =>
  typeof t === "string" ? e.key === t : "key" in t ? e.key === t.key : e.commandId === t.commandId;

/** Every entry for one setting (a key) or shortcut (`{ commandId }`), newest first: the inspector's "History of this setting". */
export function historyOf(state: SettingsState, target: string | Target): ChangeEntry[] {
  return state.changes.filter((e) => matches(e, target));
}

/** The newest entry for a setting or shortcut: the inspector's "Changed by". */
export function lastChange(state: SettingsState, target: string | Target): ChangeEntry | undefined {
  return state.changes.find((e) => matches(e, target));
}

export type ChangeFilter = "all" | ActorKind;

export interface ChangeCounts {
  all: number;
  you: number;
  agent: number;
  "app-update": number;
  import: number;
}

/** The numbers on the Changes filters All / You / Agents / App updates / Imports. */
export function changeCounts(state: SettingsState): ChangeCounts {
  const c: ChangeCounts = { all: 0, you: 0, agent: 0, "app-update": 0, import: 0 };
  for (const e of state.changes) {
    c.all++;
    c[actorOf(e.who)]++;
  }
  return c;
}

/**
 * The Changes list for a filter and the filter field's text. Text matches the setting's key or label, or the command id, or the agent
 * name or import file; `labelOf` lets the host add command labels.
 */
export function filterChanges(
  state: SettingsState,
  opts: { who?: ChangeFilter; text?: string; settings?: readonly SettingDef[]; labelOf?(e: ChangeEntry): string | undefined } = {},
): ChangeEntry[] {
  const words = (opts.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const labels = new Map((opts.settings ?? []).map((d) => [d.key, d.label]));
  return state.changes.filter((e) => {
    if (opts.who && opts.who !== "all" && actorOf(e.who) !== opts.who) return false;
    if (words.length === 0) return true;
    const hay = [e.key, e.commandId, e.key !== undefined ? labels.get(e.key) : undefined, opts.labelOf?.(e), whoText(e.who)].filter(Boolean).join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

function whoText(who: Who): string {
  switch (who.kind) {
    case "agent":
      return who.name;
    case "import":
      return who.file;
    case "app-update":
      return who.version;
    case "reset":
      return who.by?.kind === "agent" ? who.by.name : "";
    default:
      return "";
  }
}

/** Entries newer than `seenAt` (ms): the "N new" badge on Changes. */
export function newSince(state: SettingsState, seenAt: number): number {
  return state.changes.filter((e) => e.at > seenAt).length;
}

export interface BatchInfo {
  id: string;
  /** When the batch was written (its newest entry). */
  at: number;
  who: Who;
  /** Newest first. */
  entries: ChangeEntry[];
  /** For an import batch. */
  import?: ImportWho;
  skipped: SkippedItem[];
}

/** One batch, for the import card and its inspector (file, Mac, when exported, counts, skipped). */
export function batchOf(state: SettingsState, batchId: string): BatchInfo | undefined {
  const entries = state.changes.filter((e) => e.batch === batchId);
  const first = entries[0];
  if (!first) return undefined;
  const imp = first.who.kind === "import" ? first.who : undefined;
  return { id: batchId, at: first.at, who: first.who, entries, ...(imp ? { import: imp } : {}), skipped: imp?.skipped ?? [] };
}

/** The newest import batch: `undo-import --last`. */
export function lastImportBatch(state: SettingsState): string | undefined {
  return state.changes.find((e) => e.who.kind === "import" && e.batch !== undefined)?.batch;
}

export interface SearchHit {
  key: string;
  label: string;
  section: string;
  sectionLabel: string;
  group?: string;
}

/**
 * Settings whose label, help line, group or section label contain every word typed; in sidebar order, then declared order.
 * Secrets are found too (their row says whether a key is saved).
 */
export function searchSettings(settings: readonly SettingDef[], sections: readonly Section[], query: string): SearchHit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const sectionLabel = new Map(sections.map((s) => [s.id, s.label]));
  const order = new Map(sections.map((s, i) => [s.id, i]));
  const hits: (SearchHit & { i: number })[] = [];
  settings.forEach((d, i) => {
    const sl = sectionLabel.get(d.section) ?? d.section;
    const hay = `${d.label} ${d.help ?? ""} ${d.group ?? ""} ${sl}`.toLowerCase();
    if (words.every((w) => hay.includes(w))) hits.push({ key: d.key, label: d.label, section: d.section, sectionLabel: sl, ...(d.group ? { group: d.group } : {}), i });
  });
  hits.sort((a, b) => (order.get(a.section) ?? 1e9) - (order.get(b.section) ?? 1e9) || a.i - b.i);
  return hits.map(({ i: _i, ...h }) => h);
}
