import { describe, expect, test } from "bun:test";
import { applyCapture, applyPushed, applyVerified, emptyRecord, noteEdit, parseRecord, protectionAgeSeconds } from "./deadline.ts";

const capture = (startedAt: number, extra: Partial<Parameters<typeof applyCapture>[1]> = {}) => ({ snapshot: "s1", ref: "r", startedAt, sawChange: true, readPaths: [], pendingPaths: [], clearedPaths: [], ...extra });

describe("deadline arithmetic", () => {
  test("the oldest edit only moves earlier until a verified snapshot covers it", () => {
    let r = noteEdit(emptyRecord(), 1000);
    r = noteEdit(r, 5000);
    r = noteEdit(r, 500);
    expect(r.oldestUnprotectedEdit).toBe(500);
    r = applyCapture(r, capture(6000));
    expect(r.oldestUnprotectedEdit).toBe(500);
    r = applyPushed(r, "s1", "r");
    expect(r.oldestUnprotectedEdit).toBe(500);
    r = applyVerified(r, r.lastPushed!, 7000);
    expect(r.oldestUnprotectedEdit).toBeNull();
    expect(r.protectedThrough).toBe(6000);
  });

  test("a file left pending keeps its first-seen time across captures", () => {
    let r = applyCapture(emptyRecord(), capture(1000, { pendingPaths: ["a.md"] }));
    r = applyCapture(r, capture(2000, { pendingPaths: ["a.md"] }));
    r = applyVerified(applyPushed(r, "s1", "r"), { snapshot: "s1", ref: "r", coverage: 2000, pendingFloor: r.lastCapture!.pendingFloor }, 3000);
    expect(r.oldestUnprotectedEdit).toBe(1000);
    r = applyCapture(r, capture(4000, { snapshot: "s2", readPaths: ["a.md"] }));
    expect(r.pendingSince).toEqual({});
    r = applyVerified(applyPushed(r, "s2", "r"), applyPushed(r, "s2", "r").lastPushed!, 5000);
    expect(r.oldestUnprotectedEdit).toBeNull();
  });

  test("verifying a snapshot whose capture was not recorded advances nothing", () => {
    let r = noteEdit(emptyRecord(), 100);
    r = applyPushed(r, "unknown", "r");
    r = applyVerified(r, r.lastPushed!, 200);
    expect(r.oldestUnprotectedEdit).toBe(100);
    expect(r.lastVerifiedSnapshot).toBe("unknown");
  });

  test("age is whole seconds since the oldest unprotected edit", () => {
    expect(protectionAgeSeconds(noteEdit(emptyRecord(), 1000), 62_500)).toBe(61);
    expect(protectionAgeSeconds(emptyRecord(), 62_500)).toBe(0);
  });

  test("records of the wrong shape are refused", () => {
    expect(parseRecord(emptyRecord())).not.toBeNull();
    expect(parseRecord({ ...emptyRecord(), oldestUnprotectedEdit: "yesterday" })).toBeNull();
    expect(parseRecord({ ...emptyRecord(), schema: 2 })).toBeNull();
  });
});
