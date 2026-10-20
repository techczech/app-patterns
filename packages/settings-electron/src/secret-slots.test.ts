import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fakeCipher, tempDir } from "./fake-electron.test-support.ts";
import { checkSecret, MAX_SHAPE_HINT_CHARS, SafeStorageSlots, SLOT_MESSAGES, slotsForWindow, type SlotInfo } from "./secret-slots.ts";

const KEY = "sk-fake-sentinel-value-for-test-1234";
const defs = [
  { id: "accounts.openai", label: "OpenAI key", check: (v: string) => (v.startsWith("sk-") ? null : "That does not look like an OpenAI key") },
  { id: "accounts.speech", label: "Speech key" },
];
const slots = (dir: string, cipher = fakeCipher()) => new SafeStorageSlots({ dir, slots: defs, cipher });

describe("SafeStorageSlots", () => {
  test("round trip: set, list shows connected + last four only, get returns the value, remove", () => {
    const dir = tempDir();
    const s = slots(dir);
    expect(s.list()).toEqual([
      { id: "accounts.openai", label: "OpenAI key", status: "missing" },
      { id: "accounts.speech", label: "Speech key", status: "missing" },
    ]);
    expect(s.set("accounts.openai", `  ${KEY}\n`)).toEqual({ ok: true });
    const listed = s.list();
    expect(listed[0]).toEqual({ id: "accounts.openai", label: "OpenAI key", status: "connected", last4: "1234" });
    expect(JSON.stringify(listed)).not.toContain(KEY.slice(0, -4));
    // A fresh instance reads it back through the cipher.
    expect(slots(dir).get("accounts.openai")).toBe(KEY);
    expect(s.remove("accounts.openai")).toEqual({ ok: true });
    expect(s.list()[0]!.status).toBe("missing");
    expect(slots(dir).get("accounts.openai")).toBeNull();
  });

  test("nothing on disk in plain text; the file is 0600 and no temporary file is left", () => {
    const dir = tempDir();
    slots(dir).set("accounts.openai", KEY);
    const files = readdirSync(dir);
    expect(files).toEqual(["accounts.openai.key"]);
    const raw = readFileSync(join(dir, files[0]!));
    expect(raw.toString("utf8")).not.toContain(KEY);
    expect(raw.toString("latin1")).not.toContain(KEY.slice(8, 20));
    expect(statSync(join(dir, files[0]!)).mode & 0o777).toBe(0o600);
  });

  test("damaged ciphertext reads as problem, with a fixed message and no last four", () => {
    const dir = tempDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "accounts.openai.key"), Buffer.from("garbage that is not ciphertext"));
    const [info] = slots(dir).list();
    expect(info).toEqual({ id: "accounts.openai", label: "OpenAI key", status: "problem", detail: SLOT_MESSAGES.unreadable });
    expect(slots(dir).get("accounts.openai")).toBeNull();
  });

  test("secure storage unavailable: set refused, a saved key reads as problem", () => {
    const dir = tempDir();
    slots(dir).set("accounts.openai", KEY);
    const off = slots(dir, fakeCipher(false));
    expect(off.list()[0]).toEqual({ id: "accounts.openai", label: "OpenAI key", status: "problem", detail: SLOT_MESSAGES.storageMissing });
    expect(off.set("accounts.speech", "abcdefghijklmnopqrstu")).toEqual({ ok: false, error: SLOT_MESSAGES.noStorage });
  });

  test("bad values are refused in fixed words that never echo the value", () => {
    const s = slots(tempDir());
    const cases: [string, string, string][] = [
      ["accounts.openai", "   ", SLOT_MESSAGES.empty],
      ["accounts.openai", "sk-has a space-1234567", SLOT_MESSAGES.spaces],
      ["accounts.openai", `sk-${"x".repeat(5000)}`, SLOT_MESSAGES.tooLong],
      ["accounts.openai", "pk-notopenai-123456789", SLOT_MESSAGES.shape],
      ["accounts.none", KEY, SLOT_MESSAGES.unknown],
    ];
    for (const [id, v, msg] of cases) {
      const r = s.set(id, v);
      expect(r).toEqual(msg === SLOT_MESSAGES.shape ? { ok: false, error: msg, refusal: "shape" } : { ok: false, error: msg });
      if (!r.ok && v.trim()) expect(r.error).not.toContain(v.trim());
    }
    expect(s.remove("accounts.none")).toEqual({ ok: false, error: SLOT_MESSAGES.unknown });
  });

  test("a short key is connected but shows no last four", () => {
    const s = slots(tempDir());
    s.set("accounts.speech", "abc12345");
    expect(s.list()[1]).toEqual({ id: "accounts.speech", label: "Speech key", status: "connected" });
  });

  test("a link in place of the key file is never followed or replaced", () => {
    const dir = tempDir();
    const target = join(dir, "elsewhere.bin");
    writeFileSync(target, "x");
    symlinkSync(target, join(dir, "accounts.openai.key"));
    const s = slots(dir);
    expect(s.list()[0]!.status).toBe("problem");
    expect(s.set("accounts.openai", KEY)).toEqual({ ok: false, error: SLOT_MESSAGES.write });
    expect(readFileSync(target, "utf8")).toBe("x");
  });

  test("slot ids are checked when declared", () => {
    expect(() => new SafeStorageSlots({ dir: tempDir(), slots: [{ id: "../escape", label: "x" }], cipher: fakeCipher() })).toThrow();
    expect(() => new SafeStorageSlots({ dir: tempDir(), slots: [{ id: "a", label: "x" }, { id: "a", label: "y" }], cipher: fakeCipher() })).toThrow();
  });
});

describe("a slot's shapeHint", () => {
  const HINT = "Anthropic keys start with sk-ant-";
  const OWN = "the check's own words, never shown";
  const hinted = [
    { id: "accounts.anthropic", label: "Anthropic key", shapeHint: HINT, check: (v: string) => (v.startsWith("sk-ant-") ? null : OWN) },
    { id: "accounts.plain", label: "Plain key", check: (v: string) => (v.startsWith("pk-") ? null : OWN) },
  ];

  test("a shape refusal says the slot's hint, never the check's own string; no hint says SLOT_MESSAGES.shape", () => {
    const s = new SafeStorageSlots({ dir: tempDir(), slots: hinted, cipher: fakeCipher() });
    expect(s.set("accounts.anthropic", "sk-openai-0123456789abcdef")).toEqual({ ok: false, error: HINT, refusal: "shape" });
    expect(s.set("accounts.plain", "sk-openai-0123456789abcdef")).toEqual({ ok: false, error: SLOT_MESSAGES.shape, refusal: "shape" });
    expect(s.set("accounts.anthropic", "has spaces 0123456789")).toEqual({ ok: false, error: SLOT_MESSAGES.spaces }); // other refusals keep their words
    expect(s.set("accounts.anthropic", "sk-ant-0123456789abcdef")).toEqual({ ok: true });
    expect(s.shapeHints).toEqual(new Map([["accounts.anthropic", HINT]]));
  });

  test("checkSecret with a def whose hint was never checked falls back to SLOT_MESSAGES.shape", () => {
    expect(checkSecret("x-123", { id: "a", label: "A", shapeHint: "two\nlines", check: () => OWN })).toEqual({ ok: false, error: SLOT_MESSAGES.shape, refusal: "shape" });
  });

  test("a check that writes the value into its definition's hint cannot change what is said", () => {
    const VALUE = "pk-the-whole-key-0123456789abcdef";
    const def = {
      id: "accounts.anthropic", label: "Anthropic key", shapeHint: HINT,
      check(this: { shapeHint?: string } | undefined, v: string) {
        if (this) this.shapeHint = v; // the reproduction: `this` was the kept definition
        def.shapeHint = v; // and the app's own object, reached through the closure
        return "refused";
      },
    };
    const s = new SafeStorageSlots({ dir: tempDir(), slots: [def], cipher: fakeCipher() });
    for (let i = 0; i < 2; i++) {
      const r = s.set("accounts.anthropic", VALUE);
      expect(r).toEqual({ ok: false, error: HINT, refusal: "shape" });
      expect(JSON.stringify(r)).not.toContain("0123456789");
    }
    expect(s.shapeHints.get("accounts.anthropic")).toBe(HINT);
  });

  test("each field is read once: a hint getter that turns multiline after the first read is kept as first read", () => {
    let reads = 0;
    const def = { id: "accounts.anthropic", label: "Anthropic key", check: () => "refused" } as { id: string; label: string; check(): string; shapeHint?: string };
    Object.defineProperty(def, "shapeHint", { enumerable: true, get: () => (reads++ === 0 ? HINT : "two\nlines pk-0123456789") });
    const s = new SafeStorageSlots({ dir: tempDir(), slots: [def], cipher: fakeCipher() });
    expect(reads).toBe(1);
    expect(s.set("accounts.anthropic", "pk-0123456789abcdef")).toEqual({ ok: false, error: HINT, refusal: "shape" });
    expect(s.shapeHints.get("accounts.anthropic")).toBe(HINT);
    expect(reads).toBe(1);
  });

  test("an invalid hint is refused when the slots are made", () => {
    const make = (shapeHint: unknown) => () =>
      new SafeStorageSlots({ dir: tempDir(), slots: [{ id: "a", label: "A", shapeHint } as never], cipher: fakeCipher() });
    for (const bad of ["", "   ", " padded", "two\nlines", "line\u2028sep", "bidi\u202Eflip", "tab\there", "<b>bold</b>", "x".repeat(MAX_SHAPE_HINT_CHARS + 1), 42]) {
      expect(make(bad)).toThrow(/shapeHint/);
    }
    expect(make("x".repeat(MAX_SHAPE_HINT_CHARS))).not.toThrow();
  });
});

describe("slotsForWindow", () => {
  test("keeps only the known fields; last4 cut to four, and only for a connected slot; detail only in the package's fixed words", () => {
    const leaky = [
      { id: "a", label: "A", status: "connected", last4: "abcdefgh", value: "sk-SECRET", token: "t" },
      { id: "b", label: "B", status: "problem", last4: "1234", detail: "Rejected" },
      { id: "c", label: "C", status: "weird" },
      { id: "d", label: "D", status: "problem", detail: SLOT_MESSAGES.unreadable },
      { label: "no id", status: "connected" },
    ] as unknown as SlotInfo[];
    expect(slotsForWindow(leaky)).toEqual([
      { id: "a", label: "A", status: "connected", last4: "efgh" },
      { id: "b", label: "B", status: "problem" },
      { id: "c", label: "C", status: "problem" },
      { id: "d", label: "D", status: "problem", detail: SLOT_MESSAGES.unreadable },
    ]);
  });
});

describe("SafeStorageSlots: links on the way to the key folder", () => {
  test("a key folder that is a link is neither read nor written through", () => {
    const base = tempDir();
    const real = join(base, "real");
    mkdirSync(real);
    slots(real).set("accounts.openai", KEY); // a good key file over there
    symlinkSync(real, join(base, "keys"));
    const s = slots(join(base, "keys"));
    expect(s.list()[0]).toEqual({ id: "accounts.openai", label: "OpenAI key", status: "problem", detail: SLOT_MESSAGES.linked });
    expect(s.get("accounts.openai")).toBeNull();
    expect(s.set("accounts.speech", "abcdefghijklmnop")).toEqual({ ok: false, error: SLOT_MESSAGES.write });
    expect(s.remove("accounts.openai")).toEqual({ ok: false, error: SLOT_MESSAGES.remove });
    expect(readdirSync(real).sort()).toEqual(["accounts.openai.key"]);
  });

  test("a link in a folder between the root and the key folder is refused", () => {
    const base = tempDir();
    mkdirSync(join(base, "elsewhere"));
    symlinkSync(join(base, "elsewhere"), join(base, "data"));
    const s = new SafeStorageSlots({ dir: join(base, "data", "keys"), root: base, slots: defs, cipher: fakeCipher() });
    expect(s.set("accounts.openai", KEY)).toEqual({ ok: false, error: SLOT_MESSAGES.write });
    expect(readdirSync(join(base, "elsewhere"))).toEqual([]);
    expect(s.list()[0]!.status).toBe("problem");
  });

  test("a folder swapped for a link after construction is refused (its realpath was pinned)", () => {
    const base = tempDir();
    const dir = join(base, "keys");
    mkdirSync(dir);
    const s = slots(dir);
    mkdirSync(join(base, "other"));
    rmSync(dir, { recursive: true });
    symlinkSync(join(base, "other"), dir);
    expect(s.set("accounts.openai", KEY)).toEqual({ ok: false, error: SLOT_MESSAGES.write });
    expect(readdirSync(join(base, "other"))).toEqual([]);
  });

  test("a key folder outside its root is refused when declared", () => {
    const base = tempDir();
    expect(() => new SafeStorageSlots({ dir: "/elsewhere/keys", root: base, slots: defs, cipher: fakeCipher() })).toThrow();
  });
});

describe("SafeStorageSlots: a short write never replaces a good key", () => {
  test("a write that stops short is finished in more writes", () => {
    const dir = tempDir();
    const s = new SafeStorageSlots({
      dir, slots: defs, cipher: fakeCipher(),
      testHooks: { write: (fd, buf, off, len) => writeSync(fd, buf, off, Math.min(len, 6)) },
    });
    expect(s.set("accounts.openai", KEY)).toEqual({ ok: true });
    expect(slots(dir).get("accounts.openai")).toBe(KEY);
  });

  test("a write that fails part way keeps the old key file and leaves no temporary file", () => {
    const dir = tempDir();
    slots(dir).set("accounts.openai", KEY);
    let calls = 0;
    const s = new SafeStorageSlots({
      dir, slots: defs, cipher: fakeCipher(),
      testHooks: {
        write: (fd, buf, off, len) => {
          if (calls++ === 0) return writeSync(fd, buf, off, Math.min(len, 6));
          throw Object.assign(new Error("no space"), { code: "ENOSPC" });
        },
      },
    });
    expect(s.set("accounts.openai", "sk-a-new-key-that-does-not-fit-000")).toEqual({ ok: false, error: SLOT_MESSAGES.write });
    expect(slots(dir).get("accounts.openai")).toBe(KEY);
    expect(readdirSync(dir)).toEqual(["accounts.openai.key"]);
  });

  test("a write that makes no progress is a failure, not a loop", () => {
    const dir = tempDir();
    slots(dir).set("accounts.openai", KEY);
    const s = new SafeStorageSlots({ dir, slots: defs, cipher: fakeCipher(), testHooks: { write: () => 0 } });
    expect(s.set("accounts.openai", "sk-another-key-0123456789")).toEqual({ ok: false, error: SLOT_MESSAGES.write });
    expect(slots(dir).get("accounts.openai")).toBe(KEY);
    expect(readdirSync(dir)).toEqual(["accounts.openai.key"]);
  });
});
