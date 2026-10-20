/**
 * One app's settings, kept in `<dir>/settings.json`. Holds an in-memory view for the window, but never writes from it: every change takes
 * the file's lock, reads the file again, applies the pure operation to what is on disk, writes atomically and unlocks (invariant 4), so a
 * stale view can never overwrite a newer file. The folder is watched (`fs.watch` on the folder, so a file replaced by rename is seen too);
 * 100 ms after the last event the file is read again and `onChange` is called when it differs (invariant 6). On opening, the watcher is
 * installed before the first read, and one more read follows once it is running, so a change made while opening is not missed.
 *
 * A damaged file (not JSON, too large, a top level that is not an object, JSON `null`) is set aside as `.damaged-<timestamp>`, defaults
 * are loaded, and one changelog entry records it (invariant 7). A file of another app, or from a newer version, is left as it is and
 * changes are refused.
 */
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, watch, type FSWatcher } from "node:fs";
import { basename, join } from "node:path";
import { CHANGELOG_KEY, groupsOf, INVALID_SAVED_VALUE, type Actor, type ChangeEntry, type SecretStatus } from "../changes.ts";
import type { CommandsAdapter } from "../keys.ts";
import { loadState, type LoadProblem, type Migrated } from "../load.ts";
import { rebind, rebindMany, recordSecret, reset, resetAll, resetEntry, resetSection, resetShortcuts, set, undoBatch, type UndoResult } from "../operations.ts";
import type { Schema } from "../schema.ts";
import { emptyState, type OpContext, type OpErrorCode, type OpResult, type SettingsState } from "../state.ts";
import { applyImport, exportFile, previewImport, type ExportFile, type ImportPreview } from "../transfer.ts";
import type { ApplyEnv } from "../schema.ts";
import { MAX_FILE_BYTES, SettingsFile, type FileErrorCode, type FileMessages, type FileRead, type SettingsFileTestHooks } from "./settings-file.ts";
import type { LockOptions } from "./lock.ts";
import { judgeWrite, stateProblem, type BeforeWrite, type WriteRoute } from "../write-check.ts";

export const SETTINGS_FILE_NAME = "settings.json";
export const WATCH_DEBOUNCE_MS = 100;
export const WATCH_MAX_WAIT_MS = 500;

export interface SettingsStoreOptions {
  /** The app's data folder; the file is `<dir>/settings.json` (or `fileName`). */
  dir: string;
  /** Must equal `schema.app`. */
  app: string;
  schema: Schema;
  /** The app's command registry, through `commandsAdapter(registry)`. */
  registry: CommandsAdapter;
  /** The running app's version, for the loader's own entries (`who: app-update`). */
  appVersion: string;
  migrate?(old: unknown): Migrated | null;
  /** Called with the new state after every change, own or from outside. */
  onChange?(state: SettingsState): void;
  /**
   * Who this store's changes are logged as: default you; the CLI passes the agent; an app re-applying settings because its version
   * changed passes `{ kind: "app-update", version }`.
   */
  who?: Actor;
  /**
   * The app's rule over a whole write (see `WriteProposal`): runs once per write, under the lock, for every route (set, rebind, reset,
   * undo, import, a key's record, a migration); `{ reject: reason }` refuses it, nothing is written, and the caller gets code
   * `rejected` with the reason. A refusal ends the write: nothing of it is written, and the rule is not asked again. Never run for the
   * loader's pure repairs (route `repair`: invalid values back to default, a damaged file set aside, a secret removed from the file): they
   * only remove or default values and must not be vetoed. A migration is never a repair: it is always judged. While the rule refuses a
   * migration, nothing migrated is shown: the view is the defaults and `problem()` is `{ code: "rejected", error: reason }`.
   */
  beforeWrite?: BeforeWrite;
  /** The folder the settings folder must resolve to (default `dir`). */
  root?: string;
  fileName?: string;
  /** Watch the folder for outside changes (default true; the CLI turns it off). */
  watch?: boolean;
  lock?: LockOptions;
  messages?: Partial<FileMessages & StoreMessages>;
  /** One plain line per thing worth knowing (a damaged file set aside, values dropped). Default console.warn. */
  log?(line: string): void;
  now?(): number;
  newId?(): string;
  maxBytes?: number;
  /** Test seams in the file layer. Not for apps. */
  testHooks?: SettingsFileTestHooks;
}

export interface StoreMessages {
  otherApp: string;
  newerVersion: string;
}

const DEFAULT_STORE_MESSAGES: StoreMessages = {
  otherApp: "The settings file belongs to another app, so it is left as it is and changes are not saved",
  newerVersion: "The settings file was written by a newer version of the app; update the app before changing settings",
};

/** `rejected`: the app's `beforeWrite` rule refused the write; the error is its reason. */
export type StoreErrorCode = OpErrorCode | FileErrorCode | "rejected";
/**
 * Why the file may not be used: another app's, a newer version's, a link / outside the root, or a damaged file that could not be set
 * aside. `rejected`: the app's `beforeWrite` rule refused to migrate the legacy file; it stays on disk, the view is the defaults, and
 * changes may still be made (each one carries the migration and is judged with it).
 */
export type StoreProblem = LoadProblem | "refused" | "unarchived" | "rejected";
/** The store's write routes: the app's (judged by `beforeWrite`) and `repair`, the loader's pure repairs, which never are. */
type StoreRoute = WriteRoute | "repair";
export type StoreResult = { ok: true; state: SettingsState; entries: ChangeEntry[]; batch?: string } | { ok: false; code: StoreErrorCode; error: string };
export type StoreUndoResult = UndoResult | { ok: false; code: StoreErrorCode; error: string; skipped?: undefined };

interface Loaded {
  state: SettingsState;
  /** The loader's entries: non-empty means the file should be written back. */
  entries: ChangeEntry[];
  problem?: StoreProblem;
  error?: string;
  damaged?: boolean;
  /** A legacy file the migrate hook read: always written back as v2 (whatever it held is not left on disk). */
  migrated?: boolean;
  /** The load was lossy: the file holds something the loader left out or changed (maybe a secret, under any name), so it is written back. */
  purge?: boolean;
}

const lstatOrNull = (p: string) => {
  try {
    return lstatSync(p);
  } catch {
    return null;
  }
};

const isObject = (v: unknown): boolean => v !== null && typeof v === "object" && !Array.isArray(v);

/** Same order of keys every time, for comparing two states. */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

export class SettingsStore {
  readonly file: SettingsFile;
  readonly ready: Promise<void>;
  private state: SettingsState;
  private problemNow: StoreProblem | undefined;
  private refusedError: string | undefined;
  private readonly ctx: OpContext & { appVersion: string };
  private readonly msg: StoreMessages;
  private readonly log: (line: string) => void;
  private watcher: FSWatcher | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closedForGood = false;
  private lastDropped: string | undefined;
  private lastRejected: string | undefined;
  private firstEventAt = 0;

  constructor(private readonly opts: SettingsStoreOptions) {
    if (opts.app !== opts.schema.app) throw new Error(`SettingsStore: app "${opts.app}" does not match the schema's app "${opts.schema.app}"`);
    const now = opts.now ?? Date.now;
    this.file = new SettingsFile(join(opts.dir, opts.fileName ?? SETTINGS_FILE_NAME), {
      root: opts.root ?? opts.dir, maxBytes: opts.maxBytes ?? MAX_FILE_BYTES, lock: opts.lock, messages: opts.messages, now,
      accept: (raw) => isObject(raw) && loadState(raw, this.probeCtx()).problem !== "not-settings",
      ...(opts.testHooks ? { testHooks: opts.testHooks } : {}),
    });
    this.msg = { ...DEFAULT_STORE_MESSAGES, ...opts.messages };
    this.log = opts.log ?? ((l) => console.warn(l));
    this.ctx = { schema: opts.schema, commands: opts.registry, who: opts.who ?? { kind: "you" }, now, newId: opts.newId ?? randomUUID, appVersion: opts.appVersion };
    this.state = emptyState(opts.app);
    this.ready = this.open();
  }

  private async open(): Promise<void> {
    const watching = this.opts.watch !== false;
    if (watching) this.startWatch(); // first, so a change made after the read below is seen
    await this.file.sweep();
    await this.reloadNow(true);
    if (watching) this.schedule(); // and one more read once the watcher runs: a change between installing it and its first event
  }

  /** The state as last read or written. */
  view(): SettingsState {
    return this.state;
  }

  /**
   * Why changes are refused: the file is another app's, from a newer version, a link / outside the root, or damaged and could not be
   * set aside (`unarchived`: the view is the defaults, but nothing reads or writes the file until it can be set aside).
   */
  problem(): { code: StoreProblem; error: string } | undefined {
    if (!this.problemNow) return undefined;
    const error =
      this.problemNow === "other-app" ? this.msg.otherApp
      : this.problemNow === "newer-version" ? this.msg.newerVersion
      : this.problemNow === "unarchived" ? this.file.messages.unarchived
      : (this.refusedError ?? "");
    return { code: this.problemNow, error };
  }

  get path(): string {
    return this.file.path;
  }

  // ---- operations: each one is lock → re-read → pure operation → write → unlock --------------------------------------------------

  set(key: string, value: unknown): Promise<StoreResult> {
    return this.mutate("set", (s) => set(s, key, value, this.ctx));
  }

  rebind(commandId: string, chord: string): Promise<StoreResult> {
    return this.mutate("rebind", (s) => rebind(s, commandId, chord, this.ctx));
  }

  rebindMany(pairs: readonly { commandId: string; chord: string }[]): Promise<StoreResult> {
    return this.mutate("rebind", (s) => rebindMany(s, pairs, this.ctx));
  }

  reset(target: string | { commandId: string }): Promise<StoreResult> {
    return this.mutate("reset", (s) => reset(s, target, this.ctx));
  }

  resetSection(sectionId: string): Promise<StoreResult> {
    return this.mutate("reset-section", (s) => resetSection(s, sectionId, this.ctx));
  }

  /** Every shortcut override removed, in one batch. */
  resetShortcuts(): Promise<StoreResult> {
    return this.mutate("reset-shortcuts", (s) => resetShortcuts(s, this.ctx));
  }

  resetAll(): Promise<StoreResult> {
    return this.mutate("reset-all", (s) => resetAll(s, this.ctx));
  }

  resetEntry(entryId: string): Promise<StoreResult> {
    return this.mutate("reset-entry", (s) => resetEntry(s, entryId, this.ctx));
  }

  /**
   * Logs a key saved, replaced or removed in Accounts and keys (the key itself is kept by the app's key slots, never here): one entry
   * with who, `from` / `to` "connected" or "missing".
   */
  recordSecret(key: string, from: SecretStatus, to: SecretStatus): Promise<StoreResult> {
    return this.mutate("record-secret", (s) => recordSecret(s, key, from, to, this.ctx));
  }

  /** Undo import (or any batch). `skipped` lists what was changed again since and is kept. */
  async undoBatch(batchId: string): Promise<StoreUndoResult> {
    let undo: UndoResult | undefined;
    const r = await this.mutate("undo", (s) => (undo = undoBatch(s, batchId, this.ctx)));
    if (!undo) return r.ok ? { ok: false, code: "unwritten", error: this.file.messages.unwritten } : { ok: false, code: r.code, error: r.error };
    if (!undo.ok) return undo;
    if (!r.ok) return { ok: false, code: r.code, error: r.error };
    return { ...undo, state: r.state };
  }

  /** What importing `file` (text or parsed JSON) would do, judged against the view. Apply it with `applyImport`. */
  previewImport(file: unknown, apply?: ApplyEnv): ImportPreview {
    return previewImport(this.state, file, { schema: this.opts.schema, commands: this.opts.registry, ...(apply ? { apply } : {}) });
  }

  /** Applies a preview to the file as it is on disk now (values checked again; the batch logs what really changes). */
  applyImport(preview: ImportPreview, opts: { file: string }): Promise<StoreResult> {
    const by = this.ctx.who.kind === "you" ? undefined : this.ctx.who;
    return this.mutate("import", (s) => applyImport(s, preview, opts, { ...this.ctx, ...(by ? { by } : {}) }));
  }

  /** The export file for the view. Never holds a secret. */
  exportFile(opts: { hostName: string }): ExportFile {
    return exportFile(this.state, { appVersion: this.ctx.appVersion, hostName: opts.hostName, now: this.ctx.now(), schema: this.opts.schema, commands: this.opts.registry });
  }

  /** Reads the file again now (what the watcher does after its debounce). */
  reload(): Promise<void> {
    return this.reloadNow(true);
  }

  /** Quitting: every later change is refused with `reason`. */
  refuseWrites(reason?: string): void {
    this.file.refuseWrites(reason);
  }

  pending(): number {
    return this.file.pending();
  }

  flushWithin(ms: number): Promise<boolean> {
    return this.file.flushWithin(ms);
  }

  /** Stops watching and waits for queued writes. */
  async close(): Promise<void> {
    this.closedForGood = true;
    if (this.timer) clearTimeout(this.timer);
    this.watcher?.close();
    this.watcher = undefined;
    await this.ready.catch(() => undefined);
    await this.file.flush();
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------------

  /** Reads the raw file into a state; the entries are the loader's (non-empty means the file should be written back). */
  private loadFrom(read: FileRead): Loaded {
    if (read.kind === "refused") return { state: emptyState(this.opts.app), entries: [], problem: "refused", error: read.error };
    if (read.kind === "missing") return { state: emptyState(this.opts.app), entries: [] };
    if (read.kind === "damaged") return { ...this.damagedState(), damaged: true };
    const r = loadState(read.raw, { ...this.ctx, ...(this.opts.migrate ? { migrate: this.opts.migrate } : {}) });
    if (r.dropped.length) {
      const line = `Settings: left out of ${this.file.path}: ${r.dropped.slice(0, 20).join(", ")}${r.dropped.length > 20 ? ` and ${r.dropped.length - 20} more` : ""}`;
      if (line !== this.lastDropped) this.log(line); // once, not on every reload
      this.lastDropped = line;
    }
    if (r.problem === "not-settings") return { ...this.damagedState(), damaged: true };
    if (r.problem) return { state: r.state, entries: [], problem: r.problem };
    return { state: r.state, entries: r.entries, ...(r.migrated ? { migrated: true } : {}), ...(r.lossy ? { purge: true } : {}) };
  }

  /** Defaults, with one entry saying the file was damaged and set aside (`key: "changes"`, `from: null`, `to: null`, `note: INVALID_SAVED_VALUE`). */
  private damagedState(): { state: SettingsState; entries: ChangeEntry[] } {
    const entry: ChangeEntry = {
      id: this.ctx.newId(), at: this.ctx.now(), key: CHANGELOG_KEY, from: null, to: null,
      who: { kind: "app-update", version: this.ctx.appVersion.slice(0, 200) }, note: INVALID_SAVED_VALUE,
    };
    return { state: { ...emptyState(this.opts.app), changes: [entry] }, entries: [entry] };
  }

  /** Puts `next` in memory and tells the window when it differs from what it had. */
  private adopt(next: Loaded): void {
    this.problemNow = next.problem;
    this.refusedError = next.error;
    const changed = canon(next.state) !== canon(this.state);
    this.state = next.state;
    if (changed) this.opts.onChange?.(next.state);
  }

  /** Cuts the oldest history, never a batch and never the newest `keep` entries, until the file fits under the size cap. */
  private fitted(state: SettingsState, keep: number): SettingsState {
    const max = this.opts.maxBytes ?? MAX_FILE_BYTES;
    const size = (s: SettingsState) => Buffer.byteLength(JSON.stringify(s, null, 2) + "\n", "utf8");
    if (size(state) <= max) return state;
    const groups = groupsOf(state.changes);
    let changes = state.changes;
    while (groups.length > 0) {
      const g = groups.pop()!;
      const next = changes.slice(0, changes.length - g.length);
      if (next.length < keep) break;
      changes = next;
      if (size({ ...state, changes }) <= max) {
        this.log(`Settings: the oldest ${state.changes.length - changes.length} changes were dropped to keep ${this.file.path} under ${max} bytes`);
        return { ...state, changes };
      }
    }
    return state; // still too large: the file layer refuses the write
  }

  private writeProblem(l: Loaded): { code: FileErrorCode; error: string } | null {
    if (l.problem === "other-app") return { code: "refused", error: this.msg.otherApp };
    if (l.problem === "newer-version") return { code: "refused", error: this.msg.newerVersion };
    if (l.problem === "refused") return { code: "refused", error: l.error ?? this.file.messages.linked };
    return null;
  }

  private mutate(route: WriteRoute, op: (s: SettingsState) => OpResult): Promise<StoreResult> {
    return this.ready.then(() => this.mutateNow(route, op, false));
  }

  /**
   * Why a proposed write may not happen, or null. The app's `beforeWrite` runs first, on every route but `repair` (the loader's pure
   * repairs are never put to it), then the whole state is checked against the schema and the registry, whatever the rule said.
   */
  private judge(route: StoreRoute, who: Actor, before: SettingsState, next: SettingsState, entries: readonly ChangeEntry[]): { code: StoreErrorCode; error: string } | null {
    const hook = this.opts.beforeWrite;
    if (hook && route !== "repair") {
      const why = judgeWrite(hook, { route, who, before, next, entries }, this.log);
      if (why !== null) return { code: "rejected", error: why };
    }
    const bad = stateProblem(next, this.opts.schema, this.opts.registry);
    return bad === null ? null : { code: "invalid-value", error: bad };
  }

  /**
   * Lock → read → `op` on what is on disk → write → unlock. The write the operation makes is judged once. When it is refused, nothing of
   * it is written and there is no second try: a migration riding on it is not written either (nor shown), while a pure repair the
   * loader made (never judged) is still written, so a refused change cannot keep a secret or a damaged file on disk. When the operation
   * itself changes nothing or fails, the loader's write goes alone: a migration judged as route `migration` (who: the app update), a
   * pure repair as route `repair`, never judged. `force` writes the state read even when nothing changed (to drop a secret).
   */
  private async mutateNow(route: WriteRoute, op: (s: SettingsState) => OpResult, force: boolean): Promise<StoreResult> {
    let outcome: StoreResult | undefined;
    let before: Loaded | undefined;
    let after: Loaded | undefined;
    const r = await this.file.update((read) => {
      const loaded = this.loadFrom(read);
      if (loaded.damaged) this.log(`Settings: ${this.file.path} could not be read; it was set aside${read.kind === "damaged" && read.setAside ? ` as ${basename(read.setAside)}` : ""} and the defaults loaded`);
      const migrating = loaded.migrated === true;
      // What the view shows when this write goes nowhere: never a migration the app's rule has not let through.
      before = migrating ? this.unmigrated() : loaded;
      const blocked = this.writeProblem(loaded);
      if (blocked) {
        outcome = { ok: false, ...blocked };
        return { result: undefined };
      }
      const res = op(loaded.state);
      // A pure repair is pending when the loader changed what the file holds: values repaired (its entries) or anything left out.
      const repairing = !migrating && (loaded.entries.length > 0 || loaded.purge === true || force);
      // What the disk holds before this write, as the app's rule sees it: the defaults for a missing, damaged or legacy file.
      const base = migrating || loaded.damaged ? emptyState(this.opts.app) : loaded.state;
      if (res.ok && res.entries.length > 0) {
        const next = this.fitted(res.state, res.entries.length + loaded.entries.length);
        const refused = this.judge(route, this.ctx.who, base, next, [...res.entries, ...loaded.entries]);
        if (!refused) {
          outcome = { ok: true, state: next, entries: res.entries, ...(res.batch !== undefined ? { batch: res.batch } : {}) };
          after = { state: next, entries: [] };
          return { write: next, result: undefined };
        }
        // Refused: the transaction ends here. Nothing judged is written and the rule is not asked again.
        outcome = { ok: false, ...refused };
        if (!repairing) return { result: undefined };
      } else if (!res.ok) {
        outcome = res;
      } else if (!migrating && !repairing) {
        outcome = { ok: true, state: res.state, entries: [], ...(res.batch !== undefined ? { batch: res.batch } : {}) };
        after = { state: res.state, entries: [] };
        return { result: undefined };
      }
      if (!migrating && !repairing) return { result: undefined };
      const loaderState = this.fitted(loaded.state, loaded.entries.length);
      // A migration is never a repair: judged as the app update, whatever it holds (only defaults, or no entries at all).
      const refused = migrating
        ? this.judge("migration", { kind: "app-update", version: this.ctx.appVersion }, emptyState(this.opts.app), loaderState, loaded.entries)
        : this.judge("repair", { kind: "app-update", version: this.ctx.appVersion }, base, loaderState, loaded.entries);
      if (refused) {
        outcome ??= { ok: false, ...refused };
        if (migrating && refused.code === "rejected") {
          after = this.unmigrated(refused.error);
          if (refused.error !== this.lastRejected) this.log(`Settings: the app's rule refused moving ${this.file.path} to this version (${refused.error}); the file is left as it is and the defaults are in use`);
          this.lastRejected = refused.error;
        }
        return { result: undefined };
      }
      this.lastRejected = undefined;
      if (outcome === undefined) {
        outcome = { ok: true, state: loaderState, entries: [] };
        after = { state: loaderState, entries: [] };
      }
      return { write: loaderState, result: undefined };
    });
    if (!r.ok) {
      // A damaged file that could not be set aside: nothing may use it (the CLI refuses every verb; the app sees the problem).
      if (r.problem === "unarchived") this.adopt({ state: emptyState(this.opts.app), entries: [], problem: "unarchived", error: r.error });
      // Nothing reached the disk: the view becomes what was read, never the unsaved change.
      else if (before && r.code !== "locked" && r.code !== "closed") this.adopt(before);
      return { ok: false, code: r.code, error: r.error };
    }
    const seen = after ?? before;
    if (seen) this.adopt(seen);
    return outcome ?? { ok: false, code: "unwritten", error: this.file.messages.unwritten };
  }

  /**
   * The view of a legacy file not (yet) migrated: the defaults and no history, as the disk holds no settings of this version. With
   * `rejected`, the app's rule refused the migration; without it, a refusal already showing stays (the migration was not judged again).
   */
  private unmigrated(rejected?: string): Loaded {
    const why = rejected ?? (this.problemNow === "rejected" ? this.refusedError : undefined);
    return { state: emptyState(this.opts.app), entries: [], ...(why !== undefined ? { problem: "rejected" as const, error: why } : {}) };
  }

  /** Reads the file again; `inOrder` waits behind updates in progress, so an older read never replaces a newer write in memory. */
  private async reloadNow(inOrder: boolean): Promise<void> {
    const read = inOrder ? await this.file.readInOrder() : await this.file.read();
    const need = this.needsRepair(read);
    if (need) {
      const r = await this.mutateNow("migration", (s) => ({ ok: true, state: s, entries: [] }), need === "purge");
      if (r.ok) return;
      if (r.code === "rejected") return; // the app's rule refused the migration: mutateNow showed the defaults and the problem, and logged it
      if (r.code !== "refused" || read.kind === "damaged") this.log(`Settings: ${this.file.path} needs repairing but could not be written: ${r.error}`);
      if (this.problemNow === "unarchived") return; // adopted by mutateNow; the damaged read below would hide it
    }
    const loaded = this.loadFrom(read);
    // A migration that was not written is never shown.
    this.adopt(loaded.migrated ? this.unmigrated() : loaded);
  }

  /** A clock for judging a file without logging anything (its entries are thrown away). */
  private probeCtx() {
    return { ...this.ctx, ...(this.opts.migrate ? { migrate: this.opts.migrate } : {}), now: () => 0, newId: () => "probe" };
  }

  /** Whether a file needs writing back: damaged, values the loader repaired, or anything it left out (a lossy load). */
  private needsRepair(read: FileRead): false | "repair" | "purge" {
    if (read.kind === "damaged") return "repair";
    if (read.kind !== "ok") return false;
    const r = loadState(read.raw, this.probeCtx());
    if (r.problem !== undefined) return false;
    if (r.migrated) return "purge";
    if (r.entries.length > 0) return "repair";
    return r.lossy ? "purge" : false;
  }

  private startWatch(): void {
    if (this.closedForGood) return;
    const name = basename(this.file.path);
    try {
      // First run: there must be a folder to watch. Only when nothing is there (no await between the check and the call); an existing
      // link or folder is left to the file layer's checks.
      if (lstatOrNull(this.opts.dir) === null) mkdirSync(this.opts.dir, { recursive: true, mode: 0o700 });
      this.watcher = watch(this.opts.dir, { persistent: false }, (_event, filename) => {
        if (filename !== null && filename !== undefined && String(filename) !== name) return; // lock and temporary files
        this.schedule();
      });
      this.watcher.on("error", () => {
        this.log(`Settings: stopped watching ${this.opts.dir}; outside changes show after the next change here`);
        this.watcher?.close();
        this.watcher = undefined;
      });
    } catch {
      this.log(`Settings: cannot watch ${this.opts.dir}; outside changes show after the next change here`);
    }
  }

  /** Reload 100 ms after the last event, but never more than 500 ms after the first, so a stream of writes cannot starve it. */
  private schedule(): void {
    if (this.closedForGood) return;
    const now = Date.now();
    if (!this.timer) this.firstEventAt = now;
    else clearTimeout(this.timer);
    const delay = Math.max(0, Math.min(WATCH_DEBOUNCE_MS, this.firstEventAt + WATCH_MAX_WAIT_MS - now));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (!this.closedForGood) void this.reload();
    }, delay);
  }
}
