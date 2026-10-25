import { describe, expect, test } from "bun:test";
import { cycleReportView, listView, vaultStatusView } from "./status-view.ts";
import type { VaultStatusReport } from "./vault-worker.ts";

describe("bounded status view", () => {
  test("a list keeps its exact count and says how many entries it omits", () => {
    expect(listView(["a", "b", "c"], 2)).toEqual({ count: 3, items: ["a", "b"], omitted: 1 });
    expect(listView(["a"], 0)).toEqual({ count: 1, items: [], omitted: 1 });
    expect(listView([], 10)).toEqual({ count: 0, items: [], omitted: 0 });
  });

  test("shortening never changes the summary, the uncertainty or any count", () => {
    const report: VaultStatusReport = {
      vault: "v", summary: "blocked", uncertainty: ["pending-files", "blocked:secret-found", "edits-after-last-capture-unknown"],
      helper: { state: "idle", cycleStartedAt: null, nextDueAt: 1, lastCycle: { vault: "v", reason: "schedule", startedAt: 0, finishedAt: 1, outcome: "blocked", capture: { snapshot: "s", committed: true, startedAt: 0, changed: 1, pending: ["p1", "p2"], skipped: 0 }, push: { state: "blocked", reason: "secret-found", message: "m".repeat(2_000) }, verify: null, block: { reason: "secret-found", at: 1, message: "found", findings: [{ path: "a", rule: "r" }, { path: "b", rule: "r" }] }, error: null } },
      fresh: true, engineObservedAt: 1, statusError: null,
      engine: { machineId: "m", checkoutId: "c", protectionAgeSeconds: 400, oldestUnprotectedEdit: 1, lastVerifiedSnapshot: null, lastVerifiedAt: null, protectedThrough: null, latestSnapshot: "s", latestRef: "r", lastPushed: null, pending: ["p1", "p2", "p3"], unlistedFolders: [""], unflushedEditSince: null, writing: [], lastError: null, recoveredFromDamagedRecord: false, repositoryHooksNotRun: [], enabled: true, remote: "origin", block: { reason: "secret-found", at: 1, message: "found", findings: [{ path: "a", rule: "r" }] } },
    };
    const view = vaultStatusView(report, 0);
    expect(view.summary).toBe("blocked");
    expect(view.uncertainty).toEqual(report.uncertainty);
    expect(view.engine!.pending).toEqual({ count: 3, items: [], omitted: 3 });
    expect(view.engine!.unlistedFolders.count).toBe(1);
    expect(view.engine!.protectionAgeSeconds).toBe(400);
    expect(view.engine!.block!.findings).toEqual({ count: 1, items: [], omitted: 1 });
    expect(view.helper.lastCycle!.capture!.pending).toEqual({ count: 2, items: [], omitted: 2 });
    expect(view.helper.lastCycle!.block!.findings!.count).toBe(2);
    expect(view.helper.lastCycle!.push!.message!.length).toBeLessThan(600);
    expect(cycleReportView(report.helper.lastCycle!, 1).capture!.pending.items).toEqual(["p1"]);
  });
});
