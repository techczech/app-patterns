import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lockTestHooks, withFolderLock } from "./engine-store.ts";

// Ordinary files only: no other process is started, inspected or signalled. No test reaches a live
// contender, so the lock never checks a pid.

const cleanups: Array<() => void> = [];
afterEach(() => {
  lockTestHooks.beforeWithdraw = undefined;
  lockTestHooks.createFile = undefined;
  while (cleanups.length) cleanups.pop()!();
});

function lockDir(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "vault-sync-lock-cleanup-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, "lock");
  mkdirSync(dir);
  cleanups.push(() => { if (existsSync(dir)) chmodSync(dir, 0o700); });
  return dir;
}

const files = (dir: string, kind: "choosing" | "ticket") => readdirSync(dir).filter((n) => n.startsWith(`${kind}-`));

/** Puts an empty folder where this contender's file of `kind` is, so unlinking it fails (EPERM or EISDIR). */
function blockRemoval(dir: string, kind: "choosing" | "ticket"): void {
  const [name] = files(dir, kind);
  rmSync(join(dir, name!));
  mkdirSync(join(dir, name!));
}

const neverEntered = () => Promise.reject(new Error("the callback must not run"));

describe("acquisition cleanup failures reach the opt-in listener (review r5, R5-1)", () => {
  test("the choosing announcement cannot be withdrawn: reported, the ticket taken is removed, the callback never runs", async () => {
    const dir = lockDir();
    lockTestHooks.beforeWithdraw = () => blockRemoval(dir, "choosing");
    const heard: unknown[] = [];
    const error = await withFolderLock(dir, { waitMs: 0, onReleaseError: (e) => heard.push(e) }, neverEntered).then(() => null, (e: unknown) => e);
    // Before: the withdrawal error left acquisition before any listener could hear it, and the ticket stayed.
    expect(heard).toHaveLength(1);
    expect((error as NodeJS.ErrnoException).code).toBe((heard[0] as NodeJS.ErrnoException).code);
    expect((error as NodeJS.ErrnoException).code).not.toBe("ENOENT");
    expect(files(dir, "ticket")).toEqual([]);
    expect(files(dir, "choosing")).toHaveLength(1);
  });

  test("neither file can be removed: both failures are reported and both files stay", async () => {
    const dir = lockDir();
    lockTestHooks.beforeWithdraw = () => chmodSync(dir, 0o500);
    const heard: unknown[] = [];
    const error = await withFolderLock(dir, { waitMs: 0, onReleaseError: (e) => heard.push(e) }, neverEntered).then(() => null, (e: unknown) => e);
    expect(heard.map((e) => (e as NodeJS.ErrnoException).code)).toEqual(["EACCES", "EACCES"]);
    expect((error as NodeJS.ErrnoException).code).toBe("EACCES");
    chmodSync(dir, 0o700);
    expect(files(dir, "choosing")).toHaveLength(1);
    expect(files(dir, "ticket")).toHaveLength(1);
  });

  test("an acquisition error that came first is the one thrown; the withdrawal failure is reported", async () => {
    const dir = lockDir();
    lockTestHooks.beforeWithdraw = () => {
      blockRemoval(dir, "choosing");
      throw new Error("acquisition failed");
    };
    const heard: unknown[] = [];
    await expect(withFolderLock(dir, { waitMs: 0, onReleaseError: (e) => heard.push(e) }, neverEntered)).rejects.toThrow("acquisition failed");
    expect(heard).toHaveLength(1);
    expect(files(dir, "ticket")).toEqual([]);
  });

  test("a throwing listener changes nothing: the ticket removal is still attempted and the same error thrown", async () => {
    const dir = lockDir();
    lockTestHooks.beforeWithdraw = () => chmodSync(dir, 0o500);
    let calls = 0;
    const error = await withFolderLock(dir, { waitMs: 0, onReleaseError: () => { calls += 1; throw new Error("listener failed"); } }, neverEntered).then(() => null, (e: unknown) => e);
    expect(calls).toBe(2);
    expect((error as NodeJS.ErrnoException).code).toBe("EACCES");
  });

  test("control: without a listener the default is unchanged: the withdrawal error is thrown and the ticket stays", async () => {
    const dir = lockDir();
    lockTestHooks.beforeWithdraw = () => {
      blockRemoval(dir, "choosing");
      throw new Error("acquisition failed");
    };
    const error = await withFolderLock(dir, { waitMs: 0 }, neverEntered).then(() => null, (e: unknown) => e);
    expect((error as Error).message).not.toBe("acquisition failed");
    expect((error as NodeJS.ErrnoException).code).not.toBe("ENOENT");
    expect(files(dir, "ticket")).toHaveLength(1);
  });
});

describe("ticket release failures after the callback (r4 seam, direct)", () => {
  test("the callback's error is kept when its ticket cannot be removed; the failure is reported", async () => {
    const dir = lockDir();
    const heard: unknown[] = [];
    const run = withFolderLock(dir, { waitMs: 0, onReleaseError: (e) => heard.push(e) }, async () => {
      blockRemoval(dir, "ticket");
      throw new Error("callback failed");
    });
    await expect(run).rejects.toThrow("callback failed");
    expect(heard).toHaveLength(1);
    expect(files(dir, "ticket")).toHaveLength(1);
  });

  test("a throwing listener does not replace the callback's error", async () => {
    const dir = lockDir();
    const run = withFolderLock(dir, { waitMs: 0, onReleaseError: () => { throw new Error("listener failed"); } }, async () => {
      blockRemoval(dir, "ticket");
      throw new Error("callback failed");
    });
    await expect(run).rejects.toThrow("callback failed");
  });

  test("a callback that succeeds keeps its value when its ticket cannot be removed; the failure is reported", async () => {
    const dir = lockDir();
    const heard: unknown[] = [];
    const value = await withFolderLock(dir, { waitMs: 0, onReleaseError: (e) => heard.push(e) }, async () => {
      blockRemoval(dir, "ticket");
      return 7;
    });
    expect(value).toBe(7);
    expect(heard).toHaveLength(1);
  });
});

describe("an exclusive creation that rejects after creating the file is never taken as no claim (review r6, R6-1)", () => {
  type Kind = "choosing" | "ticket";
  const kindOf = (path: string): Kind => (path.split("/").pop()!.startsWith("choosing-") ? "choosing" : "ticket");
  /** The real exclusive creation runs and makes the file; then the operation rejects, as a failed close would. */
  const failAfterCreating = (kind: Kind, error: Error) => {
    lockTestHooks.createFile = async (path) => {
      await writeFile(path, "", { flag: "wx" });
      if (kindOf(path) === kind) throw error;
    };
  };
  const ioError = () => Object.assign(new Error("EIO: i/o error, close"), { code: "EIO" });
  const counting = () => {
    const entered = { count: 0 };
    return { entered, fn: async () => { entered.count += 1; return 1; } };
  };

  for (const kind of ["choosing", "ticket"] as const) {
    test(`${kind}: the file exists, the listener hears its creation is unproven, nothing is removed, the original error is thrown, the callback never runs`, async () => {
      const dir = lockDir();
      writeFileSync(join(dir, "unrelated"), "keep");
      const original = ioError();
      failAfterCreating(kind, original);
      const heard: unknown[] = [];
      const { entered, fn } = counting();
      const error = await withFolderLock(dir, { waitMs: 0, onReleaseError: (e) => heard.push(e) }, fn).then(() => null, (e: unknown) => e);
      // Before: the rejection left acquisition with no report, so a holder of the listener took the claim as gone.
      expect(error).toBe(original);
      expect(heard).toHaveLength(1);
      expect((heard[0] as Error).cause).toBe(original);
      expect((heard[0] as Error).message).toContain(`${kind}-`);
      expect(entered.count).toBe(0);
      // The created file is not deleted on the strength of the failed write; the announcement of a failed
      // ticket attempt is still withdrawn as before.
      expect(files(dir, kind)).toHaveLength(1);
      if (kind === "ticket") expect(files(dir, "choosing")).toEqual([]);
      else expect(files(dir, "ticket")).toEqual([]);
      expect(readFileSync(join(dir, "unrelated"), "utf8")).toBe("keep");
    });

    test(`${kind}: a throwing listener does not mask the original error or stop the withdrawal`, async () => {
      const dir = lockDir();
      const original = ioError();
      failAfterCreating(kind, original);
      let calls = 0;
      const { entered, fn } = counting();
      const error = await withFolderLock(dir, { waitMs: 0, onReleaseError: () => { calls += 1; throw new Error("listener failed"); } }, fn).then(() => null, (e: unknown) => e);
      expect(error).toBe(original);
      expect(calls).toBe(1);
      expect(entered.count).toBe(0);
      expect(files(dir, kind)).toHaveLength(1);
      if (kind === "ticket") expect(files(dir, "choosing")).toEqual([]);
    });

    test(`${kind}: control without a listener: the same error, the same files, as before`, async () => {
      const dir = lockDir();
      const original = ioError();
      failAfterCreating(kind, original);
      const { entered, fn } = counting();
      const error = await withFolderLock(dir, { waitMs: 0 }, fn).then(() => null, (e: unknown) => e);
      expect(error).toBe(original);
      expect(entered.count).toBe(0);
      expect(files(dir, kind)).toHaveLength(1);
      if (kind === "ticket") expect(files(dir, "choosing")).toEqual([]);
      else expect(files(dir, "ticket")).toEqual([]);
    });

    test(`${kind}: EEXIST created nothing: not reported, and the existing file keeps its bytes`, async () => {
      const dir = lockDir();
      let foreign = "";
      lockTestHooks.createFile = async (path) => {
        if (kindOf(path) === kind) {
          foreign = path;
          writeFileSync(path, "someone else's");
        }
        await writeFile(path, "", { flag: "wx" });
      };
      const heard: unknown[] = [];
      const { entered, fn } = counting();
      const error = await withFolderLock(dir, { waitMs: 0, onReleaseError: (e) => heard.push(e) }, fn).then(() => null, (e: unknown) => e);
      expect((error as NodeJS.ErrnoException).code).toBe("EEXIST");
      expect(heard).toEqual([]);
      expect(entered.count).toBe(0);
      expect(readFileSync(foreign, "utf8")).toBe("someone else's");
      expect(files(dir, kind)).toHaveLength(1);
    });
  }

  test("ticket: when the announcement then cannot be withdrawn either, both are reported and the creation error is thrown", async () => {
    const dir = lockDir();
    const original = ioError();
    lockTestHooks.createFile = async (path) => {
      await writeFile(path, "", { flag: "wx" });
      if (kindOf(path) === "ticket") {
        blockRemoval(dir, "choosing");
        throw original;
      }
    };
    const heard: unknown[] = [];
    const { entered, fn } = counting();
    const error = await withFolderLock(dir, { waitMs: 0, onReleaseError: (e) => heard.push(e) }, fn).then(() => null, (e: unknown) => e);
    expect(error).toBe(original);
    expect(heard).toHaveLength(2);
    expect((heard[0] as Error).cause).toBe(original);
    expect(entered.count).toBe(0);
    expect(files(dir, "ticket")).toHaveLength(1);
    expect(files(dir, "choosing")).toHaveLength(1);
  });

  test("an ordinary failure before creation is reported conservatively; nothing exists and nothing is removed", async () => {
    const dir = lockDir();
    chmodSync(dir, 0o500);
    const heard: unknown[] = [];
    const { entered, fn } = counting();
    const error = await withFolderLock(dir, { waitMs: 0, onReleaseError: (e) => heard.push(e) }, fn).then(() => null, (e: unknown) => e);
    expect((error as NodeJS.ErrnoException).code).toBe("EACCES");
    // The rejection alone cannot show the file is absent, so the claim is reported as possibly left.
    expect(heard).toHaveLength(1);
    expect((heard[0] as Error).cause).toBe(error);
    expect(entered.count).toBe(0);
    chmodSync(dir, 0o700);
    expect(readdirSync(dir)).toEqual([]);
  });
});
