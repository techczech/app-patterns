/**
 * The changelog: one entry per setting or shortcut changed, with who changed it (invariant 3). Newest first, at most 300 entries,
 * and the cap never splits a batch (an import, a section reset, a migration).
 */
import type { SettingValue } from "./schema.ts";

/**
 * Someone who acts through the window, the CLI or the app itself: you, an agent, or the app applying settings because its version
 * changed (a re-migration on update). The loader's own entries are `app-update` too.
 */
export type Actor = { kind: "you" } | { kind: "agent"; name: string } | { kind: "app-update"; version: string };

export interface SkippedItem {
  key?: string;
  commandId?: string;
  reason: string;
}

export interface ImportWho {
  kind: "import";
  /** The file's name as picked ("Example Editor Settings 2026-10-17.json"). */
  file: string;
  /** From the file: which Mac and app version exported it, and when (ISO). Shown on the import batch. */
  exportedFrom?: string;
  exportedAt?: string;
  appVersion?: string;
  /** Settings in the file that were not imported, with why. */
  skipped?: SkippedItem[];
  /** Who ran the import (an agent through the CLI); absent = you. */
  by?: Actor;
}

export type Who =
  | Actor
  | ImportWho
  /** Reset of one entry, or Undo of a batch (one reset per entry put back). `by` is who pressed it; absent = you. */
  | { kind: "reset"; of: string; by?: Actor };

/** Marks the entry the loader writes when a saved value was not valid (the bad value itself is never logged). */
export const INVALID_SAVED_VALUE = "INVALID_SAVED_VALUE";
/**
 * Notes of the loader's summary entries. When one load repairs more than `REPAIR_SUMMARY_LIMIT` values of one kind, it writes one entry
 * for that kind instead of one per value: `key: CHANGELOG_KEY`, `from` = how many were reset to their default, `to: null`.
 */
export const INVALID_SAVED_SETTINGS = "INVALID_SAVED_SETTINGS";
export const INVALID_SAVED_SHORTCUTS = "INVALID_SAVED_SHORTCUTS";
export const REPAIR_SUMMARY_LIMIT = 20;
export type Note = typeof INVALID_SAVED_VALUE | typeof INVALID_SAVED_SETTINGS | typeof INVALID_SAVED_SHORTCUTS;
const NOTES: readonly string[] = [INVALID_SAVED_VALUE, INVALID_SAVED_SETTINGS, INVALID_SAVED_SHORTCUTS];
export const isSummaryNote = (n: Note | undefined): n is typeof INVALID_SAVED_SETTINGS | typeof INVALID_SAVED_SHORTCUTS =>
  n === INVALID_SAVED_SETTINGS || n === INVALID_SAVED_SHORTCUTS;
/** A summary's targets as written: bounded ids, no repeats, sorted. */
export const sortedTargets = (ids: Iterable<unknown>): string[] =>
  [...new Set([...ids].filter((x): x is string => typeof x === "string" && x.length > 0 && x.length <= LIMITS.id))].sort();

/**
 * Where a value came from: `import` (an import file) or `local` (typed here, by you or an agent, a migration, or a default). An entry
 * written before origins were recorded has none: its values' origin is unknown, and the operations treat unknown as possibly imported.
 */
export type ValueOrigin = "import" | "local";
const ORIGINS: readonly string[] = ["import", "local"];

export interface ChangeEntry {
  id: string;
  /** ms since 1970. */
  at: number;
  /** A setting key, or `commandId` for a shortcut; exactly one is present. */
  key?: string;
  commandId?: string;
  /** Values before and after. For a shortcut: the effective chord ("" = none). `null` = no valid value (an invalid saved value, or "the command's default" when the default is not known). */
  from: SettingValue | null;
  to: SettingValue | null;
  who: Who;
  /** Origin of `from` (the value this entry replaced) and of `to`. Absent: unknown (an entry from before origins were recorded). */
  fromOrigin?: ValueOrigin;
  toOrigin?: ValueOrigin;
  /** Shared by every entry written by one operation that changed more than one thing, and by every import. */
  batch?: string;
  /** Marks an entry the loader wrote; such an entry has nothing valid to put back. */
  note?: Note;
  /**
   * Only on a loader summary (`INVALID_SAVED_SETTINGS`, `INVALID_SAVED_SHORTCUTS`): the setting keys or command ids it reset, sorted.
   * Undo counts each as touched by this entry.
   */
  targets?: string[];
}

export const MAX_CHANGES = 300;

/**
 * What an entry about a key (a `secret` setting) may hold as `from` and `to`: whether a key was saved, never any part of it. Such an
 * entry is written only by `recordSecret`: who is you, an agent or an app update, no batch, no note.
 */
export const SECRET_STATUSES = ["connected", "missing"] as const;
export type SecretStatus = (typeof SECRET_STATUSES)[number];
export const isSecretStatus = (v: unknown): v is SecretStatus => v === "connected" || v === "missing";
/** Whether an entry about a key holds only what `recordSecret` writes. */
export const isSecretEntry = (e: ChangeEntry): boolean =>
  e.key !== undefined && e.commandId === undefined && isSecretStatus(e.from) && isSecretStatus(e.to) &&
  (e.who.kind === "you" || e.who.kind === "agent" || e.who.kind === "app-update") && e.batch === undefined && e.note === undefined && e.targets === undefined &&
  e.fromOrigin === undefined && e.toOrigin === undefined;

/** The filter groups of the Changes page. A reset counts for whoever pressed it. */
export type ActorKind = "you" | "agent" | "app-update" | "import";
export function actorOf(who: Who): ActorKind {
  if (who.kind === "reset") return who.by?.kind ?? "you";
  return who.kind;
}

/** Length limits the loader enforces; writers bound to the same limits so whatever they write reads back unchanged. */
export const LIMITS = { id: 200, name: 200, file: 1024, text: 4096, skipped: 50 } as const;

/** Cuts a string to `max` characters. */
export const bound = (s: string, max: number): string => (s.length <= max ? s : s.slice(0, max));

/** An actor with its name bounded, for writing. */
export function boundActor(a: Actor): Actor {
  if (a.kind === "agent") return { kind: "agent", name: bound(a.name, LIMITS.name) };
  if (a.kind === "app-update") return { kind: "app-update", version: bound(String(a.version), LIMITS.name) };
  return { kind: "you" };
}

/** Groups of entries that must stay together: a batch, or a single entry. In list order (newest first). */
export function groupsOf(list: readonly ChangeEntry[]): ChangeEntry[][] {
  const groups = new Map<string, ChangeEntry[]>();
  list.forEach((e, i) => {
    const g = e.batch !== undefined ? `b:${e.batch}` : `e:${i}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g)!.push(e);
  });
  return [...groups.values()];
}

/**
 * Keeps the newest entries up to `cap`, dropping the oldest. A batch is kept whole or dropped whole. A batch larger than the cap is never
 * kept (operations refuse to write one; the loader drops one and logs that it did).
 */
export function capChanges(list: readonly ChangeEntry[], cap = MAX_CHANGES): ChangeEntry[] {
  if (list.length <= cap) return [...list];
  const out: ChangeEntry[] = [];
  for (const g of groupsOf(list)) {
    if (g.length > cap) continue;
    if (out.length + g.length > cap) break;
    out.push(...g);
  }
  return out;
}

const isStr = (v: unknown, max: number = LIMITS.text): v is string => typeof v === "string" && v.length <= max;
const isValue = (v: unknown): v is SettingValue | null => v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || isStr(v);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function readActor(v: unknown): Actor | null {
  if (!isObj(v)) return null;
  if (v.kind === "you") return { kind: "you" };
  if (v.kind === "agent" && isStr(v.name, LIMITS.name)) return { kind: "agent", name: v.name };
  if (v.kind === "app-update" && isStr(v.version, LIMITS.name)) return { kind: "app-update", version: v.version };
  return null;
}

function readSkipped(v: unknown): SkippedItem | null {
  if (!isObj(v) || !isStr(v.reason)) return null;
  if (isStr(v.key, LIMITS.id) && v.commandId === undefined) return { key: v.key, reason: v.reason };
  if (isStr(v.commandId, LIMITS.id) && v.key === undefined) return { commandId: v.commandId, reason: v.reason };
  return null;
}

/** Rebuilds a `who` from its known fields only; null when it is not one. */
function readWho(v: unknown): Who | null {
  const actor = readActor(v);
  if (actor) return actor;
  if (!isObj(v)) return null;
  switch (v.kind) {
    case "reset": {
      if (!isStr(v.of, LIMITS.id)) return null;
      if (v.by === undefined) return { kind: "reset", of: v.of };
      const by = readActor(v.by);
      return by ? { kind: "reset", of: v.of, by } : null;
    }
    case "import": {
      if (!isStr(v.file, LIMITS.file)) return null;
      const w: ImportWho = { kind: "import", file: v.file };
      for (const f of ["exportedFrom", "exportedAt", "appVersion"] as const) {
        const x = v[f];
        if (x === undefined) continue;
        if (!isStr(x, LIMITS.name)) return null;
        w[f] = x;
      }
      if (v.skipped !== undefined) {
        if (!Array.isArray(v.skipped) || v.skipped.length > LIMITS.skipped) return null;
        const items = v.skipped.map(readSkipped);
        if (items.some((x) => x === null)) return null;
        w.skipped = items as SkippedItem[];
      }
      if (v.by !== undefined) {
        const by = readActor(v.by);
        if (!by) return null;
        w.by = by;
      }
      return w;
    }
    default:
      return null;
  }
}

/** Rebuilds an entry read from a file from its known fields only (unknown properties at any level are dropped); null when it is not one. */
export function readEntry(v: unknown): ChangeEntry | null {
  if (!isObj(v)) return null;
  if (!isStr(v.id, LIMITS.id) || typeof v.at !== "number" || !Number.isFinite(v.at)) return null;
  const hasKey = v.key !== undefined;
  if (hasKey === (v.commandId !== undefined)) return null;
  if (hasKey ? !isStr(v.key, LIMITS.id) : !isStr(v.commandId, LIMITS.id)) return null;
  if (!isValue(v.from) || !isValue(v.to)) return null;
  const who = readWho(v.who);
  if (!who) return null;
  if (v.batch !== undefined && !isStr(v.batch, LIMITS.id)) return null;
  if (v.note !== undefined && !NOTES.includes(v.note as string)) return null;
  if (v.fromOrigin !== undefined && !ORIGINS.includes(v.fromOrigin as string)) return null;
  if (v.toOrigin !== undefined && !ORIGINS.includes(v.toOrigin as string)) return null;
  const e: ChangeEntry = { id: v.id, at: v.at, ...(hasKey ? { key: v.key as string } : { commandId: v.commandId as string }), from: v.from, to: v.to, who };
  if (v.fromOrigin !== undefined) e.fromOrigin = v.fromOrigin as ValueOrigin;
  if (v.toOrigin !== undefined) e.toOrigin = v.toOrigin as ValueOrigin;
  if (v.batch !== undefined) e.batch = v.batch as string;
  if (v.note !== undefined) e.note = v.note as Note;
  if (isSummaryNote(e.note) && Array.isArray(v.targets)) e.targets = sortedTargets(v.targets);
  return e;
}

/** Whether a value read from a file is a well-formed entry. */
export const isChangeEntry = (v: unknown): v is ChangeEntry => readEntry(v) !== null;

/**
 * The key of the loader's entry saying part of the saved changelog was dropped (a batch larger than the cap). Reserved: no setting may
 * use it. The entry has `note: INVALID_SAVED_VALUE`, `from` = the number of entries dropped, `to: null`.
 * The loader's summary entries (`INVALID_SAVED_SETTINGS`, `INVALID_SAVED_SHORTCUTS`) use the same key and shape.
 */
export const CHANGELOG_KEY = "changes";
