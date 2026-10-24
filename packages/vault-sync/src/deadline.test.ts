import { describe, expect, test } from "bun:test";
import { applyCapture, applyPushed, applyVerified, convertedRecord, emptyRecord, noteEdit, noteFlush, noteWriteStart, parseRecord, protectionAgeSeconds, type CaptureOutcome, type DeadlineRecord } from "./deadline.ts";

/** A capture that read the record as `r` before reading files (so it is ordered after every report in `r`). */
const outcome = (r: DeadlineRecord, startedAt: number, extra: Partial<CaptureOutcome> = {}): CaptureOutcome => ({
  snapshot: "s1", ref: "r", startedAt, startGen: r.generation, pendingFloor: r.lastCapture?.coverage ?? startedAt, committed: true, sawChange: false,
  readPaths: [], goneConfirmed: [], pendingPaths: [], clearedPaths: [], unlistedFolders: [], relistedFolders: [], ...extra,
});
const capture = (r: DeadlineRecord, startedAt: number, extra: Partial<CaptureOutcome> = {}) => applyCapture(r, outcome(r, startedAt, extra)).record;
const pushAndVerify = (r: DeadlineRecord, snapshot: string, at: number) => {
  const pushed = applyPushed(r, snapshot, "r");
  return applyVerified(pushed, pushed.lastPushed!, at);
};
const edit = (r: DeadlineRecord, time: number, path: string | null = null) => noteEdit(r, time, path);

describe("deadline arithmetic", () => {
  test("a reported edit is resolved only by a save acknowledgement, a later capture and its verification", () => {
    let r = edit(emptyRecord(), 1000, "a.md").record;
    r = edit(r, 5000, "a.md").record;
    const last = edit(r, 500, "a.md");
    r = last.record;
    expect(r.oldestUnprotectedEdit).toBe(500);
    // Captures and verification without a save acknowledgement resolve nothing, however late.
    r = pushAndVerify(capture(r, 6000, { readPaths: ["a.md"] }), "s1", 7000);
    expect(r.oldestUnprotectedEdit).toBe(500);
    expect(r.protectedThrough).toBe(500);
    // A capture that read the record before the acknowledgement does not cover it.
    const before = r;
    r = noteFlush(r, { upTo: last.ticket, paths: ["a.md"] }, 8000);
    expect(r.unflushed).toEqual([]);
    r = applyCapture(r, { ...outcome(before, 9000, { snapshot: "s2", readPaths: ["a.md"] }) }).record;
    r = pushAndVerify(r, "s2", 9100);
    expect(r.oldestUnprotectedEdit).toBe(500);
    r = capture(r, 9200, { snapshot: "s3", readPaths: ["a.md"] });
    r = applyPushed(r, "s3", "r");
    expect(r.oldestUnprotectedEdit).toBe(500);
    r = applyVerified(r, r.lastPushed!, 9500);
    expect(r.oldestUnprotectedEdit).toBeNull();
    expect(r.protectedThrough).toBe(9200);
  });

  test("ordering comes from generations: equal and rolled-back clocks change ages, never which came first", () => {
    // Edit, acknowledgement and capture all at the same clock reading, and then a clock that went back.
    const e = edit(emptyRecord(), 1000, "a.md");
    const before = e.record;
    const acked = noteFlush(before, { upTo: e.ticket, paths: ["a.md"] }, 1000);
    // A capture that read the record before the acknowledgement (same clock) does not capture it.
    let r = applyCapture(acked, outcome(before, 1000, { readPaths: ["a.md"] })).record;
    r = pushAndVerify(r, "s1", 1000);
    expect(r.oldestUnprotectedEdit).toBe(1000);
    // One that read it after, with the clock rolled back, does.
    r = pushAndVerify(capture(r, 900, { snapshot: "s2", readPaths: ["a.md"] }), "s2", 900);
    expect(r.oldestUnprotectedEdit).toBeNull();
  });

  test("an acknowledgement covers only the paths it names (review round 2, R8)", () => {
    // A has an unsaved edit; B is edited and saved. B's save must not count for A.
    let r = edit(emptyRecord(), 1000, "a.md").record;
    const b = edit(r, 2000, "b.md");
    r = noteFlush(b.record, { upTo: b.ticket, paths: ["b.md"] }, 2000);
    r = pushAndVerify(capture(r, 3000, { readPaths: ["a.md", "b.md"], sawChange: true }), "s1", 3100);
    expect(r.oldestUnprotectedEdit).toBe(1000);
    expect(r.unflushed.map((u) => u.path)).toEqual(["a.md"]);
  });

  test("an edit reported without a path is covered only by an acknowledgement for all documents", () => {
    let r = edit(emptyRecord(), 1000).record;
    const b = edit(r, 2000, "b.md");
    r = noteFlush(b.record, { upTo: b.ticket, paths: ["b.md"] }, 2000);
    r = pushAndVerify(capture(r, 3000, { readPaths: ["a.md", "b.md"] }), "s1", 3100);
    expect(r.oldestUnprotectedEdit).toBe(1000);
    r = noteFlush(r, { upTo: b.ticket, allDocuments: true }, 3200);
    // A vault-wide acknowledgement needs a complete capture: one with a pending file or an unlisted folder does not do.
    r = pushAndVerify(capture(r, 4000, { snapshot: "s2", readPaths: ["a.md"], pendingPaths: ["c.md"] }), "s2", 4100);
    expect(r.oldestUnprotectedEdit).toBe(1000);
    r = pushAndVerify(capture(r, 4200, { snapshot: "s3", readPaths: ["a.md", "c.md"], unlistedFolders: ["d"] }), "s3", 4300);
    expect(r.oldestUnprotectedEdit).toBe(1000);
    r = pushAndVerify(capture(r, 5000, { snapshot: "s4", readPaths: ["a.md", "c.md"], relistedFolders: ["d"] }), "s4", 5100);
    expect(r.oldestUnprotectedEdit).toBeNull();
  });

  test("edits after the acknowledged ticket stay unflushed with a conservative floor", () => {
    const first = edit(emptyRecord(), 100, "a.md");
    let r = edit(first.record, 900, "a.md").record;
    r = noteFlush(r, { upTo: first.ticket, paths: ["a.md"] }, 1000);
    expect(r.unflushed).toEqual([{ path: "a.md", from: 100, first: first.ticket + 1, last: first.ticket + 1 }]);
    r = pushAndVerify(capture(r, 1100, { readPaths: ["a.md"] }), "s1", 1200);
    expect(r.oldestUnprotectedEdit).toBe(100);
  });

  test("an acknowledgement must name paths or all documents, and a ticket the record handed out", () => {
    const e = edit(emptyRecord(), 100, "a.md");
    expect(() => noteFlush(e.record, { upTo: e.ticket, paths: [] }, 200)).toThrow();
    expect(() => noteFlush(e.record, { upTo: e.ticket + 1, paths: ["a.md"] }, 200)).toThrow();
    expect(() => noteFlush(e.record, { upTo: -1, allDocuments: true }, 200)).toThrow();
  });

  test("a pending file does not replace an earlier known edit (review finding 4)", () => {
    let r = pushAndVerify(capture(emptyRecord(), 1_000_000, { readPaths: ["a.md"] }), "s1", 1_000_500);
    const e = edit(r, 1_001_000, "a.md");
    r = noteFlush(e.record, { upTo: e.ticket, paths: ["a.md"] }, 1_001_000);
    r = capture(r, 1_601_000, { committed: false, pendingPaths: ["a.md"] });
    r = pushAndVerify(r, "s1", 1_601_000);
    // The file's floor is the previous capture (the last time it was read); the known edit is later.
    expect(r.oldestUnprotectedEdit).toBe(1_000_000);
    expect(protectionAgeSeconds(r, 1_601_000)).toBe(601);
    expect(r.protectedThrough).toBe(1_000_000);
  });

  test("verifying an unchanged snapshot does not acknowledge an unflushed edit (review finding 5)", () => {
    let r = pushAndVerify(capture(emptyRecord(), 1000, { readPaths: ["a.md"] }), "s1", 1100);
    r = edit(r, 2000, "a.md").record;
    r = capture(r, 3000, { committed: false, readPaths: ["a.md"] });
    r = pushAndVerify(r, "s1", 3100);
    expect(r.oldestUnprotectedEdit).toBe(2000);
  });

  test("a file left pending keeps its floor from the capture before until a capture reads it and that is verified", () => {
    let r = capture(emptyRecord(), 500, { committed: true });
    r = capture(r, 1000, { snapshot: "s1", pendingPaths: ["a.md"] });
    expect(r.pendingSince).toEqual({ "a.md": 500 });
    r = capture(r, 2000, { committed: false, pendingPaths: ["a.md"] });
    r = pushAndVerify(r, "s1", 3000);
    expect(r.oldestUnprotectedEdit).toBe(500);
    r = capture(r, 4000, { snapshot: "s2", readPaths: ["a.md"], sawChange: true });
    expect(r.pendingSince).toEqual({});
    expect(r.oldestUnprotectedEdit).toBe(500);
    r = pushAndVerify(r, "s2", 5000);
    expect(r.oldestUnprotectedEdit).toBeNull();
  });

  test("a folder that could not be listed is pending until it is listed (review round 2, R5)", () => {
    let r = pushAndVerify(capture(emptyRecord(), 1000, { readPaths: ["a.md"] }), "s1", 1100);
    r = capture(r, 61_000, { snapshot: "s2", readPaths: ["a.md"], sawChange: true, unlistedFolders: ["notes/new"] });
    expect(r.unlistedSince).toEqual({ "notes/new": 1000 });
    r = pushAndVerify(r, "s2", 61_100);
    expect(r.oldestUnprotectedEdit).toBe(1000);
    expect(r.protectedThrough).toBe(1000);
    r = capture(r, 121_000, { snapshot: "s3", readPaths: ["a.md", "notes/new/b.md"], sawChange: true, relistedFolders: ["notes/new"] });
    expect(r.unlistedSince).toEqual({});
    expect(r.oldestUnprotectedEdit).toBe(1000);
    r = pushAndVerify(r, "s3", 121_100);
    expect(r.oldestUnprotectedEdit).toBeNull();
  });

  test("an acknowledged deletion is covered by a capture that confirms the path gone (review round 2, R7)", () => {
    const e = edit(emptyRecord(), 1000, "a.md");
    let r = noteFlush(e.record, { upTo: e.ticket, paths: ["a.md"] }, 1000);
    r = pushAndVerify(capture(r, 2000, { goneConfirmed: ["a.md"], sawChange: true }), "s1", 2100);
    expect(r.oldestUnprotectedEdit).toBeNull();
  });

  test("confirmed absence transfers a pending path's older floor until verification", () => {
    let r = capture(emptyRecord(), 100, { readPaths: ["kept.md"] });
    r = capture(r, 200, { pendingPaths: ["a.md"] });
    const e = edit(r, 300, "a.md");
    r = noteFlush(e.record, { upTo: e.ticket, paths: ["a.md"] }, 300);
    r = capture(r, 400, { committed: false, goneConfirmed: ["a.md"], clearedPaths: ["a.md"] });
    expect(r.pendingSince).toEqual({});
    expect(r.oldestUnprotectedEdit).toBe(100);
    r = pushAndVerify(r, "s1", 500);
    expect(r.oldestUnprotectedEdit).toBeNull();
  });

  test("verifying an earlier snapshot leaves edits captured later outstanding", () => {
    let r = capture(emptyRecord(), 1000, { sawChange: true });
    const pushed = applyPushed(r, "s1", "r");
    r = capture(pushed, 2000, { snapshot: "s2", sawChange: true });
    r = applyVerified(r, pushed.lastPushed!, 2500);
    expect(r.oldestUnprotectedEdit).toBe(2000);
    expect(r.protectedThrough).toBe(1000);
  });

  test("a coordinated write is outstanding from its start, and its end keeps a mark with a new generation", () => {
    let r = noteWriteStart(emptyRecord(), ["a.md"], 100);
    expect(r.oldestUnprotectedEdit).toBe(100);
    const startGen = r.writes["a.md"]!.gen;
    r = noteFlush(r, { upTo: 0, paths: ["a.md"], completedWrites: [{ path: "a.md", token: r.generation }] }, 200);
    expect(r.writes["a.md"]).toEqual({ gen: startGen + 1, active: false, since: 100 });
    // The written bytes still need a capture after the end.
    expect(r.flushed).toEqual([{ path: "a.md", from: 100, ackGen: startGen + 1 }]);
    expect(r.oldestUnprotectedEdit).toBe(100);
    // A capture ordered after the end prunes the mark and captures the write.
    r = pushAndVerify(capture(r, 300, { readPaths: ["a.md"] }), "s1", 400);
    expect(r.writes).toEqual({});
    expect(r.oldestUnprotectedEdit).toBeNull();
  });

  test("the coverage a snapshot can claim stops at the oldest edit it does not hold", () => {
    const r = edit(emptyRecord(), 400, "a.md").record;
    expect(applyCapture(r, outcome(r, 1000, { readPaths: ["a.md"] })).coverageThrough).toBe(400);
    expect(applyCapture(emptyRecord(), outcome(emptyRecord(), 1000, { readPaths: ["a.md"] })).coverageThrough).toBe(1000);
    const earlier = capture(emptyRecord(), 500, { pendingPaths: ["b.md"] });
    expect(applyCapture(earlier, outcome(earlier, 1000, { snapshot: "s2", pendingPaths: ["b.md"] })).coverageThrough).toBe(500);
    const looked = capture(emptyRecord(), 500, { readPaths: ["a.md"] });
    expect(applyCapture(looked, outcome(looked, 1000, { snapshot: "s2", unlistedFolders: ["x"] })).coverageThrough).toBe(500);
  });

  test("verifying a snapshot whose capture was not recorded advances nothing", () => {
    let r = edit(emptyRecord(), 100).record;
    r = applyPushed(r, "unknown", "r");
    r = applyVerified(r, r.lastPushed!, 200);
    expect(r.oldestUnprotectedEdit).toBe(100);
    expect(r.lastVerifiedSnapshot).toBe("unknown");
  });

  test("age is whole seconds since the oldest unprotected edit", () => {
    expect(protectionAgeSeconds(edit(emptyRecord(), 1000).record, 62_500)).toBe(61);
    expect(protectionAgeSeconds(emptyRecord(), 62_500)).toBe(0);
  });

  test("records of the wrong shape or another schema are not taken as they are", () => {
    expect(parseRecord(emptyRecord())).not.toBeNull();
    expect(parseRecord({ ...emptyRecord(), oldestUnprotectedEdit: "yesterday" })).toBeNull();
    expect(parseRecord({ ...emptyRecord(), schema: 2 })).toBeNull();
    expect(parseRecord({ ...emptyRecord(), flushed: [{ path: null, from: 1, ackGen: "x" }] })).toBeNull();
    // A ticket ahead of the counter that hands them out is not a record this engine wrote.
    expect(parseRecord({ ...emptyRecord(), unflushed: [{ path: null, from: 1, first: 1, last: 5 }] })).toBeNull();
  });

  test("conversion keeps the oldest known edit and treats the old state as unsaved (review round 2, R6)", () => {
    const schema1 = { schema: 1, oldestUnprotectedEdit: 400_000, latestEditNoted: 400_000, lastVerifiedSnapshot: null, lastVerifiedAt: null, protectedThrough: 300_000, lastCapture: null, lastPushed: null, pendingSince: { "b.md": 450_000 }, lastError: null };
    let r = convertedRecord(schema1, 1_000_000, 1_000_000);
    expect(r.oldestUnprotectedEdit).toBe(400_000);
    expect(protectionAgeSeconds(r, 1_000_000)).toBe(600);
    expect(r.pendingSince).toEqual({ "b.md": 450_000 });
    expect(r.convertedFrom).toBe(1);
    expect(r.protectedThrough).toBe(300_000);
    // A complete disk capture and verification do not discharge it; an acknowledgement for one document does not either.
    r = pushAndVerify(capture(r, 1_100_000, { readPaths: ["a.md", "b.md"], sawChange: true }), "s1", 1_100_100);
    expect(r.oldestUnprotectedEdit).toBe(400_000);
    r = noteFlush(r, { upTo: 0, paths: ["a.md"] }, 1_100_200);
    r = pushAndVerify(capture(r, 1_200_000, { snapshot: "s2", readPaths: ["a.md", "b.md"] }), "s2", 1_200_100);
    expect(r.oldestUnprotectedEdit).toBe(400_000);
    // Only an acknowledgement for all documents, a complete capture after it and verification do.
    r = noteFlush(r, { upTo: 0, allDocuments: true }, 1_200_200);
    r = pushAndVerify(capture(r, 1_300_000, { snapshot: "s3", readPaths: ["a.md", "b.md"] }), "s3", 1_300_100);
    expect(r.oldestUnprotectedEdit).toBeNull();

    // A damaged record, or one naming nothing, counts from the file's last write.
    expect(convertedRecord(undefined, 700_000, 1_000_000).oldestUnprotectedEdit).toBe(700_000);
    expect(convertedRecord(undefined, 700_000, 1_000_000).convertedFrom).toBe("damaged");
    // A record of the previous schema keeps every state's earliest time.
    const schema2 = { schema: 2, oldestUnprotectedEdit: null, unflushed: { from: 650_000, to: 660_000 }, flushed: [{ from: 600_000, flushedAt: 610_000, paths: null }], captured: [{ seq: 3, from: 550_000 }], writing: {}, pendingSince: {} };
    expect(convertedRecord(schema2, 900_000, 1_000_000).oldestUnprotectedEdit).toBe(550_000);
  });
});
