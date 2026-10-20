/**
 * Keys and sign-ins for Accounts and keys. `SecretSlots` is what the Settings host talks to; `SafeStorageSlots` is the default, one
 * encrypted file per key in the app's folder, encrypted with Electron `safeStorage` (Keychain-backed on macOS). Ported from Agent Traffic
 * Control's `summary/key-store.ts`, generalised to several slots, with an injectable `Cipher` so the tests run without Electron.
 *
 * Main process only. A clear value is never written, logged, or put into an error or a result; outside this file it is only ever
 * status + last four characters (`list`). `get` is for the app's own main-process code (the model client) and has no IPC channel.
 *
 * Folder containment (the idea of `@app-patterns/settings/node` SettingsFile): the key folder and every folder between it and `root` must be
 * real folders, never links, and the key folder must resolve (realpath) to the place under `root` it names, `root`'s realpath taken
 * when first seen. A key file is a regular file, never a link. Checked before every read, write and removal. As there, these checks
 * guard against links already in place or swapped in before an operation; a swap between a check and the call is the accepted residual.
 */
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Cipher } from "./electron-types.ts";

export type SlotStatus = "connected" | "missing" | "problem";

/** One slot as the window may see it. */
export interface SlotInfo {
  id: string;
  label: string;
  status: SlotStatus;
  detail?: string;
  last4?: string;
}

/**
 * A slot's answer. `refusal: "shape"` marks a value refused by the slot's shape check (and only that); the Settings host shows the
 * slot's install-time `shapeHint` only for a result that carries the marker and whose `error` is exactly that hint.
 */
export type SlotResult = { ok: true } | { ok: false; error: string; refusal?: "shape" };

export interface SecretSlots {
  list(): SlotInfo[] | Promise<SlotInfo[]>;
  set(id: string, value: string): SlotResult | Promise<SlotResult>;
  remove(id: string): SlotResult | Promise<SlotResult>;
  /**
   * Each slot's `shapeHint` (slot id → hint). The Settings host copies it once, when installed, and checks every hint with
   * `shapeHintProblem`; afterwards a `set` result from slot `id` marked `refusal: "shape"` whose error is exactly that slot's hint is
   * shown as it is. Changes made after install are not seen.
   */
  readonly shapeHints?: ReadonlyMap<string, string>;
}

export interface SlotDef {
  /** The key of the `secret` setting this slot belongs to; also its file name, so letters, digits, `.`, `_` and `-` only. */
  id: string;
  label: string;
  /**
   * A shape check on the trimmed value (a provider prefix, say). Any string refuses the value; the window is told `SLOT_MESSAGES.shape`,
   * or `shapeHint` when the slot declares one, never the string returned (an app's own words are not sent to the window). Called with
   * no `this`.
   */
  check?(value: string): string | null;
  /**
   * What the window says when `check` refuses a value, instead of `SLOT_MESSAGES.shape` ("Anthropic keys start with sk-ant-"). A fixed
   * string, checked when the slots are made (`shapeHintProblem`): one line of plain text, at most `MAX_SHAPE_HINT_CHARS` characters.
   * It is never built from the value.
   */
  shapeHint?: string;
}

export const MAX_SECRET_CHARS = 4096;
/** Below this length the last four characters are not shown: they would be too much of the key. */
export const LAST4_MIN_CHARS = 12;
const SLOT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const MAX_SHAPE_HINT_CHARS = 160;
/** Control and format characters (bidi overrides, zero-width), line and paragraph separators, and markup brackets. */
const HINT_REFUSED = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]/u;

/** Why `hint` cannot be a slot's `shapeHint`, or null when it can: a non-empty single line of plain text, trimmed, bounded. */
export function shapeHintProblem(hint: unknown): string | null {
  if (typeof hint !== "string") return "must be a string";
  if (!hint.trim()) return "must not be empty";
  if (hint !== hint.trim()) return "must not start or end with spaces";
  if (hint.length > MAX_SHAPE_HINT_CHARS) return `must be at most ${MAX_SHAPE_HINT_CHARS} characters`;
  if (HINT_REFUSED.test(hint)) return "must be one line of plain text (no control characters, line breaks, < or >)";
  return null;
}

/** Fixed messages: none of them includes a value. */
export const SLOT_MESSAGES = {
  unknown: "There is no such key",
  empty: "Enter a key",
  spaces: "A key has no spaces in it",
  tooLong: "That is too long to be a key",
  noStorage: "This Mac's secure storage is not available, so the key was not saved",
  encrypt: "The key could not be encrypted, so it was not saved",
  write: "The key could not be saved",
  remove: "The key could not be removed",
  unreadable: "The saved key could not be read; enter it again",
  storageMissing: "This Mac's secure storage is not available, so the saved key cannot be read",
  shape: "That does not look like the right kind of key",
  linked: "The keys folder is a link or is not where it should be, so the key is not used",
} as const;

/** Whether `text` is one of the fixed messages above (and so may be shown in the window). */
export const isSlotMessage = (text: unknown): text is (typeof SLOT_MESSAGES)[keyof typeof SLOT_MESSAGES] =>
  typeof text === "string" && (Object.values(SLOT_MESSAGES) as string[]).includes(text);

export interface SafeStorageSlotsOptions {
  /** The folder the files go in (`<dir>/<id>.key`). Created 0700 when missing. */
  dir: string;
  /**
   * The folder `dir` must be in or equal (the app's userData folder): no folder from below it down to `dir` may be a link. Default
   * `dir` itself, whose realpath is then pinned when first seen (a link already above it at that moment is accepted).
   */
  root?: string;
  slots: readonly SlotDef[];
  cipher: Cipher;
  /** Test seams. Not for apps. */
  testHooks?: { write?(fd: number, buf: Buffer, offset: number, length: number): number };
}

type ShapeCheck = (value: string) => string | null;
/** A slot as `SafeStorageSlots` keeps it: each field of the app's `SlotDef` read once, the hint already checked; frozen. */
interface SlotSnapshot {
  readonly id: string;
  readonly label: string;
  readonly check: ShapeCheck | undefined;
  readonly hint: string | undefined;
}

/** Reads each field of `def` exactly once; a hint that fails `shapeHintProblem` is reported, never kept. */
function snapshotOf(def: SlotDef): { snap: SlotSnapshot; hintProblem: string | null } {
  const { id, label, check, shapeHint } = def;
  const hintProblem = shapeHint === undefined ? null : shapeHintProblem(shapeHint);
  const snap = Object.freeze({
    id, label, check: typeof check === "function" ? check : undefined, hint: shapeHint !== undefined && hintProblem === null ? shapeHint : undefined,
  });
  return { snap, hintProblem };
}

type CheckResult = { ok: true; value: string } | { ok: false; error: string; refusal?: "shape" };

function checkWith(raw: string, snap?: SlotSnapshot): CheckResult {
  const value = raw.trim();
  if (!value) return { ok: false, error: SLOT_MESSAGES.empty };
  if (/\s/.test(value)) return { ok: false, error: SLOT_MESSAGES.spaces };
  if (value.length > MAX_SECRET_CHARS) return { ok: false, error: SLOT_MESSAGES.tooLong };
  // No `this`: the check cannot reach the slot's definition. The hint comes from the snapshot, never from what the check returns.
  if (snap?.check && snap.check.call(undefined, value)) return { ok: false, error: snap.hint ?? SLOT_MESSAGES.shape, refusal: "shape" };
  return { ok: true, value };
}

/**
 * The trimmed value, or why it cannot be a key. Never echoes the input. A shape refusal is marked `refusal: "shape"` and says the
 * definition's `shapeHint` when it passes `shapeHintProblem`, else `SLOT_MESSAGES.shape`.
 */
export function checkSecret(raw: string, def?: SlotDef): CheckResult {
  return checkWith(raw, def ? snapshotOf(def).snap : undefined);
}

export class SafeStorageSlots implements SecretSlots {
  /** Decrypted once per run, so the Keychain is not asked on every list. */
  private readonly cache = new Map<string, string>();
  private readonly defs: Map<string, SlotSnapshot>;
  /** Each declared `shapeHint`, checked when the slots are made. */
  readonly shapeHints: ReadonlyMap<string, string>;
  private readonly dir: string;
  private readonly root: string;
  /** `dir` relative to `root`, split into folder names ([] when they are the same folder). */
  private readonly steps: string[];
  private rootReal: string | undefined;

  constructor(private readonly opts: SafeStorageSlotsOptions) {
    this.dir = resolve(opts.dir);
    this.root = resolve(opts.root ?? opts.dir);
    const rel = relative(this.root, this.dir);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("SafeStorageSlots: dir must be inside root");
    this.steps = rel === "" ? [] : rel.split(sep);
    try {
      this.rootReal = realpathSync(this.root);
    } catch {
      this.rootReal = undefined; // not there yet: pinned when first seen
    }
    this.defs = new Map();
    for (const def of opts.slots) {
      const { snap: d, hintProblem } = snapshotOf(def);
      if (typeof d.id !== "string" || !SLOT_ID.test(d.id)) throw new Error(`SafeStorageSlots: slot id "${String(d.id)}" may hold letters, digits, ".", "_" and "-" only`);
      if (this.defs.has(d.id)) throw new Error(`SafeStorageSlots: slot "${d.id}" is declared twice`);
      if (hintProblem) throw new Error(`SafeStorageSlots: slot "${d.id}" shapeHint ${hintProblem}`);
      this.defs.set(d.id, d);
    }
    this.shapeHints = new Map([...this.defs.values()].flatMap((d) => (d.hint === undefined ? [] : [[d.id, d.hint] as const])));
  }

  /** Where a slot's encrypted file lives. */
  pathOf(id: string): string {
    return join(this.dir, `${id}.key`);
  }

  /**
   * The folder check: "ok", "missing" (some folder on the way is not there yet; nothing to read), or "refused" (a link, not a folder,
   * or `dir` does not resolve to where it names under `root`).
   */
  private folder(): "ok" | "missing" | "refused" {
    let p = this.root;
    const chain = [...this.steps.map((name) => (p = join(p, name)))];
    if (chain.length === 0) chain.push(this.dir); // root is the key folder: it may not be a link either
    for (const q of chain) {
      let st;
      try {
        st = lstatSync(q);
      } catch (e) {
        return (e as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "refused";
      }
      if (st.isSymbolicLink() || !st.isDirectory()) return "refused";
    }
    try {
      this.rootReal ??= realpathSync(this.root);
      return realpathSync(this.dir) === join(this.rootReal, ...this.steps) ? "ok" : "refused";
    } catch {
      return "refused";
    }
  }

  private canEncrypt(): boolean {
    try {
      return this.opts.cipher.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  private exists(id: string): boolean {
    if (this.folder() !== "ok") return false;
    try {
      return lstatSync(this.pathOf(id)).isFile();
    } catch {
      return false;
    }
  }

  /** The clear value, or why there is none. */
  private read(id: string): { value: string } | { status: "missing" } | { status: "problem"; detail: string } {
    const cached = this.cache.get(id);
    if (cached !== undefined) return { value: cached };
    const f = this.folder();
    if (f === "missing") return { status: "missing" };
    if (f === "refused") return { status: "problem", detail: SLOT_MESSAGES.linked };
    let st;
    try {
      st = lstatSync(this.pathOf(id));
    } catch {
      return { status: "missing" };
    }
    if (!st.isFile()) return { status: "problem", detail: SLOT_MESSAGES.unreadable }; // a link or a folder is never followed
    if (!this.canEncrypt()) return { status: "problem", detail: SLOT_MESSAGES.storageMissing };
    try {
      if (st.size > MAX_SECRET_CHARS * 8) return { status: "problem", detail: SLOT_MESSAGES.unreadable };
      const value = this.opts.cipher.decryptString(readFileSync(this.pathOf(id)));
      if (typeof value !== "string" || !value || /\s/.test(value) || value.length > MAX_SECRET_CHARS) return { status: "problem", detail: SLOT_MESSAGES.unreadable };
      this.cache.set(id, value);
      return { value };
    } catch {
      return { status: "problem", detail: SLOT_MESSAGES.unreadable };
    }
  }

  list(): SlotInfo[] {
    return [...this.defs.values()].map((d) => {
      const r = this.read(d.id);
      if ("value" in r) {
        const info: SlotInfo = { id: d.id, label: d.label, status: "connected" };
        if (r.value.length >= LAST4_MIN_CHARS) info.last4 = r.value.slice(-4);
        return info;
      }
      return r.status === "missing" ? { id: d.id, label: d.label, status: "missing" } : { id: d.id, label: d.label, status: "problem", detail: r.detail };
    });
  }

  set(id: string, raw: string): SlotResult {
    const def = this.defs.get(id);
    if (!def || typeof raw !== "string") return { ok: false, error: SLOT_MESSAGES.unknown };
    const checked = checkWith(raw, def);
    if (!checked.ok) return checked;
    if (!this.canEncrypt()) return { ok: false, error: SLOT_MESSAGES.noStorage };
    let blob: Buffer;
    try {
      blob = this.opts.cipher.encryptString(checked.value);
    } catch {
      return { ok: false, error: SLOT_MESSAGES.encrypt };
    }
    try {
      this.writeAtomic(this.pathOf(id), blob);
    } catch {
      return { ok: false, error: SLOT_MESSAGES.write };
    }
    this.cache.set(id, checked.value);
    return { ok: true };
  }

  remove(id: string): SlotResult {
    if (!this.defs.has(id)) return { ok: false, error: SLOT_MESSAGES.unknown };
    this.cache.delete(id);
    const f = this.folder();
    if (f === "missing") return { ok: true };
    if (f === "refused") return { ok: false, error: SLOT_MESSAGES.remove };
    try {
      const st = lstatSync(this.pathOf(id), { throwIfNoEntry: false });
      if (st && !st.isFile()) return { ok: false, error: SLOT_MESSAGES.remove }; // a link or a folder is left alone
      rmSync(this.pathOf(id), { force: true });
      return { ok: true };
    } catch {
      return { ok: false, error: SLOT_MESSAGES.remove };
    }
  }

  /** The clear value, for the app's main-process code only. Null when none is saved or it cannot be read. Never sent to a window. */
  get(id: string): string | null {
    if (!this.defs.has(id)) return null;
    const r = this.read(id);
    return "value" in r ? r.value : null;
  }

  /** Whether a slot has a saved file (without decrypting it). */
  has(id: string): boolean {
    return this.cache.has(id) || this.exists(id);
  }

  /**
   * A fresh temporary file (O_EXCL, 0600), every byte written and fsynced, then renamed over the slot's file: a crash or a full disk
   * leaves the old file or the new one, never half. On any shortfall or error the temporary file is removed and the old file kept.
   */
  private writeAtomic(path: string, blob: Buffer): void {
    let f = this.folder();
    if (f === "missing") {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 }); // only what is missing: every folder there was checked above
      f = this.folder();
    }
    if (f !== "ok") throw new Error("folder refused");
    try {
      if (!lstatSync(path).isFile()) throw new Error("not a file"); // never replace a link or a folder
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    const write = this.opts.testHooks?.write ?? ((fd: number, buf: Buffer, off: number, len: number) => writeSync(fd, buf, off, len));
    const fd = openSync(tmp, "wx", 0o600);
    let done = false;
    try {
      try {
        let at = 0;
        while (at < blob.length) {
          const n = write(fd, blob, at, blob.length - at);
          if (!Number.isInteger(n) || n <= 0) throw new Error("short write");
          at += n;
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, path);
      done = true;
    } finally {
      if (!done) {
        try {
          unlinkSync(tmp);
        } catch {
          // already gone
        }
      }
    }
  }
}

/**
 * The slot list as it may leave main: only the known fields, each bounded, `last4` at most four characters, `detail` only when it is one
 * of `SLOT_MESSAGES`. A `SecretSlots` written by an app that returns more (a value, a token, its own words) has it stripped here, before
 * anything reaches IPC.
 */
export function slotsForWindow(list: readonly SlotInfo[]): SlotInfo[] {
  const str = (v: unknown, max: number): string | undefined => (typeof v === "string" ? v.slice(0, max) : undefined);
  const out: SlotInfo[] = [];
  for (const s of Array.isArray(list) ? list.slice(0, 100) : []) {
    if (!s || typeof s !== "object") continue;
    const id = str(s.id, 200);
    if (!id) continue;
    const status: SlotStatus = s.status === "connected" || s.status === "missing" ? s.status : "problem";
    const info: SlotInfo = { id, label: str(s.label, 200) ?? id, status };
    // Only the package's own fixed words: an app's detail could carry a key (a provider's error echoing it).
    if (isSlotMessage(s.detail)) info.detail = s.detail;
    const last4 = typeof s.last4 === "string" && s.last4.length > 0 ? s.last4.slice(-4) : undefined;
    if (last4 && status === "connected") info.last4 = last4;
    out.push(info);
  }
  return out;
}
