import { describe, expect, it } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync, renameSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { acquireLock, LockRefused, LockTimeout, pidAlive, removeLockIf } from "./lock.ts";
import { tempDir } from "./node-fixture.test-support.ts";

/** The pid of a process that has exited. */
async function deadPid(): Promise<number> {
  const p = Bun.spawn(["bun", "-e", "0"]);
  await p.exited;
  expect(pidAlive(p.pid)).toBe(false);
  return p.pid;
}

const lockFile = (file: string, pid: number, at: number, nonce = "theirs") => writeFileSync(`${file}.lock`, JSON.stringify({ pid, at, nonce, host: hostname() }));
const lockText = (file: string) => readFileSync(`${file}.lock`, "utf8");

describe("acquireLock", () => {
  it("creates <file>.lock with pid, time, nonce and host, and removes it on release", async () => {
    const f = join(tempDir(), "settings.json");
    const lock = await acquireLock(f);
    const held = JSON.parse(lockText(f));
    expect(held).toMatchObject({ pid: process.pid, nonce: lock.nonce, host: hostname() });
    expect(Math.abs(held.at - Date.now())).toBeLessThan(5_000);
    expect(await lock.held()).toBe(true);
    await lock.release();
    expect(existsSync(`${f}.lock`)).toBe(false);
    expect(await lock.held()).toBe(false);
    expect(readdirSync(join(f, ".."))).toEqual([]); // no temporary file left
  });

  it("makes a second taker wait until the first releases", async () => {
    const f = join(tempDir(), "settings.json");
    const first = await acquireLock(f);
    let second = false;
    const p = acquireLock(f).then((l) => ((second = true), l));
    await Bun.sleep(80);
    expect(second).toBe(false);
    await first.release();
    const l = await p;
    expect(second).toBe(true);
    await l.release();
  });

  it("recovers a dead process's lock at once", async () => {
    const f = join(tempDir(), "settings.json");
    lockFile(f, await deadPid(), Date.now());
    const lock = await acquireLock(f, { waitMs: 1_000 });
    expect(JSON.parse(lockText(f)).pid).toBe(process.pid);
    await lock.release();
  });

  it("never removes a live process's lock within the 30 s lease; times out instead", async () => {
    const f = join(tempDir(), "settings.json");
    lockFile(f, process.pid, Date.now() - 25_000);
    const before = lockText(f);
    const t0 = Date.now();
    await expect(acquireLock(f, { waitMs: 300 })).rejects.toBeInstanceOf(LockTimeout);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(290);
    expect(lockText(f)).toBe(before);
  });

  it("recovers a live pid's lock after the lease (a crashed writer's pid reused by another process)", async () => {
    const f = join(tempDir(), "settings.json");
    lockFile(f, process.pid, Date.now()); // alive: this very process stands in for the unrelated process that got the pid
    await expect(acquireLock(f, { waitMs: 150 })).rejects.toBeInstanceOf(LockTimeout);
    const later = () => Date.now() + 31_000;
    const lock = await acquireLock(f, { waitMs: 500, now: later });
    expect(JSON.parse(lockText(f)).nonce).toBe(lock.nonce);
    await lock.release();
  });

  it("judges a lock whose text does not parse by the lease alone", async () => {
    const f = join(tempDir(), "settings.json");
    writeFileSync(`${f}.lock`, "");
    await expect(acquireLock(f, { waitMs: 150 })).rejects.toBeInstanceOf(LockTimeout);
    const old = (Date.now() - 31_000) / 1000;
    utimesSync(`${f}.lock`, old, old);
    const lock = await acquireLock(f, { waitMs: 1_000 });
    await lock.release();
  });

  it("never exists without its metadata: every read of the lock parses, while many take and release it", async () => {
    const f = join(tempDir(), "settings.json");
    let reads = 0;
    let bad = 0;
    let running = true;
    const poller = (async () => {
      while (running) {
        try {
          const j = JSON.parse(readFileSync(`${f}.lock`, "utf8"));
          if (typeof j.nonce !== "string" || typeof j.pid !== "number") bad++;
          reads++;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") bad++;
        }
        await new Promise((r) => setImmediate(r));
      }
    })();
    await Promise.all(
      Array.from({ length: 4 }, async () => {
        for (let i = 0; i < 25; i++) {
          const l = await acquireLock(f, { waitMs: 5_000 });
          await Bun.sleep(0);
          await l.release();
        }
      }),
    );
    running = false;
    await poller;
    expect(bad).toBe(0);
    expect(reads).toBeGreaterThan(0);
  });

  it("two breakers racing: the late one removes the fresh lock it moved and never puts it back; the fresh owner learns it lost it", async () => {
    const f = join(tempDir(), "settings.json");
    lockFile(f, await deadPid(), Date.now(), "old");
    // Both breakers judged the same stale lock.
    const seen = { text: lockText(f), ino: lstatSync(`${f}.lock`).ino };
    const isSeen = (text: string, ino: number) => text === seen.text && ino === seen.ino;
    expect(await removeLockIf(f, isSeen)).toBe(true); // the first breaker
    const fresh = await acquireLock(f, { waitMs: 0 }); // someone takes the lock
    expect(await removeLockIf(f, isSeen)).toBe(false); // the late breaker moves it aside, sees it is not the stale one: lost race
    expect(existsSync(`${f}.lock`)).toBe(false); // not put back
    expect(await fresh.held()).toBe(false);
    const next = await acquireLock(f, { waitMs: 0 });
    await fresh.release(); // no longer its lock: leaves the next one alone
    expect(await next.held()).toBe(true);
    await next.release();
    expect(existsSync(`${f}.lock`)).toBe(false);
    expect(readdirSync(join(f, ".."))).toEqual([]);
  });

  it("when a third lock is taken while a breaker has the fresh one aside, the fresh lock's owner learns it lost the lock", async () => {
    const f = join(tempDir(), "settings.json");
    const fresh = await acquireLock(f, { waitMs: 0 });
    let third: Awaited<ReturnType<typeof acquireLock>> | undefined;
    expect(await removeLockIf(f, () => false, { afterMove: async () => void (third = await acquireLock(f, { waitMs: 0 })) })).toBe(false);
    expect(await fresh.held()).toBe(false);
    expect(await third!.held()).toBe(true);
    await fresh.release(); // not its lock any more: leaves the third alone
    expect(await third!.held()).toBe(true);
    await third!.release();
  });

  it("an evicted holder sees it no longer holds the lock", async () => {
    const f = join(tempDir(), "settings.json");
    const mine = await acquireLock(f);
    const taker = await acquireLock(f, { waitMs: 500, now: () => Date.now() + 31_000 }); // after the lease
    expect(await mine.held()).toBe(false);
    expect(await taker.held()).toBe(true);
    await mine.release();
    expect(await taker.held()).toBe(true);
    await taker.release();
  });

  it("held() needs the very file it linked: a copy with the same nonce does not count", async () => {
    const f = join(tempDir(), "settings.json");
    const l = await acquireLock(f);
    const text = lockText(f);
    const before = statSync(`${f}.lock`);
    // Create the copy while the original still exists so the inodes cannot coincide, then replace it.
    writeFileSync(`${f}.lock.copy`, text);
    renameSync(`${f}.lock.copy`, `${f}.lock`); // same text, another file
    const after = statSync(`${f}.lock`);
    expect(after.dev === before.dev && after.ino === before.ino).toBe(false);
    expect(await l.held()).toBe(false);
    await l.release(); // not its lock: left alone
    expect(lockText(f)).toBe(text);
  });

  it("lets only one of many waiters break a stale lock; each then holds it alone", async () => {
    const f = join(tempDir(), "settings.json");
    lockFile(f, await deadPid(), Date.now() - 11_000);
    let inside = 0;
    let most = 0;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        const lock = await acquireLock(f, { waitMs: 3_000 });
        inside++;
        most = Math.max(most, inside);
        await Bun.sleep(5);
        inside--;
        await lock.release();
      }),
    );
    expect(most).toBe(1);
    expect(existsSync(`${f}.lock`)).toBe(false);
  });

  it("a guard that refuses: the lock creates, links and moves nothing", async () => {
    const d = tempDir();
    const f = join(d, "settings.json");
    await expect(acquireLock(f, { guard: async () => false })).rejects.toBeInstanceOf(LockRefused);
    expect(readdirSync(d)).toEqual([]);
    let allow = true;
    const l = await acquireLock(f, { guard: async () => allow });
    allow = false;
    await l.release(); // refused: the lock is left where it is, nothing moved
    expect(JSON.parse(lockText(f)).nonce).toBe(l.nonce);
    expect(readdirSync(d)).toEqual(["settings.json.lock"]);
  });
});
