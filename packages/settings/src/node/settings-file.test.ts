import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { removeLockIf } from "./lock.ts";
import { SettingsFile, syncDir } from "./settings-file.ts";
import { tempDir } from "./node-fixture.test-support.ts";

const errno = (code: string) => Object.assign(new Error(code), { code });

describe("SettingsFile: the lock at commit", () => {
  it("a holder that lost the lock before its commit writes nothing, and runs the update again once the lock is free", async () => {
    const d = tempDir();
    const path = join(d, "settings.json");
    const file = new SettingsFile(path);
    let attempts = 0;
    let seenWhileEvicted: boolean | undefined;
    const r = await file.update(() => {
      attempts++;
      if (attempts === 1) {
        // Evicted mid-update: our lock is gone and another holder (alive, fresh) has taken it.
        unlinkSync(`${path}.lock`);
        writeFileSync(`${path}.lock`, JSON.stringify({ pid: process.pid, at: Date.now(), nonce: "intruder", host: hostname() }));
        setTimeout(() => {
          seenWhileEvicted = existsSync(path);
          unlinkSync(`${path}.lock`);
        }, 150);
      }
      return { write: { attempt: attempts }, result: attempts };
    });
    expect(r).toMatchObject({ ok: true, written: true, result: 2 });
    expect(seenWhileEvicted).toBe(false); // nothing was written while the other held the lock
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ attempt: 2 });
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it("gives up with `locked` when the lock stays taken after it was lost", async () => {
    const d = tempDir();
    const path = join(d, "settings.json");
    const file = new SettingsFile(path, { lock: { waitMs: 300 } });
    const r = await file.update(() => {
      unlinkSync(`${path}.lock`);
      writeFileSync(`${path}.lock`, JSON.stringify({ pid: process.pid, at: Date.now(), nonce: "intruder", host: hostname() }));
      return { write: { x: 1 }, result: undefined };
    });
    expect(r).toMatchObject({ ok: false, code: "locked" });
    expect(existsSync(path)).toBe(false);
  });
});

describe("SettingsFile: a folder swapped for a link", () => {
  function setup() {
    const base = tempDir();
    const dir = join(base, "data");
    const outside = join(base, "outside");
    mkdirSync(dir);
    mkdirSync(outside);
    writeFileSync(join(outside, "settings.json"), "OUTSIDE");
    const swap = () => {
      renameSync(dir, join(base, "data-moved"));
      symlinkSync(outside, dir);
    };
    return { base, dir, outside, swap };
  }

  it("refuses the write when the folder is swapped before the commit, and touches nothing outside", async () => {
    const { dir, outside, swap } = setup();
    const file = new SettingsFile(join(dir, "settings.json"), { testHooks: { beforeCommit: swap } });
    const r = await file.update(() => ({ write: { x: 1 }, result: undefined }));
    expect(r).toMatchObject({ ok: false, code: "refused" });
    expect(readFileSync(join(outside, "settings.json"), "utf8")).toBe("OUTSIDE");
  });

  it("detects a swap inside the commit (after the last check) and reports the write refused", async () => {
    const { dir, outside, swap } = setup();
    const file = new SettingsFile(join(dir, "settings.json"), {
      testHooks: {
        beforeRename: (tmp) => {
          const name = tmp.slice(dir.length + 1);
          swap();
          writeFileSync(join(outside, name), "PLANTED"); // the rename now runs inside the other folder
        },
      },
    });
    const r = await file.update(() => ({ write: { x: 1 }, result: undefined }));
    expect(r).toMatchObject({ ok: false, code: "refused" });
  });
});

describe("SettingsFile: folder fsync", () => {
  const fake = (sync: () => Promise<void>) => async () => ({ sync, close: async () => {} });

  it("ignores a platform that cannot fsync a folder, and fails on a real fsync error", async () => {
    for (const code of ["EINVAL", "ENOTSUP"]) await syncDir("/x", fake(() => Promise.reject(errno(code))));
    for (const code of ["EISDIR", "EPERM", "EACCES"]) await syncDir("/x", () => Promise.reject(errno(code)));
    await expect(syncDir("/x", fake(() => Promise.reject(errno("EIO"))))).rejects.toMatchObject({ code: "EIO" });
    await expect(syncDir("/x", () => Promise.reject(errno("EIO")))).rejects.toMatchObject({ code: "EIO" });
  });

  it("reports the update unwritten when the folder fsync fails with EIO", async () => {
    const d = tempDir();
    const file = new SettingsFile(join(d, "settings.json"), { testHooks: { openDir: fake(() => Promise.reject(errno("EIO"))) } });
    const r = await file.update(() => ({ write: { x: 1 }, result: undefined }));
    expect(r).toMatchObject({ ok: false, code: "unwritten" });
    rmSync(d, { recursive: true, force: true });
  });
});

describe("SettingsFile: fix round 2", () => {
  it("a delayed breaker that moved a fresh lock aside never makes its owner's stale read count: no update is lost", async () => {
    const d = tempDir();
    const path = join(d, "settings.json");
    writeFileSync(path, JSON.stringify({ a: 0, b: 0 }));
    const a = new SettingsFile(path);
    const b = new SettingsFile(path);
    let attempts = 0;
    let bResult: unknown;
    const r = await a.update(async (read) => {
      attempts++;
      const raw = (read as { raw: Record<string, number> }).raw;
      if (attempts === 1) {
        // A breaker that judged an older lock stale moves A's fresh lock aside; while it is aside, B takes the free lock,
        // commits and releases; then the breaker sees the lock it moved is not the one it judged.
        const removed = await removeLockIf(path, () => false, {
          afterMove: async () => void (bResult = await b.update((rb) => ({ write: { ...(rb as { raw: object }).raw, b: 1 }, result: "b" }))),
        });
        expect(removed).toBe(false);
      }
      return { write: { ...raw, a: 1 }, result: attempts };
    });
    expect(bResult).toMatchObject({ ok: true, written: true });
    expect(r).toMatchObject({ ok: true, written: true, result: 2 }); // A lost its lock, wrote nothing, ran again
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ a: 1, b: 1 });
    expect(readdirSync(d)).toEqual(["settings.json"]);
  });

  it("refuses to set a damaged file aside through a folder swapped for a link after the read, and moves nothing outside", async () => {
    const base = tempDir();
    const dir = join(base, "data");
    const outside = join(base, "outside");
    mkdirSync(dir);
    mkdirSync(outside);
    writeFileSync(join(dir, "settings.json"), "{damaged");
    writeFileSync(join(outside, "settings.json"), "OUTSIDE");
    let swapped = false;
    const file = new SettingsFile(join(dir, "settings.json"), {
      testHooks: {
        afterRead: () => {
          if (swapped) return;
          swapped = true;
          renameSync(dir, join(base, "data-moved"));
          symlinkSync(outside, dir);
        },
      },
    });
    const r = await file.update(() => ({ write: { x: 1 }, result: undefined }));
    expect(swapped).toBe(true);
    expect(r).toMatchObject({ ok: false, code: "refused" });
    expect(readdirSync(outside)).toEqual(["settings.json"]);
    expect(readFileSync(join(outside, "settings.json"), "utf8")).toBe("OUTSIDE");
    expect(readFileSync(join(base, "data-moved", "settings.json"), "utf8")).toBe("{damaged");
  });

  it("refuses to set a damaged file aside when the folder was replaced by another real folder at the same path", async () => {
    const base = tempDir();
    const dir = join(base, "data");
    mkdirSync(dir);
    writeFileSync(join(dir, "settings.json"), "{damaged");
    let swapped = false;
    const file = new SettingsFile(join(dir, "settings.json"), {
      testHooks: {
        afterRead: () => {
          if (swapped) return;
          swapped = true;
          renameSync(dir, join(base, "data-moved"));
          mkdirSync(dir);
          writeFileSync(join(dir, "settings.json"), "OTHER");
        },
      },
    });
    const r = await file.update(() => ({ write: { x: 1 }, result: undefined }));
    expect(r).toMatchObject({ ok: false, code: "refused" });
    expect(readdirSync(dir)).toEqual(["settings.json"]);
    expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe("OTHER");
  });
});

describe("SettingsFile: fix round 3 (the guard is the last await before every change to the folder)", () => {
  function setup() {
    const base = tempDir();
    const dir = join(base, "data");
    const outside = join(base, "outside");
    mkdirSync(dir);
    mkdirSync(outside);
    writeFileSync(join(outside, "settings.json"), "OUTSIDE");
    const swap = () => {
      renameSync(dir, join(base, "data-moved"));
      symlinkSync(outside, dir);
    };
    return { base, dir, outside, swap };
  }

  it("a folder swapped while the archive name is chosen: the damaged file's rename is refused and nothing outside moves", async () => {
    const { base, dir, outside, swap } = setup();
    writeFileSync(join(dir, "settings.json"), "{damaged");
    let swapped = false;
    const file = new SettingsFile(join(dir, "settings.json"), {
      now: () => {
        // The clock is read to name the archive, after the read and its checks.
        if (!swapped) {
          swapped = true;
          swap();
        }
        return Date.UTC(2026, 9, 19, 12, 0, 0);
      },
    });
    const r = await file.update(() => ({ write: { x: 1 }, result: undefined }));
    expect(swapped).toBe(true);
    expect(r).toMatchObject({ ok: false, code: "refused" });
    expect(readdirSync(outside)).toEqual(["settings.json"]);
    expect(readFileSync(join(outside, "settings.json"), "utf8")).toBe("OUTSIDE");
    expect(readFileSync(join(base, "data-moved", "settings.json"), "utf8")).toBe("{damaged");
  });

  it("a folder swapped during the update's function: no temporary file is ever created outside, and the write is refused", async () => {
    const { dir, outside, swap } = setup();
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ x: 0 }));
    let outsideAtCommit: string[] | undefined;
    const file = new SettingsFile(join(dir, "settings.json"), { testHooks: { beforeCommit: () => void (outsideAtCommit = readdirSync(outside)) } });
    const r = await file.update(() => {
      swap();
      return { write: { x: 1, secretish: "full settings bytes" }, result: undefined };
    });
    expect(r).toMatchObject({ ok: false, code: "refused" });
    expect(outsideAtCommit).toBeUndefined(); // refused before the temporary file was opened
    expect(readdirSync(outside)).toEqual(["settings.json"]);
    expect(readFileSync(join(outside, "settings.json"), "utf8")).toBe("OUTSIDE");
  });

  it("a holder evicted after its temporary file is written (the last step before the commit) writes nothing and runs again", async () => {
    const d = tempDir();
    const path = join(d, "settings.json");
    let attempts = 0;
    let seenWhileEvicted: string | undefined;
    const file = new SettingsFile(path, {
      testHooks: {
        beforeCommit: () => {
          if (attempts !== 1) return;
          unlinkSync(`${path}.lock`);
          writeFileSync(`${path}.lock`, JSON.stringify({ pid: process.pid, at: Date.now(), nonce: "intruder", host: hostname() }));
          setTimeout(() => {
            seenWhileEvicted = existsSync(path) ? readFileSync(path, "utf8") : "none";
            unlinkSync(`${path}.lock`);
          }, 150);
        },
      },
    });
    const r = await file.update(() => ({ write: { attempt: ++attempts }, result: attempts }));
    expect(r).toMatchObject({ ok: true, written: true, result: 2 });
    expect(seenWhileEvicted).toBe("none");
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ attempt: 2 });
  });
});

describe("SettingsFile: fix round 4", () => {
  it("an update refused because settings.json became a link releases its lock: the next save, once the file is plain again, succeeds", async () => {
    const base = tempDir();
    const dir = join(base, "data");
    mkdirSync(dir);
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ x: 0 }));
    writeFileSync(join(base, "elsewhere.json"), "{}");
    const file = new SettingsFile(path, { lock: { waitMs: 300 } });
    const r = await file.update(() => {
      unlinkSync(path);
      symlinkSync(join(base, "elsewhere.json"), path);
      return { write: { x: 1 }, result: undefined };
    });
    expect(r).toMatchObject({ ok: false, code: "refused" });
    expect(readdirSync(dir)).toEqual(["settings.json"]); // no lock and no temporary file left behind
    unlinkSync(path);
    writeFileSync(path, JSON.stringify({ x: 0 }));
    const again = await file.update(() => ({ write: { x: 2 }, result: undefined }));
    expect(again).toMatchObject({ ok: true, written: true });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ x: 2 });
    expect(readFileSync(join(base, "elsewhere.json"), "utf8")).toBe("{}");
  });

  it("the sweep removes lock-metadata and moved-lock temporary files a dead process left", async () => {
    const d = tempDir();
    const path = join(d, "settings.json");
    const p = Bun.spawn(["bun", "-e", "0"]);
    await p.exited;
    for (const hex of ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]) writeFileSync(join(d, `.settings.json.${p.pid}.${hex}.tmp`), JSON.stringify({ pid: p.pid, at: 0, nonce: hex }));
    const file = new SettingsFile(path);
    expect(await file.update(() => ({ write: { x: 1 }, result: undefined }))).toMatchObject({ ok: true });
    expect(readdirSync(d)).toEqual(["settings.json"]);
  });
});
