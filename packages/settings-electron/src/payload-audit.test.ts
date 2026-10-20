/**
 * Invariant 5: a key's value never reaches a renderer, the settings file or an export. Every `bridle-settings:` channel is called with valid
 * arguments after a key is saved; every answer, every push and every file written is searched for the value.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHANNELS } from "./channels.ts";
import { fakeCipher, harness, tempDir, until, type Harness } from "./fake-electron.test-support.ts";
import { MESSAGES } from "./install.ts";
import { SafeStorageSlots, SLOT_MESSAGES, type SecretSlots, type SlotInfo } from "./secret-slots.ts";

const SECRET = "sk-audit-0123456789abcdefghijklmnopZYXW";
const BODY = SECRET.slice(0, -4); // everything but the last four, which the window may show

const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });

async function exerciseEveryChannel(h: Harness): Promise<unknown[]> {
  const out: unknown[] = [];
  const call = async (c: string, ...a: unknown[]) => {
    try {
      out.push(await h.call(c, ...a));
    } catch (e) {
      out.push(String(e));
    }
  };
  h.host.openSettingsWindow("accounts");
  await call(CHANNELS.setSecret, "accounts.openai", SECRET);
  await call(CHANNELS.view);
  await call(CHANNELS.set, "editor.size", 20);
  await call(CHANNELS.set, "accounts.openai", SECRET); // refused: a key never travels on set
  await call(CHANNELS.rebind, "rename", "⌘E");
  await call(CHANNELS.rebindMany, [{ commandId: "rename", chord: "⌘G" }]);
  await call(CHANNELS.reset, "editor.size");
  await call(CHANNELS.reset, { commandId: "rename" });
  await call(CHANNELS.resetSection, "editor");
  await call(CHANNELS.resetAll);
  await call(CHANNELS.resetEntry, h.store.view().changes[0]?.id ?? "x");
  await call(CHANNELS.undoBatch, "none");
  h.fe.saveAnswers.push({ canceled: false, filePath: join(h.dir, "export.json") });
  await call(CHANNELS.export);
  const imp = join(h.dir, "import.json");
  writeFileSync(imp, JSON.stringify({ format: "bridle-settings-export", version: 1, app: "testapp", settings: { "editor.focus": true, "accounts.openai": "sk-from-file-should-be-skipped-0000" }, keys: {} }));
  h.fe.openAnswers.push({ canceled: false, filePaths: [imp] });
  await call(CHANNELS.importPreview);
  await call(CHANNELS.importApply, "import.json");
  h.fe.openAnswers.push({ canceled: false, filePaths: ["/tmp"] });
  await call(CHANNELS.choosePath, "general.folder");
  await call(CHANNELS.setSecret, "accounts.openai", "bad value with spaces " + SECRET);
  await call(CHANNELS.view);
  await call(CHANNELS.removeSecret, "accounts.openai");
  await call(CHANNELS.setSecret, "accounts.openai", SECRET);
  await call(CHANNELS.view);
  return out;
}

describe("no handler returns a key's value", () => {
  test("every answer and every push holds status and last four at most", async () => {
    const h = await harness();
    const answers = await exerciseEveryChannel(h);
    const pushes = h.fe.windows.flatMap((w) => w.webContents.sent);
    const text = JSON.stringify({ answers, pushes });
    expect(text).not.toContain(BODY);
    expect(text).toContain('"last4":"ZYXW"'); // the slot is visible as connected
    // The channels exercised are every invoke channel there is.
    const exercised = new Set(Object.values(CHANNELS).filter((c) => c !== CHANNELS.changed && c !== CHANNELS.section));
    expect([...h.fe.handlers.keys()].sort()).toEqual([...exercised].sort());
    expect(pushes.some((p) => p.channel === CHANNELS.changed)).toBe(true);
  });

  test("the settings file and the export never hold it; the key file is not plain text", async () => {
    const h = await harness();
    await exerciseEveryChannel(h);
    for (const f of filesUnder(h.dir)) {
      if (f.endsWith("import.json")) continue; // the test's own input
      expect(readFileSync(f).toString("latin1")).not.toContain(BODY);
    }
    const exported = readFileSync(join(h.dir, "export.json"), "utf8");
    expect(exported).not.toContain("accounts.openai");
    expect(h.slots.get("accounts.openai")).toBe(SECRET); // still usable by main
  });

  test("an app's own SecretSlots that leaks a value in list() or in an error is stripped before IPC", async () => {
    const leaky: SecretSlots = {
      list: () => [{ id: "accounts.openai", label: "OpenAI", status: "connected", last4: SECRET, value: SECRET } as unknown as SlotInfo],
      set: (_id, v) => ({ ok: false, error: `Rejected ${v}` }),
      remove: () => ({ ok: true }),
    };
    const h = await harness({ slots: leaky });
    const answers = await exerciseEveryChannel(h);
    const text = JSON.stringify({ answers, pushes: h.win().webContents.sent });
    expect(text).not.toContain(BODY);
  });
});

describe("an adapter's own words never reach the window", () => {
  const LONG = `sk-${"q".repeat(380)}TAIL4567890123456`; // 400 characters: a cut error could still carry most of it
  const stored = "sk-stored-key-the-adapter-echoes-0000WXYZ";
  const echoing = (): SecretSlots => ({
    list: () => [{ id: "accounts.openai", label: "OpenAI key", status: "problem", detail: `The provider refused ${stored}` }],
    set: (_id, v) => ({ ok: false, error: `Rejected ${v} (stored was ${stored})` }),
    remove: () => ({ ok: false, error: `Could not remove ${stored}` }),
  });

  test("slot detail, set errors and remove errors become the package's fixed words", async () => {
    const h = await harness({ slots: echoing() });
    h.host.openSettingsWindow("accounts");
    const view = (await h.call(CHANNELS.view)) as { slots: SlotInfo[] };
    expect(view.slots).toEqual([{ id: "accounts.openai", label: "OpenAI key", status: "problem" }]);
    const set = await h.call(CHANNELS.setSecret, "accounts.openai", LONG);
    expect(set).toEqual({ ok: false, error: MESSAGES.secretFailed });
    const removed = await h.call(CHANNELS.removeSecret, "accounts.openai");
    expect(removed).toEqual({ ok: false, error: MESSAGES.removeFailed });
    const text = JSON.stringify({ view, set, removed, pushes: h.win().webContents.sent });
    expect(text).not.toContain(stored.slice(3, 20));
    expect(text).not.toContain("q".repeat(20));
    expect(text).not.toContain("TAIL");
  });

  test("the default slots' own fixed words still come through", async () => {
    const h = await harness();
    h.host.openSettingsWindow("accounts");
    expect(await h.call(CHANNELS.setSecret, "accounts.openai", "has spaces in it 123456")).toEqual({ ok: false, error: SLOT_MESSAGES.spaces });
  });
});

describe("a slot's shapeHint reaches the window only as that slot's refusal", () => {
  const HINT = "OpenAI keys start with sk-";
  const OWN = "the check's own words: never shown";

  test("the declared hint comes through on a shape refusal; the check's own string never does", async () => {
    const slots = new SafeStorageSlots({
      dir: join(tempDir(), "keys"), cipher: fakeCipher(),
      slots: [{ id: "accounts.openai", label: "OpenAI key", shapeHint: HINT, check: (v) => (v.startsWith("sk-") ? null : `${OWN} ${v}`) }],
    });
    const h = await harness({ slots });
    h.host.openSettingsWindow("accounts");
    const VALUE = "pk-wrong-provider-0123456789";
    const r = await h.call(CHANNELS.setSecret, "accounts.openai", VALUE);
    expect(r).toEqual({ ok: false, error: HINT });
    const text = JSON.stringify({ r, pushes: h.win().webContents.sent });
    expect(text).not.toContain(OWN);
    expect(text).not.toContain(VALUE);
  });

  test("another slot's error in the same words, a removal in those words, and an undeclared hint become fixed words", async () => {
    const twoSlots = (): SecretSlots & { shapeHints: Map<string, string> } => ({
      list: () => [
        { id: "accounts.openai", label: "OpenAI key", status: "missing" },
        { id: "accounts.other", label: "Other key", status: "missing" },
      ],
      set: () => ({ ok: false, error: HINT, refusal: "shape" }),
      remove: () => ({ ok: false, error: HINT, refusal: "shape" }),
      shapeHints: new Map([["accounts.openai", HINT]]),
    });
    const slots = twoSlots();
    const h = await harness({ slots });
    h.host.openSettingsWindow("accounts");
    await h.call(CHANNELS.view);
    await until(() => h.win().webContents.sent.some((p) => JSON.stringify(p).includes("accounts.other")), 1000);
    expect(await h.call(CHANNELS.setSecret, "accounts.openai", "sk-0123456789abcdef")).toEqual({ ok: false, error: HINT });
    expect(await h.call(CHANNELS.setSecret, "accounts.other", "sk-0123456789abcdef")).toEqual({ ok: false, error: MESSAGES.secretFailed });
    expect(await h.call(CHANNELS.removeSecret, "accounts.openai")).toEqual({ ok: false, error: MESSAGES.removeFailed });
    // The map is copied at install: a hint added afterwards is not shown.
    slots.shapeHints.set("accounts.other", HINT);
    expect(await h.call(CHANNELS.setSecret, "accounts.other", "sk-0123456789abcdef")).toEqual({ ok: false, error: MESSAGES.secretFailed });
  });

  test("the hint's words without the shape marker (a storage failure, say) become fixed words", async () => {
    let marked = false;
    const slots: SecretSlots = {
      list: () => [{ id: "accounts.openai", label: "OpenAI key", status: "missing" }],
      set: () => (marked ? { ok: false, error: HINT, refusal: "shape" } : { ok: false, error: HINT }),
      remove: () => ({ ok: true }),
      shapeHints: new Map([["accounts.openai", HINT]]),
    };
    const h = await harness({ slots });
    h.host.openSettingsWindow("accounts");
    expect(await h.call(CHANNELS.setSecret, "accounts.openai", "sk-0123456789abcdef")).toEqual({ ok: false, error: MESSAGES.secretFailed });
    marked = true;
    expect(await h.call(CHANNELS.setSecret, "accounts.openai", "sk-0123456789abcdef")).toEqual({ ok: false, error: HINT });
  });

  test("a Map subclass's own iterator is not used to read the hints", async () => {
    class Shifty extends Map<string, string> {
      override *[Symbol.iterator](): MapIterator<[string, string]> {
        yield ["accounts.openai", "two\nlines"];
      }
      override entries(): MapIterator<[string, string]> {
        return this[Symbol.iterator]();
      }
    }
    const slots: SecretSlots = {
      list: () => [{ id: "accounts.openai", label: "OpenAI key", status: "missing" }],
      set: () => ({ ok: false, error: HINT, refusal: "shape" }),
      remove: () => ({ ok: true }),
      shapeHints: new Shifty([["accounts.openai", HINT]]),
    };
    const h = await harness({ slots });
    h.host.openSettingsWindow("accounts");
    expect(await h.call(CHANNELS.setSecret, "accounts.openai", "sk-0123456789abcdef")).toEqual({ ok: false, error: HINT });
  });

  test("an app's own SecretSlots with an invalid hint is refused at install", async () => {
    const bad: SecretSlots = {
      list: () => [], set: () => ({ ok: true }), remove: () => ({ ok: true }),
      shapeHints: new Map([["accounts.openai", "two\nlines"]]),
    };
    await expect(harness({ slots: bad })).rejects.toThrow(/shapeHint/);
  });
});
