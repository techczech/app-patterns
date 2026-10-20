/**
 * The agent settings CLI: `runSettingsCli(argv, opts, io)`. Each app ships its own small bin wrapper that passes its schema, registry
 * and data folder. Every change is logged `who: { kind: "agent", name }` (name from `--agent` or `BRIDLE_AGENT`, default "agent"), goes
 * through the same lock as the app (invariant 4), and is seen by an open Settings window within a second (invariant 6).
 *
 * Exit codes: 0 done · 1 the settings file cannot be used or could not be saved (it is a link, another app's, from a newer version, a
 * damaged file that could not be set aside, or the disk refused; every command, reads included, prints no value then) · 2 bad input or
 * not possible (an unknown key or command, an invalid value, a reserved or taken shortcut, a write the app's `beforeWrite` rule refused,
 * an undo whose every setting changed again since) · 3 needs confirmation (`reset --all`, `reset-shortcut --all` or `import` without
 * `--yes`) · 4 the settings file stayed locked for 5 s. When the app's rule refuses to migrate a legacy file, commands still run on the
 * defaults (exit as usual, 0 for a read): the store's log line on stderr says why, and `--json` output carries `problem`.
 *
 * `rebind` and `reset-shortcut` write the same shortcut map the Settings window writes, through the same store, lock and whole-set
 * check (reserved chords, collisions, fixed commands), and print the entries they logged.
 *
 * Output: plain text, or with `--json` one JSON object on stdout (errors included; nothing then goes to stderr but the store's log
 * lines). Options end at `--`. In plain text every string that came from a file has its control characters written as `\uXXXX`, so a
 * settings or import file cannot drive the terminal.
 *
 * No secret value is ever printed or written: secret settings are listed as kept in Keychain, and `set` on one is refused.
 */
import { writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { LIMITS, type ChangeEntry } from "../changes.ts";
import type { CommandsAdapter } from "../keys.ts";
import type { Migrated } from "../load.ts";
import { changedFromDefault } from "../operations.ts";
import { batchOf, lastImportBatch } from "../queries.ts";
import { formatValue, parseValue, type Schema, type SettingDef, type SettingValue } from "../schema.ts";
import { valueOf } from "../state.ts";
import type { ImportPreview } from "../transfer.ts";
import type { BeforeWrite } from "../write-check.ts";
import { parseChordArg } from "./chord-arg.ts";
import { readBoundedFile } from "./bounded-read.ts";
import type { LockOptions } from "./lock.ts";
import { MAX_FILE_BYTES } from "./settings-file.ts";
import { SettingsStore, type StoreErrorCode } from "./settings-store.ts";

export interface SettingsCliOptions {
  app: string;
  dir: string;
  schema: Schema;
  /** The app's command registry, through `commandsAdapter(registry)`. */
  registry: CommandsAdapter;
  /** The app's version. */
  version: string;
  /** The app's name in messages ("Example Editor"); default the app id. */
  appName?: string;
  migrate?(old: unknown): Migrated | null;
  root?: string;
  fileName?: string;
  /** Default: wait 5 s; a lock is stale when its process is dead or after the 30 s lease. */
  lock?: LockOptions;
  /** The app's rule over a whole write, as the app's own store has it (pass the same function, so the CLI keeps the app's rules). */
  beforeWrite?: BeforeWrite;
}

export interface SettingsCliIO {
  stdout(text: string): void;
  stderr(text: string): void;
  /** Default process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Default Date.now. */
  now?(): number;
  newId?(): string;
  /** For relative paths in `export` and `import`; default process.cwd(). */
  cwd?: string;
  /** For `export`; default os.hostname(). */
  hostName?: string;
}

export const EXIT = { ok: 0, failed: 1, badInput: 2, confirm: 3, locked: 4 } as const;
export const DEFAULT_AGENT = "agent";
export const DEFAULT_CHANGES_LIMIT = 20;

const USAGE = `Usage:
  list [--section <id>]
  get <key>
  set <key> <value>
  reset <key> | --section <id> | --all --yes
  rebind <command> <shortcut>        (shortcut: "cmd+shift+l", "⌘⇧L", or "none")
  reset-shortcut <command> | --all --yes
  changes [--limit <n>]
  export <file>
  import <file> [--yes]
  undo-import --last | <batch>
Options for every command: --json, --agent <name> (or BRIDLE_AGENT)`;

const VERBS: Record<string, { args: [number, number]; flags: string[] }> = {
  list: { args: [0, 0], flags: ["section"] },
  get: { args: [1, 1], flags: [] },
  set: { args: [2, 2], flags: [] },
  reset: { args: [0, 1], flags: ["section", "all", "yes"] },
  changes: { args: [0, 0], flags: ["limit"] },
  export: { args: [1, 1], flags: [] },
  import: { args: [1, 1], flags: ["yes"] },
  "undo-import": { args: [0, 1], flags: ["last"] },
  rebind: { args: [2, 2], flags: [] },
  "reset-shortcut": { args: [0, 1], flags: ["all", "yes"] },
};
const VALUE_FLAGS = new Set(["section", "limit", "agent"]);
const BOOL_FLAGS = new Set(["all", "yes", "last", "json"]);
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u001f\u007f-\u009f]/g;
// eslint-disable-next-line no-control-regex
const CONTROLS_BUT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;
const asEscape = (c: string) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;
/** A string from a file, for one line of text output: every C0/C1 control (newline too) as `\uXXXX`. */
const esc = (text: unknown): string => String(text).replace(CONTROLS, asEscape);
/** The last pass over text output: controls as `\uXXXX`, except the newlines between lines this CLI writes. */
const safe = (text: string): string => text.replace(CONTROLS_BUT_NEWLINE, asEscape);

class Exit {
  constructor(readonly code: number, readonly message: string, readonly json?: Record<string, unknown>) {}
}

interface Parsed {
  verb: string;
  args: string[];
  flags: Map<string, string | true>;
}

/** Parses every argument; `json` comes from the options parsed (never from a value or an argument after `--`), even when parsing fails. */
function parse(argv: readonly string[]): { json: boolean; parsed?: Parsed; error?: Exit } {
  const args: string[] = [];
  const flags = new Map<string, string | true>();
  let rest = false;
  let error: Exit | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (rest || !a.startsWith("--")) {
      args.push(a);
      continue;
    }
    if (a === "--") {
      rest = true;
      continue;
    }
    const eq = a.indexOf("=");
    const name = a.slice(2, eq < 0 ? undefined : eq);
    if (VALUE_FLAGS.has(name)) {
      const v = eq >= 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined) error ??= new Exit(EXIT.badInput, `--${name} needs a value`);
      else flags.set(name, v);
    } else if (BOOL_FLAGS.has(name) && eq < 0) {
      flags.set(name, true);
    } else {
      error ??= new Exit(EXIT.badInput, /^--[a-z-]{1,20}$/.test(a) ? `Unknown option ${a}\n${USAGE}` : `Unknown option\n${USAGE}`);
    }
  }
  const json = flags.get("json") === true;
  if (error) return { json, error };
  const verb = args.shift();
  if (!verb) return { json, error: new Exit(EXIT.badInput, USAGE) };
  const spec = VERBS[verb];
  if (!spec) return { json, error: new Exit(EXIT.badInput, `${/^[a-z-]{1,20}$/.test(verb) ? `Unknown command "${verb}"` : "Unknown command"}\n${USAGE}`) };
  if (args.length < spec.args[0] || args.length > spec.args[1]) return { json, error: new Exit(EXIT.badInput, USAGE) };
  for (const f of flags.keys()) if (f !== "json" && f !== "agent" && !spec.flags.includes(f)) return { json, error: new Exit(EXIT.badInput, `--${f} does not go with ${verb}\n${USAGE}`) };
  return { json, parsed: { verb, args, flags } };
}

/** The agent's name: `--agent`, else `BRIDLE_AGENT`, else "agent". Trimmed; refused when it holds control characters or is too long. */
function agentName(flag: string | true | undefined, env: Readonly<Record<string, string | undefined>>): string {
  const raw = typeof flag === "string" ? flag : env.BRIDLE_AGENT ?? "";
  const name = raw.trim();
  if (name === "") return DEFAULT_AGENT;
  if (CONTROL.test(name)) throw new Exit(EXIT.badInput, "The agent name cannot hold control characters");
  if (name.length > LIMITS.name) throw new Exit(EXIT.badInput, `The agent name can be at most ${LIMITS.name} characters`);
  return name;
}

const exitFor = (code: StoreErrorCode): number => {
  switch (code) {
    case "locked":
      return EXIT.locked;
    case "unwritten":
    case "closed":
    case "too-large":
      return EXIT.failed;
    case "refused":
      return EXIT.failed;
    case "not-possible":
    case "rejected":
      return EXIT.badInput;
    default:
      return EXIT.badInput;
  }
};

/** A setting's row for `list` and `get`. A secret never has a value here. */
function row(store: SettingsStore, schema: Schema, def: SettingDef) {
  const state = store.view();
  if (def.type === "secret") {
    return { key: def.key, label: def.label, section: def.section, type: def.type, value: null, default: null, changed: false, secret: true as const };
  }
  const value = valueOf(state, schema, def.key);
  return { key: def.key, label: def.label, section: def.section, type: def.type, value, default: def.default, changed: Object.hasOwn(state.settings, def.key) };
}

function whoText(e: ChangeEntry): string {
  const w = e.who;
  switch (w.kind) {
    case "you":
      return "you";
    case "agent":
      return `agent ${esc(w.name)}`;
    case "app-update":
      return `app update ${esc(w.version)}`;
    case "import":
      return `import of ${esc(w.file)}${w.by?.kind === "agent" ? ` by agent ${esc(w.by.name)}` : ""}`;
    case "reset":
      return `reset${w.by?.kind === "agent" ? ` by agent ${esc(w.by.name)}` : ""}`;
  }
}

function entryLine(e: ChangeEntry, schema: Schema): string {
  const def = e.key !== undefined ? schema.def(e.key) : undefined;
  const what = esc(e.key ?? `shortcut ${e.commandId}`);
  const val = (v: SettingValue | null) => esc(e.commandId !== undefined ? (v === "" ? "None" : v === null ? "—" : String(v)) : formatValue(def, v));
  const note = e.note ? ` (${esc(e.note)})` : "";
  const at = Number.isFinite(e.at) && Math.abs(e.at) <= 8.64e15 ? new Date(e.at).toISOString() : "?";
  return `${at}  ${what}  ${val(e.from)} → ${val(e.to)}  by ${whoText(e)}${e.batch ? `  batch ${esc(e.batch)}` : ""}${note}`;
}

function previewText(p: ImportPreview, schema: Schema): string {
  const lines: string[] = [];
  const src = p.source;
  if (src) lines.push(`From ${[src.exportedFrom, src.appVersion && `version ${src.appVersion}`, src.exportedAt].filter(Boolean).map(esc).join(", ") || "an export file"}`);
  lines.push(`${p.changes.length} to change, ${p.skipped.length} skipped, ${p.alreadyMatch} already match`);
  for (const c of p.changes) {
    const def = c.key !== undefined ? schema.def(c.key) : undefined;
    lines.push(
      c.key !== undefined
        ? `  ${esc(c.key)}: ${esc(formatValue(def, c.from))} → ${esc(formatValue(def, c.to))}`
        : `  shortcut ${esc(c.commandId)}: ${esc(c.from || "None")} → ${esc(c.to || "None")}`,
    );
  }
  for (const s of p.skipped) lines.push(`  skipped ${esc(s.key ?? `shortcut ${s.commandId}`)}: ${esc(s.reason)}`);
  return lines.join("\n");
}

/** Runs one CLI command. `argv` is the arguments after the program name. Returns the exit code; never throws. */
export async function runSettingsCli(argv: readonly string[], opts: SettingsCliOptions, io: SettingsCliIO): Promise<number> {
  const parsed = parse(argv);
  const json = parsed.json;
  let store: SettingsStore | undefined;
  /** A refused migration still in force, shown with every `--json` result (in plain text the store's log line says it on stderr). */
  const warning = (): Record<string, unknown> => {
    const p = store?.problem();
    return p?.code === "rejected" ? { problem: { code: p.code, error: p.error } } : {};
  };
  const out = (text: string, data: Record<string, unknown>) => io.stdout(json ? `${JSON.stringify({ ...data, ...warning() })}\n` : `${safe(text)}\n`);
  const fail = (code: number, message: string, data: Record<string, unknown> = {}): number => {
    if (json) io.stdout(`${JSON.stringify({ ok: false, exit: code, error: message, ...warning(), ...data })}\n`);
    else if (code === EXIT.confirm) io.stdout(`${safe(message)}\n`);
    else io.stderr(`${safe(message)}\n`);
    return code;
  };
  try {
    if (parsed.error) throw parsed.error;
    const p = parsed.parsed!;
    const env = io.env ?? process.env;
    const name = agentName(p.flags.get("agent"), env);
    const appName = opts.appName ?? opts.app;
    const schema = opts.schema;
    store = new SettingsStore({
      dir: opts.dir, app: opts.app, schema, registry: opts.registry, appVersion: opts.version, who: { kind: "agent", name }, watch: false,
      log: (line) => io.stderr(`${esc(line)}\n`),
      ...(opts.migrate ? { migrate: opts.migrate } : {}), ...(opts.root ? { root: opts.root } : {}), ...(opts.fileName ? { fileName: opts.fileName } : {}),
      ...(opts.lock ? { lock: opts.lock } : {}), ...(io.now ? { now: io.now } : {}), ...(io.newId ? { newId: io.newId } : {}),
      ...(opts.beforeWrite ? { beforeWrite: opts.beforeWrite } : {}),
    });
    await store.ready;
    const s = store;
    // A file this CLI may not use (a link, outside the root, another app's, a newer version's): no command reads or changes it.
    // A refused migration is not one: the file is left as it is, the values are the defaults (never the migrated ones), and the store
    // has logged why on stderr; commands go on, and a change carries the migration and is judged with it.
    const problem = s.problem();
    if (problem && problem.code !== "rejected") return fail(EXIT.failed, problem.error, { code: "refused", problem: problem.code });
    const cwd = io.cwd ?? process.cwd();
    const pathOf = (f: string) => (isAbsolute(f) ? f : resolve(cwd, f));
    const needDef = (key: string): SettingDef => {
      const def = schema.def(key);
      if (!def) throw new Exit(EXIT.badInput, `There is no setting "${key.slice(0, LIMITS.id)}". Run "list" to see them.`);
      return def;
    };
    const storeFail = (r: { code: StoreErrorCode; error: string }): number => fail(exitFor(r.code), r.error, { code: r.code });
    const changesOut = (entries: ChangeEntry[], data: Record<string, unknown> = {}) =>
      out(entries.length ? entries.map((e) => entryLine(e, schema)).join("\n") : "Nothing changed; it already had that value", { ok: true, changed: entries.length > 0, entries, ...data });

    switch (p.verb) {
      case "list": {
        const section = p.flags.get("section");
        if (typeof section === "string" && !schema.section(section)) throw new Exit(EXIT.badInput, `There is no section "${section.slice(0, LIMITS.id)}". Sections: ${schema.sections.map((x) => x.id).join(", ")}`);
        const rows = schema.settings.filter((d) => section === undefined || d.section === section).map((d) => row(s, schema, d));
        out(
          rows
            .map((r) =>
              r.type === "secret"
                ? `${r.key} = (a key, kept in Keychain; see Accounts and keys)`
                : `${r.key} = ${esc(formatValue(schema.def(r.key), r.value))}${r.changed ? `  (default ${esc(formatValue(schema.def(r.key), r.default))})` : ""}`,
            )
            .join("\n"),
          { settings: rows },
        );
        return EXIT.ok;
      }
      case "get": {
        const def = needDef(p.args[0]!);
        const r = row(s, schema, def);
        const last = s.view().changes.find((e) => e.key === def.key);
        out(def.type === "secret" ? "(a key, kept in Keychain; see Accounts and keys)" : esc(r.value), { ...r, ...(last ? { lastChange: last } : {}) });
        return EXIT.ok;
      }
      case "set": {
        const def = needDef(p.args[0]!);
        if (def.type === "secret") {
          throw new Exit(EXIT.badInput, `"${def.label}" is a key. Keys are kept in Keychain, never in the settings file: set it in ${appName} › Settings › Accounts and keys.`, { code: "secret" });
        }
        const v = parseValue(def, p.args[1]!);
        if (!v.ok) throw new Exit(EXIT.badInput, `${def.key}: ${v.error}`, { code: "invalid-value" });
        const r = await s.set(def.key, v.value);
        if (!r.ok) return storeFail(r);
        changesOut(r.entries);
        return EXIT.ok;
      }
      case "reset": {
        const key = p.args[0];
        const section = p.flags.get("section");
        const all = p.flags.get("all") === true;
        if ([key !== undefined, section !== undefined, all].filter(Boolean).length !== 1) throw new Exit(EXIT.badInput, USAGE);
        if (key !== undefined) {
          const def = needDef(key);
          if (def.type === "secret") throw new Exit(EXIT.badInput, `"${def.label}" is a key: remove it in ${appName} › Settings › Accounts and keys.`, { code: "secret" });
          const r = await s.reset(def.key);
          if (!r.ok) return storeFail(r);
          changesOut(r.entries);
          return EXIT.ok;
        }
        if (typeof section === "string") {
          if (!schema.section(section)) throw new Exit(EXIT.badInput, `There is no section "${section.slice(0, LIMITS.id)}"`);
          const r = await s.resetSection(section);
          if (!r.ok) return storeFail(r);
          changesOut(r.entries, r.batch ? { batch: r.batch } : {});
          return EXIT.ok;
        }
        const count = changedFromDefault(s.view(), schema).count;
        if (p.flags.get("yes") !== true) {
          if (count === 0) {
            out("Nothing to reset: every setting and shortcut has its default", { ok: true, changed: false, entries: [], count: 0 });
            return EXIT.ok;
          }
          return fail(EXIT.confirm, `This puts ${count} setting${count === 1 ? "" : "s"} and shortcuts back to their defaults. Run again with --yes to do it.`, { needsConfirmation: true, count });
        }
        const r = await s.resetAll();
        if (!r.ok) return storeFail(r);
        changesOut(r.entries, r.batch ? { batch: r.batch } : {});
        return EXIT.ok;
      }
      case "rebind": {
        const id = p.args[0]!;
        if (!opts.registry.isCommand(id) || schema.def(id)) throw new Exit(EXIT.badInput, `There is no command "${id.slice(0, LIMITS.id)}"`, { code: "unknown-command" });
        const c = parseChordArg(p.args[1]!);
        if (!c.ok) throw new Exit(EXIT.badInput, `${id}: ${c.error}`, { code: "invalid-chord" });
        const r = await s.rebind(id, c.chord);
        if (!r.ok) return storeFail(r);
        changesOut(r.entries);
        return EXIT.ok;
      }
      case "reset-shortcut": {
        const id = p.args[0];
        const all = p.flags.get("all") === true;
        if ((id !== undefined) === all) throw new Exit(EXIT.badInput, USAGE);
        if (id !== undefined) {
          if (p.flags.get("yes") !== undefined) throw new Exit(EXIT.badInput, `--yes goes with reset-shortcut --all\n${USAGE}`);
          if (!opts.registry.isCommand(id) || schema.def(id)) throw new Exit(EXIT.badInput, `There is no command "${id.slice(0, LIMITS.id)}"`, { code: "unknown-command" });
          const r = await s.reset({ commandId: id });
          if (!r.ok) return storeFail(r);
          changesOut(r.entries);
          return EXIT.ok;
        }
        const count = Object.keys(s.view().keys).length;
        if (p.flags.get("yes") !== true) {
          if (count === 0) {
            out("Nothing to reset: every shortcut has its default", { ok: true, changed: false, entries: [], count: 0 });
            return EXIT.ok;
          }
          return fail(EXIT.confirm, `This puts ${count} shortcut${count === 1 ? "" : "s"} back to ${count === 1 ? "its default" : "their defaults"}. Run again with --yes to do it.`, { needsConfirmation: true, count });
        }
        const r = await s.resetShortcuts();
        if (!r.ok) return storeFail(r);
        changesOut(r.entries, r.batch ? { batch: r.batch } : {});
        return EXIT.ok;
      }
      case "changes": {
        const raw = p.flags.get("limit");
        const limit = raw === undefined ? DEFAULT_CHANGES_LIMIT : Number(raw);
        if (!Number.isInteger(limit) || limit < 1) throw new Exit(EXIT.badInput, "--limit must be a whole number of at least 1");
        const all = s.view().changes;
        const entries = all.slice(0, limit);
        out(entries.length ? entries.map((e) => entryLine(e, schema)).join("\n") : "No changes yet", { changes: entries, total: all.length });
        return EXIT.ok;
      }
      case "export": {
        const path = pathOf(p.args[0]!);
        const file = s.exportFile({ hostName: io.hostName ?? hostname() });
        try {
          await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, { flag: "wx", mode: 0o644 });
        } catch (e) {
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "EEXIST") throw new Exit(EXIT.badInput, `${path} already exists; pick a new file name`);
          return fail(EXIT.failed, `Could not write ${path}`);
        }
        const n = Object.keys(file.settings).length;
        const k = Object.keys(file.keys).length;
        out(`Exported ${n} setting${n === 1 ? "" : "s"} and ${k} shortcut${k === 1 ? "" : "s"} to ${path}`, { ok: true, file: path, settings: n, keys: k });
        return EXIT.ok;
      }
      case "import": {
        const path = pathOf(p.args[0]!);
        const r = await readBoundedFile(path, MAX_FILE_BYTES);
        if (r.kind !== "ok") {
          throw new Exit(EXIT.badInput, r.kind === "missing" ? `There is no file ${path}` : r.kind === "too-large" ? `${path} is too large to be a settings export` : `${path} cannot be read`);
        }
        const preview = s.previewImport(r.text);
        if (preview.refused) return fail(EXIT.badInput, preview.refused.message, { code: "refused", refused: preview.refused });
        if (preview.changes.length === 0) {
          out(`${previewText(preview, schema)}\nNothing to import.`, { ok: true, applied: false, preview });
          return EXIT.ok;
        }
        if (p.flags.get("yes") !== true) {
          if (json) io.stdout(`${JSON.stringify({ ok: false, exit: EXIT.confirm, needsConfirmation: true, preview })}\n`);
          else io.stdout(`${safe(previewText(preview, schema))}\nRun again with --yes to import.\n`);
          return EXIT.confirm;
        }
        const done = await s.applyImport(preview, { file: basename(path) });
        if (!done.ok) return storeFail(done);
        out(`Imported: ${done.entries.length} change${done.entries.length === 1 ? "" : "s"}${done.batch ? ` (batch ${esc(done.batch)}; undo with "undo-import --last")` : ""}`, {
          ok: true, applied: true, ...(done.batch ? { batch: done.batch } : {}), entries: done.entries, skipped: preview.skipped,
        });
        return EXIT.ok;
      }
      case "undo-import": {
        const last = p.flags.get("last") === true;
        const id = p.args[0];
        if (last === (id !== undefined)) throw new Exit(EXIT.badInput, USAGE);
        const batch = last ? lastImportBatch(s.view()) : id!;
        if (!batch) throw new Exit(EXIT.badInput, "There is no import to undo", { code: "not-found" });
        const info = batchOf(s.view(), batch);
        if (!info) throw new Exit(EXIT.badInput, "That batch is no longer in the list of changes", { code: "not-found" });
        if (!info.import) throw new Exit(EXIT.badInput, "That batch is not an import", { code: "not-found" });
        const r = await s.undoBatch(batch);
        if (!r.ok) return fail(exitFor(r.code), r.error, { code: r.code, ...(r.skipped ? { skipped: r.skipped } : {}) });
        const skippedText = r.skipped.map((x) => `  kept ${esc(x.key ?? `shortcut ${x.commandId}`)}: ${esc(x.reason)}`).join("\n");
        out(`${r.entries.map((e) => entryLine(e, schema)).join("\n")}${skippedText ? `\n${skippedText}` : ""}`, {
          ok: true, ...(r.batch ? { batch: r.batch } : {}), entries: r.entries, skipped: r.skipped,
        });
        return EXIT.ok;
      }
    }
    return fail(EXIT.badInput, USAGE);
  } catch (e) {
    if (e instanceof Exit) return fail(e.code, e.message, e.json);
    return fail(EXIT.failed, `Settings could not be changed: ${e instanceof Error ? e.message.slice(0, 300) : "unexpected error"}`);
  } finally {
    await store?.close();
  }
}
