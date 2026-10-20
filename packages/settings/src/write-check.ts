/**
 * The app's rule over a whole write (`beforeWrite`), and the check every state passes before it is written. A schema `validate` sees one
 * value; `beforeWrite` sees the whole state a write would leave, so an app can keep two settings apart (a library folder that must not
 * overlap another). The store runs it once per write, under the lock, for every route: set, rebind, reset, undo, import, a key's record,
 * and a migration. It can only refuse: it is given frozen copies, and what is written is the store's own state, checked again after it.
 */
import { boundActor, bound, CHANGELOG_KEY, LIMITS, type Actor, type ChangeEntry } from "./changes.ts";
import { overrideError, setError, type CommandsAdapter } from "./keys.ts";
import { checkValue, type Schema } from "./schema.ts";
import type { SettingsState } from "./state.ts";

/** Which store operation the write comes from. `migration`: the loader read the app's legacy file and the write records it as v2. */
export type WriteRoute =
  | "set" | "rebind" | "reset" | "reset-section" | "reset-shortcuts" | "reset-all" | "reset-entry" | "undo" | "import" | "record-secret" | "migration";

export interface WriteProposal {
  route: WriteRoute;
  /** Who the write is for: the store's actor; `app-update` for a migration. */
  who: Actor;
  /** The state as it stands on disk (the defaults when the file is missing, damaged or a legacy file being migrated). */
  before: Readonly<SettingsState>;
  /** The whole state the write would leave. */
  next: Readonly<SettingsState>;
  /** The changelog entries the write adds, newest first (the operation's, and the loader's when it repaired or migrated). */
  entries: readonly ChangeEntry[];
  /** Setting keys the write changes (each has an entry). */
  keys: readonly string[];
  /** Commands whose shortcut the write changes. */
  commandIds: readonly string[];
}

/** Nothing (or `null`): write. `{ reject }`: nothing is written and the caller gets `{ ok: false, code: "rejected", error: reject }`. */
export type WriteVerdict = void | null | undefined | { reject: string };
/** Synchronous and quick: it runs under the file's lock. A throw, a promise or any other return refuses the write (and is logged). */
export type BeforeWrite = (proposal: WriteProposal) => WriteVerdict;

/** The reason given when a hook throws or returns something it should not. */
export const RULE_FAILED = "A settings rule could not judge this change, so it was not saved";

/** Why `state` may not be written, or null: a stored value the schema refuses, a secret, or a shortcut set that does not stand. */
export function stateProblem(state: SettingsState, schema: Schema, commands: CommandsAdapter): string | null {
  for (const [key, value] of Object.entries(state.settings)) {
    const def = schema.def(key);
    if (!def) return `There is no setting "${bound(key, LIMITS.id)}"`;
    const err = checkValue(def, value);
    if (err) return `${def.label}: ${err}`;
  }
  for (const [id, chord] of Object.entries(state.keys)) {
    const err = overrideError(id, chord, schema, commands);
    if (err) return err;
  }
  return setError(state.keys, commands);
}

function deepFreeze<T>(v: T): T {
  if (v && typeof v === "object") {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
}

/** The keys and commands named by the entries that record a change (not the loader's repair notes). */
export function changedTargets(entries: readonly ChangeEntry[]): { keys: string[]; commandIds: string[] } {
  const keys = new Set<string>();
  const commandIds = new Set<string>();
  for (const e of entries) {
    if (e.note !== undefined) continue;
    if (e.key !== undefined && e.key !== CHANGELOG_KEY) keys.add(e.key);
    if (e.commandId !== undefined) commandIds.add(e.commandId);
  }
  return { keys: [...keys], commandIds: [...commandIds] };
}

/**
 * Runs `hook` on frozen copies and returns the reason to refuse, or null. Fails closed: a throw, a promise or an unknown return refuses,
 * with one line to `log`.
 */
export function judgeWrite(
  hook: BeforeWrite,
  p: { route: WriteRoute; who: Actor; before: SettingsState; next: SettingsState; entries: readonly ChangeEntry[] },
  log: (line: string) => void,
): string | null {
  const proposal: WriteProposal = deepFreeze({
    route: p.route, who: boundActor(p.who), before: structuredClone(p.before), next: structuredClone(p.next), entries: structuredClone([...p.entries]),
    ...changedTargets(p.entries),
  });
  let verdict: unknown;
  try {
    verdict = hook(proposal);
  } catch (e) {
    log(`Settings: the app's beforeWrite rule threw (${e instanceof Error ? e.message.slice(0, 300) : "unknown error"}); the change was not saved`);
    return RULE_FAILED;
  }
  if (verdict === undefined || verdict === null) return null;
  if (typeof verdict === "object" && !Array.isArray(verdict) && typeof (verdict as { reject?: unknown }).reject === "string" && !(verdict instanceof Promise)) {
    const reason = (verdict as { reject: string }).reject.trim();
    return reason ? bound(reason, LIMITS.text) : RULE_FAILED;
  }
  log(`Settings: the app's beforeWrite rule returned ${verdict instanceof Promise ? "a promise (it must be synchronous)" : "something other than nothing or { reject }"}; the change was not saved`);
  if (verdict instanceof Promise) verdict.catch(() => undefined);
  return RULE_FAILED;
}
