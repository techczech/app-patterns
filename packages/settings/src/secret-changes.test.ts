/** A key saved or removed in Accounts and keys is logged (invariant 3) with status words only, never the value (invariant 5). */
import { describe, expect, test } from "bun:test";
import { commands, fresh, makeCtx, must, schema } from "./fixture.test-support.ts";
import { loadState } from "./load.ts";
import { recordSecret, resetEntry, undoBatch } from "./operations.ts";

const loadCtx = { schema, commands, appVersion: "0.31.0", now: () => 0, newId: () => "ld" };

describe("recordSecret", () => {
  test("logs one entry with who and status words, and changes no setting", () => {
    const saved = must(recordSecret(fresh(), "accounts.speech", "missing", "connected", makeCtx({ kind: "agent", name: "A" })));
    expect(saved.entries).toEqual([{ id: "id1", at: 1000, key: "accounts.speech", from: "missing", to: "connected", who: { kind: "agent", name: "A" } }]);
    expect(saved.state.settings).toEqual({});
    // Replacing a key is a change too: one more entry, though both ends are "connected".
    const replaced = must(recordSecret(saved.state, "accounts.speech", "connected", "connected", makeCtx()));
    expect(replaced.state.changes).toHaveLength(2);
    expect(replaced.entries[0]).toMatchObject({ from: "connected", to: "connected", who: { kind: "you" } });
  });

  test("refuses anything but a secret setting and the two status words", () => {
    const ctx = makeCtx();
    expect(recordSecret(fresh(), "editor.proseSize", "missing", "connected", ctx)).toMatchObject({ ok: false, code: "invalid-value" });
    expect(recordSecret(fresh(), "nope", "missing", "connected", ctx)).toMatchObject({ ok: false, code: "unknown-key" });
    expect(recordSecret(fresh(), "accounts.speech", "missing", "sk-TEST-SECRET" as "connected", ctx)).toMatchObject({ ok: false, code: "invalid-value" });
  });

  test("survives a reload; an entry about a secret holding anything else is still dropped", () => {
    const st = must(recordSecret(fresh(), "accounts.speech", "missing", "connected", makeCtx())).state;
    const raw = {
      ...JSON.parse(JSON.stringify(st)),
      changes: [
        ...st.changes,
        { id: "v", at: 1, key: "accounts.speech", from: "missing", to: "TEST-SECRET", who: { kind: "you" } },
        { id: "b", at: 1, key: "accounts.speech", from: "missing", to: "connected", who: { kind: "you" }, batch: "B" },
        { id: "i", at: 1, key: "accounts.speech", from: "missing", to: "connected", who: { kind: "import", file: "f" } },
        { id: "c", at: 1, commandId: "accounts.speech", from: "missing", to: "connected", who: { kind: "you" } },
      ],
    };
    const r = loadState(raw, loadCtx);
    expect(r.state.changes).toEqual(st.changes);
    expect(r.dropped).toEqual(["changes: 4 about a secret"]);
    expect(r.lossy).toBe(true);
    expect(JSON.stringify(r)).not.toContain("TEST-SECRET");
    // The status entry alone, as written, reads back with nothing left out.
    expect(loadState(JSON.parse(JSON.stringify(st)), loadCtx).lossy).toBe(false);
  });

  test("Reset of such an entry is refused: a key cannot be put back from the list", () => {
    const st = must(recordSecret(fresh(), "accounts.speech", "connected", "missing", makeCtx())).state;
    expect(resetEntry(st, st.changes[0]!.id, makeCtx())).toMatchObject({ ok: false, code: "not-possible" });
    expect(undoBatch(st, "none", makeCtx())).toMatchObject({ ok: false, code: "not-found" });
  });
});
